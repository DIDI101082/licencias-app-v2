-- ==========================================================
-- Servidores → Accesos
--   * El agente (versión 1.9 o posterior), SOLO en servidores, envía los inicios de sesión por consola y por
--     Escritorio remoto, los cierres y los intentos fallidos (log de seguridad de Windows).
--   * Lista de usuarios autorizados por servidor: si entra alguien que no está, alerta.
--   * Alertas: acceso no autorizado, cuenta local o "Administrador", primer acceso de un usuario a un servidor,
--     acceso fuera de horario e intentos fallidos. Arrancan apagadas.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de servidores.sql e instalacion-segura.sql. Se puede repetir.
-- ==========================================================

create table if not exists public.srv_accesos_config (
  id int primary key default 1 check (id = 1),
  alertas boolean not null default false,
  alertar_primer_acceso boolean not null default true,
  alertar_fuera_horario boolean not null default true,
  hora_desde int not null default 7 check (hora_desde between 0 and 23),
  hora_hasta int not null default 21 check (hora_hasta between 1 and 24),
  fines_de_semana boolean not null default false,     -- true = el fin de semana no cuenta como fuera de horario
  umbral_fallos int not null default 10 check (umbral_fallos between 3 and 1000),
  dias_historial int not null default 180 check (dias_historial between 30 and 730)
);
insert into public.srv_accesos_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.srv_accesos (
  id bigserial primary key,
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  hostname text,
  record_id bigint not null,
  fecha timestamptz not null,
  tipo text not null check (tipo in ('inicio', 'fin', 'fallo')),
  usuario text not null,
  dominio text,
  logon_type int,             -- 2 consola, 10 Escritorio remoto, 11 credenciales en caché, 3 red (solo fallos)
  ip text,
  origen text,                -- nombre del equipo desde el que se conectó
  logon_id text,              -- une el inicio con su cierre
  motivo text,                -- código de error de los fallos
  unique (dispositivo_id, record_id)
);
create index if not exists idx_srv_accesos_fecha on public.srv_accesos (fecha desc);
create index if not exists idx_srv_accesos_sesion on public.srv_accesos (dispositivo_id, logon_id, tipo);
create index if not exists idx_srv_accesos_usuario on public.srv_accesos (dispositivo_id, lower(usuario), tipo, fecha);

create table if not exists public.srv_autorizados (
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  usuario text not null,                -- en minúsculas; sin dominio ("jperez") o con dominio ("accusys\jperez")
  agregado_en timestamptz not null default now(),
  agregado_por uuid default auth.uid(),
  primary key (dispositivo_id, usuario)
);

-- ----------------------------------------------------------
-- Lo llama el agente del servidor (se autentica con la clave propia del equipo)
-- ----------------------------------------------------------
create or replace function public.srv_reportar_accesos(p_token text, p_uuid text, p_hostname text, p_secreto text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; n int := 0; v_dias int;
begin
  v_id := inv_verificar_equipo(p_token, p_uuid, p_hostname, p_secreto);
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'pendiente de aprobación'); end if;
  if jsonb_typeof(p_datos -> 'eventos') = 'array' then
    insert into srv_accesos (dispositivo_id, hostname, record_id, fecha, tipo, usuario, dominio, logon_type, ip, origen, logon_id, motivo)
    select v_id, left(p_hostname, 100), x.record_id, x.fecha, x.tipo, left(x.usuario, 200), nullif(left(x.dominio, 100), ''), x.logon_type,
           nullif(left(x.ip, 60), ''), nullif(left(x.origen, 100), ''), nullif(left(x.logon_id, 40), ''), nullif(left(x.motivo, 20), '')
      from jsonb_to_recordset(p_datos -> 'eventos') as x(record_id bigint, fecha timestamptz, tipo text, usuario text, dominio text, logon_type int,
                                                         ip text, origen text, logon_id text, motivo text)
     where x.record_id is not null and x.fecha is not null and x.tipo in ('inicio', 'fin', 'fallo') and coalesce(x.usuario, '') <> ''
    on conflict (dispositivo_id, record_id) do nothing;
    get diagnostics n = row_count;
  end if;
  select dias_historial into v_dias from srv_accesos_config where id = 1;
  delete from srv_accesos where dispositivo_id = v_id and fecha < now() - make_interval(days => coalesce(v_dias, 180));
  return jsonb_build_object('ok', true, 'eventos', n);
end $$;
revoke all on function public.srv_reportar_accesos(text, text, text, text, jsonb) from public;
grant execute on function public.srv_reportar_accesos(text, text, text, text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Sesiones (cada inicio con su cierre y sus marcas de riesgo)
-- ----------------------------------------------------------
create or replace view public.srv_sesiones with (security_invoker = true) as
with c as (select * from srv_accesos_config where id = 1)
select a.id, a.dispositivo_id, coalesce(s.nombre, a.hostname) as servidor, a.hostname, a.fecha, a.usuario, a.dominio, a.logon_type, a.ip, a.origen,
       (select min(f.fecha) from srv_accesos f
         where f.dispositivo_id = a.dispositivo_id and f.tipo = 'fin' and f.logon_id = a.logon_id and f.fecha >= a.fecha) as fin,
       case when not exists (select 1 from srv_autorizados z where z.dispositivo_id = a.dispositivo_id) then null
            else exists (select 1 from srv_autorizados z where z.dispositivo_id = a.dispositivo_id
                          and z.usuario in (lower(a.usuario), lower(coalesce(a.dominio, '') || '\' || a.usuario))) end as autorizado,
       (upper(coalesce(a.dominio, '')) = upper(coalesce(a.hostname, '-')) or lower(a.usuario) in ('administrator', 'administrador')) as cuenta_local,
       (extract(hour from a.fecha at time zone 'America/Argentina/Buenos_Aires') < (select hora_desde from c)
        or extract(hour from a.fecha at time zone 'America/Argentina/Buenos_Aires') >= (select hora_hasta from c)
        or (extract(isodow from a.fecha at time zone 'America/Argentina/Buenos_Aires') >= 6 and not (select fines_de_semana from c))) as fuera_horario,
       (not exists (select 1 from srv_accesos b where b.dispositivo_id = a.dispositivo_id and b.tipo = 'inicio'
                     and lower(b.usuario) = lower(a.usuario) and b.fecha < a.fecha)
        and exists (select 1 from srv_accesos o where o.dispositivo_id = a.dispositivo_id and o.fecha < a.fecha - interval '7 days')) as primer_acceso
  from srv_accesos a
  left join srv_servidores s on s.dispositivo_id = a.dispositivo_id
 where a.tipo = 'inicio';

-- Servidores que envían accesos (para la lista y los autorizados)
create or replace view public.srv_accesos_equipos with (security_invoker = true) as
select a.dispositivo_id, coalesce(max(s.nombre), max(a.hostname)) as servidor, max(a.hostname) as hostname, max(a.fecha) as ultimo_evento,
       (select count(*) from srv_autorizados z where z.dispositivo_id = a.dispositivo_id) as autorizados
  from srv_accesos a left join srv_servidores s on s.dispositivo_id = a.dispositivo_id
 group by a.dispositivo_id;

-- ----------------------------------------------------------
-- Configuración y autorizados (solo administradores)
-- ----------------------------------------------------------
create or replace function public.srv_accesos_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update srv_accesos_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    alertar_primer_acceso = coalesce((p ->> 'alertar_primer_acceso')::boolean, alertar_primer_acceso),
    alertar_fuera_horario = coalesce((p ->> 'alertar_fuera_horario')::boolean, alertar_fuera_horario),
    hora_desde = coalesce((p ->> 'hora_desde')::int, hora_desde),
    hora_hasta = coalesce((p ->> 'hora_hasta')::int, hora_hasta),
    fines_de_semana = coalesce((p ->> 'fines_de_semana')::boolean, fines_de_semana),
    umbral_fallos = coalesce((p ->> 'umbral_fallos')::int, umbral_fallos)
  where id = 1;
end $$;
revoke execute on function public.srv_accesos_config_guardar(jsonb) from public, anon;
grant execute on function public.srv_accesos_config_guardar(jsonb) to authenticated;

create or replace function public.srv_autorizado_guardar(p_dispositivo uuid, p_usuario text, p_agregar boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v text := lower(trim(p_usuario));
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(v, '') = '' then raise exception 'Falta el usuario'; end if;
  if p_agregar then
    insert into srv_autorizados (dispositivo_id, usuario) values (p_dispositivo, left(v, 200)) on conflict do nothing;
  else
    delete from srv_autorizados where dispositivo_id = p_dispositivo and usuario = v;
  end if;
end $$;
revoke execute on function public.srv_autorizado_guardar(uuid, text, boolean) from public, anon;
grant execute on function public.srv_autorizado_guardar(uuid, text, boolean) to authenticated;

-- Arrancar la lista con quienes entraron en los últimos N días (después se depura a mano)
create or replace function public.srv_autorizados_desde_historial(p_dispositivo uuid, p_dias int default 30)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  insert into srv_autorizados (dispositivo_id, usuario)
  select distinct p_dispositivo, lower(a.usuario) from srv_accesos a
   where a.dispositivo_id = p_dispositivo and a.tipo = 'inicio' and a.fecha > now() - make_interval(days => least(greatest(p_dias, 1), 365))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.srv_autorizados_desde_historial(uuid, int) from public, anon;
grant execute on function public.srv_autorizados_desde_historial(uuid, int) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.srv_accesos_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c srv_accesos_config;
begin
  select * into c from srv_accesos_config where id = 1;
  if not coalesce(c.alertas, false) then return; end if;

  insert into _cond select 'acc:noaut:' || id, 'acceso', 'alta', 'Acceso no autorizado a ' || servidor || ': ' || usuario,
         concat_ws(' · ', case logon_type when 10 then 'Escritorio remoto' when 2 then 'Consola' else 'Tipo ' || logon_type end,
                   'desde ' || coalesce(ip, origen), to_char(fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'),
                   'no está en la lista de autorizados'), '/servidores/accesos'
    from srv_sesiones where fecha > now() - interval '24 hours' and autorizado = false
  on conflict do nothing;

  insert into _cond select 'acc:local:' || id, 'acceso', 'alta', 'Acceso con cuenta local o genérica a ' || servidor || ': ' || usuario,
         concat_ws(' · ', 'desde ' || coalesce(ip, origen), to_char(fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'),
                   'usá cuentas nominales del dominio para poder saber quién entró'), '/servidores/accesos'
    from srv_sesiones where fecha > now() - interval '24 hours' and cuenta_local
  on conflict do nothing;

  if c.alertar_primer_acceso then
    insert into _cond select 'acc:primero:' || id, 'acceso', 'media', 'Primer acceso de ' || usuario || ' a ' || servidor,
           concat_ws(' · ', 'desde ' || coalesce(ip, origen), to_char(fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')), '/servidores/accesos'
      from srv_sesiones where fecha > now() - interval '24 hours' and primer_acceso and autorizado is distinct from false
    on conflict do nothing;
  end if;

  if c.alertar_fuera_horario then
    insert into _cond select 'acc:horario:' || id, 'acceso', 'media', 'Acceso fuera de horario a ' || servidor || ': ' || usuario,
           concat_ws(' · ', 'desde ' || coalesce(ip, origen), to_char(fecha at time zone 'America/Argentina/Buenos_Aires', 'Dy DD/MM HH24:MI')), '/servidores/accesos'
      from srv_sesiones where fecha > now() - interval '24 hours' and fuera_horario and autorizado is distinct from false and not cuenta_local
    on conflict do nothing;
  end if;

  insert into _cond select 'acc:fallos:' || a.dispositivo_id, 'acceso', 'alta',
         'Intentos fallidos de inicio de sesión en ' || coalesce(max(s.nombre), max(a.hostname)),
         count(*) || ' en la última hora · usuarios: ' || left(string_agg(distinct a.usuario, ', '), 100) ||
         coalesce(' · desde ' || left(string_agg(distinct coalesce(a.ip, a.origen), ', '), 100), ''), '/servidores/accesos'
    from srv_accesos a left join srv_servidores s on s.dispositivo_id = a.dispositivo_id
   where a.tipo = 'fallo' and a.fecha > now() - interval '1 hour'
   group by a.dispositivo_id having count(*) >= c.umbral_fallos
  on conflict do nothing;
end $$;
revoke all on function public.srv_accesos_condiciones_alertas() from public, anon, authenticated;

-- Gancho común (los demás módulos sin cambios)
create or replace function public.alertas_condiciones_extra()
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.backups_condiciones_alertas()') is not null then perform backups_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_condiciones_alertas()') is not null then perform srv_condiciones_alertas(); end if;
  if to_regprocedure('public.unifi_condiciones_alertas()') is not null then perform unifi_condiciones_alertas(); end if;
  if to_regprocedure('public.sw_condiciones_alertas()') is not null then perform sw_condiciones_alertas(); end if;
  if to_regprocedure('public.fg_condiciones_alertas()') is not null then perform fg_condiciones_alertas(); end if;
  if to_regprocedure('public.ad_condiciones_alertas()') is not null then perform ad_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_accesos_condiciones_alertas()') is not null then perform srv_accesos_condiciones_alertas(); end if;
end $$;
revoke all on function public.alertas_condiciones_extra() from public, anon, authenticated;

do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_evaluar(boolean)') is null then return; end if;
  v_def := pg_get_functiondef('public.alertas_evaluar(boolean)'::regprocedure);
  if position('alertas_condiciones_extra' in v_def) > 0 then return; end if;
  if position('-- Abrir las nuevas' in v_def) = 0 then return; end if;
  v_def := replace(v_def, '-- Abrir las nuevas',
    E'-- Condiciones de otros módulos\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
  execute v_def;
end $$;

-- ----------------------------------------------------------
-- Permisos: se ve con la solapa Servidores; los accesos los escribe solo el agente
-- ----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['srv_accesos', 'srv_autorizados', 'srv_accesos_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''servidores''))', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
end $$;
grant select on public.srv_sesiones, public.srv_accesos_equipos to authenticated;

do $$
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  drop trigger if exists trg_auditoria on public.srv_autorizados;
  create trigger trg_auditoria after insert or update or delete on public.srv_autorizados for each row execute function public.auditar();
  drop trigger if exists trg_auditoria on public.srv_accesos_config;
  create trigger trg_auditoria after insert or update or delete on public.srv_accesos_config for each row execute function public.auditar();
end $$;
