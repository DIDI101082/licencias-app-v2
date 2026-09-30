-- ==========================================================
-- SINCRONIZACIÓN AUTOMÁTICA CON ENTRA ID + AVISOS DE ALTAS Y BAJAS (con "quién")
--   * Vercel dispara /api/entra/auto cada 15 minutos (vercel.json) con la misma clave
--     CRON_SECRET que usa la verificación diaria (se valida contra prog_config).
--   * Cada corrida trae los usuarios de Entra ID, aplica altas, cambios y bajas en Empleados
--     (lo que abre solo el checklist de alta o de baja) y registra cada movimiento.
--   * Con el permiso AuditLog.Read.All, lee los registros de auditoría de Entra para saber
--     QUIÉN creó, deshabilitó, habilitó o eliminó la cuenta. Si la cuenta viene sincronizada
--     desde el AD local (Entra Connect), busca el autor en los eventos del puente de AD.
--   * Aviso a Teams por cada alta o baja (espera hasta 40 minutos a que aparezca el "quién").
--   * Freno de seguridad: si una corrida quiere dar de baja más cuentas que el límite, no aplica
--     nada y avisa (protege contra un error de filtro o de permisos que "vacíe" Empleados).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de entra.sql, altas-bajas.sql, alertas.sql y
-- postura.sql. Se puede volver a ejecutar sin problema.
-- ==========================================================

create table if not exists public.entra_auto_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default false,
  requerir_area boolean not null default true,
  alertar boolean not null default true,
  limite_bajas int not null default 10 check (limite_bajas between 1 and 500),
  auditoria_desde timestamptz,           -- hasta dónde se leyó la auditoría de Entra
  auditoria_ok boolean,                  -- la última lectura de auditoría funcionó
  ultima_ejecucion timestamptz,
  resultado jsonb not null default '{}',
  ultimo_error text
);
alter table public.entra_auto_config add column if not exists activado timestamptz;   -- cuándo se encendió
insert into public.entra_auto_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.entra_eventos (
  id bigserial primary key,
  lote bigint not null,                  -- una corrida = un lote (para agrupar cargas masivas)
  detectado timestamptz not null default now(),
  tipo text not null check (tipo in ('alta', 'baja', 'reactivacion', 'eliminado')),
  empleado_id uuid references public.empleados(id) on delete set null,
  entra_id text,
  nombre text,
  email text,
  area text,
  actor text,                            -- quién hizo el cambio
  actor_origen text check (actor_origen in ('entra', 'ad', 'sincronizacion')),
  fecha_accion timestamptz,              -- cuándo lo hizo (según la auditoría)
  movimiento_id bigint
);
create index if not exists idx_entra_eventos_detectado on public.entra_eventos (detectado desc);
create index if not exists idx_entra_eventos_entra on public.entra_eventos (entra_id, detectado desc);
create sequence if not exists public.entra_eventos_lote_seq;

-- ----------------------------------------------------------
-- Llamadas de la tarea programada (se identifican con la clave CRON_SECRET)
-- ----------------------------------------------------------
create or replace function public.entra_auto_inicio(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c entra_auto_config;
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  select * into c from entra_auto_config where id = 1;
  if not c.activo then
    return jsonb_build_object('activo', false);
  end if;
  return jsonb_build_object(
    'activo', true,
    'requerir_area', c.requerir_area,
    'auditoria_desde', c.auditoria_desde,
    'empleados', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'entra_id', entra_id, 'nombre', nombre, 'apellido', apellido, 'email', email,
        'area', area, 'puesto', puesto, 'activo', activo)) from empleados), '[]'));
end $$;
revoke all on function public.entra_auto_inicio(text) from public, authenticated;
grant execute on function public.entra_auto_inicio(text) to anon;

create or replace function public.entra_auto_error(p_token text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  update entra_auto_config set ultima_ejecucion = now(), ultimo_error = left(p_error, 300) where id = 1;
end $$;
revoke all on function public.entra_auto_error(text, text) from public, authenticated;
grant execute on function public.entra_auto_error(text, text) to anon;

-- Completa el "quién" de los movimientos con la auditoría de Entra y, si la cuenta viene
-- del AD local, con los eventos del puente de Active Directory.
create or replace function public.entra_completar_actores(p_auditoria jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  a jsonb;
  n int := 0;
  k int;
  ev record;
  v_actor text;
begin
  for a in select * from jsonb_array_elements(coalesce(p_auditoria, '[]')) loop
    update entra_eventos e set
      actor = a->>'actor',
      actor_origen = case when (a->>'sincronizacion')::boolean then 'sincronizacion' else 'entra' end,
      fecha_accion = (a->>'fecha')::timestamptz
    where e.id = (
      select x.id from entra_eventos x
       where x.entra_id = a->>'entra_id'
         and (x.actor is null or x.actor_origen = 'sincronizacion')
         and x.actor_origen is distinct from 'ad'
         and (x.tipo = a->>'tipo' or (x.tipo = 'eliminado' and a->>'tipo' = 'baja'))
         and x.detectado between (a->>'fecha')::timestamptz - interval '1 hour' and (a->>'fecha')::timestamptz + interval '2 days'
       order by x.detectado limit 1);
    get diagnostics k = row_count;
    n := n + k;
  end loop;

  -- Cuentas sincronizadas desde el AD local: el autor real está en los eventos del DC
  if to_regclass('public.ad_eventos') is not null then
    for ev in
      select * from entra_eventos
       where actor_origen = 'sincronizacion' and detectado > now() - interval '3 days' and email is not null
    loop
      begin
        select e.actor into v_actor
          from ad_eventos e
         where e.tipo = case ev.tipo when 'alta' then 'usuario_creado' when 'baja' then 'usuario_deshabilitado'
                                     when 'eliminado' then 'usuario_eliminado' else 'usuario_habilitado' end
           and e.fecha between coalesce(ev.fecha_accion, ev.detectado) - interval '1 day' and coalesce(ev.fecha_accion, ev.detectado) + interval '1 hour'
           and e.actor is not null
           and (lower(regexp_replace(e.usuario, '^.*\\', '')) = lower(split_part(ev.email, '@', 1))
                or lower(regexp_replace(e.usuario, '^.*\\', '')) in (
                     select lower(u.sam) from ad_usuarios u where lower(u.mail) = lower(ev.email) or lower(u.upn) = lower(ev.email)))
         order by e.fecha desc limit 1;
        if v_actor is not null then
          update entra_eventos set actor = v_actor, actor_origen = 'ad' where id = ev.id;
          n := n + 1;
        end if;
      exception when others then null;
      end;
    end loop;
  end if;
  return n;
end $$;
revoke all on function public.entra_completar_actores(jsonb) from public, anon, authenticated;

-- Aplica los cambios calculados por la app y registra los movimientos
create or replace function public.entra_auto_aplicar(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c entra_auto_config;
  v_lote bigint := nextval('entra_eventos_lote_seq');
  v_bajas int;
  v_activos int;
  v_limite int;
  v_ids uuid[];
  v_id uuid;
  v_ant empleados;
  v_nuevo boolean;
  v_tipo text;
  x jsonb;
  cmp jsonb;
  n_nuevos int := 0; n_act int := 0; n_bajas int := 0; n_react int := 0;
  n_eventos int := 0; n_actores int := 0;
  v_res jsonb;
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  select * into c from entra_auto_config where id = 1;
  if not c.activo then return jsonb_build_object('omitido', 'desactivada'); end if;

  -- Freno de seguridad
  v_bajas := jsonb_array_length(coalesce(p->'desactivar', '[]'))
           + (select count(*) from jsonb_array_elements(coalesce(p->'actualizar', '[]')) u
               where u->'campos'->'activo'->>'despues' = 'false');
  select count(*) into v_activos from empleados where activo;
  v_limite := greatest(c.limite_bajas, 1);
  if v_bajas > v_limite then
    v_res := jsonb_build_object('frenado', true, 'bajas', v_bajas, 'limite', v_limite, 'activos', v_activos);
    update entra_auto_config set ultima_ejecucion = now(), resultado = v_res,
      ultimo_error = 'Frenada: quería dar de baja ' || v_bajas || ' cuentas y el límite es ' || v_limite || '. No se aplicó nada.'
    where id = 1;
    perform alertas_evaluar(true);
    return v_res;
  end if;

  -- Altas
  for x in select * from jsonb_array_elements(coalesce(p->'nuevos', '[]')) loop
    insert into empleados (nombre, apellido, email, area, puesto, entra_id, activo, origen, sincronizado)
    values (x->>'nombre', x->>'apellido', lower(x->>'email'), x->>'area', nullif(x->>'puesto', ''),
            x->>'entra_id', true, 'entra', now())
    on conflict do nothing
    returning id into v_id;
    if v_id is not null then
      n_nuevos := n_nuevos + 1;
      insert into entra_eventos (lote, tipo, empleado_id, entra_id, nombre, email, area)
      values (v_lote, 'alta', v_id, x->>'entra_id', trim(concat_ws(' ', x->>'nombre', x->>'apellido')), lower(x->>'email'), x->>'area');
    end if;
    v_id := null;
  end loop;

  -- Cambios (datos y estado habilitado/deshabilitado)
  for x in select * from jsonb_array_elements(coalesce(p->'actualizar', '[]')) loop
    cmp := x->'campos';
    select * into v_ant from empleados where id = (x->>'id')::uuid;
    if v_ant.id is null then continue; end if;
    v_nuevo := (cmp->'activo'->>'despues')::boolean;
    update empleados set
      nombre = coalesce(cmp->'nombre'->>'despues', nombre),
      apellido = coalesce(cmp->'apellido'->>'despues', apellido),
      email = coalesce(lower(cmp->'email'->>'despues'), email),
      area = coalesce(cmp->'area'->>'despues', area),
      puesto = coalesce(cmp->'puesto'->>'despues', puesto),
      entra_id = coalesce(cmp->'entra_id'->>'despues', entra_id),
      activo = coalesce(v_nuevo, activo),
      sincronizado = now()
    where id = v_ant.id;
    n_act := n_act + 1;

    v_tipo := case when v_nuevo is false and v_ant.activo then 'baja'
                   when v_nuevo is true and not v_ant.activo then 'reactivacion' end;
    if v_tipo is not null then
      if v_tipo = 'baja' then n_bajas := n_bajas + 1; else n_react := n_react + 1; end if;
      insert into entra_eventos (lote, tipo, empleado_id, entra_id, nombre, email, area)
      select v_lote, v_tipo, e.id, e.entra_id, trim(concat_ws(' ', e.nombre, e.apellido)), e.email, e.area
        from empleados e where e.id = v_ant.id;
    end if;
  end loop;

  -- Cuentas que ya no existen en Entra (eliminadas)
  select array_agg((d->>'id')::uuid) into v_ids from jsonb_array_elements(coalesce(p->'desactivar', '[]')) d;
  if v_ids is not null then
    insert into entra_eventos (lote, tipo, empleado_id, entra_id, nombre, email, area)
    select v_lote, 'eliminado', e.id, e.entra_id, trim(concat_ws(' ', e.nombre, e.apellido)), e.email, e.area
      from empleados e where e.id = any(v_ids) and e.activo;
    update empleados set activo = false, sincronizado = now() where id = any(v_ids) and activo;
    n_bajas := n_bajas + cardinality(v_ids);
  end if;

  select count(*) into n_eventos from entra_eventos where lote = v_lote;

  -- Vincular cada movimiento con su checklist de alta o baja (lo abre el disparador de Empleados)
  if n_eventos > 0 and to_regclass('public.empleados_movimientos') is not null then
    update entra_eventos ev set movimiento_id = (
      select m.id from empleados_movimientos m
       where m.empleado_id = ev.empleado_id
         and m.tipo = case when ev.tipo in ('alta', 'reactivacion') then 'alta' else 'baja' end
       order by m.creado desc limit 1)
    where ev.lote = v_lote;
  end if;

  -- El "quién"
  n_actores := entra_completar_actores(p->'auditoria');

  if n_nuevos + n_act + n_bajas > 0 then
    insert into empleados_sync (fuente, nuevos, actualizados, desactivados, usuario)
    values ('entra', n_nuevos, greatest(n_act - n_bajas - n_react, 0), n_bajas, null);
  end if;

  v_res := jsonb_build_object('nuevos', n_nuevos, 'actualizados', n_act, 'bajas', n_bajas, 'reactivaciones', n_react,
                              'movimientos', n_eventos, 'actores', n_actores, 'total_entra', p->'total',
                              'duracion_s', p->'duracion_s', 'auditoria_error', p->>'auditoria_error');
  update entra_auto_config set
    ultima_ejecucion = now(),
    resultado = v_res,
    ultimo_error = null,
    auditoria_ok = (p->>'auditoria_error') is null,
    auditoria_desde = case when (p->>'auditoria_error') is null and p->>'auditoria_hasta' is not null
                           then (p->>'auditoria_hasta')::timestamptz else auditoria_desde end
  where id = 1;

  if n_eventos + n_actores > 0 then
    perform alertas_evaluar(true);
  end if;
  return v_res;
end $$;
revoke all on function public.entra_auto_aplicar(text, jsonb) from public, authenticated;
grant execute on function public.entra_auto_aplicar(text, jsonb) to anon;

-- ----------------------------------------------------------
-- Alertas (se suman a la revisión de cada 10 minutos)
-- ----------------------------------------------------------
create or replace function public.entra_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare
  c entra_auto_config;
  v_espera interval;
begin
  select * into c from entra_auto_config where id = 1;
  if not coalesce(c.activo, false) or not coalesce(c.alertar, false) then return; end if;
  -- Si la auditoría funciona, se espera hasta 40 minutos a que aparezca el "quién"
  v_espera := case when coalesce(c.auditoria_ok, false) then interval '40 minutes' else interval '0' end;

  -- Movimientos de a uno (lotes chicos)
  insert into _cond
  select 'entra:ev:' || e.id, 'entra',
         case e.tipo when 'alta' then 'media' when 'reactivacion' then 'media' else 'alta' end,
         case e.tipo when 'alta' then 'Alta en Entra ID: ' when 'reactivacion' then 'Cuenta habilitada de nuevo en Entra ID: '
                     when 'baja' then 'Baja en Entra ID (cuenta deshabilitada): ' else 'Cuenta eliminada en Entra ID: ' end
           || coalesce(e.nombre, e.email, '?'),
         concat_ws(' · ', nullif(e.area, ''), e.email,
                   case when e.actor is null then 'autor sin identificar'
                        when e.actor_origen = 'ad' then 'por ' || e.actor || ' (AD local)'
                        when e.actor_origen = 'sincronizacion' then 'sincronizado desde el AD local'
                        else 'por ' || e.actor end,
                   to_char(coalesce(e.fecha_accion, e.detectado) at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'),
                   case when e.movimiento_id is not null then 'checklist abierto' end),
         coalesce('/empleados/movimientos/' || e.movimiento_id, '/empleados')
    from entra_eventos e
   where e.detectado > now() - interval '24 hours'
     and (e.actor_origen in ('entra', 'ad') or e.detectado < now() - v_espera)   -- si vino del AD local, espera al puente de AD
     and (select count(*) from entra_eventos l where l.lote = e.lote) <= 10
  on conflict do nothing;

  -- Cargas masivas: un solo aviso por corrida
  insert into _cond
  select 'entra:lote:' || e.lote, 'entra', 'alta',
         'Muchos cambios en Entra ID en una sola sincronización (' || count(*) || ')',
         concat_ws(' · ',
           nullif(count(*) filter (where e.tipo = 'alta'), 0) || ' altas',
           nullif(count(*) filter (where e.tipo in ('baja', 'eliminado')), 0) || ' bajas',
           nullif(count(*) filter (where e.tipo = 'reactivacion'), 0) || ' rehabilitadas',
           'revisá los checklists'),
         '/empleados/movimientos'
    from entra_eventos e
   where e.detectado > now() - interval '24 hours'
   group by e.lote
  having count(*) > 10
  on conflict do nothing;

  -- Corrida frenada por el límite de bajas
  if coalesce((c.resultado->>'frenado')::boolean, false) then
    insert into _cond values ('entra:frenado', 'entra', 'alta',
      'La sincronización con Entra ID se frenó por seguridad',
      coalesce(c.ultimo_error, '') || ' Revisá los cambios desde Empleados → Entra ID y, si son correctos, aplicalos a mano o subí el límite.',
      '/empleados')
    on conflict do nothing;
  end if;

  -- La tarea no corre
  if greatest(coalesce(c.ultima_ejecucion, '-infinity'), coalesce(c.activado, '-infinity')) < now() - interval '1 hour' then
    insert into _cond values ('entra:sin_correr', 'entra', 'media',
      'La sincronización automática con Entra ID no está corriendo',
      coalesce('Última corrida: ' || to_char(c.ultima_ejecucion at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca corrió')
        || '. Revisá CRON_SECRET en Vercel.',
      '/empleados')
    on conflict do nothing;
  elsif c.ultimo_error is not null then
    insert into _cond values ('entra:error', 'entra', 'media',
      'Error en la sincronización automática con Entra ID', c.ultimo_error, '/empleados')
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.entra_condiciones_alertas() from public, anon, authenticated;

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
  if position('entra_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.entra_condiciones_alertas()'') is not null then perform entra_condiciones_alertas(); end if;\n');
    execute v_def;
  end if;

  -- Y que la revisión de alertas llame a esa lista (si ningún módulo anterior lo hizo)
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
-- Pantalla (Empleados → Entra ID)
-- ----------------------------------------------------------
create or replace function public.entra_auto_estado() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c entra_auto_config;
begin
  if not puede_ver('empleados') then raise exception 'Sin acceso'; end if;
  select * into c from entra_auto_config where id = 1;
  return jsonb_build_object(
    'activo', c.activo, 'requerir_area', c.requerir_area, 'alertar', c.alertar, 'limite_bajas', c.limite_bajas,
    'auditoria_ok', c.auditoria_ok, 'ultima_ejecucion', c.ultima_ejecucion, 'resultado', c.resultado,
    'ultimo_error', c.ultimo_error,
    'clave_configurada', (select token_hash is not null from prog_config where id = 1),
    'alertas_teams', (select activo and teams_webhook is not null from alertas_config where id = 1),
    'eventos', coalesce((select jsonb_agg(to_jsonb(e) order by e.detectado desc)
                           from (select id, detectado, tipo, nombre, email, area, actor, actor_origen, fecha_accion, movimiento_id
                                   from entra_eventos order by detectado desc limit 30) e), '[]'));
end $$;
revoke all on function public.entra_auto_estado() from public, anon;
grant execute on function public.entra_auto_estado() to authenticated;

create or replace function public.entra_auto_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede cambiar la sincronización automática';
  end if;
  update entra_auto_config set
    activo = coalesce((p->>'activo')::boolean, activo),
    requerir_area = coalesce((p->>'requerir_area')::boolean, requerir_area),
    alertar = coalesce((p->>'alertar')::boolean, alertar),
    limite_bajas = coalesce((p->>'limite_bajas')::int, limite_bajas),
    -- al activarla, la auditoría arranca desde ahora (no avisa cambios viejos)
    auditoria_desde = case when (p->>'activo')::boolean and not activo then now() - interval '1 hour' else auditoria_desde end,
    ultimo_error = case when (p->>'activo')::boolean and not activo then null else ultimo_error end,
    resultado = case when (p->>'activo')::boolean and not activo then '{}'::jsonb else resultado end,
    activado = case when (p->>'activo')::boolean and not activo then now() else activado end
  where id = 1;
end $$;
revoke all on function public.entra_auto_guardar(jsonb) from public, anon;
grant execute on function public.entra_auto_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Permisos: se leen solo con las funciones de arriba; se escriben solo desde la tarea
-- ----------------------------------------------------------
alter table public.entra_auto_config enable row level security;
alter table public.entra_eventos enable row level security;
revoke all on public.entra_auto_config from anon, authenticated;
revoke insert, update, delete on public.entra_eventos from anon, authenticated;

drop policy if exists entra_eventos_select on public.entra_eventos;
create policy entra_eventos_select on public.entra_eventos for select to authenticated using (puede_ver('empleados'));

-- Registro en Logs de los cambios de configuración
do $$
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  drop trigger if exists trg_auditoria on public.entra_auto_config;
  create trigger trg_auditoria after update on public.entra_auto_config
    for each row when (old.activo is distinct from new.activo or old.alertar is distinct from new.alertar
                       or old.requerir_area is distinct from new.requerir_area or old.limite_bajas is distinct from new.limite_bajas)
    execute function public.auditar();
end $$;
