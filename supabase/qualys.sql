-- ==========================================================
-- QUALYS VMDR (Endpoints → Qualys VMDR)
--   * La tarea /api/qualys/auto (cada 30 minutos) lee Qualys con un usuario de API de SOLO LECTURA
--     (rol Reader). Variables en Vercel: QUALYS_API_URL, QUALYS_USUARIO y QUALYS_CLAVE. La clave nunca
--     se guarda en la base. Solo se usan acciones de consulta: no lanza escaneos ni cambia nada en Qualys.
--   * Trae las vulnerabilidades confirmadas de severidad 3 a 5 de cada equipo. La primera carga va
--     de a páginas (puede llevar varias corridas); después solo trae los equipos que Qualys volvió a
--     procesar (escaneos nuevos), incluidas las vulnerabilidades corregidas.
--   * Completa título, CVE, CVSS, inteligencia de amenazas (explotada, ransomware…) y solución de
--     cada QID desde la base de conocimiento de Qualys.
--   * Cruza los equipos de Qualys con el inventario (agente) y los servidores por nombre o IP, y
--     muestra qué equipos no se escanean hace más de N días.
--   * Alertas (con su aviso a Teams): QID nuevo urgente o explotado activamente, equipos sin escaneo
--     y lectura caída. La carga inicial no avisa.
-- Ejecutar en el SQL Editor, DESPUÉS de postura.sql, accesos.sql, alertas.sql, inicio.sql y servidores.sql.
-- Se puede volver a ejecutar sin problema.
-- ==========================================================

create table if not exists public.qualys_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default true,
  alertar_nuevas boolean not null default true,
  alertar_cobertura boolean not null default true,
  sev_alerta int not null default 5 check (sev_alerta between 3 and 5),   -- avisar QID nuevos desde esta severidad (los explotados, siempre)
  dias_cobertura int not null default 30 check (dias_cobertura between 1 and 365),
  carga_completa boolean not null default false,  -- terminó la primera vuelta completa
  cursor_id_min bigint,                           -- próxima página de la vuelta en curso
  ciclo_inicio timestamptz,                       -- cuándo arrancó la vuelta en curso
  procesado_desde timestamptz,                    -- vm_processed_after de la vuelta en curso
  ultimo_ciclo timestamptz,                       -- cuándo terminó la última vuelta completa
  hosts_leido timestamptz,
  ultima_ejecucion timestamptz,
  ultimo_ok timestamptz,
  ultimo_error text,
  avisos jsonb not null default '[]',
  duracion_s int
);
insert into public.qualys_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.qualys_hosts (
  id bigint primary key,
  ip text,
  dns text,
  netbios text,
  os text,
  tracking text,                 -- IP, DNS, NETBIOS, AGENT…
  ultimo_escaneo timestamptz,
  ultimo_escaneo_auth timestamptz,
  nombre_corto text generated always as (lower(split_part(coalesce(nullif(netbios, ''), nullif(dns, ''), ip, ''), '.', 1))) stored,
  primera_vez timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
create index if not exists idx_qualys_hosts_nombre on public.qualys_hosts (nombre_corto);
create index if not exists idx_qualys_hosts_ip on public.qualys_hosts (ip);

create table if not exists public.qualys_detecciones (
  clave text primary key,
  host_id bigint not null references public.qualys_hosts(id) on delete cascade,
  qid int not null,
  tipo text,
  severidad int,
  puerto int,
  protocolo text,
  estado text not null,          -- New, Active, Re-Opened, Fixed
  primera timestamptz,           -- primera detección según Qualys
  ultima timestamptz,
  corregida timestamptz,
  veces int,
  qds int,
  qds_nivel text,
  deshabilitada boolean not null default false,
  ignorada boolean not null default false,
  primera_vez timestamptz not null default now(),   -- cuándo la vio esta app
  avisar boolean not null default true,              -- false: vino en la carga inicial
  actualizado timestamptz not null default now()
);
create index if not exists idx_qualys_det_host on public.qualys_detecciones (host_id);
create index if not exists idx_qualys_det_qid on public.qualys_detecciones (qid);

create table if not exists public.qualys_kb (
  qid int primary key,
  titulo text,
  categoria text,
  tipo text,
  severidad int,
  parcheable boolean,
  publicada timestamptz,
  cves text[] not null default '{}',
  cvss numeric,
  cvss3 numeric,
  amenazas text[] not null default '{}',
  solucion text,
  actualizado timestamptz not null default now()
);

-- Explotada activamente: ataques en curso o catálogo KEV de CISA (según la inteligencia de Qualys)
create or replace function public.qualys_explotada(a text[]) returns boolean
language sql immutable as $$
  select exists (select 1 from unnest(coalesce(a, '{}')) x where x ~* '^(active_attacks|cisa|.*known_exploited|wormable)')
$$;
create or replace function public.qualys_ransomware(a text[]) returns boolean
language sql immutable as $$ select exists (select 1 from unnest(coalesce(a, '{}')) x where x ~* 'ransomware') $$;

-- Detección abierta (la que cuenta)
create or replace function public.qualys_abierta(d qualys_detecciones) returns boolean
language sql immutable as $$ select d.estado <> 'Fixed' and not d.deshabilitada and not d.ignorada $$;

-- ----------------------------------------------------------
-- Equipos de Qualys ↔ inventario (agente) y servidores, por nombre corto o IP
-- ----------------------------------------------------------
create or replace view public.qualys_v_equipos with (security_invoker = true) as
with inv as (
  select d.id::text as inv_id, 'agente' as origen, d.hostname as nombre, lower(split_part(d.hostname, '.', 1)) as corto, d.ip,
         coalesce(d.tipo, case when d.so_nombre ilike '%server%' or d.so_nombre ilike '%linux%' then 'servidor' end) as tipo,
         d.usuario as persona, null::text as area, d.ultimo_reporte
    from inv_dispositivos d
   where d.estado_registro = 'aprobado'
  union all
  select 'srv:' || s.id, 'servidor', s.nombre, lower(split_part(s.nombre, '.', 1)), null, 'servidor', s.responsable, s.sede, null
    from srv_servidores s
   where s.activo and s.dispositivo_id is null
)
select h.*, i.inv_id, i.origen, i.nombre as inv_nombre, i.tipo as inv_tipo, i.persona, i.area
  from qualys_hosts h
  left join lateral (
    select * from inv
     where (h.nombre_corto <> '' and inv.corto = h.nombre_corto) or (h.ip is not null and inv.ip = h.ip)
     order by (inv.corto = h.nombre_corto) desc, inv.ultimo_reporte desc nulls last
     limit 1) i on true;

-- ----------------------------------------------------------
-- Tarea programada (se identifica con la clave CRON_SECRET)
-- ----------------------------------------------------------
create or replace function public.qualys_auto_inicio(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  return (select jsonb_build_object(
    'activo', activo, 'cursor_id_min', cursor_id_min, 'procesado_desde', procesado_desde, 'ciclo_inicio', ciclo_inicio,
    'carga_completa', carga_completa, 'leer_hosts', hosts_leido is null or hosts_leido < now() - interval '6 hours')
    from qualys_config where id = 1);
end $$;
revoke all on function public.qualys_auto_inicio(text) from public, authenticated;
grant execute on function public.qualys_auto_inicio(text) to anon;

-- Recibe una parte por llamada: hosts (lista completa), una página de detecciones, la base de conocimiento o el cierre
create or replace function public.qualys_auto_aplicar(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c qualys_config;
  v_hosts int := 0;
  v_det int := 0;
  v_kb int := 0;
  v_avisar int := 0;
  v_faltan int[];
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  select * into c from qualys_config where id = 1;

  -- Lista de hosts (cobertura)
  if jsonb_typeof(p -> 'hosts') = 'array' then
    insert into qualys_hosts as t (id, ip, dns, netbios, os, tracking, ultimo_escaneo, ultimo_escaneo_auth, actualizado)
    select (x ->> 'id')::bigint, x ->> 'ip', x ->> 'dns', x ->> 'netbios', left(x ->> 'os', 200), x ->> 'tracking',
           (x ->> 'ultimo_escaneo')::timestamptz, (x ->> 'ultimo_escaneo_auth')::timestamptz, now()
      from jsonb_array_elements(p -> 'hosts') x where x ->> 'id' is not null
    on conflict (id) do update set ip = excluded.ip, dns = excluded.dns, netbios = excluded.netbios, os = excluded.os, tracking = excluded.tracking,
      ultimo_escaneo = coalesce(excluded.ultimo_escaneo, t.ultimo_escaneo), ultimo_escaneo_auth = coalesce(excluded.ultimo_escaneo_auth, t.ultimo_escaneo_auth),
      actualizado = now();
    get diagnostics v_hosts = row_count;
    -- Hosts que ya no están en la suscripción (nunca con una lista vacía)
    if jsonb_array_length(p -> 'hosts') > 0 then
      delete from qualys_hosts where id not in (select (x ->> 'id')::bigint from jsonb_array_elements(p -> 'hosts') x);
    end if;
    update qualys_config set hosts_leido = now() where id = 1;
  end if;

  -- Página de detecciones
  if jsonb_typeof(p -> 'pagina') = 'object' then
    -- Arranque de una vuelta nueva
    if c.cursor_id_min is null then
      update qualys_config set ciclo_inicio = coalesce((p ->> 'ciclo_inicio')::timestamptz, now()) where id = 1;
    end if;

    insert into qualys_hosts as t (id, ip, dns, netbios, os, tracking, ultimo_escaneo, ultimo_escaneo_auth, actualizado)
    select (h ->> 'id')::bigint, h ->> 'ip', h ->> 'dns', h ->> 'netbios', left(h ->> 'os', 200), h ->> 'tracking',
           (h ->> 'ultimo_escaneo')::timestamptz, (h ->> 'ultimo_escaneo_auth')::timestamptz, now()
      from jsonb_array_elements(p -> 'pagina' -> 'hosts') h where h ->> 'id' is not null
    on conflict (id) do update set ip = excluded.ip, dns = coalesce(excluded.dns, t.dns), netbios = coalesce(excluded.netbios, t.netbios),
      os = coalesce(excluded.os, t.os), tracking = coalesce(excluded.tracking, t.tracking),
      ultimo_escaneo = coalesce(excluded.ultimo_escaneo, t.ultimo_escaneo), actualizado = now();

    -- En la carga inicial, lo que estaba abierto en un host y ya no viene, quedó corregido
    if not c.carga_completa then
      update qualys_detecciones d set estado = 'Fixed', corregida = coalesce(d.corregida, now()), actualizado = now()
       where d.host_id in (select (h ->> 'id')::bigint from jsonb_array_elements(p -> 'pagina' -> 'hosts') h)
         and d.estado <> 'Fixed'
         and d.clave not in (select x ->> 'clave' from jsonb_array_elements(p -> 'pagina' -> 'hosts') h, jsonb_array_elements(h -> 'detecciones') x);
    end if;

    with nuevas as (
      insert into qualys_detecciones as t (clave, host_id, qid, tipo, severidad, puerto, protocolo, estado, primera, ultima, corregida, veces,
                                          qds, qds_nivel, deshabilitada, ignorada, avisar, actualizado)
      select x ->> 'clave', (h ->> 'id')::bigint, (x ->> 'qid')::int, x ->> 'tipo', (x ->> 'severidad')::int, (x ->> 'puerto')::int, x ->> 'protocolo',
             coalesce(x ->> 'estado', 'Active'), (x ->> 'primera')::timestamptz, (x ->> 'ultima')::timestamptz, (x ->> 'corregida')::timestamptz,
             (x ->> 'veces')::int, (x ->> 'qds')::int, x ->> 'qds_nivel', coalesce((x ->> 'deshabilitada')::boolean, false),
             coalesce((x ->> 'ignorada')::boolean, false), c.carga_completa, now()
        from jsonb_array_elements(p -> 'pagina' -> 'hosts') h, jsonb_array_elements(h -> 'detecciones') x
       where x ->> 'clave' is not null and x ->> 'qid' is not null
      on conflict (clave) do update set
        host_id = excluded.host_id, tipo = excluded.tipo, severidad = excluded.severidad, estado = excluded.estado, ultima = excluded.ultima,
        corregida = excluded.corregida, veces = excluded.veces, qds = excluded.qds, qds_nivel = excluded.qds_nivel,
        deshabilitada = excluded.deshabilitada, ignorada = excluded.ignorada, actualizado = now()
      returning (xmax = 0) as insertada, avisar
    )
    select count(*), count(*) filter (where insertada and avisar) into v_det, v_avisar from nuevas;

    -- Siguiente página o fin de la vuelta
    if p -> 'pagina' ->> 'siguiente' is not null then
      update qualys_config set cursor_id_min = (p -> 'pagina' ->> 'siguiente')::bigint where id = 1;
    else
      update qualys_config set cursor_id_min = null, carga_completa = true, ultimo_ciclo = now(),
        procesado_desde = coalesce(ciclo_inicio, now()), ciclo_inicio = null where id = 1;
    end if;
  end if;

  -- Base de conocimiento
  if jsonb_typeof(p -> 'kb') = 'array' then
    insert into qualys_kb as t (qid, titulo, categoria, tipo, severidad, parcheable, publicada, cves, cvss, cvss3, amenazas, solucion, actualizado)
    select (v ->> 'qid')::int, left(v ->> 'titulo', 500), v ->> 'categoria', v ->> 'tipo', (v ->> 'severidad')::int, (v ->> 'parcheable')::boolean,
           (v ->> 'publicada')::timestamptz,
           coalesce(array(select jsonb_array_elements_text(v -> 'cves')), '{}'), (v ->> 'cvss')::numeric, (v ->> 'cvss3')::numeric,
           coalesce(array(select jsonb_array_elements_text(v -> 'amenazas')), '{}'), left(v ->> 'solucion', 1500), now()
      from jsonb_array_elements(p -> 'kb') v where v ->> 'qid' is not null
    on conflict (qid) do update set titulo = excluded.titulo, categoria = excluded.categoria, tipo = excluded.tipo, severidad = excluded.severidad,
      parcheable = excluded.parcheable, publicada = excluded.publicada, cves = excluded.cves, cvss = excluded.cvss, cvss3 = excluded.cvss3,
      amenazas = excluded.amenazas, solucion = excluded.solucion, actualizado = now();
    get diagnostics v_kb = row_count;
  end if;

  -- Cierre de la corrida
  if coalesce((p ->> 'fin')::boolean, false) then
    update qualys_config set ultima_ejecucion = now(), ultimo_ok = now(), ultimo_error = null,
      avisos = coalesce(p -> 'avisos', '[]'), duracion_s = (p ->> 'duracion_s')::int where id = 1;
    delete from qualys_detecciones where estado = 'Fixed' and coalesce(corregida, actualizado) < now() - interval '1 year';
    -- Avisar ya, sin esperar la revisión de alertas de cada 10 minutos
    if exists (select 1 from qualys_detecciones where avisar and primera_vez > now() - interval '1 hour')
       and to_regprocedure('public.alertas_evaluar(boolean)') is not null then
      begin
        perform alertas_evaluar(true);
      exception when others then null;
      end;
    end if;
  end if;

  -- QID que todavía no tienen datos de la base de conocimiento (los refresca cada 30 días)
  select coalesce(array_agg(q), '{}') into v_faltan from (
    select distinct d.qid as q from qualys_detecciones d left join qualys_kb k on k.qid = d.qid
     where qualys_abierta(d) and (k.qid is null or k.actualizado < now() - interval '30 days')
     limit 300) s;

  return jsonb_build_object('hosts', v_hosts, 'detecciones', v_det, 'nuevas', v_avisar, 'kb', v_kb, 'faltan_kb', to_jsonb(v_faltan),
    'cursor', (select cursor_id_min from qualys_config where id = 1), 'carga_completa', (select carga_completa from qualys_config where id = 1));
end $$;
revoke all on function public.qualys_auto_aplicar(text, jsonb) from public, authenticated;
grant execute on function public.qualys_auto_aplicar(text, jsonb) to anon;

create or replace function public.qualys_auto_error(p_token text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  update qualys_config set ultima_ejecucion = now(), ultimo_error = left(p_error, 300) where id = 1;
end $$;
revoke all on function public.qualys_auto_error(text, text) from public, authenticated;
grant execute on function public.qualys_auto_error(text, text) to anon;

-- ----------------------------------------------------------
-- Pantalla
-- ----------------------------------------------------------
create or replace function public.qualys_estado() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c qualys_config;
begin
  if not puede_ver('seguridad') then raise exception 'Sin acceso'; end if;
  select * into c from qualys_config where id = 1;
  return jsonb_build_object(
    'activo', c.activo, 'alertar_nuevas', c.alertar_nuevas, 'alertar_cobertura', c.alertar_cobertura, 'sev_alerta', c.sev_alerta,
    'dias_cobertura', c.dias_cobertura, 'carga_completa', c.carga_completa, 'cursor_id_min', c.cursor_id_min, 'ultimo_ciclo', c.ultimo_ciclo,
    'ultima_ejecucion', c.ultima_ejecucion, 'ultimo_ok', c.ultimo_ok, 'ultimo_error', c.ultimo_error, 'avisos', c.avisos, 'duracion_s', c.duracion_s,
    'clave_configurada', coalesce((select token_hash is not null from prog_config where id = 1), false),
    'sin_kb', (select count(distinct d.qid) from qualys_detecciones d left join qualys_kb k on k.qid = d.qid where qualys_abierta(d) and k.qid is null),
    -- Por QID
    'vulns', coalesce((
      select jsonb_agg(v order by v.explotada desc, v.severidad desc, v.equipos desc)
        from (select d.qid, max(d.severidad) as severidad, max(d.qds) as qds, count(distinct d.host_id) as equipos, min(d.primera) as primera,
                     max(d.primera_vez) as vista, k.titulo, k.categoria, k.cves, coalesce(k.cvss3, k.cvss) as cvss, k.amenazas, k.parcheable,
                     qualys_explotada(k.amenazas) as explotada, qualys_ransomware(k.amenazas) as ransomware
                from qualys_detecciones d left join qualys_kb k on k.qid = d.qid
               where qualys_abierta(d)
               group by d.qid, k.qid) v), '[]'),
    -- Por equipo
    'equipos', coalesce((
      select jsonb_agg(e order by e.explotadas desc, e.s5 desc, e.s4 desc, e.nombre)
        from (select h.id, coalesce(nullif(h.netbios, ''), h.dns, h.ip) as nombre, h.ip, h.dns, h.os, h.tracking, h.ultimo_escaneo, h.ultimo_escaneo_auth,
                     h.inv_id, h.origen, h.inv_nombre, h.inv_tipo, h.persona, h.area,
                     count(*) filter (where d.severidad = 5) as s5, count(*) filter (where d.severidad = 4) as s4, count(*) filter (where d.severidad = 3) as s3,
                     count(*) filter (where qualys_explotada(k.amenazas)) as explotadas, max(d.qds) as qds_max,
                     min(d.primera) filter (where d.severidad >= 4) as mas_vieja
                from qualys_v_equipos h
                left join qualys_detecciones d on d.host_id = h.id and qualys_abierta(d)
                left join qualys_kb k on k.qid = d.qid
               group by h.id, h.netbios, h.dns, h.ip, h.os, h.tracking, h.ultimo_escaneo, h.ultimo_escaneo_auth,
                        h.inv_id, h.origen, h.inv_nombre, h.inv_tipo, h.persona, h.area) e), '[]'),
    -- Inventario que Qualys no ve o no escanea hace más de N días
    'cobertura', coalesce((
      select jsonb_agg(x order by x.ultimo_escaneo nulls first, x.nombre)
        from (select i.*, h.id as host_id, h.ultimo_escaneo, h.ultimo_escaneo_auth
                from (select d.id::text as inv_id, d.hostname as nombre, d.ip, d.usuario as persona,
                             coalesce(d.tipo, case when d.so_nombre ilike '%server%' or d.so_nombre ilike '%linux%' then 'servidor' end) as tipo,
                             d.ultimo_reporte, lower(split_part(d.hostname, '.', 1)) as corto
                        from inv_dispositivos d where d.estado_registro = 'aprobado'
                      union all
                      select 'srv:' || s.id, s.nombre, null, s.responsable, 'servidor', null, lower(split_part(s.nombre, '.', 1))
                        from srv_servidores s where s.activo and s.dispositivo_id is null) i
                left join lateral (select * from qualys_hosts q where q.nombre_corto = i.corto or (i.ip is not null and q.ip = i.ip)
                                    order by q.ultimo_escaneo desc nulls last limit 1) h on true
               where h.id is null or h.ultimo_escaneo is null or h.ultimo_escaneo < now() - make_interval(days => c.dias_cobertura)) x), '[]'),
    'corregidas_30d', (select count(*) from qualys_detecciones where estado = 'Fixed' and corregida > now() - interval '30 days'),
    'nuevas_30d', (select count(*) from qualys_detecciones where avisar and primera_vez > now() - interval '30 days'));
end $$;
revoke all on function public.qualys_estado() from public, anon;
grant execute on function public.qualys_estado() to authenticated;

-- Detalle: detecciones de un equipo o equipos de un QID
create or replace function public.qualys_detalle(p_host bigint default null, p_qid int default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not puede_ver('seguridad') then raise exception 'Sin acceso'; end if;
  return jsonb_build_object(
    'kb', (select to_jsonb(k) from qualys_kb k where k.qid = p_qid),
    'detecciones', coalesce((
      select jsonb_agg(jsonb_build_object(
               'clave', d.clave, 'host_id', d.host_id, 'equipo', coalesce(nullif(h.netbios, ''), h.dns, h.ip), 'ip', h.ip, 'persona', h.persona,
               'qid', d.qid, 'titulo', k.titulo, 'severidad', d.severidad, 'qds', d.qds, 'puerto', d.puerto, 'protocolo', d.protocolo,
               'estado', d.estado, 'primera', d.primera, 'ultima', d.ultima, 'veces', d.veces, 'cves', k.cves, 'explotada', qualys_explotada(k.amenazas),
               'parcheable', k.parcheable, 'solucion', case when p_host is not null then k.solucion end)
               order by d.severidad desc, d.qds desc nulls last, d.primera)
        from qualys_detecciones d join qualys_v_equipos h on h.id = d.host_id left join qualys_kb k on k.qid = d.qid
       where qualys_abierta(d) and (p_host is null or d.host_id = p_host) and (p_qid is null or d.qid = p_qid)), '[]'));
end $$;
revoke all on function public.qualys_detalle(bigint, int) from public, anon;
grant execute on function public.qualys_detalle(bigint, int) to authenticated;

create or replace function public.qualys_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede cambiar esta configuración'; end if;
  update qualys_config set
    activo = coalesce((p ->> 'activo')::boolean, activo),
    alertar_nuevas = coalesce((p ->> 'alertar_nuevas')::boolean, alertar_nuevas),
    alertar_cobertura = coalesce((p ->> 'alertar_cobertura')::boolean, alertar_cobertura),
    sev_alerta = least(5, greatest(3, coalesce((p ->> 'sev_alerta')::int, sev_alerta))),
    dias_cobertura = least(365, greatest(1, coalesce((p ->> 'dias_cobertura')::int, dias_cobertura)))
  where id = 1;
end $$;
revoke all on function public.qualys_guardar(jsonb) from public, anon;
grant execute on function public.qualys_guardar(jsonb) to authenticated;

-- Volver a cargar todo desde cero (por ejemplo, si se cortó la carga inicial)
create or replace function public.qualys_recargar() returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede recargar'; end if;
  update qualys_config set cursor_id_min = null, ciclo_inicio = null, procesado_desde = null, hosts_leido = null where id = 1;
end $$;
revoke all on function public.qualys_recargar() from public, anon;
grant execute on function public.qualys_recargar() to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.qualys_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c qualys_config;
begin
  select * into c from qualys_config where id = 1;
  if c.ultima_ejecucion is null then return; end if;

  -- QID nuevo (visto por primera vez en los últimos 7 días) urgente o explotado activamente: una alerta por QID
  if c.alertar_nuevas then
    insert into _cond
    select 'qualys:qid:' || q.qid, 'qualys', case when q.explotada then 'alta' else 'media' end,
           'Qualys: ' || case when q.explotada then 'vulnerabilidad explotada activamente' else 'vulnerabilidad nueva de severidad ' || q.sev end
             || ' en ' || q.n || case when q.n = 1 then ' equipo' else ' equipos' end,
           concat_ws(' · ', coalesce(q.titulo, 'QID ' || q.qid), 'QID ' || q.qid, nullif(array_to_string(q.cves[1:3], ', '), ''),
                     'equipos: ' || array_to_string(q.equipos[1:5], ', ') || case when q.n > 5 then '…' else '' end),
           '/inventario/qualys?vista=vulnerabilidades&qid=' || q.qid
      from (select d.qid, max(d.severidad) as sev, count(distinct d.host_id) as n, k.titulo, k.cves, qualys_explotada(k.amenazas) as explotada,
                   array_agg(distinct coalesce(nullif(h.netbios, ''), h.dns, h.ip)) as equipos
              from qualys_detecciones d join qualys_hosts h on h.id = d.host_id left join qualys_kb k on k.qid = d.qid
             where qualys_abierta(d)
             group by d.qid, k.qid
            having bool_or(d.avisar and d.primera_vez > now() - interval '7 days')
               and (max(d.severidad) >= c.sev_alerta or qualys_explotada(k.amenazas))) q
    on conflict do nothing;
  end if;

  -- Equipos del inventario sin escaneo reciente (una sola alerta, abierta mientras haya)
  if c.alertar_cobertura and c.carga_completa then
    insert into _cond
    select 'qualys:cobertura', 'qualys', 'media',
           'Qualys: ' || count(*) || case when count(*) = 1 then ' equipo sin escanear' else ' equipos sin escanear' end || ' hace más de ' || c.dias_cobertura || ' días',
           left(string_agg(i.nombre, ', ' order by i.nombre), 300), '/inventario/qualys?vista=cobertura'
      from (select d.hostname as nombre, d.ip, lower(split_part(d.hostname, '.', 1)) as corto
              from inv_dispositivos d where d.estado_registro = 'aprobado' and d.ultimo_reporte > now() - interval '30 days'
            union all
            select s.nombre, null, lower(split_part(s.nombre, '.', 1)) from srv_servidores s where s.activo and s.dispositivo_id is null) i
     where not exists (select 1 from qualys_hosts q where (q.nombre_corto = i.corto or (i.ip is not null and q.ip = i.ip))
                          and q.ultimo_escaneo > now() - make_interval(days => c.dias_cobertura))
    having count(*) > 0
    on conflict do nothing;
  end if;

  -- La lectura dejó de funcionar
  if c.activo and coalesce(c.ultimo_ok, '-infinity') < now() - interval '3 hours' then
    insert into _cond values ('qualys:lectura', 'qualys', 'media', 'Qualys: la lectura no funciona hace más de 3 horas',
      coalesce(c.ultimo_error, 'La tarea programada no está corriendo (revisá QUALYS_API_URL, QUALYS_USUARIO, QUALYS_CLAVE y CRON_SECRET en Vercel)'),
      '/inventario/qualys')
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.qualys_condiciones_alertas() from public, anon, authenticated;

-- Engancha las condiciones en la lista de "otros módulos" y suma Qualys a Integraciones, sin pisar lo que ya existe
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
  if position('qualys_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.qualys_condiciones_alertas()'') is not null then perform qualys_condiciones_alertas(); end if;\n');
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

  -- Inicio → Integraciones
  if to_regprocedure('public.integraciones_estado()') is not null then
    v_def := pg_get_functiondef('public.integraciones_estado()'::regprocedure);
    if position('qualys_config' in v_def) = 0 and position('  select coalesce(jsonb_agg(jsonb_build_object(' in v_def) > 0 then
      v_def := replace(v_def, '  select coalesce(jsonb_agg(jsonb_build_object(', $x$  begin
    insert into _int select 85, 'qualys', 'Qualys VMDR', 'Equipos', ultima_ejecucion is not null, ultimo_ok, 'API',
      (select count(*) from qualys_hosts) || ' equipos · ' || (select count(*) from qualys_detecciones d where qualys_abierta(d)) || ' vulnerabilidades abiertas'
        || case when not carga_completa then ' · carga inicial en curso' else '' end,
      ultimo_error, '/inventario/qualys', 90, 240 from qualys_config where id = 1;
  exception when others then null; end;

  select coalesce(jsonb_agg(jsonb_build_object($x$);
      execute v_def;
    end if;
  end if;
end $$;

-- ----------------------------------------------------------
-- Permisos: se leen solo con qualys_estado() / qualys_detalle(); se escriben solo desde la tarea
-- ----------------------------------------------------------
alter table public.qualys_config enable row level security;
alter table public.qualys_hosts enable row level security;
alter table public.qualys_detecciones enable row level security;
alter table public.qualys_kb enable row level security;
revoke all on public.qualys_config, public.qualys_hosts, public.qualys_detecciones, public.qualys_kb from anon, authenticated;
revoke all on public.qualys_v_equipos from anon, authenticated;
