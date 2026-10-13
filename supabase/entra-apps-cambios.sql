-- ==========================================================
-- APLICACIONES DE ENTRA ID: QUIÉN BORRA O DESHABILITA APLICACIONES
--   * La tarea de cada 15 minutos (/api/entra/auto) lee la auditoría de Entra ID (categoría
--     ApplicationManagement, solo lectura) y guarda acá cada aplicación borrada, borrada
--     definitivamente, deshabilitada, reactivada o restaurada, con quién lo hizo y desde qué IP.
--   * Entra conserva esa auditoría 30 días (7 sin licencia P1/P2): acá queda 2 años.
--   * Cada borrado o deshabilitación nuevo abre una alerta (y su aviso a Teams). La primera
--     lectura trae los últimos 30 días como historial, sin avisar.
-- Requiere en la app de Entra el permiso AuditLog.Read.All (el mismo de la sincronización de empleados).
-- Ejecutar en el SQL Editor, DESPUÉS de postura.sql, accesos.sql y alertas.sql.
-- Se puede volver a ejecutar sin problema.
-- ==========================================================

create table if not exists public.entra_apps_config (
  id int primary key default 1 check (id = 1),
  alertar boolean not null default true,
  leido_hasta timestamptz,               -- hasta dónde se leyó la auditoría
  ultima_ejecucion timestamptz,
  ultimo_error text
);
insert into public.entra_apps_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.entra_apps_cambios (
  evento_id text primary key,            -- id del registro de auditoría de Entra
  fecha timestamptz not null,
  accion text not null check (accion in ('borrada', 'borrada_definitiva', 'deshabilitada', 'reactivada', 'restaurada')),
  objeto text not null default 'empresarial' check (objeto in ('registro', 'empresarial')),
  objeto_id text,
  app_id text,
  aplicacion text not null,
  actor text,
  ip text,
  avisar boolean not null default true,  -- false: vino en la primera lectura (historial), no se avisa
  registrado timestamptz not null default now()
);
create index if not exists idx_entra_apps_cambios_fecha on public.entra_apps_cambios (fecha desc);

-- ----------------------------------------------------------
-- Tarea programada (se identifica con la clave CRON_SECRET)
-- ----------------------------------------------------------
create or replace function public.entra_apps_auto_inicio(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  return jsonb_build_object('leido_hasta', (select leido_hasta from entra_apps_config where id = 1));
end $$;
revoke all on function public.entra_apps_auto_inicio(text) from public, authenticated;
grant execute on function public.entra_apps_auto_inicio(text) to anon;

create or replace function public.entra_apps_auto_aplicar(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_primera boolean;
  v_nuevos int := 0;
  v_avisar int := 0;
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  v_primera := (select leido_hasta is null from entra_apps_config where id = 1);

  with nuevos as (
    insert into entra_apps_cambios (evento_id, fecha, accion, objeto, objeto_id, app_id, aplicacion, actor, ip, avisar)
    select x ->> 'evento_id', (x ->> 'fecha')::timestamptz, x ->> 'accion', coalesce(x ->> 'objeto', 'empresarial'),
           x ->> 'objeto_id', x ->> 'app_id', left(coalesce(x ->> 'aplicacion', 'Sin nombre'), 200),
           left(x ->> 'actor', 200), left(x ->> 'ip', 60), not v_primera
      from jsonb_array_elements(coalesce(p -> 'cambios', '[]')) x
     where coalesce(x ->> 'evento_id', '') <> ''
       and x ->> 'accion' in ('borrada', 'borrada_definitiva', 'deshabilitada', 'reactivada', 'restaurada')
    on conflict (evento_id) do nothing
    returning accion, avisar
  )
  select count(*), count(*) filter (where avisar and accion in ('borrada', 'borrada_definitiva', 'deshabilitada'))
    into v_nuevos, v_avisar from nuevos;

  update entra_apps_config
     set leido_hasta = coalesce((p ->> 'hasta')::timestamptz, now()), ultima_ejecucion = now(), ultimo_error = null
   where id = 1;
  delete from entra_apps_cambios where fecha < now() - interval '2 years';

  -- Avisar ya, sin esperar la revisión de alertas de cada 10 minutos
  if v_avisar > 0 and coalesce((select alertar from entra_apps_config where id = 1), false)
     and to_regprocedure('public.alertas_evaluar(boolean)') is not null then
    begin
      perform alertas_evaluar(true);
    exception when others then null;   -- un problema con Teams no puede frenar la lectura
    end;
  end if;
  return jsonb_build_object('nuevos', v_nuevos, 'avisos', v_avisar, 'primera', v_primera);
end $$;
revoke all on function public.entra_apps_auto_aplicar(text, jsonb) from public, authenticated;
grant execute on function public.entra_apps_auto_aplicar(text, jsonb) to anon;

create or replace function public.entra_apps_auto_error(p_token text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  update entra_apps_config set ultima_ejecucion = now(), ultimo_error = left(p_error, 300) where id = 1;
end $$;
revoke all on function public.entra_apps_auto_error(text, text) from public, authenticated;
grant execute on function public.entra_apps_auto_error(text, text) to anon;

-- ----------------------------------------------------------
-- Pantalla (Aplicaciones de Entra ID)
-- ----------------------------------------------------------
create or replace function public.entra_apps_cambios_estado() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c entra_apps_config;
begin
  if not puede_ver('seguridad') then raise exception 'Sin acceso'; end if;
  select * into c from entra_apps_config where id = 1;
  return jsonb_build_object(
    'alertar', c.alertar, 'leido_hasta', c.leido_hasta, 'ultima_ejecucion', c.ultima_ejecucion, 'ultimo_error', c.ultimo_error,
    'eventos', coalesce((select jsonb_agg(to_jsonb(e) order by e.fecha desc)
                           from (select evento_id, fecha, accion, objeto, objeto_id, app_id, aplicacion, actor, ip
                                   from entra_apps_cambios order by fecha desc limit 500) e), '[]'));
end $$;
revoke all on function public.entra_apps_cambios_estado() from public, anon;
grant execute on function public.entra_apps_cambios_estado() to authenticated;

create or replace function public.entra_apps_cambios_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede cambiar esta configuración'; end if;
  update entra_apps_config set alertar = coalesce((p ->> 'alertar')::boolean, alertar) where id = 1;
end $$;
revoke all on function public.entra_apps_cambios_guardar(jsonb) from public, anon;
grant execute on function public.entra_apps_cambios_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas: cada borrado o deshabilitación queda como alerta abierta 7 días (sale una vez a Teams)
-- ----------------------------------------------------------
create or replace function public.entra_apps_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce((select alertar from entra_apps_config where id = 1), false) then return; end if;
  insert into _cond
  select 'entra_app:' || c.evento_id, 'entra_app',
         case c.accion when 'deshabilitada' then 'media' else 'alta' end,
         case c.accion when 'deshabilitada' then 'Aplicación de Entra deshabilitada: '
                       when 'borrada_definitiva' then 'Aplicación de Entra borrada definitivamente: '
                       else 'Aplicación de Entra borrada: ' end || c.aplicacion,
         concat_ws(' · ', case c.objeto when 'registro' then 'registro de aplicación' else 'aplicación empresarial' end,
                   'por ' || coalesce(c.actor, 'desconocido'), case when c.ip is not null then 'desde ' || c.ip end,
                   to_char(c.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
         '/inventario/apps-entra'
    from entra_apps_cambios c
   where c.avisar and c.accion in ('borrada', 'borrada_definitiva', 'deshabilitada')
     and c.fecha > now() - interval '7 days'
  on conflict do nothing;
end $$;
revoke all on function public.entra_apps_condiciones_alertas() from public, anon, authenticated;

-- Engancha las condiciones en la lista de "otros módulos" sin pisar lo que ya existe
do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_condiciones_extra()') is null then
    execute $f$
      create function public.alertas_condiciones_extra()
      returns void language plpgsql security definer set search_path = public as $b$
      begin
        null;
      end $b$;
    $f$;
    revoke all on function public.alertas_condiciones_extra() from public, anon, authenticated;
  end if;

  v_def := pg_get_functiondef('public.alertas_condiciones_extra()'::regprocedure);
  if position('entra_apps_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.entra_apps_condiciones_alertas()'') is not null then perform entra_apps_condiciones_alertas(); end if;\n');
    execute v_def;
  end if;

  if to_regprocedure('public.alertas_evaluar(boolean)') is not null then
    v_def := pg_get_functiondef('public.alertas_evaluar(boolean)'::regprocedure);
    if position('alertas_condiciones_extra' in v_def) = 0 and position('-- Abrir las nuevas' in v_def) > 0 then
      v_def := replace(v_def, '-- Abrir las nuevas',
        E'-- Condiciones de otros módulos\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
      execute v_def;
    end if;
  end if;
end $$;

-- ----------------------------------------------------------
-- Permisos: se leen solo con entra_apps_cambios_estado(); se escriben solo desde la tarea
-- ----------------------------------------------------------
alter table public.entra_apps_config enable row level security;
alter table public.entra_apps_cambios enable row level security;
revoke all on public.entra_apps_config, public.entra_apps_cambios from anon, authenticated;
