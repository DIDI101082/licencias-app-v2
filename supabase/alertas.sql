-- ==========================================================
-- ALERTAS AUTOMÁTICAS A MICROSOFT TEAMS
--   * La base revisa cada 10 minutos: equipos de red caídos (PRTG), puente de PRTG
--     sin reportar, detecciones de ESET (y de Defender si lo hubiera), equipos fuera del país, equipos que dejaron
--     de reportar, discos sin cifrar, sin parches, sin antivirus, software prohibido
--     y equipos nuevos esperando aprobación.
--   * Cada problema se avisa UNA sola vez; cuando se soluciona se cierra solo.
--   * Resumen semanal los lunes a las 9:00 (hora de Argentina).
--   * La dirección del webhook de Teams es secreta: nunca se muestra en la app ni en Logs.
-- Requiere las extensiones "http" (ya activa por geo.sql) y "pg_cron".
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de ingresos.sql (antes que altas-bajas.sql,
-- vencimientos.sql, vulnerabilidades.sql y revision-accesos.sql).
-- ==========================================================

create extension if not exists http with schema extensions;

create table if not exists public.alertas_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default false,
  teams_webhook text,
  url_app text,
  reglas text[] not null default array['prtg_caido', 'puente_caido', 'amenaza', 'fuera_pais', 'sin_reportar',
                                       'sin_cifrar', 'sin_parches', 'antivirus', 'software_prohibido', 'equipo_pendiente',
                                       'vulnerabilidad', 'vencimiento', 'baja_pendiente', 'revision_accesos'],
  dias_sin_reportar int not null default 3 check (dias_sin_reportar between 1 and 90),
  dias_sin_parches int not null default 30 check (dias_sin_parches between 7 and 365),
  minutos_puente int not null default 20 check (minutos_puente between 5 and 240),
  resumen_semanal boolean not null default true,
  ultima_evaluacion timestamptz,
  ultimo_envio timestamptz,
  ultimo_error text
);
insert into public.alertas_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.alertas (
  id bigserial primary key,
  clave text not null,                 -- identifica el problema (ej. "prtg:2045") para no repetir avisos
  regla text not null,
  severidad text not null check (severidad in ('critica', 'alta', 'media', 'info')),
  titulo text not null,
  detalle text,
  enlace text,
  abierta timestamptz not null default now(),
  ultima_vez timestamptz not null default now(),
  resuelta timestamptz,
  enviada timestamptz,                 -- cuándo salió el aviso a Teams
  aviso_resuelta timestamptz,          -- cuándo salió el aviso de "resuelto" (solo red)
  envio_error text
);
create unique index if not exists uq_alertas_abierta on public.alertas(clave) where resuelta is null;
create index if not exists idx_alertas_abierta on public.alertas(abierta desc);

-- ----------------------------------------------------------
-- Envío a Teams (tarjeta adaptable; sirve para Workflows y para webhooks clásicos)
-- ----------------------------------------------------------
create or replace function public.alertas_teams(p_titulo text, p_lineas text[], p_enlace text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  c alertas_config;
  v_body jsonb := '[]'::jsonb;
  v_linea text;
  v_card jsonb;
  r record;
begin
  select * into c from alertas_config where id = 1;
  if c.teams_webhook is null then
    return 'Falta configurar el webhook de Teams';
  end if;

  v_body := v_body || jsonb_build_object('type', 'TextBlock', 'size', 'Medium', 'weight', 'Bolder', 'wrap', true,
                                         'text', p_titulo);
  foreach v_linea in array coalesce(p_lineas, '{}') loop
    v_body := v_body || jsonb_build_object('type', 'TextBlock', 'wrap', true, 'spacing', 'Small', 'text', v_linea);
  end loop;

  v_card := jsonb_build_object(
    'type', 'message',
    'attachments', jsonb_build_array(jsonb_build_object(
      'contentType', 'application/vnd.microsoft.card.adaptive',
      'contentUrl', null,
      'content', jsonb_build_object(
        '$schema', 'http://adaptivecards.io/schemas/adaptive-card.json',
        'type', 'AdaptiveCard', 'version', '1.4',
        'msteams', jsonb_build_object('width', 'Full'),
        'body', v_body,
        'actions', case when coalesce(c.url_app, '') ~ '^https://'
                        then jsonb_build_array(jsonb_build_object('type', 'Action.OpenUrl', 'title', 'Abrir Accusys Cyber',
                               'url', rtrim(c.url_app, '/') || coalesce(p_enlace, '/auditoria/alertas')))
                        else '[]'::jsonb end))));

  begin
    begin
      perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');
    exception when others then null;
    end;
    select * into r from http_post(c.teams_webhook, v_card::text, 'application/json');
    if r.status between 200 and 299 then
      update alertas_config set ultimo_envio = now(), ultimo_error = null where id = 1;
      return null;
    end if;
    update alertas_config set ultimo_error = 'Teams respondió ' || r.status || ': ' || left(coalesce(r.content, ''), 200) where id = 1;
    return 'Teams respondió ' || r.status;
  exception when others then
    update alertas_config set ultimo_error = left(sqlerrm, 300) where id = 1;
    return left(sqlerrm, 300);
  end;
end $$;
revoke all on function public.alertas_teams(text, text[], text) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Evaluación: detecta problemas, abre/cierra alertas y avisa las nuevas
-- ----------------------------------------------------------
create or replace function public.alertas_evaluar(p_enviar boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c alertas_config;
  v_paises text[];
  v_prtg_fresco boolean := false;
  v_nuevas int := 0;
  v_resueltas int := 0;
  v_lineas text[] := '{}';
  v_error text;
  v_icono jsonb := '{"critica": "🔴", "alta": "🟠", "media": "🟡", "info": "🔵"}';
  v_total int;
  r record;
begin
  select * into c from alertas_config where id = 1;
  select coalesce(geo_paises_permitidos, array['AR']) into v_paises from inv_agente_config where id = 1;
  v_paises := coalesce(v_paises, array['AR']);

  drop table if exists _cond;
  create temp table _cond (
    clave text primary key, regla text, severidad text, titulo text, detalle text, enlace text
  ) on commit drop;

  -- Red (PRTG): solo si la foto es reciente; si el puente está caído, lo avisa su propia regla
  select coalesce(actualizado > now() - make_interval(mins => c.minutos_puente), false)
    into v_prtg_fresco from red_prtg_estado where id = 1;
  v_prtg_fresco := coalesce(v_prtg_fresco, false);

  if 'prtg_caido' = any(c.reglas) and v_prtg_fresco then
    insert into _cond
    select 'prtg:' || (d->>'objid'), 'prtg_caido', 'critica',
           'Equipo de red caído: ' || coalesce(d->>'nombre', '?'),
           concat_ws(' · ', nullif(d->>'grupo', ''), nullif(d->>'host', '')), '/red'
      from red_prtg_estado e,
           jsonb_array_elements(case when jsonb_typeof(e.datos->'dispositivos') = 'array' then e.datos->'dispositivos' else '[]'::jsonb end) d
     where e.id = 1 and d->>'estado' = 'caido'
    on conflict do nothing;
  end if;

  if 'puente_caido' = any(c.reglas) then
    insert into _cond
    select 'puente', 'puente_caido', 'alta', 'El puente de PRTG dejó de reportar',
           case when e.actualizado is null then 'Nunca envió datos'
                else 'Último dato: ' || to_char(e.actualizado at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') end,
           '/red'
      from red_puente_config pc join red_prtg_estado e on e.id = 1
     where pc.id = 1 and pc.token_hash is not null and not v_prtg_fresco
    on conflict do nothing;
  end if;

  if 'amenaza' = any(c.reglas) then
    insert into _cond
    select 'amenaza:' || a.id, 'amenaza', case when coalesce(a.severidad, 0) >= 4 then 'critica' else 'alta' end,
           'Amenaza en ' || coalesce(d.hostname, '?') || ': ' || coalesce(a.nombre, 'sin nombre'),
           concat_ws(' · ', nullif(a.usuario, ''), case when a.ejecutada then 'llegó a ejecutarse' end,
                     'detectada ' || to_char(a.detectada at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
           '/inventario/riesgos'
      from inv_amenazas a join inv_dispositivos d on d.id = a.dispositivo_id
     where not a.revisada and a.detectada > now() - interval '30 days'
    on conflict do nothing;
  end if;

  -- Detecciones de ESET (antivirus principal): las no resueltas ni revisadas de los últimos 30 días
  if 'amenaza' = any(c.reglas) and to_regclass('public.eset_detecciones') is not null then
    insert into _cond
    select 'eset:' || e.uuid, 'amenaza',
           case e.severidad when 'HIGH' then 'critica' when 'MEDIUM' then 'alta' else 'media' end,
           'ESET en ' || coalesce(e.equipo_nombre, '?') || ': ' || coalesce(e.nombre, e.tipo, 'detección'),
           concat_ws(' · ', initcap(replace(lower(e.categoria), '_', ' ')), nullif(e.usuario, ''), left(nullif(e.objeto, ''), 120),
                     'detectada ' || to_char(e.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
           '/inventario/riesgos?vista=eset'
      from eset_detecciones e
     where not e.resuelta and not e.revisada and e.fecha > now() - interval '30 days'
       and coalesce(e.severidad, '') not in ('DIAGNOSTIC', 'INFORMATIONAL')
    on conflict do nothing;
  end if;

  if 'fuera_pais' = any(c.reglas) then
    insert into _cond
    select 'pais:' || d.id || ':' || d.geo_pais_codigo, 'fuera_pais', 'alta',
           coalesce(d.hostname, '?') || ' se conecta desde ' || coalesce(d.geo_pais, d.geo_pais_codigo),
           concat_ws(' · ', nullif(d.usuario, ''), nullif(d.geo_ciudad, ''), nullif(d.geo_isp, ''),
                     case when d.geo_es_proxy then 'VPN o proxy' end),
           '/inventario/ubicacion'
      from inv_dispositivos d
     where d.estado_registro = 'aprobado' and d.geo_pais_codigo is not null
       and not (d.geo_pais_codigo = any(v_paises))
       and d.ultimo_reporte > now() - interval '1 day'
    on conflict do nothing;
  end if;

  if 'sin_reportar' = any(c.reglas) then
    insert into _cond
    select 'sinreporte:' || d.id, 'sin_reportar', 'media',
           coalesce(d.hostname, '?') || ' no reporta hace ' || (current_date - d.ultimo_reporte::date) || ' días',
           concat_ws(' · ', nullif(d.usuario, ''), 'último reporte ' || to_char(d.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')),
           '/inventario/monitoreo'
      from inv_dispositivos d
     where d.estado_registro = 'aprobado' and d.ultimo_reporte < now() - make_interval(days => c.dias_sin_reportar)
    on conflict do nothing;
  end if;

  if 'sin_cifrar' = any(c.reglas) then
    insert into _cond
    select 'cifrado:' || d.id, 'sin_cifrar', 'alta', coalesce(d.hostname, '?') || ': disco sin cifrar',
           concat_ws(' · ', nullif(d.usuario, ''), coalesce(d.cifrado_producto, 'BitLocker'),
                     replace(coalesce(d.cifrado_estado, d.bitlocker_estado), '_', ' ')),
           '/inventario/seguridad'
      from inv_dispositivos d
     where d.estado_registro = 'aprobado' and d.seguridad_actualizado is not null
       and case when d.cifrado_producto ~* 'luks' then d.cifrado_estado = 'sin_cifrar'
                when d.cifrado_producto is not null then d.cifrado_estado in ('sin_cifrar', 'error')
                else d.bitlocker_estado in ('sin_cifrar', 'suspendido', 'descifrando') end
    on conflict do nothing;
  end if;

  if 'sin_parches' = any(c.reglas) then
    insert into _cond
    select 'parches:' || d.id, 'sin_parches', 'media',
           coalesce(d.hostname, '?') || ' sin parches hace ' || (current_date - d.ultimo_parche::date) || ' días',
           concat_ws(' · ', nullif(d.usuario, ''), nullif(d.ultimo_parche_titulo, '')),
           '/inventario/seguridad'
      from inv_dispositivos d
     where d.estado_registro = 'aprobado' and d.so_nombre ilike '%windows%'
       and d.ultimo_parche < now() - make_interval(days => c.dias_sin_parches)
    on conflict do nothing;
  end if;

  if 'antivirus' = any(c.reglas) then
    insert into _cond
    select 'antivirus:' || d.id, 'antivirus', 'alta', coalesce(d.hostname, '?') || ' sin antivirus activo',
           nullif(d.usuario, ''), '/inventario/seguridad'
      from inv_dispositivos d
     where d.estado_registro = 'aprobado' and d.so_nombre ilike '%windows%' and d.seguridad_actualizado is not null
       and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(d.av_productos) = 'array' then d.av_productos else '[]'::jsonb end) p
                        where (p->>'activo')::boolean)
    on conflict do nothing;
  end if;

  if 'software_prohibido' = any(c.reglas) then
    insert into _cond
    select 'soft:' || s.dispositivo_id || ':' || s.aplicacion, 'software_prohibido', 'media',
           coalesce(s.hostname, '?') || ' tiene ' || s.aplicacion,
           concat_ws(' · ', nullif(s.usuario, ''), nullif(s.motivo, '')), '/inventario/riesgos'
      from inv_v_software_prohibido s
    on conflict do nothing;
  end if;

  if 'equipo_pendiente' = any(c.reglas) then
    insert into _cond
    select 'pendiente:' || d.id, 'equipo_pendiente', 'info',
           'Equipo nuevo esperando aprobación: ' || coalesce(d.hostname, '?'),
           concat_ws(' · ', nullif(d.usuario, ''), nullif(d.ip_publica, '')), '/inventario/monitoreo'
      from inv_dispositivos d
     where d.estado_registro = 'pendiente'
    on conflict do nothing;
  end if;

  -- Las reglas siguientes dependen de módulos opcionales: si su tabla no existe todavía, se saltean
  if 'vulnerabilidad' = any(c.reglas) and to_regclass('public.vuln_consultas') is not null then
    insert into _cond
    select 'vuln:' || e.cpe || ':' || e.version, 'vulnerabilidad', 'alta',
           case when position(e.version in min(e.aplicacion)) > 0 then min(e.aplicacion) else min(e.aplicacion) || ' ' || e.version end
             || ': ' || max(e.kev) || ' vulnerabilidad' || case when max(e.kev) > 1 then 'es' else '' end
             || ' explotada' || case when max(e.kev) > 1 then 's' else '' end || ' activamente',
           count(distinct e.dispositivo_id) || ' equipo' || case when count(distinct e.dispositivo_id) > 1 then 's' else '' end
             || ': ' || left(string_agg(distinct e.hostname, ', '), 200),
           '/inventario/vulnerabilidades'
      from vuln_v_equipos e
     where e.kev > 0
     group by e.cpe, e.version
    on conflict do nothing;
  end if;

  if 'vencimiento' = any(c.reglas) and to_regclass('public.vencimientos_v') is not null then
    insert into _cond
    select 'venc:' || v.origen || ':' || v.ref || ':' || v.fecha_vencimiento,
           'vencimiento', case when v.fecha_vencimiento < current_date then 'alta' else 'media' end,
           case when v.fecha_vencimiento < current_date then 'Venció: ' else 'Vence pronto: ' end || v.descripcion,
           concat_ws(' · ', case v.tipo when 'licencia' then 'Licencia' when 'garantia' then 'Garantía' when 'certificado' then 'Certificado SSL'
                                        when 'dominio' then 'Dominio' when 'secreto' then 'Secreto' when 'contrato' then 'Contrato' else 'Otro' end,
                     to_char(v.fecha_vencimiento, 'DD/MM/YYYY'), nullif(v.responsable, '')),
           '/vencimientos'
      from vencimientos_v v
     where v.fecha_vencimiento is not null
       and v.fecha_vencimiento <= current_date + v.aviso_dias
       and v.fecha_vencimiento >= current_date - 30        -- lo vencido hace mucho ya no se reitera
    on conflict do nothing;
  end if;

  if 'baja_pendiente' = any(c.reglas) and to_regclass('public.empleados_v_movimientos') is not null then
    insert into _cond
    select 'baja:' || m.id, 'baja_pendiente', 'alta',
           'Baja sin cerrar: ' || trim(concat_ws(' ', m.nombre, m.apellido)),
           concat_ws(' · ', 'hace ' || (current_date - m.fecha) || ' días',
                     case when m.equipos_asignados > 0 then m.equipos_asignados || ' equipo(s) sin devolver' end,
                     case when m.licencias_activas > 0 then m.licencias_activas || ' licencia(s) sin liberar' end,
                     (m.tareas - m.hechas) || ' tarea(s) pendientes'),
           '/empleados/movimientos/' || m.id
      from empleados_v_movimientos m
     where m.tipo = 'baja' and m.estado = 'abierto' and m.fecha <= current_date - 7
    on conflict do nothing;
  end if;

  if 'revision_accesos' = any(c.reglas) and to_regclass('public.revision_campanas') is not null then
    insert into _cond
    select 'revision:' || coalesce((select max(id) from revision_campanas), 0), 'revision_accesos', 'info',
           case when exists (select 1 from revision_campanas where estado = 'abierta' and vence < current_date)
                then 'La revisión de accesos está vencida'
                else 'Toca la revisión trimestral de accesos' end,
           coalesce('Última cerrada: ' || to_char((select max(cerrada) from revision_campanas) at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'),
                    'Nunca se hizo una revisión'),
           '/auditoria/revision'
     where exists (select 1 from revision_campanas where estado = 'abierta' and vence < current_date)
        or (not exists (select 1 from revision_campanas where estado = 'abierta')
            and coalesce((select max(cerrada) from revision_campanas), '-infinity') < now() - interval '90 days')
    on conflict do nothing;
  end if;

  -- Abrir las nuevas
  insert into alertas (clave, regla, severidad, titulo, detalle, enlace)
  select k.clave, k.regla, k.severidad, k.titulo, k.detalle, k.enlace
    from _cond k
   where not exists (select 1 from alertas a where a.clave = k.clave and a.resuelta is null);
  get diagnostics v_nuevas = row_count;

  -- Actualizar las que siguen (el texto puede cambiar: "hace 5 días" → "hace 6 días")
  update alertas a set ultima_vez = now(), titulo = k.titulo, detalle = k.detalle, severidad = k.severidad
    from _cond k
   where a.clave = k.clave and a.resuelta is null;

  -- Cerrar las que ya no están (si PRTG no mandó datos, las de red se mantienen)
  update alertas a set resuelta = now()
   where a.resuelta is null
     and not exists (select 1 from _cond k where k.clave = a.clave)
     and not (a.regla = 'prtg_caido' and not v_prtg_fresco and 'prtg_caido' = any(c.reglas));
  get diagnostics v_resueltas = row_count;

  -- Historial acotado a 1 año
  delete from alertas where resuelta < now() - interval '365 days';

  update alertas_config set ultima_evaluacion = now() where id = 1;

  -- Aviso a Teams: una sola tarjeta con todo lo nuevo (y lo que se recuperó en la red)
  if p_enviar and c.activo and c.teams_webhook is not null then
    select count(*) into v_total from alertas where resuelta is null and enviada is null;
    for r in
      select id, severidad, titulo, detalle from alertas
       where resuelta is null and enviada is null
       order by case severidad when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, abierta
       limit 25
    loop
      v_lineas := v_lineas || (coalesce(v_icono->>r.severidad, '•') || ' **' || r.titulo || '**'
                               || coalesce(' — ' || nullif(r.detalle, ''), ''));
    end loop;
    if v_total > 25 then
      v_lineas := v_lineas || ('…y ' || (v_total - 25) || ' más. Mirá el detalle en la app.');
    end if;
    for r in
      select titulo from alertas
       where regla in ('prtg_caido', 'puente_caido') and resuelta is not null and enviada is not null and aviso_resuelta is null
       order by resuelta limit 25
    loop
      v_lineas := v_lineas || ('✅ Resuelto: ' || r.titulo);
    end loop;

    if cardinality(v_lineas) > 0 then
      v_error := alertas_teams(
        case when v_total = 0 then 'Accusys Cyber · Problemas resueltos'
             when v_total = 1 then 'Accusys Cyber · 1 alerta nueva'
             else 'Accusys Cyber · ' || v_total || ' alertas nuevas' end,
        v_lineas,
        case when v_total > 0 then (select enlace from alertas where resuelta is null and enviada is null
                                     order by case severidad when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, abierta limit 1)
        end);
      if v_error is null then
        update alertas set enviada = now(), envio_error = null where resuelta is null and enviada is null;
        update alertas set aviso_resuelta = now()
         where regla in ('prtg_caido', 'puente_caido') and resuelta is not null and enviada is not null and aviso_resuelta is null;
      else
        update alertas set envio_error = v_error where resuelta is null and enviada is null;
      end if;
    end if;
  end if;

  return jsonb_build_object('nuevas', v_nuevas, 'resueltas', v_resueltas,
                            'abiertas', (select count(*) from alertas where resuelta is null),
                            'error_envio', v_error);
end $$;
revoke all on function public.alertas_evaluar(boolean) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Resumen semanal
-- ----------------------------------------------------------
create or replace function public.alertas_resumen(p_forzar boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare
  c alertas_config;
  v_lineas text[] := '{}';
  v_nombres jsonb := '{"prtg_caido": "Equipos de red caídos", "puente_caido": "Puente de PRTG sin reportar",
    "amenaza": "Amenazas sin revisar", "fuera_pais": "Equipos fuera del país", "sin_reportar": "Equipos que no reportan",
    "sin_cifrar": "Discos sin cifrar", "sin_parches": "Equipos sin parches", "antivirus": "Sin antivirus activo",
    "software_prohibido": "Software prohibido", "equipo_pendiente": "Equipos esperando aprobación",
    "vulnerabilidad": "Apps con vulnerabilidades explotadas", "vencimiento": "Vencimientos próximos o vencidos",
    "baja_pendiente": "Bajas de empleados sin cerrar", "revision_accesos": "Revisión de accesos pendiente"}';
  r record;
  n int;
begin
  select * into c from alertas_config where id = 1;
  if not p_forzar and not (c.activo and c.resumen_semanal) then
    return 'Resumen semanal desactivado';
  end if;

  select count(*) into n from inv_dispositivos where estado_registro = 'aprobado';
  v_lineas := v_lineas || ('**Equipos con agente:** ' || n || ' (reportaron en las últimas 24 h: '
    || (select count(*) from inv_dispositivos where estado_registro = 'aprobado' and ultimo_reporte > now() - interval '1 day') || ')');
  v_lineas := v_lineas || ('**Alertas de la semana:** ' || (select count(*) from alertas where abierta > now() - interval '7 days')
    || ' nuevas · ' || (select count(*) from alertas where resuelta > now() - interval '7 days') || ' resueltas');
  begin
    v_lineas := v_lineas || ('**Caídas de red en la semana:** '
      || (select count(*) from red_prtg_eventos where estado_nuevo = 'caido' and fecha > now() - interval '7 days'));
  exception when others then null;
  end;

  v_lineas := v_lineas || '**Pendientes hoy:**'::text;
  n := 0;
  for r in
    select regla, count(*) cant from alertas where resuelta is null group by regla
     order by min(case severidad when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end), count(*) desc
  loop
    v_lineas := v_lineas || ('• ' || coalesce(v_nombres->>r.regla, r.regla) || ': ' || r.cant);
    n := n + 1;
  end loop;
  if n = 0 then
    v_lineas := v_lineas || '• Nada pendiente 🎉'::text;
  end if;

  return coalesce(alertas_teams('Accusys Cyber · Resumen semanal', v_lineas, '/auditoria/alertas'), 'Enviado');
end $$;
revoke all on function public.alertas_resumen(boolean) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Funciones para la pantalla (solo administradores configuran)
-- ----------------------------------------------------------
create or replace function public.alertas_registrar_cambio(p_desc text, p_cambios jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select nombre, email into p from perfiles where id = auth.uid();
  insert into auditoria (usuario_id, usuario_email, usuario_nombre, ip, tabla, accion, registro_id, descripcion, cambios)
  values (auth.uid(), p.email, p.nombre, inv_ip_cliente(), 'alertas_config', 'modificacion', '1', p_desc, p_cambios);
exception when others then null;
end $$;
revoke all on function public.alertas_registrar_cambio(text, jsonb) from public, anon, authenticated;

create or replace function public.alertas_config_ver()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c alertas_config;
begin
  if not puede_ver('auditoria') then
    raise exception 'Sin acceso';
  end if;
  select * into c from alertas_config where id = 1;
  return jsonb_build_object(
    'activo', c.activo, 'url_app', c.url_app, 'reglas', to_jsonb(c.reglas),
    'dias_sin_reportar', c.dias_sin_reportar, 'dias_sin_parches', c.dias_sin_parches, 'minutos_puente', c.minutos_puente,
    'resumen_semanal', c.resumen_semanal, 'ultima_evaluacion', c.ultima_evaluacion, 'ultimo_envio', c.ultimo_envio,
    'ultimo_error', c.ultimo_error,
    -- solo si hay webhook y a qué servicio apunta; nunca la dirección
    'webhook', case when c.teams_webhook is null then null
                    else substring(c.teams_webhook from '^https://([^/:]+)') end,
    'es_admin', mi_rol() = 'administrador');
end $$;
grant execute on function public.alertas_config_ver() to authenticated;

create or replace function public.alertas_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_ant alertas_config;
  v_nue alertas_config;
  v_reglas text[];
  v_url text := nullif(trim(p->>'url_app'), '');
  v_validas text[] := array['prtg_caido', 'puente_caido', 'amenaza', 'fuera_pais', 'sin_reportar',
                            'sin_cifrar', 'sin_parches', 'antivirus', 'software_prohibido', 'equipo_pendiente',
                                       'vulnerabilidad', 'vencimiento', 'baja_pendiente', 'revision_accesos'];
  v_cambios jsonb := '{}';
  k text;
begin
  if mi_rol() is distinct from 'administrador' then
    raise exception 'Solo un administrador puede cambiar las alertas';
  end if;
  if v_url is not null and v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$' then
    raise exception 'La dirección de la app debe ser https://dominio';
  end if;
  select array_agg(x) into v_reglas from jsonb_array_elements_text(coalesce(p->'reglas', '[]')) x where x = any(v_validas);

  select * into v_ant from alertas_config where id = 1;
  update alertas_config set
    activo = coalesce((p->>'activo')::boolean, activo),
    url_app = coalesce(rtrim(v_url, '/'), url_app),
    reglas = coalesce(v_reglas, '{}'),
    dias_sin_reportar = coalesce((p->>'dias_sin_reportar')::int, dias_sin_reportar),
    dias_sin_parches = coalesce((p->>'dias_sin_parches')::int, dias_sin_parches),
    minutos_puente = coalesce((p->>'minutos_puente')::int, minutos_puente),
    resumen_semanal = coalesce((p->>'resumen_semanal')::boolean, resumen_semanal)
  where id = 1
  returning * into v_nue;

  for k in select unnest(array['activo', 'url_app', 'reglas', 'dias_sin_reportar', 'dias_sin_parches', 'minutos_puente', 'resumen_semanal']) loop
    if (to_jsonb(v_ant)->k) is distinct from (to_jsonb(v_nue)->k) then
      v_cambios := v_cambios || jsonb_build_object(k, jsonb_build_object('antes', to_jsonb(v_ant)->k, 'despues', to_jsonb(v_nue)->k));
    end if;
  end loop;
  if v_cambios <> '{}' then
    perform alertas_registrar_cambio('Configuración de alertas', v_cambios);
  end if;
end $$;
grant execute on function public.alertas_config_guardar(jsonb) to authenticated;

create or replace function public.alertas_webhook_guardar(p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare v_url text := nullif(trim(p_url), '');
begin
  if mi_rol() is distinct from 'administrador' then
    raise exception 'Solo un administrador puede cambiar el webhook';
  end if;
  -- Solo direcciones de Microsoft (Workflows de Teams / Power Automate o webhook clásico)
  if v_url is not null and v_url !~* '^https://[a-z0-9.-]+\.(webhook\.office\.com|logic\.azure\.com|powerplatform\.com|powerautomate\.com)(:443)?/' then
    raise exception 'La dirección no parece un webhook de Microsoft Teams';
  end if;
  update alertas_config set teams_webhook = v_url, ultimo_error = null where id = 1;
  perform alertas_registrar_cambio('Webhook de Teams',
    jsonb_build_object('teams_webhook', jsonb_build_object('antes', '(oculto)', 'despues', case when v_url is null then '(quitado)' else '(cambiado)' end)));
end $$;
grant execute on function public.alertas_webhook_guardar(text) to authenticated;

create or replace function public.alertas_probar()
returns text language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if mi_rol() is distinct from 'administrador' then
    raise exception 'Solo un administrador puede enviar la prueba';
  end if;
  select coalesce(nombre, email) n into p from perfiles where id = auth.uid();
  return coalesce(alertas_teams('Accusys Cyber · Mensaje de prueba',
    array['Si ves este mensaje, las alertas llegan bien a este canal.', 'Enviado por ' || coalesce(p.n, 'un administrador') || '.']), 'ok');
end $$;
grant execute on function public.alertas_probar() to authenticated;

create or replace function public.alertas_evaluar_ahora()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then
    raise exception 'Solo un administrador';
  end if;
  return alertas_evaluar(true);
end $$;
grant execute on function public.alertas_evaluar_ahora() to authenticated;

create or replace function public.alertas_resumen_ahora()
returns text language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then
    raise exception 'Solo un administrador';
  end if;
  return alertas_resumen(true);
end $$;
grant execute on function public.alertas_resumen_ahora() to authenticated;

-- ----------------------------------------------------------
-- Permisos: el historial lo ve quien tiene Logs; la configuración nadie directo (solo por funciones)
-- ----------------------------------------------------------
alter table public.alertas_config enable row level security;
alter table public.alertas enable row level security;
revoke all on public.alertas_config from anon, authenticated;
revoke insert, update, delete on public.alertas from anon, authenticated;

drop policy if exists alertas_select on public.alertas;
create policy alertas_select on public.alertas for select to authenticated using (puede_ver('auditoria'));

-- ----------------------------------------------------------
-- Tareas programadas (pg_cron). Si da aviso, activá "pg_cron" en
-- Database → Extensions y volvé a ejecutar SOLO este bloque.
-- ----------------------------------------------------------
do $$ begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'No se pudo activar pg_cron: activalo en Database → Extensions';
end $$;

do $$ begin
  begin perform cron.unschedule('accusys-alertas'); exception when others then null; end;
  begin perform cron.unschedule('accusys-resumen-semanal'); exception when others then null; end;
  perform cron.schedule('accusys-alertas', '*/10 * * * *', 'select public.alertas_evaluar(true)');
  -- lunes 12:00 UTC = 9:00 en Argentina
  perform cron.schedule('accusys-resumen-semanal', '0 12 * * 1', 'select public.alertas_resumen()');
exception when others then
  raise notice 'Las tareas programadas no quedaron creadas (falta pg_cron): %', sqlerrm;
end $$;
