-- ==========================================================
-- Registro seguro de equipos del agente
--   * Los equipos nuevos quedan PENDIENTES hasta que un admin los aprueba
--   * Cada equipo recibe una clave propia; sin ella no puede reportar
--   * Se guarda la IP pública desde donde se registró y reporta
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de bios.sql.
-- IMPORTANTE: los equipos que ya reportaban quedan PENDIENTES para que
-- los revises y apruebes uno por uno desde Monitoreo.
-- ==========================================================

alter table public.inv_dispositivos
  add column if not exists estado_registro text not null default 'pendiente'
    check (estado_registro in ('pendiente', 'aprobado', 'bloqueado')),
  add column if not exists secreto_hash text,
  add column if not exists clave_confirmada boolean not null default false,  -- el agente ya usó su clave al menos una vez
  add column if not exists ip_registro text,     -- IP pública del primer reporte
  add column if not exists ip_publica text,      -- IP pública del último reporte
  add column if not exists aprobado_por uuid references public.perfiles(id),
  add column if not exists aprobado_en timestamptz;

alter table public.inv_agente_config
  add column if not exists dominios_autoaprobados text[] not null default '{}';

create or replace function public.inv_hash(p text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- IP pública de quien llama (la informa Supabase en los encabezados de la petición)
create or replace function public.inv_ip_cliente() returns text
language sql stable as $$
  select nullif(trim(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1)), '')
$$;

-- Valida token + clave del equipo. Devuelve el id si está aprobado, null si está pendiente.
create or replace function public.inv_verificar_equipo(p_token text, p_uuid text, p_hostname text, p_secreto text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  r record;
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;
  v_uuid := nullif(trim(p_uuid), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then
    v_uuid := nullif(trim(p_hostname), '');
  end if;
  select id, estado_registro, secreto_hash into r from inv_dispositivos where uuid_equipo = v_uuid;
  if not found then
    raise exception 'El equipo todavía no está registrado';
  end if;
  if r.estado_registro = 'bloqueado' then
    raise exception 'Equipo bloqueado por el administrador';
  end if;
  if r.secreto_hash is null or r.secreto_hash <> inv_hash(coalesce(p_secreto, '')) then
    raise exception 'Clave de equipo inválida';
  end if;
  if r.estado_registro <> 'aprobado' then
    return null;
  end if;
  return r.id;
end $$;

revoke all on function public.inv_verificar_equipo(text, text, text, text) from public, anon, authenticated;

-- Las funciones cambian de firma: se borran las anteriores
drop function if exists public.inv_reportar_dispositivo(text, jsonb);
drop function if exists public.inv_reportar_aplicaciones(text, text, text, jsonb);
drop function if exists public.inv_reportar_seguridad(text, text, text, jsonb);

create or replace function public.inv_reportar_dispositivo(p_token text, p_datos jsonb, p_secreto text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_serie text;
  v_equipo uuid;
  r record;
  v_estado text;
  v_nuevo text;
  v_dominios text[];
  v_usuario_dom text;
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;

  v_uuid := nullif(trim(p_datos->>'uuid'), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then
    v_uuid := nullif(trim(p_datos->>'hostname'), '');
  end if;
  if v_uuid is null then
    raise exception 'El reporte no trae identificador';
  end if;

  -- ¿Equipo conocido? Verificar su clave propia. ¿Nuevo? Queda pendiente de aprobación.
  select id, estado_registro, secreto_hash, clave_confirmada into r from inv_dispositivos where uuid_equipo = v_uuid;
  if found then
    if r.estado_registro = 'bloqueado' then
      raise exception 'Equipo bloqueado por el administrador';
    end if;
    if r.secreto_hash is null or (not r.clave_confirmada and coalesce(p_secreto, '') = '') then
      -- sin clave todavía (agente anterior, clave nunca usada o restablecida desde la app): se entrega una nueva
      v_nuevo := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
      update inv_dispositivos set secreto_hash = inv_hash(v_nuevo), clave_confirmada = false where id = r.id;
    elsif r.secreto_hash = inv_hash(coalesce(p_secreto, '')) then
      if not r.clave_confirmada then
        update inv_dispositivos set clave_confirmada = true where id = r.id;
      end if;
    else
      raise exception 'Clave de equipo inválida. Si reinstalaste el agente desde cero, restablecé la clave del equipo desde Monitoreo.';
    end if;
    v_estado := r.estado_registro;
  else
    select dominios_autoaprobados into v_dominios from inv_agente_config where id = 1;
    v_usuario_dom := upper(split_part(coalesce(p_datos->>'usuario', ''), '\', 1));
    v_estado := case
      when exists (select 1 from unnest(v_dominios) x
                    where upper(trim(x)) in (upper(coalesce(p_datos->>'dominio', '')),
                                             upper(split_part(coalesce(p_datos->>'dominio', ''), '.', 1)),
                                             v_usuario_dom))
      then 'aprobado' else 'pendiente' end;
    v_nuevo := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  end if;

  v_serie := nullif(trim(p_datos->>'numero_serie'), '');
  if v_serie is not null and lower(v_serie) in
     ('to be filled by o.e.m.', 'default string', 'system serial number', 'none', '0', 'not specified') then
    v_serie := null;
  end if;
  -- Solo los equipos aprobados se vinculan con el inventario
  if v_serie is not null and v_estado = 'aprobado' then
    select id into v_equipo from inv_equipos where upper(numero_serie) = upper(v_serie) limit 1;
  end if;

  insert into inv_dispositivos as d (
    uuid_equipo, hostname, numero_serie, fabricante, modelo, so_nombre, so_version, so_build,
    so_arquitectura, procesador, nucleos, ram_total_gb, ram_libre_gb, discos, almacenamiento,
    ip, mac, usuario, dominio, arranque, bateria_pct, antivirus_activo, agente_version,
    equipo_id, ultimo_reporte, estado_registro, secreto_hash, ip_registro, ip_publica
  ) values (
    v_uuid,
    p_datos->>'hostname',
    v_serie,
    p_datos->>'fabricante',
    p_datos->>'modelo',
    p_datos->>'so_nombre',
    p_datos->>'so_version',
    p_datos->>'so_build',
    p_datos->>'so_arquitectura',
    p_datos->>'procesador',
    nullif(p_datos->>'nucleos', '')::int,
    nullif(p_datos->>'ram_total_gb', '')::numeric,
    nullif(p_datos->>'ram_libre_gb', '')::numeric,
    coalesce(p_datos->'discos', '[]'::jsonb),
    p_datos->>'almacenamiento',
    p_datos->>'ip',
    p_datos->>'mac',
    p_datos->>'usuario',
    p_datos->>'dominio',
    nullif(p_datos->>'arranque', '')::timestamptz,
    nullif(p_datos->>'bateria_pct', '')::int,
    nullif(p_datos->>'antivirus_activo', '')::boolean,
    p_datos->>'agente_version',
    v_equipo,
    now(),
    v_estado,
    inv_hash(v_nuevo),
    inv_ip_cliente(),
    inv_ip_cliente()
  )
  on conflict (uuid_equipo) do update set
    hostname = excluded.hostname,
    numero_serie = excluded.numero_serie,
    fabricante = excluded.fabricante,
    modelo = excluded.modelo,
    so_nombre = excluded.so_nombre,
    so_version = excluded.so_version,
    so_build = excluded.so_build,
    so_arquitectura = excluded.so_arquitectura,
    procesador = excluded.procesador,
    nucleos = excluded.nucleos,
    ram_total_gb = excluded.ram_total_gb,
    ram_libre_gb = excluded.ram_libre_gb,
    discos = excluded.discos,
    almacenamiento = excluded.almacenamiento,
    ip = excluded.ip,
    mac = excluded.mac,
    usuario = excluded.usuario,
    dominio = excluded.dominio,
    arranque = excluded.arranque,
    bateria_pct = excluded.bateria_pct,
    antivirus_activo = excluded.antivirus_activo,
    agente_version = excluded.agente_version,
    equipo_id = coalesce(excluded.equipo_id, d.equipo_id),
    ip_publica = excluded.ip_publica,
    ultimo_reporte = now();

  -- Mantener al día los datos técnicos del equipo vinculado en el inventario
  select equipo_id into v_equipo from inv_dispositivos where uuid_equipo = v_uuid;
  if v_equipo is not null and v_estado = 'aprobado' then
    update inv_equipos e set
      hostname = coalesce(p_datos->>'hostname', e.hostname),
      sistema_operativo = coalesce(p_datos->>'so_nombre', e.sistema_operativo),
      procesador = coalesce(p_datos->>'procesador', e.procesador),
      ram_gb = coalesce(round(nullif(p_datos->>'ram_total_gb', '')::numeric)::int, e.ram_gb),
      almacenamiento = coalesce(p_datos->>'almacenamiento', e.almacenamiento),
      mac = coalesce(p_datos->>'mac', e.mac)
    where e.id = v_equipo
      and (e.hostname, e.sistema_operativo, e.procesador, e.ram_gb, e.almacenamiento, e.mac)
          is distinct from
          (coalesce(p_datos->>'hostname', e.hostname),
           coalesce(p_datos->>'so_nombre', e.sistema_operativo),
           coalesce(p_datos->>'procesador', e.procesador),
           coalesce(round(nullif(p_datos->>'ram_total_gb', '')::numeric)::int, e.ram_gb),
           coalesce(p_datos->>'almacenamiento', e.almacenamiento),
           coalesce(p_datos->>'mac', e.mac));
  end if;

  -- La clave nueva se entrega una sola vez; el agente la guarda en una carpeta protegida
  return jsonb_build_object('estado', v_estado, 'secreto', v_nuevo);
end $$;

create or replace function public.inv_reportar_aplicaciones(
  p_token text, p_uuid text, p_hostname text, p_apps jsonb, p_secreto text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_disp uuid;
  v_primera boolean;
begin
  v_disp := inv_verificar_equipo(p_token, p_uuid, p_hostname, p_secreto);
  if v_disp is null then
    return;  -- equipo pendiente de aprobación: no se guardan datos
  end if;

  drop table if exists _apps;
  create temp table _apps on commit drop as
  select distinct on (nombre, version) nombre, version, editor, fecha_instalacion
  from (
    select trim(regexp_replace(a->>'nombre', '\s+', ' ', 'g')) as nombre,
           coalesce(nullif(trim(a->>'version'), ''), '') as version,
           nullif(trim(a->>'editor'), '') as editor,
           case when a->>'fecha_instalacion' ~ '^\d{8}$'
                then to_date(a->>'fecha_instalacion', 'YYYYMMDD') end as fecha_instalacion
    from jsonb_array_elements(coalesce(p_apps, '[]'::jsonb)) a
  ) x
  where nombre <> '';

  -- En el primer reporte no se registran "instaladas" (serían todas)
  v_primera := not exists (select 1 from inv_dispositivo_apps where dispositivo_id = v_disp);

  if not v_primera then
    insert into inv_apps_cambios (dispositivo_id, nombre, accion, version_anterior, version_nueva)
    select v_disp, coalesce(n.nombre, a.nombre),
           case when a.nombre is null then 'instalada'
                when n.nombre is null then 'desinstalada'
                else 'actualizada' end,
           a.versiones, n.versiones
    from (select nombre, string_agg(version, ', ' order by version) versiones from _apps group by nombre) n
    full join (select nombre, string_agg(version, ', ' order by version) versiones
                 from inv_dispositivo_apps where dispositivo_id = v_disp group by nombre) a
      on a.nombre = n.nombre
    where a.nombre is null or n.nombre is null or a.versiones is distinct from n.versiones;
  end if;

  delete from inv_dispositivo_apps d
   where d.dispositivo_id = v_disp
     and not exists (select 1 from _apps n where n.nombre = d.nombre and n.version = d.version);

  insert into inv_dispositivo_apps (dispositivo_id, nombre, version, editor, fecha_instalacion)
  select v_disp, nombre, version, editor, fecha_instalacion from _apps
  on conflict (dispositivo_id, nombre, version) do update set
    editor = excluded.editor,
    fecha_instalacion = excluded.fecha_instalacion,
    ultimo_visto = now();

  update inv_dispositivos
     set apps_cantidad = (select count(*) from _apps), apps_actualizado = now()
   where id = v_disp;
end $$;

create or replace function public.inv_reportar_seguridad(
  p_token text, p_uuid text, p_hostname text, p_datos jsonb, p_secreto text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_disp uuid;
begin
  v_disp := inv_verificar_equipo(p_token, p_uuid, p_hostname, p_secreto);
  if v_disp is null then
    return;  -- equipo pendiente de aprobación: no se guardan datos
  end if;

  update inv_dispositivos set
    bitlocker_estado      = p_datos->>'bitlocker_estado',
    bitlocker_detalle     = p_datos->'bitlocker_detalle',
    ultimo_parche         = nullif(p_datos->>'ultimo_parche', '')::timestamptz,
    ultimo_parche_titulo  = p_datos->>'ultimo_parche_titulo',
    reinicio_pendiente    = nullif(p_datos->>'reinicio_pendiente', '')::boolean,
    admins_locales        = p_datos->'admins_locales',
    firewall_perfiles     = p_datos->'firewall_perfiles',
    firewall_activo       = nullif(p_datos->>'firewall_activo', '')::boolean,
    av_productos          = p_datos->'av_productos',
    av_firmas_fecha       = nullif(p_datos->>'av_firmas_fecha', '')::timestamptz,
    av_escaneo_rapido     = nullif(p_datos->>'av_escaneo_rapido', '')::timestamptz,
    av_escaneo_completo   = nullif(p_datos->>'av_escaneo_completo', '')::timestamptz,
    av_proteccion_alteraciones = nullif(p_datos->>'av_proteccion_alteraciones', '')::boolean,
    tpm_presente          = nullif(p_datos->>'tpm_presente', '')::boolean,
    tpm_version           = p_datos->>'tpm_version',
    secure_boot           = nullif(p_datos->>'secure_boot', '')::boolean,
    cifrado_producto      = p_datos->>'cifrado_producto',
    cifrado_estado        = p_datos->>'cifrado_estado',
    cifrado_detalle       = p_datos->>'cifrado_detalle',
    bios_clave_admin      = nullif(p_datos->>'bios_clave_admin', '')::boolean,
    bios_clave_sistema    = nullif(p_datos->>'bios_clave_sistema', '')::boolean,
    bios_fuente           = p_datos->>'bios_fuente',
    seguridad_actualizado = now()
  where id = v_disp;

  insert into inv_amenazas (dispositivo_id, deteccion_id, nombre, severidad, categoria, estado_id,
                            recursos, usuario, proceso, ejecutada, detectada, cambio_estado)
  select v_disp, a->>'deteccion_id', a->>'nombre',
         nullif(a->>'severidad', '')::int, nullif(a->>'categoria', '')::int, nullif(a->>'estado_id', '')::int,
         a->'recursos', a->>'usuario', a->>'proceso', nullif(a->>'ejecutada', '')::boolean,
         nullif(a->>'detectada', '')::timestamptz, nullif(a->>'cambio_estado', '')::timestamptz
    from jsonb_array_elements(coalesce(p_datos->'amenazas', '[]'::jsonb)) a
   where nullif(a->>'deteccion_id', '') is not null
  on conflict (dispositivo_id, deteccion_id) do update set
    estado_id = excluded.estado_id,
    cambio_estado = excluded.cambio_estado,
    recursos = excluded.recursos,
    nombre = coalesce(excluded.nombre, inv_amenazas.nombre),
    severidad = coalesce(excluded.severidad, inv_amenazas.severidad),
    ejecutada = coalesce(excluded.ejecutada, inv_amenazas.ejecutada),
    -- si Defender cambió el estado (por ejemplo, volvió a fallar), se vuelve a mostrar como no revisada
    revisada = case when excluded.estado_id is distinct from inv_amenazas.estado_id then false
                    else inv_amenazas.revisada end;
end $$;

revoke all on function public.inv_reportar_dispositivo(text, jsonb, text) from public;
revoke all on function public.inv_reportar_aplicaciones(text, text, text, jsonb, text) from public;
revoke all on function public.inv_reportar_seguridad(text, text, text, jsonb, text) from public;
grant execute on function public.inv_reportar_dispositivo(text, jsonb, text) to anon, authenticated;
grant execute on function public.inv_reportar_aplicaciones(text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.inv_reportar_seguridad(text, text, text, jsonb, text) to anon, authenticated;

-- Al aprobar un equipo: registrar quién y cuándo, y vincularlo con el inventario por N° de serie
create or replace function public.inv_al_aprobar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado_registro = 'aprobado' and old.estado_registro is distinct from 'aprobado' then
    new.aprobado_en := now();
    new.aprobado_por := auth.uid();
    if new.equipo_id is null and new.numero_serie is not null then
      select id into new.equipo_id from inv_equipos where upper(numero_serie) = upper(new.numero_serie) limit 1;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_inv_al_aprobar on public.inv_dispositivos;
create trigger trg_inv_al_aprobar before update of estado_registro on public.inv_dispositivos
  for each row execute function public.inv_al_aprobar();

-- Solo los administradores ven los equipos pendientes o bloqueados
drop policy if exists inv_dispositivos_select on public.inv_dispositivos;
create policy inv_dispositivos_select on public.inv_dispositivos for select to authenticated
  using (mi_rol() = 'administrador' or (mi_rol() is not null and estado_registro = 'aprobado'));
