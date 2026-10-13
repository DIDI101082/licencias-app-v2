-- ==========================================================
-- Datos para la ticketera (Mesa de Ayuda): ficha de la persona que pide
--   La ticketera consulta, por mail, el empleado, sus equipos asignados (con el estado
--   que informa el agente y las detecciones de ESET), MFA, cuenta de AD, cuenta de
--   Microsoft 365, licencias, capacitaciones de seguridad y simulaciones de phishing.
--   Solo lectura. Cada consulta queda registrada.
--
-- Ejecutar UNA VEZ en el SQL Editor (se puede repetir). Después, para generar la clave:
--     select public.tickets_nuevo_token();
--   y cargar el resultado en Vercel, en el proyecto de la ticketera, como CYBER_CONTEXTO_TOKEN.
--   Volver a ejecutarlo genera una clave nueva e invalida la anterior.
-- ==========================================================

-- Clave de la integración: se guarda solo su huella
create table if not exists public.tickets_integracion (
  id int primary key default 1 check (id = 1),
  token_hash text,
  creado_en timestamptz
);
insert into public.tickets_integracion (id) values (1) on conflict (id) do nothing;
alter table public.tickets_integracion enable row level security;
revoke all on public.tickets_integracion from anon, authenticated;

-- Registro de consultas (quién se consultó, desde qué ticket y cuándo)
create table if not exists public.tickets_contexto_consultas (
  id bigserial primary key,
  fecha timestamptz not null default now(),
  email text not null,
  ticket text,
  encontrado boolean not null default false
);
create index if not exists idx_tickets_contexto_consultas_fecha on public.tickets_contexto_consultas (fecha desc);
alter table public.tickets_contexto_consultas enable row level security;
drop policy if exists tickets_contexto_consultas_select on public.tickets_contexto_consultas;
create policy tickets_contexto_consultas_select on public.tickets_contexto_consultas for select to authenticated
  using (mi_rol() = 'administrador');
revoke insert, update, delete, truncate on public.tickets_contexto_consultas from anon, authenticated;

-- Genera la clave (solo desde el SQL Editor). Devuelve la clave una única vez.
create or replace function public.tickets_nuevo_token() returns text
language plpgsql security definer set search_path = public as $$
declare v text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  update tickets_integracion set token_hash = inv_hash(v), creado_en = now() where id = 1;
  return v;
end $$;
revoke all on function public.tickets_nuevo_token() from public, anon, authenticated;

-- Ficha de la persona. La llama el servidor de la ticketera con su clave.
-- Cada parte va en su propio bloque: si un módulo no está instalado, esa parte se omite y el resto sale igual.
create or replace function public.tickets_contexto(p_token text, p_email text, p_ticket text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_emp jsonb;
  v_emp_id uuid;
  r jsonb;
  x jsonb;
  q record;
  dj jsonb;
  det jsonb;
  equipos jsonb := '[]'::jsonb;
begin
  select token_hash into v_hash from tickets_integracion where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'No autorizado' using errcode = '28000';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('encontrado', false);
  end if;

  -- Empleado (por mail; si no, por la cuenta de Microsoft 365 vinculada)
  select to_jsonb(e) into v_emp from empleados e where lower(e.email) = v_email limit 1;
  if v_emp is null then
    begin
      select to_jsonb(e) into v_emp from m365_cuentas c join empleados e on e.id = c.empleado_id where lower(c.email) = v_email limit 1;
    exception when others then null;
    end;
  end if;
  v_emp_id := (v_emp ->> 'id')::uuid;

  r := jsonb_build_object('encontrado', v_emp is not null, 'consultado', now());
  if v_emp is not null then
    r := r || jsonb_build_object('empleado', jsonb_build_object(
      'id', v_emp ->> 'id',
      'nombre', trim(coalesce(v_emp ->> 'nombre', '') || ' ' || coalesce(v_emp ->> 'apellido', '')),
      'area', v_emp ->> 'area',
      'puesto', v_emp ->> 'puesto',
      'activo', coalesce((v_emp ->> 'activo')::boolean, true)));

    -- Equipos entregados y no devueltos, con lo último que informó el agente y ESET
    begin
      for q in
        select a.fecha_entrega, to_jsonb(eq) as j
          from inv_asignaciones a join inv_equipos eq on eq.id = a.equipo_id
         where a.empleado_id = v_emp_id and a.fecha_devolucion is null
         order by a.fecha_entrega desc limit 10
      loop
        dj := null; det := null; x := null;
        begin
          select to_jsonb(d) into dj from inv_dispositivos d where d.equipo_id = (q.j ->> 'id')::uuid order by d.ultimo_reporte desc nulls last limit 1;
        exception when others then null;
        end;
        begin
          select jsonb_build_object('nombre', c.nombre) into x from inv_categorias c where c.id = (q.j ->> 'categoria_id')::uuid;
        exception when others then null;
        end;
        if dj is not null then
          begin
            select jsonb_build_object(
                     'abiertas', count(*) filter (where not s.resuelta),
                     'ultima', (select jsonb_build_object('nombre', s2.nombre, 'severidad', s2.severidad, 'fecha', s2.fecha)
                                  from eset_detecciones s2 where s2.dispositivo_id = (dj ->> 'id')::uuid order by s2.fecha desc limit 1))
              into det
              from eset_detecciones s
             where s.dispositivo_id = (dj ->> 'id')::uuid and s.fecha > now() - interval '30 days';
          exception when others then null;
          end;
        end if;
        equipos := equipos || jsonb_build_array(jsonb_build_object(
          'id', q.j ->> 'id',
          'codigo', q.j ->> 'codigo',
          'categoria', x ->> 'nombre',
          'marca', q.j ->> 'marca',
          'modelo', q.j ->> 'modelo',
          'serie', q.j ->> 'numero_serie',
          'entregado', q.fecha_entrega,
          'hostname', dj ->> 'hostname',
          'so', nullif(trim(coalesce(dj ->> 'so_nombre', '') || ' ' || coalesce(dj ->> 'so_version', '')), ''),
          'ultimo_reporte', dj ->> 'ultimo_reporte',
          'antivirus', (dj ->> 'antivirus_activo')::boolean,
          'cifrado', coalesce(dj ->> 'cifrado_estado', dj ->> 'bitlocker_estado'),
          'reinicio_pendiente', (dj ->> 'reinicio_pendiente')::boolean,
          'ultimo_parche', dj ->> 'ultimo_parche',
          'ubicacion', dj ->> 'ubicacion_tipo',
          'eset', det));
      end loop;
      r := r || jsonb_build_object('equipos', equipos);
    exception when others then null;
    end;

    -- Capacitaciones de seguridad (módulo de concientización): estado de cada una para esta persona
    begin
      select coalesce(jsonb_agg(jsonb_build_object('nombre', v.capacitacion, 'estado', v.estado, 'ultima', v.ultima, 'vence', v.vence)
                                order by case v.estado when 'vencida' then 0 when 'pendiente' then 1 else 2 end, v.capacitacion), '[]'::jsonb) into x
        from capacitaciones_v_estado v where v.empleado_id = v_emp_id;
      r := r || jsonb_build_object('capacitaciones', x);
    exception when others then null;
    end;

    -- Simulaciones de phishing en las que participó (solo el resumen)
    begin
      select jsonb_build_object('recibidas', count(*), 'reporto', count(*) filter (where p.reporto),
                                'clic', count(*) filter (where p.clic or p.credenciales))
        into x from phishing_resultados p where p.empleado_id = v_emp_id;
      if (x ->> 'recibidas')::int > 0 then r := r || jsonb_build_object('simulaciones', x); end if;
    exception when others then null;
    end;

    -- Licencias asignadas (las de Microsoft 365 y las cargadas a mano)
    begin
      select coalesce(jsonb_agg(l.nombre order by l.nombre), '[]'::jsonb) into x
        from asignaciones a join licencias l on l.id = a.licencia_id
       where a.empleado_id = v_emp_id and a.fecha_liberacion is null;
      r := r || jsonb_build_object('licencias', x);
    exception when others then null;
    end;
  end if;

  -- MFA (Entra ID)
  begin
    select jsonb_build_object('activo', m.mfa, 'metodos', to_jsonb(m.metodos), 'admin', m.admin, 'actualizado', m.actualizado) into x
      from identidad_mfa m where lower(m.upn) = v_email limit 1;
    if x is not null then r := r || jsonb_build_object('mfa', x); end if;
  exception when others then null;
  end;

  -- Cuenta de Active Directory
  begin
    select jsonb_build_object('usuario', u.sam, 'habilitada', u.habilitado, 'bloqueada', u.bloqueado, 'ultimo_ingreso', u.ultimo_logon,
                              'clave_cambiada', u.pwd_cambiada, 'clave_no_vence', u.pwd_no_vence) into x
      from ad_usuarios u where lower(u.mail) = v_email or lower(u.upn) = v_email limit 1;
    if x is not null then r := r || jsonb_build_object('ad', x); end if;
  exception when others then null;
  end;

  -- Cuenta de Microsoft 365
  begin
    select jsonb_build_object('habilitada', c.habilitada, 'ultimo_ingreso', c.ultimo_ingreso) into x
      from m365_cuentas c where lower(c.email) = v_email limit 1;
    if x is not null then r := r || jsonb_build_object('m365', x); end if;
  exception when others then null;
  end;

  insert into tickets_contexto_consultas (email, ticket, encontrado) values (v_email, left(p_ticket, 40), v_emp is not null);
  delete from tickets_contexto_consultas where fecha < now() - interval '180 days';
  return r;
end $$;
revoke all on function public.tickets_contexto(text, text, text) from public;
grant execute on function public.tickets_contexto(text, text, text) to anon, authenticated;
