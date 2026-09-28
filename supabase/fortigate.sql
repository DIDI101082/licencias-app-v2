-- ==========================================================
-- Red → FortiGate
--   * Un puente en un servidor interno lee cada FortiGate por su API REST (usuario de API de solo lectura)
--     y envía: estado, HA, licencias de FortiGuard, certificados, interfaces con acceso de administración,
--     administradores, políticas y su uso, sesiones de VPN, intentos fallidos de VPN y amenazas (leídos del
--     FortiAnalyzer a través del FortiGate) y estado de los enlaces SD-WAN.
--   * La versión de FortiOS se cruza con la base oficial NVD (marca las vulnerabilidades explotadas, CISA KEV).
--   * Backup de configuración (opcional): queda en el servidor del puente; a la app solo llega qué cambió,
--     con contraseñas, claves y communities tapadas.
--   * Alertas (arrancan apagadas).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de vulnerabilidades.sql, geo.sql y switches.sql.
-- ==========================================================

create table if not exists public.fg_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  version_puente text,
  alertas boolean not null default false,
  alertar_cambios boolean not null default true,
  umbral_fallos int not null default 10 check (umbral_fallos between 3 and 1000),
  dias_aviso int not null default 30 check (dias_aviso between 1 and 180),
  paises_vpn text[] not null default array['AR'],
  minutos_sin_reporte int not null default 20 check (minutos_sin_reporte between 5 and 720)
);
insert into public.fg_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.fg_equipos (
  nombre text primary key,
  serial text,
  hostname text,
  modelo text,
  version text,
  build text,
  cpu numeric,
  mem numeric,
  sesiones numeric,
  ha_modo text,
  ha_miembros jsonb,
  ha_peers jsonb,
  ha_sincronizado boolean,
  responde boolean,
  ultimo_ok timestamptz,
  ultimo_error text,
  avisos jsonb not null default '[]',
  origen_logs text,
  actualizado timestamptz not null default now()
);

create table if not exists public.fg_licencias (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  servicio text not null, estado text, vence timestamptz,
  primary key (equipo, servicio)
);
create table if not exists public.fg_certificados (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  nombre text not null, tipo text, vence timestamptz,
  primary key (equipo, nombre)
);
create table if not exists public.fg_interfaces (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  nombre text not null, alias text, rol text, acceso text, ip text, estado text,
  primary key (equipo, nombre)
);
create table if not exists public.fg_admins (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  nombre text not null, perfil text, dos_factores text, trusthosts text[] not null default '{}',
  primary key (equipo, nombre)
);
create table if not exists public.fg_politicas (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  id int not null, nombre text, desde text, hacia text, origen text, destino text, servicio text,
  accion text, estado text, log text, comentario text, hits bigint, ultimo_uso timestamptz, bytes numeric,
  primary key (equipo, id)
);
create table if not exists public.fg_vpn (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  tipo text not null, usuario text not null, ip_publica text not null default '', ip_tunel text, desde timestamptz,
  pais_codigo text, pais text, ciudad text, isp text,
  primary key (equipo, tipo, usuario, ip_publica)
);
create table if not exists public.fg_vpn_fallos (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  fecha timestamptz not null, usuario text not null default '', ip text not null default '', motivo text, accion text,
  primary key (equipo, fecha, usuario, ip)
);
create index if not exists idx_fg_vpn_fallos_fecha on public.fg_vpn_fallos(fecha desc);
create table if not exists public.fg_amenazas (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  fecha timestamptz not null, tipo text not null, severidad text, nombre text not null default '', accion text,
  origen text not null default '', destino text not null default '', usuario text,
  primary key (equipo, fecha, tipo, nombre, origen, destino)
);
create index if not exists idx_fg_amenazas_fecha on public.fg_amenazas(fecha desc);
create table if not exists public.fg_sdwan (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  chequeo text not null, enlace text not null, estado text, latencia numeric, jitter numeric, perdida numeric,
  primary key (equipo, chequeo, enlace)
);
create table if not exists public.fg_cambios (
  id bigserial primary key,
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  fecha timestamptz not null default now(),
  hash text, inicial boolean not null default false, agregadas int, quitadas int,
  detalle jsonb not null default '[]'
);
create index if not exists idx_fg_cambios_fecha on public.fg_cambios(equipo, fecha desc);

-- Enlaces (interfaces WAN y miembros de SD-WAN): lo contratado lo carga un administrador; el resto lo informa el puente
alter table public.fg_config add column if not exists umbral_uso int not null default 85 check (umbral_uso between 30 and 100);
create table if not exists public.fg_enlaces (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  interfaz text not null,
  nombre text,                 -- proveedor o descripción (ej. "Telecom 300/300")
  bajada_mbps numeric check (bajada_mbps > 0),
  subida_mbps numeric check (subida_mbps > 0),
  respaldo boolean not null default false,
  velocidad_puerto numeric, conectado boolean, rx_bps numeric, tx_bps numeric,
  rx_bytes numeric, tx_bytes numeric, contadores_en timestamptz, actualizado timestamptz,
  primary key (equipo, interfaz)
);
-- Consumo medido (bits por segundo promedio entre dos reportes), 8 días
create table if not exists public.fg_trafico (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  interfaz text not null, fecha timestamptz not null, rx_bps numeric, tx_bps numeric,
  primary key (equipo, interfaz, fecha)
);
-- Lo que más consume en este momento (FortiView)
create table if not exists public.fg_top (
  equipo text not null references public.fg_equipos(nombre) on delete cascade,
  tipo text not null, nombre text not null, bytes numeric, sesiones numeric, bps numeric,
  primary key (equipo, tipo, nombre)
);

-- Fecha/hora en cualquiera de los formatos de FortiOS (segundos, ms, µs, ns o texto)
create or replace function public.fg_ts(p jsonb) returns timestamptz
language plpgsql immutable as $$
declare n numeric;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) = 'number' or (p #>> '{}') ~ '^\d+(\.\d+)?$' then
    n := (p #>> '{}')::numeric;
    if n <= 0 then return null; end if;
    if n > 1e17 then n := n / 1e9; elsif n > 1e14 then n := n / 1e6; elsif n > 1e11 then n := n / 1e3; end if;
    if n < 946684800 then return null; end if;   -- antes del 2000: no es una fecha real (por ejemplo, segundos de uptime)
    return to_timestamp(n);
  end if;
  begin
    return (p #>> '{}')::timestamptz;
  exception when others then return null;
  end;
end $$;

-- ----------------------------------------------------------
-- Lo llama el puente
-- ----------------------------------------------------------
create or replace function public.fg_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text; v_ahora timestamptz := now();
  e jsonb; vx jsonb; v_nom text; v_sync boolean; g_cod text; g_pais text; g_ciudad text; g_isp text; n int := 0;
  v_if text; v_rx numeric; v_tx numeric; v_rxbps numeric; v_txbps numeric; u_rx numeric; u_tx numeric; u_en timestamptz; v_seg numeric;
  v_geo_ok boolean := to_regclass('public.inv_geo_cache') is not null;
begin
  select token_hash into v_hash from fg_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de FortiGate inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'equipos'), '') <> 'array' then raise exception 'Datos inválidos'; end if;

  for e in select * from jsonb_array_elements(p_datos -> 'equipos') loop
    v_nom := left(e ->> 'nombre', 60);
    continue when coalesce(v_nom, '') = '';
    insert into fg_equipos (nombre) values (v_nom) on conflict (nombre) do nothing;

    if not coalesce((e ->> 'ok')::boolean, false) then
      update fg_equipos set responde = false, ultimo_error = left(e ->> 'error', 300), actualizado = v_ahora where nombre = v_nom;
      continue;
    end if;

    -- HA: sincronizado si todos los miembros tienen el mismo checksum
    v_sync := null;
    if jsonb_typeof(e -> 'ha_miembros') = 'array' and jsonb_array_length(e -> 'ha_miembros') > 0 then
      select count(distinct m ->> 'checksum') = 1 into v_sync from jsonb_array_elements(e -> 'ha_miembros') m;
    end if;
    update fg_equipos set responde = true, ultimo_ok = v_ahora, ultimo_error = null, actualizado = v_ahora,
      serial = left(e ->> 'serial', 40), hostname = left(e ->> 'hostname', 60), modelo = left(e ->> 'modelo', 60),
      version = substring(e ->> 'version' from '(\d+\.\d+\.\d+)'), build = left(e ->> 'build', 20),
      cpu = case when e ->> 'cpu' ~ '^[\d.]+$' then (e ->> 'cpu')::numeric end,
      mem = case when e ->> 'mem' ~ '^[\d.]+$' then (e ->> 'mem')::numeric end,
      sesiones = case when e ->> 'session' ~ '^[\d.]+$' then (e ->> 'session')::numeric end,
      ha_modo = nullif(e ->> 'ha_modo', ''), ha_miembros = e -> 'ha_miembros', ha_peers = e -> 'ha_peers', ha_sincronizado = v_sync,
      avisos = coalesce(e -> 'avisos', '[]'), origen_logs = e ->> 'origen_logs'
     where nombre = v_nom;

    -- Listas que se reemplazan en cada reporte (solo si vinieron: si falta el permiso, se conserva lo anterior)
    if jsonb_typeof(e -> 'licencias') = 'array' then
      delete from fg_licencias where equipo = v_nom;
      insert into fg_licencias (equipo, servicio, estado, vence)
      select v_nom, left(x ->> 'servicio', 60), left(x ->> 'estado', 30), fg_ts(x -> 'vence')
        from jsonb_array_elements(e -> 'licencias') x where coalesce(x ->> 'servicio', '') <> ''
      on conflict do nothing;
    end if;
    if jsonb_typeof(e -> 'certificados') = 'array' then
      delete from fg_certificados where equipo = v_nom;
      insert into fg_certificados (equipo, nombre, tipo, vence)
      select v_nom, left(x ->> 'nombre', 100), left(x ->> 'tipo', 40), fg_ts(x -> 'vence')
        from jsonb_array_elements(e -> 'certificados') x where coalesce(x ->> 'nombre', '') <> ''
      on conflict do nothing;
    end if;
    if jsonb_typeof(e -> 'interfaces') = 'array' then
      delete from fg_interfaces where equipo = v_nom;
      insert into fg_interfaces (equipo, nombre, alias, rol, acceso, ip, estado)
      select v_nom, left(x ->> 'nombre', 60), nullif(left(x ->> 'alias', 60), ''), nullif(x ->> 'rol', ''), nullif(x ->> 'acceso', ''),
             nullif(x ->> 'ip', ''), nullif(x ->> 'estado', '')
        from jsonb_array_elements(e -> 'interfaces') x where coalesce(x ->> 'nombre', '') <> ''
      on conflict do nothing;
    end if;
    if jsonb_typeof(e -> 'admins') = 'array' then
      delete from fg_admins where equipo = v_nom;
      insert into fg_admins (equipo, nombre, perfil, dos_factores, trusthosts)
      select v_nom, left(x ->> 'nombre', 60), x ->> 'perfil', x ->> 'dos_factores',
             coalesce((select array_agg(t) from jsonb_array_elements_text(case when jsonb_typeof(x -> 'trusthosts') = 'array' then x -> 'trusthosts' else '[]' end) t), '{}')
        from jsonb_array_elements(e -> 'admins') x where coalesce(x ->> 'nombre', '') <> ''
      on conflict do nothing;
    end if;
    if jsonb_typeof(e -> 'politicas') = 'array' then
      delete from fg_politicas where equipo = v_nom;
      insert into fg_politicas (equipo, id, nombre, desde, hacia, origen, destino, servicio, accion, estado, log, comentario, hits, ultimo_uso, bytes)
      select v_nom, (x ->> 'id')::int, left(x ->> 'nombre', 100), left(x ->> 'desde', 300), left(x ->> 'hacia', 300),
             left(x ->> 'origen', 500), left(x ->> 'destino', 500), left(x ->> 'servicio', 500), x ->> 'accion', x ->> 'estado',
             x ->> 'log', nullif(left(x ->> 'comentario', 300), ''),
             case when x ->> 'hits' ~ '^\d+$' then (x ->> 'hits')::bigint end, fg_ts(x -> 'ultimo_uso'),
             case when x ->> 'bytes' ~ '^\d+$' then (x ->> 'bytes')::numeric end
        from jsonb_array_elements(e -> 'politicas') x where x ->> 'id' ~ '^\d+$'
      on conflict do nothing;
    end if;
    if jsonb_typeof(e -> 'sdwan') = 'array' then
      delete from fg_sdwan where equipo = v_nom;
      insert into fg_sdwan (equipo, chequeo, enlace, estado, latencia, jitter, perdida)
      select v_nom, left(x ->> 'chequeo', 60), left(x ->> 'enlace', 60), x ->> 'estado',
             case when x ->> 'latencia' ~ '^[\d.]+$' then (x ->> 'latencia')::numeric end,
             case when x ->> 'jitter' ~ '^[\d.]+$' then (x ->> 'jitter')::numeric end,
             case when x ->> 'perdida' ~ '^[\d.]+$' then (x ->> 'perdida')::numeric end
        from jsonb_array_elements(e -> 'sdwan') x
      on conflict do nothing;
    end if;

    -- Tráfico de los enlaces: consumo = diferencia de contadores entre dos reportes
    if jsonb_typeof(e -> 'trafico') = 'array' then
      for vx in select * from jsonb_array_elements(e -> 'trafico') loop
        v_if := left(vx ->> 'interfaz', 60);
        continue when coalesce(v_if, '') = '';
        v_rx := case when vx ->> 'rx_bytes' ~ '^\d+(\.\d+)?$' then (vx ->> 'rx_bytes')::numeric end;
        v_tx := case when vx ->> 'tx_bytes' ~ '^\d+(\.\d+)?$' then (vx ->> 'tx_bytes')::numeric end;
        insert into fg_enlaces (equipo, interfaz) values (v_nom, v_if) on conflict do nothing;
        select rx_bytes, tx_bytes, contadores_en into u_rx, u_tx, u_en from fg_enlaces where equipo = v_nom and interfaz = v_if;
        v_rxbps := null; v_txbps := null;
        v_seg := extract(epoch from v_ahora - u_en);
        -- Si el contador bajó (reinicio o cambio de miembro del cluster) se descarta ese intervalo
        if v_rx is not null and u_rx is not null and v_seg between 30 and 3600 and v_rx >= u_rx and v_tx >= u_tx then
          v_rxbps := round((v_rx - u_rx) * 8 / v_seg); v_txbps := round((v_tx - u_tx) * 8 / v_seg);
        elsif vx ->> 'rx_bps' ~ '^\d+(\.\d+)?$' and v_rx is null then
          v_rxbps := (vx ->> 'rx_bps')::numeric; v_txbps := case when vx ->> 'tx_bps' ~ '^\d+(\.\d+)?$' then (vx ->> 'tx_bps')::numeric end;
        end if;
        update fg_enlaces set
          rx_bytes = v_rx, tx_bytes = v_tx, contadores_en = case when v_rx is not null then v_ahora end,
          rx_bps = coalesce(v_rxbps, case when vx ->> 'rx_bps' ~ '^\d+(\.\d+)?$' then (vx ->> 'rx_bps')::numeric end, case when u_en is null then null else rx_bps end),
          tx_bps = coalesce(v_txbps, case when vx ->> 'tx_bps' ~ '^\d+(\.\d+)?$' then (vx ->> 'tx_bps')::numeric end, case when u_en is null then null else tx_bps end),
          velocidad_puerto = case when vx ->> 'velocidad' ~ '^\d+(\.\d+)?$' then (vx ->> 'velocidad')::numeric end,
          conectado = case when vx ->> 'enlace' in ('true', 'up', '1') then true when vx ->> 'enlace' in ('false', 'down', '0') then false end,
          actualizado = v_ahora
         where equipo = v_nom and interfaz = v_if;
        if v_rxbps is not null then
          insert into fg_trafico (equipo, interfaz, fecha, rx_bps, tx_bps) values (v_nom, v_if, v_ahora, v_rxbps, v_txbps) on conflict do nothing;
        end if;
      end loop;
    end if;
    if jsonb_typeof(e -> 'top') = 'array' then
      delete from fg_top where equipo = v_nom;
      insert into fg_top (equipo, tipo, nombre, bytes, sesiones, bps)
      select v_nom, left(x ->> 'tipo', 10), left(x ->> 'nombre', 150),
             case when x ->> 'bytes' ~ '^\d+(\.\d+)?$' then (x ->> 'bytes')::numeric end,
             case when x ->> 'sesiones' ~ '^\d+(\.\d+)?$' then (x ->> 'sesiones')::numeric end,
             case when x ->> 'bps' ~ '^\d+(\.\d+)?$' then (x ->> 'bps')::numeric end
        from jsonb_array_elements(e -> 'top') x where coalesce(x ->> 'nombre', '') <> '' and x ->> 'tipo' in ('app', 'origen')
      on conflict do nothing;
    end if;

    -- VPN: sesiones activas, con país (misma geolocalización que Home office)
    if jsonb_typeof(e -> 'vpn') = 'array' then
      delete from fg_vpn where equipo = v_nom;
      for vx in select * from jsonb_array_elements(e -> 'vpn') loop
        continue when coalesce(vx ->> 'usuario', '') = '';
        -- Solo lo que ya está en la caché: las IP nuevas las ubica fg_geo_procesar() en segundo plano
        -- (consultar el servicio acá hace que Supabase corte el reporte por tiempo)
        g_cod := null; g_pais := null; g_ciudad := null; g_isp := null;
        if v_geo_ok then
          select pais_codigo, pais, ciudad, isp into g_cod, g_pais, g_ciudad, g_isp from inv_geo_cache where ip = vx ->> 'ip_publica';
        end if;
        insert into fg_vpn (equipo, tipo, usuario, ip_publica, ip_tunel, desde, pais_codigo, pais, ciudad, isp)
        values (v_nom, left(vx ->> 'tipo', 10), left(vx ->> 'usuario', 100), coalesce(left(vx ->> 'ip_publica', 60), ''),
                nullif(left(vx ->> 'ip_tunel', 60), ''), fg_ts(vx -> 'desde'),
                g_cod, g_pais, g_ciudad, g_isp)
        on conflict do nothing;
      end loop;
    end if;

    -- Historiales (30 días)
    if jsonb_typeof(e -> 'vpn_fallos') = 'array' then
      insert into fg_vpn_fallos (equipo, fecha, usuario, ip, motivo, accion)
      select v_nom, coalesce(fg_ts(x -> 'fecha'), fg_ts(to_jsonb(x ->> 'fecha_txt')), v_ahora), coalesce(left(x ->> 'usuario', 100), ''),
             coalesce(left(x ->> 'ip', 60), ''), left(x ->> 'motivo', 200), left(x ->> 'accion', 60)
        from jsonb_array_elements(e -> 'vpn_fallos') x
      on conflict do nothing;
    end if;
    if jsonb_typeof(e -> 'amenazas') = 'array' then
      insert into fg_amenazas (equipo, fecha, tipo, severidad, nombre, accion, origen, destino, usuario)
      select v_nom, coalesce(fg_ts(x -> 'fecha'), fg_ts(to_jsonb(x ->> 'fecha_txt')), v_ahora), left(x ->> 'tipo', 20), lower(nullif(x ->> 'severidad', '')),
             coalesce(left(x ->> 'nombre', 200), ''), left(x ->> 'accion', 30), coalesce(left(x ->> 'origen', 60), ''),
             coalesce(left(x ->> 'destino', 60), ''), nullif(left(x ->> 'usuario', 100), '')
        from jsonb_array_elements(e -> 'amenazas') x
      on conflict do nothing;
    end if;

    -- Cambio de configuración (resumen ya enmascarado por el puente)
    if jsonb_typeof(e -> 'cambio_config') = 'object' then
      insert into fg_cambios (equipo, hash, inicial, agregadas, quitadas, detalle)
      values (v_nom, left(e #>> '{cambio_config,hash}', 80), coalesce((e #>> '{cambio_config,inicial}')::boolean, false),
              nullif(e #>> '{cambio_config,agregadas}', '')::int, nullif(e #>> '{cambio_config,quitadas}', '')::int,
              coalesce(e #> '{cambio_config,detalle}', '[]'));
    end if;
    n := n + 1;
  end loop;

  delete from fg_vpn_fallos where fecha < v_ahora - interval '30 days';
  delete from fg_amenazas where fecha < v_ahora - interval '30 days';
  delete from fg_cambios where fecha < v_ahora - interval '365 days';
  delete from fg_trafico where fecha < v_ahora - interval '8 days';
  update fg_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20) where id = 1;
  return jsonb_build_object('ok', true, 'equipos', n);
end $$;
revoke all on function public.fg_reportar(text, jsonb) from public;
grant execute on function public.fg_reportar(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Ubicación de las IP de VPN nuevas (cada 5 minutos, hasta 10 IP por vez)
-- ----------------------------------------------------------
create or replace function public.fg_geo_procesar()
returns void language plpgsql security definer set search_path = public as $$
declare r record; g record;
begin
  if to_regprocedure('public.inv_geo_consultar(text)') is null then return; end if;
  for r in
    select distinct ip_publica from fg_vpn
     where pais_codigo is null and ip_publica ~ '^[0-9a-fA-F:.]{3,45}$'
       and ip_publica !~ '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.|169\.254\.)'
     limit 10
  loop
    begin
      select * into g from inv_geo_consultar(r.ip_publica);
      if g.pais_codigo is not null then
        update fg_vpn set pais_codigo = g.pais_codigo, pais = g.pais, ciudad = g.ciudad, isp = g.isp where ip_publica = r.ip_publica;
      end if;
    exception when others then null;
    end;
  end loop;
end $$;
revoke all on function public.fg_geo_procesar() from public, anon, authenticated;

do $$ begin
  begin perform cron.unschedule('accusys-fortigate-geo'); exception when others then null; end;
  perform cron.schedule('accusys-fortigate-geo', '*/5 * * * *', 'select public.fg_geo_procesar()');
exception when others then
  raise notice 'La ubicación de las IP de VPN no quedó programada (falta pg_cron): %', sqlerrm;
end $$;

-- ----------------------------------------------------------
-- Vulnerabilidades de FortiOS (base oficial NVD; misma tabla que el módulo Vulnerabilidades)
-- ----------------------------------------------------------
create or replace function public.fg_consultar_vulns(p_version text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_clave text; v_url text; r record; j jsonb; v_items jsonb;
begin
  if to_regclass('public.vuln_consultas') is null then return 'sin_modulo'; end if;
  select nullif(trim(nvd_api_key), '') into v_clave from vuln_config where id = 1;
  -- FortiOS figura en NVD como sistema operativo ("o"), no como aplicación
  v_url := 'https://services.nvd.nist.gov/rest/json/cves/2.0?noRejected&isVulnerable&resultsPerPage=500&cpeName='
           || urlencode('cpe:2.3:o:fortinet:fortios:' || p_version || ':*:*:*:*:*:*:*');
  begin
    begin perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000'); exception when others then null; end;
    if v_clave is not null then
      select * into r from http(('GET', v_url, array[http_header('apiKey', v_clave)], null, null)::http_request);
    else
      select * into r from http_get(v_url);
    end if;
  exception when others then
    insert into vuln_consultas (cpe, version, estado, error) values ('fortinet:fortios', p_version, 'error', left(sqlerrm, 300))
    on conflict (cpe, version) do update set consultado = now(), estado = 'error', error = excluded.error;
    return 'error';
  end;
  if r.status = 404 then
    insert into vuln_consultas (cpe, version, estado) values ('fortinet:fortios', p_version, 'sin_datos')
    on conflict (cpe, version) do update set consultado = now(), estado = 'sin_datos', error = null, total = 0, criticas = 0, altas = 0, kev = 0, max_cvss = null, cves = '[]';
    return 'sin_datos';
  elsif r.status <> 200 then
    insert into vuln_consultas (cpe, version, estado, error) values ('fortinet:fortios', p_version, 'error', 'NVD respondió ' || r.status)
    on conflict (cpe, version) do update set consultado = now(), estado = 'error', error = excluded.error;
    return 'error';
  end if;
  j := r.content::jsonb;
  with v as (select x -> 'cve' as c from jsonb_array_elements(coalesce(j -> 'vulnerabilities', '[]')) x),
  m as (
    select c ->> 'id' as id,
           coalesce(c #> '{metrics,cvssMetricV40,0,cvssData}', c #> '{metrics,cvssMetricV31,0,cvssData}',
                    c #> '{metrics,cvssMetricV30,0,cvssData}', c #> '{metrics,cvssMetricV2,0,cvssData}') as cvss,
           c #>> '{metrics,cvssMetricV2,0,baseSeverity}' as sev_v2, c ? 'cisaExploitAdd' as kev, c ->> 'cisaRequiredAction' as accion,
           (select d ->> 'value' from jsonb_array_elements(coalesce(c -> 'descriptions', '[]')) d
             order by (d ->> 'lang' = 'es') desc, (d ->> 'lang' = 'en') desc limit 1) as descripcion
      from v),
  f as (select id, (cvss ->> 'baseScore')::numeric as puntaje, upper(coalesce(cvss ->> 'baseSeverity', sev_v2, '')) as severidad, kev, accion, descripcion from m)
  select jsonb_build_object('total', count(*), 'criticas', count(*) filter (where severidad = 'CRITICAL'),
           'altas', count(*) filter (where severidad = 'HIGH'), 'kev', count(*) filter (where kev), 'max', max(puntaje),
           'cves', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'cvss', puntaje, 'severidad', severidad, 'kev', kev,
                                                                'descripcion', left(descripcion, 300), 'accion', accion))
                               from (select * from f order by kev desc, puntaje desc nulls last, id desc limit 50) t), '[]'))
    into v_items from f;
  insert into vuln_consultas (cpe, version, estado, total, criticas, altas, kev, max_cvss, cves)
  values ('fortinet:fortios', p_version, case when (v_items ->> 'total')::int = 0 then 'sin_datos' else 'ok' end,
          (v_items ->> 'total')::int, (v_items ->> 'criticas')::int, (v_items ->> 'altas')::int, (v_items ->> 'kev')::int,
          (v_items ->> 'max')::numeric, v_items -> 'cves')
  on conflict (cpe, version) do update set consultado = now(), estado = excluded.estado, error = null, total = excluded.total,
    criticas = excluded.criticas, altas = excluded.altas, kev = excluded.kev, max_cvss = excluded.max_cvss, cves = excluded.cves;
  return 'ok';
end $$;
revoke all on function public.fg_consultar_vulns(text) from public, anon, authenticated;

-- Una vez por día por versión (la tarea programada corre cada hora y solo consulta lo vencido)
create or replace function public.fg_vulns_procesar()
returns void language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if to_regclass('public.vuln_consultas') is null then return; end if;
  for r in
    select distinct e.version from fg_equipos e
      left join vuln_consultas q on q.cpe = 'fortinet:fortios' and q.version = e.version
     where e.version is not null
       and (q.cpe is null or q.consultado < now() - interval '1 day' or (q.estado = 'error' and q.consultado < now() - interval '1 hour'))
  loop
    if n > 0 then perform pg_sleep(6.5); end if;
    perform fg_consultar_vulns(r.version);
    n := n + 1;
  end loop;
end $$;
revoke all on function public.fg_vulns_procesar() from public, anon, authenticated;

do $$ begin
  begin perform cron.unschedule('accusys-fortigate-vulns'); exception when others then null; end;
  perform cron.schedule('accusys-fortigate-vulns', '17 * * * *', 'select public.fg_vulns_procesar()');
exception when others then
  raise notice 'La consulta de vulnerabilidades de FortiOS no quedó programada (falta pg_cron): %', sqlerrm;
end $$;

-- ----------------------------------------------------------
-- Vistas para la pantalla
-- ----------------------------------------------------------
-- Hallazgos de configuración (se recalculan solos con cada reporte)
create or replace view public.fg_hallazgos with (security_invoker = true) as
select equipo, 'admin_wan'::text as tipo, nombre as clave, 'alta'::text as severidad,
       'Administración abierta en la interfaz WAN ' || nombre as titulo,
       'Acceso permitido: ' || acceso || coalesce(' · ' || alias, '') || '. Dejá solo ping (o nada) en las WAN y administrá por la LAN o la VPN.' as detalle
  from fg_interfaces where rol = 'wan' and acceso ~ '(^| )(https?|ssh|telnet)( |$)'
union all
select equipo, 'snmp_wan', nombre, 'media', 'SNMP abierto en la interfaz WAN ' || nombre, 'Acceso permitido: ' || acceso || coalesce(' · ' || alias, '')
  from fg_interfaces where rol = 'wan' and acceso ~ '(^| )snmp( |$)'
union all
select equipo, 'admin_sin_trusthost', nombre, case when perfil = 'super_admin' then 'alta' else 'media' end,
       'Administrador sin hosts de confianza: ' || nombre,
       'Perfil ' || coalesce(perfil, '—') || '. Puede iniciar sesión desde cualquier IP; limitalo a las redes de administración (trusted hosts).'
  from fg_admins where cardinality(trusthosts) = 0
union all
select equipo, 'admin_sin_2fa', nombre, 'media', 'Administrador sin doble factor: ' || nombre, 'Perfil ' || coalesce(perfil, '—') || '. Activá FortiToken o doble factor por email.'
  from fg_admins where coalesce(dos_factores, 'disable') in ('disable', '')
union all
select equipo, 'admin_default', nombre, 'media', 'Cuenta "admin" por defecto activa', 'Es el primer usuario que prueba un atacante. Creá cuentas nominales y deshabilitá o renombrá "admin".'
  from fg_admins where lower(nombre) = 'admin'
union all
select equipo, 'politica_abierta', id::text, case when desde ~* 'wan' then 'critica' else 'alta' end,
       'Política ' || id || ' permite todo: ' || coalesce(nombre, 'sin nombre'),
       'De ' || coalesce(desde, '—') || ' a ' || coalesce(hacia, '—') || ': origen, destino y servicio en "all".'
  from fg_politicas where estado = 'enable' and accion = 'accept'
   and origen ~* '(^|, )all($|,)' and destino ~* '(^|, )all($|,)' and servicio ~* '(^|, )all($|,)'
union all
select equipo, 'politica_wan_all', id::text, 'alta',
       'Política ' || id || ' abre todos los servicios desde Internet: ' || coalesce(nombre, 'sin nombre'),
       'De ' || coalesce(desde, '—') || ' a ' || coalesce(hacia, '—') || ' · destino ' || coalesce(destino, '—')
  from fg_politicas where estado = 'enable' and accion = 'accept' and desde ~* 'wan' and servicio ~* '(^|, )all($|,)'
   and not (origen ~* '(^|, )all($|,)' and destino ~* '(^|, )all($|,)')
union all
select equipo, 'politica_sin_log', id::text, 'media', 'Política ' || id || ' sin registro de tráfico: ' || coalesce(nombre, 'sin nombre'),
       'Sin log no queda rastro para investigar un incidente.'
  from fg_politicas where estado = 'enable' and accion = 'accept' and coalesce(log, '') = 'disable'
union all
select equipo, 'politica_sin_uso', id::text, 'baja', 'Política ' || id || ' sin uso: ' || coalesce(nombre, 'sin nombre'),
       case when coalesce(hits, 0) = 0 then 'Nunca se usó desde el último reinicio.' else 'Último uso: ' || to_char(ultimo_uso at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') end
         || ' Si ya no hace falta, conviene borrarla.'
  from fg_politicas where estado = 'enable' and (coalesce(hits, 0) = 0 or ultimo_uso < now() - interval '90 days')
union all
select equipo, 'politica_deshabilitada', id::text, 'baja', 'Política ' || id || ' deshabilitada: ' || coalesce(nombre, 'sin nombre'),
       'Las políticas deshabilitadas se acumulan y confunden. Si no se va a usar, borrala.'
  from fg_politicas where estado = 'disable';

-- Resumen por equipo (con vulnerabilidades de su versión)
create or replace view public.fg_equipos_vista with (security_invoker = true) as
select e.*, q.estado as vuln_estado, q.consultado as vuln_consultado, q.total as vuln_total, q.criticas as vuln_criticas,
       q.altas as vuln_altas, q.kev as vuln_kev, q.max_cvss as vuln_max_cvss, q.cves as vuln_cves
  from fg_equipos e
  left join vuln_consultas q on q.cpe = 'fortinet:fortios' and q.version = e.version;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.fg_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('red') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'alertas', alertas, 'alertar_cambios', alertar_cambios, 'umbral_fallos', umbral_fallos, 'dias_aviso', dias_aviso,
    'paises_vpn', paises_vpn, 'minutos_sin_reporte', minutos_sin_reporte, 'umbral_uso', umbral_uso)
  end from fg_config where id = 1
$$;
revoke execute on function public.fg_estado() from public, anon;
grant execute on function public.fg_estado() to authenticated;

create or replace function public.fg_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update fg_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.fg_nuevo_puente(text) from public, anon;
grant execute on function public.fg_nuevo_puente(text) to authenticated;

create or replace function public.fg_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update fg_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    alertar_cambios = coalesce((p ->> 'alertar_cambios')::boolean, alertar_cambios),
    umbral_fallos = coalesce((p ->> 'umbral_fallos')::int, umbral_fallos),
    dias_aviso = coalesce((p ->> 'dias_aviso')::int, dias_aviso),
    paises_vpn = coalesce((select array_agg(upper(trim(x))) from jsonb_array_elements_text(p -> 'paises_vpn') x where trim(x) ~* '^[a-z]{2}$'), paises_vpn),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte),
    umbral_uso = coalesce((p ->> 'umbral_uso')::int, umbral_uso)
  where id = 1;
end $$;
revoke execute on function public.fg_config_guardar(jsonb) from public, anon;
grant execute on function public.fg_config_guardar(jsonb) to authenticated;

-- Datos de un enlace que carga el administrador (lo contratado)
create or replace function public.fg_enlace_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update fg_enlaces set
    nombre = nullif(left(trim(p ->> 'nombre'), 80), ''),
    bajada_mbps = case when p ->> 'bajada_mbps' ~ '^\d+(\.\d+)?$' and (p ->> 'bajada_mbps')::numeric > 0 then (p ->> 'bajada_mbps')::numeric end,
    subida_mbps = case when p ->> 'subida_mbps' ~ '^\d+(\.\d+)?$' and (p ->> 'subida_mbps')::numeric > 0 then (p ->> 'subida_mbps')::numeric end,
    respaldo = coalesce((p ->> 'respaldo')::boolean, false)
  where equipo = p ->> 'equipo' and interfaz = p ->> 'interfaz';
  if not found then raise exception 'Enlace inexistente'; end if;
end $$;
revoke execute on function public.fg_enlace_guardar(jsonb) from public, anon;
grant execute on function public.fg_enlace_guardar(jsonb) to authenticated;

-- Serie para el gráfico: promedio y máximo por tramo (10 minutos para 24 h, 1 hora para 7 días)
create or replace function public.fg_trafico_serie(p_equipo text, p_interfaz text, p_horas int)
returns table (fecha timestamptz, rx_bps numeric, tx_bps numeric, rx_max numeric, tx_max numeric)
language sql stable security invoker set search_path = public as $$
  select date_bin(case when p_horas > 48 then interval '1 hour' else interval '10 minutes' end, t.fecha, timestamptz '2000-01-01') as f,
         round(avg(t.rx_bps)), round(avg(t.tx_bps)), max(t.rx_bps), max(t.tx_bps)
    from fg_trafico t
   where t.equipo = p_equipo and t.interfaz = p_interfaz and t.fecha > now() - make_interval(hours => least(greatest(p_horas, 1), 192))
   group by 1 order by 1
$$;
revoke execute on function public.fg_trafico_serie(text, text, int) from public, anon;
grant execute on function public.fg_trafico_serie(text, text, int) to authenticated;

-- Quitar un equipo que ya no existe (se vuelve a crear solo si el puente lo sigue informando)
create or replace function public.fg_quitar_equipo(p_nombre text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  delete from fg_equipos where nombre = p_nombre;
end $$;
revoke execute on function public.fg_quitar_equipo(text) from public, anon;
grant execute on function public.fg_quitar_equipo(text) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.fg_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c fg_config;
begin
  select * into c from fg_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  if c.ultimo_reporte is null or c.ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte) then
    insert into _cond values ('fg:puente', 'fortigate', 'alta', 'El puente de FortiGate dejó de reportar',
      coalesce('Último reporte ' || to_char(c.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'), '/red/fortigate')
    on conflict do nothing;
    return;
  end if;

  -- Equipo sin respuesta
  insert into _cond select 'fg:caido:' || nombre, 'fortigate', 'critica', 'FortiGate sin respuesta: ' || nombre, left(ultimo_error, 200), '/red/fortigate'
    from fg_equipos where responde = false
  on conflict do nothing;

  -- HA: un solo miembro o configuración desincronizada
  insert into _cond select 'fg:ha:' || nombre, 'fortigate', 'alta', 'Cluster HA con problemas: ' || nombre,
         case when jsonb_array_length(coalesce(ha_miembros, '[]')) < 2 then 'Solo responde un miembro del cluster'
              else 'La configuración de los miembros no está sincronizada' end, '/red/fortigate'
    from fg_equipos where responde and coalesce(ha_modo, 'standalone') <> 'standalone'
     and (jsonb_array_length(coalesce(ha_miembros, '[]')) < 2 or ha_sincronizado = false)
  on conflict do nothing;

  -- Vulnerabilidades de la versión de FortiOS
  if to_regclass('public.vuln_consultas') is not null then
    insert into _cond select 'fg:vuln:' || e.nombre || ':' || e.version, 'fortigate',
           case when q.kev > 0 then 'critica' else 'alta' end,
           'FortiOS ' || e.version || ' vulnerable en ' || e.nombre,
           q.total || ' vulnerabilidades' || case when q.kev > 0 then ', ' || q.kev || ' explotadas activamente (CISA KEV)' else ', ' || q.criticas || ' críticas' end
             || '. Actualizá a la última versión recomendada por Fortinet.', '/red/fortigate'
      from fg_equipos e join vuln_consultas q on q.cpe = 'fortinet:fortios' and q.version = e.version
     where q.kev > 0 or q.criticas > 0
    on conflict do nothing;
  end if;

  -- Licencias y certificados
  insert into _cond select 'fg:lic:' || equipo || ':' || servicio, 'fortigate',
         case when vence < now() or estado ~* 'expired' then 'alta' else 'media' end,
         case when vence < now() or estado ~* 'expired' then 'Licencia vencida: ' else 'Licencia por vencer: ' end || servicio || ' (' || equipo || ')',
         coalesce('Vence el ' || to_char(vence at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), estado), '/red/fortigate?vista=licencias'
    from fg_licencias where (vence is not null and vence < now() + make_interval(days => c.dias_aviso)) or estado ~* 'expired'
  on conflict do nothing;
  insert into _cond select 'fg:cert:' || equipo || ':' || nombre, 'fortigate', case when vence < now() then 'alta' else 'media' end,
         case when vence < now() then 'Certificado vencido: ' else 'Certificado por vencer: ' end || nombre || ' (' || equipo || ')',
         'Vence el ' || to_char(vence at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), '/red/fortigate?vista=licencias'
    from fg_certificados where vence < now() + make_interval(days => c.dias_aviso)
  on conflict do nothing;

  -- Configuración riesgosa (solo lo grave)
  insert into _cond select 'fg:cfg:' || equipo || ':' || tipo || ':' || clave, 'fortigate', severidad, titulo || ' (' || equipo || ')', left(detalle, 250), '/red/fortigate?vista=configuracion'
    from fg_hallazgos where severidad in ('critica', 'alta')
  on conflict do nothing;

  -- Fuerza bruta contra la VPN (por IP y por usuario, última hora)
  insert into _cond select 'fg:bf:ip:' || ip, 'fortigate', 'alta', 'Intentos fallidos de VPN desde ' || ip,
         count(*) || ' intentos en la última hora' || coalesce(' · usuarios: ' || left(string_agg(distinct nullif(usuario, ''), ', '), 120), ''), '/red/fortigate?vista=vpn'
    from fg_vpn_fallos where fecha > now() - interval '1 hour' and ip <> '' group by ip having count(*) >= c.umbral_fallos
  on conflict do nothing;
  insert into _cond select 'fg:bf:usr:' || usuario, 'fortigate', 'alta', 'Intentos fallidos de VPN para el usuario ' || usuario,
         count(*) || ' intentos en la última hora desde ' || count(distinct ip) || ' IP', '/red/fortigate?vista=vpn'
    from fg_vpn_fallos where fecha > now() - interval '1 hour' and usuario <> '' group by usuario having count(*) >= c.umbral_fallos
  on conflict do nothing;

  -- Conexión de VPN desde un país no permitido
  insert into _cond select 'fg:pais:' || usuario || ':' || ip_publica, 'fortigate', 'alta',
         'VPN conectada desde ' || coalesce(pais, pais_codigo) || ': ' || usuario,
         concat_ws(' · ', 'IP ' || ip_publica, nullif(ciudad, ''), nullif(isp, ''), equipo), '/red/fortigate?vista=vpn'
    from fg_vpn where pais_codigo is not null and not (upper(pais_codigo) = any(c.paises_vpn))
  on conflict do nothing;

  -- SD-WAN
  insert into _cond select 'fg:wan:' || equipo || ':' || enlace, 'fortigate',
         case when estado <> 'up' then 'alta' else 'media' end,
         case when estado <> 'up' then 'Enlace caído: ' else 'Enlace degradado: ' end || enlace || ' (' || equipo || ')',
         case when estado <> 'up' then 'Chequeo ' || chequeo else 'Pérdida ' || coalesce(perdida, 0) || '% · latencia ' || coalesce(round(latencia), 0) || ' ms' end,
         '/red/fortigate?vista=sdwan'
    from fg_sdwan where estado <> 'up' or coalesce(perdida, 0) > 5 or coalesce(latencia, 0) > 250
  on conflict do nothing;

  -- Amenaza crítica que no se bloqueó (IPS / antivirus, últimas 2 horas)
  insert into _cond select 'fg:amenaza:' || md5(tipo || nombre || destino), 'fortigate', 'alta',
         tipo || ' no bloqueado: ' || nombre,
         count(*) || ' eventos hacia ' || destino || ' · acción ' || max(accion) || ' · origen ' || left(string_agg(distinct origen, ', '), 80),
         '/red/fortigate?vista=amenazas'
    from fg_amenazas
   where fecha > now() - interval '2 hours' and coalesce(severidad, '') in ('critical', 'critica', 'high')
     and coalesce(accion, '') in ('detected', 'pass', 'passthrough', 'monitored', 'accept')
   group by tipo, nombre, destino
  on conflict do nothing;

  -- Cambios de configuración (últimas 24 horas)
  if c.alertar_cambios then
    insert into _cond select 'fg:cambio:' || id, 'fortigate', 'media', 'Cambio de configuración en ' || equipo,
           coalesce(agregadas, 0) || ' líneas nuevas y ' || coalesce(quitadas, 0) || ' quitadas', '/red/fortigate?vista=cambios'
      from fg_cambios where not inicial and fecha > now() - interval '24 hours'
    on conflict do nothing;
  end if;

  -- Enlace saturado (promedio de los últimos 30 minutos contra lo contratado)
  insert into _cond
  select 'fg:sat:' || l.equipo || ':' || l.interfaz || ':' || d.sentido, 'fortigate', 'media',
         'Enlace saturado: ' || coalesce(l.nombre, l.interfaz) || ' (' || l.equipo || ')',
         initcap(d.sentido) || ' al ' || round(d.uso) || '% de lo contratado en los últimos 30 minutos', '/red/fortigate?vista=sdwan'
    from fg_enlaces l
    cross join lateral (
      select 'bajada' as sentido, avg(t.rx_bps) / (l.bajada_mbps * 1e4) as uso, count(*) as n
        from fg_trafico t where t.equipo = l.equipo and t.interfaz = l.interfaz and t.fecha > now() - interval '30 minutes' and l.bajada_mbps is not null
      union all
      select 'subida', avg(t.tx_bps) / (l.subida_mbps * 1e4), count(*)
        from fg_trafico t where t.equipo = l.equipo and t.interfaz = l.interfaz and t.fecha > now() - interval '30 minutes' and l.subida_mbps is not null
    ) d
   where d.n >= 2 and d.uso >= c.umbral_uso
  on conflict do nothing;

  -- El tráfico está saliendo por el enlace de respaldo (el principal está caído o degradado)
  insert into _cond
  select 'fg:respaldo:' || r.equipo || ':' || r.interfaz, 'fortigate', 'alta',
         'El tráfico sale por el enlace de respaldo: ' || coalesce(r.nombre, r.interfaz) || ' (' || r.equipo || ')',
         'En los últimos 30 minutos pasó más tráfico por el respaldo que por los enlaces principales. Revisá el enlace principal.',
         '/red/fortigate?vista=sdwan'
    from fg_enlaces r
   where r.respaldo
     and (select avg(t.rx_bps + t.tx_bps) from fg_trafico t where t.equipo = r.equipo and t.interfaz = r.interfaz and t.fecha > now() - interval '30 minutes') > 1e6
     and (select avg(t.rx_bps + t.tx_bps) from fg_trafico t where t.equipo = r.equipo and t.interfaz = r.interfaz and t.fecha > now() - interval '30 minutes')
         > coalesce((select sum(x.m) from (select avg(t.rx_bps + t.tx_bps) as m from fg_trafico t join fg_enlaces p on p.equipo = t.equipo and p.interfaz = t.interfaz
                      where t.equipo = r.equipo and not p.respaldo and t.fecha > now() - interval '30 minutes' group by t.interfaz) x), 0)
  on conflict do nothing;

  -- Recursos altos
  insert into _cond select 'fg:recursos:' || nombre, 'fortigate', 'media', 'FortiGate con recursos al límite: ' || nombre,
         'CPU ' || coalesce(cpu, 0) || '% · memoria ' || coalesce(mem, 0) || '%', '/red/fortigate'
    from fg_equipos where responde and (coalesce(cpu, 0) >= 90 or coalesce(mem, 0) >= 90)
  on conflict do nothing;
end $$;
revoke all on function public.fg_condiciones_alertas() from public, anon, authenticated;

-- Gancho común (los demás módulos sin cambios)
create or replace function public.alertas_condiciones_extra()
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.backups_condiciones_alertas()') is not null then perform backups_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_condiciones_alertas()') is not null then perform srv_condiciones_alertas(); end if;
  if to_regprocedure('public.unifi_condiciones_alertas()') is not null then perform unifi_condiciones_alertas(); end if;
  if to_regprocedure('public.sw_condiciones_alertas()') is not null then perform sw_condiciones_alertas(); end if;
  if to_regprocedure('public.fg_condiciones_alertas()') is not null then perform fg_condiciones_alertas(); end if;
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
-- Permisos: se ve con la solapa Red; los datos los escribe solo el puente
-- ----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['fg_equipos', 'fg_licencias', 'fg_certificados', 'fg_interfaces', 'fg_admins', 'fg_politicas', 'fg_vpn',
                           'fg_vpn_fallos', 'fg_amenazas', 'fg_sdwan', 'fg_cambios', 'fg_enlaces', 'fg_trafico', 'fg_top'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''red''))', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter table public.fg_config enable row level security;
revoke all on public.fg_config from anon, authenticated;
grant select on public.fg_hallazgos, public.fg_equipos_vista to authenticated;

-- Quien ve la solapa Red también ve las vulnerabilidades de FortiOS (el resto de vuln_consultas sigue siendo de Seguridad)
do $$
begin
  if to_regclass('public.vuln_consultas') is null then return; end if;
  drop policy if exists vuln_consultas_fortios on public.vuln_consultas;
  create policy vuln_consultas_fortios on public.vuln_consultas for select to authenticated
    using (cpe = 'fortinet:fortios' and puede_ver('red'));
end $$;

do $$
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  drop trigger if exists trg_auditoria on public.fg_config;
  create trigger trg_auditoria after insert or update or delete on public.fg_config for each row execute function public.auditar();
end $$;

-- Funciones internas: sin acceso directo
revoke execute on function public.fg_ts(jsonb) from public, anon;
