-- ==========================================================
-- Red → FortiGate → Inicios de sesión
--   * El puente (versión 1.5 o posterior) lee del log de eventos de cada FortiGate los inicios de sesión de
--     administración (GUI, SSH, consola), los intentos fallidos y los cierres, y los envía a la app.
--   * Alertas (si las del FortiGate están activadas): avisa cada inicio de sesión y los intentos fallidos repetidos.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de fortigate.sql. Se puede repetir.
-- ==========================================================

create table if not exists public.fg_admin_logins (
  id bigserial primary key,
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  fecha timestamptz not null,
  tipo text not null check (tipo in ('inicio', 'fallo', 'cierre')),
  usuario text not null default '',
  ip text not null default '',
  via text,                    -- https, ssh, console, jsconsole...
  motivo text,
  unique (equipo, fecha, tipo, usuario, ip)
);
create index if not exists idx_fg_admin_logins_fecha on public.fg_admin_logins(fecha desc);

alter table public.fg_config add column if not exists alertar_logins boolean not null default true;

-- ----------------------------------------------------------
-- Lo llama el puente (mismo token y mismos datos que fg_reportar)
-- ----------------------------------------------------------
create or replace function public.fg_reportar_logins(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_hash text; e jsonb; n int := 0; k int;
begin
  select token_hash into v_hash from fg_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de FortiGate inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'equipos'), '') <> 'array' then raise exception 'Datos inválidos'; end if;

  for e in select * from jsonb_array_elements(p_datos -> 'equipos') loop
    if jsonb_typeof(e -> 'admin_logins') <> 'array' or not exists (select 1 from fg_equipos where nombre = e ->> 'nombre') then continue; end if;
    insert into fg_admin_logins (equipo, fecha, tipo, usuario, ip, via, motivo)
    select e ->> 'nombre', coalesce(fg_ts(x -> 'fecha'), fg_ts(to_jsonb(x ->> 'fecha_txt')), now()),
           case when x ->> 'tipo' in ('inicio', 'fallo', 'cierre') then x ->> 'tipo' else 'inicio' end,
           coalesce(left(x ->> 'usuario', 100), ''), coalesce(left(x ->> 'ip', 60), ''), left(x ->> 'via', 60), left(x ->> 'motivo', 200)
      from jsonb_array_elements(e -> 'admin_logins') x
    on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end loop;

  delete from fg_admin_logins where fecha < now() - interval '180 days';
  return jsonb_build_object('ok', true, 'nuevos', n);
end $$;
revoke all on function public.fg_reportar_logins(text, jsonb) from public;
grant execute on function public.fg_reportar_logins(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Configuración: avisar cada inicio de sesión
-- ----------------------------------------------------------
create or replace function public.fg_logins_config()
returns boolean language sql stable security definer set search_path = public as $$
  select case when puede_ver('red') then alertar_logins end from fg_config where id = 1
$$;
revoke execute on function public.fg_logins_config() from public, anon;
grant execute on function public.fg_logins_config() to authenticated;

create or replace function public.fg_logins_config_guardar(p_alertar boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update fg_config set alertar_logins = coalesce(p_alertar, alertar_logins) where id = 1;
end $$;
revoke execute on function public.fg_logins_config_guardar(boolean) from public, anon;
grant execute on function public.fg_logins_config_guardar(boolean) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.fg_logins_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c fg_config;
begin
  select * into c from fg_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  -- Cada inicio de sesión de administración (queda abierta 2 horas)
  if c.alertar_logins then
    insert into _cond select 'fg:login:' || id, 'fortigate', 'media', 'Inicio de sesión en el FortiGate ' || equipo || ': ' || coalesce(nullif(usuario, ''), '(sin usuario)'),
           to_char(fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') || coalesce(' · desde ' || nullif(ip, ''), '') || coalesce(' · por ' || nullif(via, ''), ''),
           '/red/fortigate?vista=accesos'
      from fg_admin_logins where tipo = 'inicio' and fecha > now() - interval '2 hours'
    on conflict do nothing;
  end if;

  -- Intentos fallidos repetidos de entrar a la administración (última hora, por IP)
  insert into _cond select 'fg:loginfallo:' || equipo || ':' || ip, 'fortigate', 'alta', 'Intentos fallidos de administración en el FortiGate ' || equipo,
         count(*) || ' intentos en la última hora desde ' || coalesce(nullif(ip, ''), 'origen desconocido')
           || coalesce(' · usuarios: ' || left(string_agg(distinct nullif(usuario, ''), ', '), 120), ''), '/red/fortigate?vista=accesos'
    from fg_admin_logins where tipo = 'fallo' and fecha > now() - interval '1 hour' group by equipo, ip having count(*) >= least(c.umbral_fallos, 5)
  on conflict do nothing;
end $$;
revoke all on function public.fg_logins_condiciones_alertas() from public, anon, authenticated;

-- Engancha las condiciones en la lista de "otros módulos" sin pisar lo que ya existe
do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_condiciones_extra()') is null then return; end if;
  v_def := pg_get_functiondef('public.alertas_condiciones_extra()'::regprocedure);
  if position('fg_logins_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.fg_logins_condiciones_alertas()'') is not null then perform fg_logins_condiciones_alertas(); end if;\n');
    execute v_def;
  end if;
end $$;

-- Permisos: se ve con la solapa Red; los datos los escribe solo el puente
alter table public.fg_admin_logins enable row level security;
drop policy if exists fg_admin_logins_select on public.fg_admin_logins;
create policy fg_admin_logins_select on public.fg_admin_logins for select to authenticated using (puede_ver('red'));
revoke insert, update, delete on public.fg_admin_logins from anon, authenticated;
