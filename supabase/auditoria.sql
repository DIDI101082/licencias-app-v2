-- ==========================================================
-- Logs: registro de cambios hechos por las personas en la app
--   * Se registra en la BASE: cualquier cambio queda, venga de una pantalla o de la API
--   * Nadie puede modificar ni borrar el registro (ni siquiera un administrador)
--   * Secretos (tokens, claves, huellas) nunca se guardan: aparecen como "(oculto)"
--   * Los reportes automáticos de agentes y del puente de PRTG no se registran
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de acceso-restringido.sql y red-topologia.sql.
-- ==========================================================

-- Nueva solapa "Logs" (auditoria) en los grupos de acceso
alter table public.grupos_acceso drop constraint if exists grupos_acceso_modulos_check;
alter table public.grupos_acceso add constraint grupos_acceso_modulos_check
  check (modulos <@ array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red', 'auditoria']);

create or replace function public.mis_modulos() returns text[]
language sql stable security definer set search_path = public as $$
  select case
           when p.rol = 'administrador'
             then array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red', 'auditoria']
           else coalesce(g.modulos, '{}')      -- sin grupo: ninguna solapa
         end
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
   where p.id = auth.uid()
$$;

create table if not exists public.auditoria (
  id bigserial primary key,
  fecha timestamptz not null default now(),
  usuario_id uuid,
  usuario_email text,
  usuario_nombre text,
  ip text,
  tabla text not null,
  accion text not null check (accion in ('alta', 'modificacion', 'baja')),
  registro_id text,
  descripcion text,
  cambios jsonb     -- modificación: {campo: {antes, despues}}; alta/baja: los datos del registro
);
create index if not exists idx_auditoria_fecha on public.auditoria(fecha desc);
create index if not exists idx_auditoria_usuario on public.auditoria(usuario_id, fecha desc);
create index if not exists idx_auditoria_tabla on public.auditoria(tabla, fecha desc);

create or replace function public.auditar()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_old jsonb;
  v_new jsonb;
  v_fila jsonb;
  v_cambios jsonb := '{}'::jsonb;
  k text;
  v_desc text;
  v_extra text;
  -- campos que cambian solos y no aportan
  v_ignorar text[] := array['actualizado', 'updated_at', 'ultimo_reporte', 'geo_actualizado', 'ubicacion_actualizada',
                            'seguridad_actualizado', 'apps_actualizado', 'ultimo_uso', 'usos',
                            -- campos de autor: se vacían al eliminar un usuario y no son un cambio en sí
                            'asignado_por', 'cargado_por', 'creado_por', 'registrado_por', 'aprobado_por'];
  -- secretos: nunca se guarda su valor
  v_secretos text[] := array['token', 'token_hash', 'secreto_hash', 'codigo_hash', 'geo_api_key', 'password'];
  p record;
begin
  -- Solo acciones de personas con sesión; los agentes y el puente no tienen usuario
  if v_uid is null then
    return coalesce(new, old);
  end if;

  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      continue when k = any(v_ignorar);
      if (v_old -> k) is distinct from (v_new -> k) then
        if k = any(v_secretos) then
          v_cambios := v_cambios || jsonb_build_object(k, jsonb_build_object('antes', '(oculto)', 'despues', '(cambiado)'));
        else
          v_cambios := v_cambios || jsonb_build_object(k, jsonb_build_object('antes', v_old -> k, 'despues', v_new -> k));
        end if;
      end if;
    end loop;
    if v_cambios = '{}'::jsonb then
      return new;   -- nada relevante cambió
    end if;
  else
    v_fila := coalesce(v_new, v_old);
    for k in select unnest(v_secretos) loop
      if v_fila ? k and v_fila ->> k is not null then v_fila := jsonb_set(v_fila, array[k], '"(oculto)"'); end if;
    end loop;
    -- registros muy grandes (por ejemplo, un equipo con todo su inventario técnico): solo los datos simples
    if pg_column_size(v_fila) > 6000 then
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_fila
        from jsonb_each(v_fila) where jsonb_typeof(value) not in ('array', 'object');
    end if;
    v_cambios := v_fila;
  end if;

  -- Las direcciones de mapas de PRTG llevan una clave secreta: se oculta
  if tg_table_name = 'red_mapas' then
    v_cambios := regexp_replace(v_cambios::text, '((mapid|key)=)[^&"]+', '\1•••', 'g')::jsonb;
  end if;

  -- Descripción legible del registro
  v_fila := coalesce(v_new, v_old);
  v_desc := coalesce(
    nullif(trim(concat_ws(' ', v_fila ->> 'nombre', v_fila ->> 'apellido')), ''),
    v_fila ->> 'email', v_fila ->> 'codigo', v_fila ->> 'hostname', v_fila ->> 'descripcion',
    v_fila ->> 'patron', v_fila ->> 'cidr', v_fila ->> 'motivo', v_fila ->> 'fecha');
  begin
    if v_fila ? 'licencia_id' then
      select nombre into v_extra from licencias where id::text = v_fila ->> 'licencia_id';
      v_desc := concat_ws(' · ', v_extra, v_desc);
    end if;
    if v_fila ? 'equipo_id' and v_fila ->> 'equipo_id' is not null then
      select coalesce(codigo, numero_serie) into v_extra from inv_equipos where id::text = v_fila ->> 'equipo_id';
      v_desc := concat_ws(' · ', v_extra, v_desc);
    end if;
    if v_fila ? 'empleado_id' and v_fila ->> 'empleado_id' is not null then
      select trim(concat_ws(' ', nombre, apellido)) into v_extra from empleados where id::text = v_fila ->> 'empleado_id';
      v_desc := concat_ws(' → ', v_desc, v_extra);
    end if;
  exception when others then null;
  end;

  select nombre, email into p from perfiles where id = v_uid;

  insert into auditoria (usuario_id, usuario_email, usuario_nombre, ip, tabla, accion, registro_id, descripcion, cambios)
  values (
    v_uid, p.email, p.nombre,
    (select inv_ip_cliente()),
    tg_table_name,
    case tg_op when 'INSERT' then 'alta' when 'UPDATE' then 'modificacion' else 'baja' end,
    coalesce(v_fila ->> 'id', v_fila ->> 'objid', v_fila ->> 'empleado_id'),
    left(v_desc, 300),
    v_cambios
  );
  return coalesce(new, old);
exception when others then
  -- el registro de auditoría nunca debe impedir la operación
  return coalesce(new, old);
end $$;

-- Activar en todas las tablas que modifican las personas
do $$
declare t text;
begin
  foreach t in array array[
    'perfiles', 'grupos_acceso', 'empleados', 'licencias', 'asignaciones',
    'inv_equipos', 'inv_asignaciones', 'inv_mantenimientos', 'inv_categorias', 'inv_ubicaciones', 'inv_proveedores', 'inv_productos',
    'inv_dispositivos', 'inv_agente_config', 'inv_codigos_instalacion', 'inv_software_prohibido', 'inv_amenazas', 'inv_redes',
    'asistencia_config', 'asistencia_feriados', 'asistencia_excepciones',
    'red_mapas', 'red_puente_config', 'red_conexiones'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_auditoria on public.%I', t);
      execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
    end if;
  end loop;
end $$;

-- Inicios de sesión (registro de autenticación de Supabase)
create or replace function public.auditoria_sesiones(p_desde timestamptz, p_limite int default 500)
returns table (fecha timestamptz, email text, accion text, ip text, proveedor text)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not puede_ver('auditoria') then
    return;
  end if;
  return query
    select e.created_at,
           coalesce(e.payload ->> 'actor_username', e.payload -> 'traits' ->> 'user_email', e.payload -> 'traits' ->> 'email'),
           e.payload ->> 'action',
           nullif(e.ip_address::text, ''),
           e.payload -> 'traits' ->> 'provider'
      from auth.audit_log_entries e
     where e.created_at >= p_desde
       and e.payload ->> 'action' in ('login', 'logout', 'user_signedup', 'user_deleted', 'user_invited', 'user_updated_password', 'user_recovery_requested')
     order by e.created_at desc
     limit least(greatest(p_limite, 1), 2000);
exception when others then
  return;
end $$;
revoke all on function public.auditoria_sesiones(timestamptz, int) from public, anon;
grant execute on function public.auditoria_sesiones(timestamptz, int) to authenticated;

-- Permisos: solo lectura para quien tenga la solapa Logs; nadie puede escribir, editar ni borrar
alter table public.auditoria enable row level security;
revoke insert, update, delete, truncate on public.auditoria from anon, authenticated;
drop policy if exists auditoria_select on public.auditoria;
create policy auditoria_select on public.auditoria for select to authenticated using (puede_ver('auditoria'));
