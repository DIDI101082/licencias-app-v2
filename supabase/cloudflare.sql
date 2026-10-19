-- ==========================================================
-- CLOUDFLARE (Perímetro → Cloudflare)
--   * Cada 15 minutos la tarea /api/cloudflare/auto lee la cuenta de Cloudflare con un token de
--     SOLO LECTURA (variable CLOUDFLARE_API_TOKEN en Vercel): zonas, registros DNS, configuración
--     de seguridad, certificados, tráfico de 7 días, eventos del firewall de 24 horas y la
--     auditoría de la cuenta (quién cambió qué y los inicios de sesión).
--   * El token nunca se guarda en la base. La app no puede cambiar nada en Cloudflare.
--   * Semáforo por dominio calculado acá (cf_controles), así la pantalla y las alertas usan la misma regla.
--   * Alertas (con su aviso a Teams): cambios en la cuenta, inicios de sesión, configuración débil,
--     certificado por vencer, pico de ataques y lectura caída. La primera lectura trae 30 días de
--     auditoría como historial, sin avisar.
-- Ejecutar en el SQL Editor, DESPUÉS de postura.sql, accesos.sql, alertas.sql e inicio.sql.
-- Se puede volver a ejecutar sin problema.
-- ==========================================================

create table if not exists public.cf_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default true,
  alertar_cambios boolean not null default true,
  alertar_logins boolean not null default true,
  alertar_config boolean not null default true,
  alertar_ataques boolean not null default true,
  umbral_mitigados int not null default 5000 check (umbral_mitigados > 0),
  dias_cert int not null default 15 check (dias_cert between 1 and 90),
  cuenta_id text,
  cuenta_nombre text,
  auditoria_hasta timestamptz,          -- hasta dónde se leyó la auditoría
  ultima_ejecucion timestamptz,
  ultimo_ok timestamptz,
  ultimo_error text,
  auditoria_error text,
  avisos jsonb not null default '[]',
  duracion_s int
);
insert into public.cf_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.cf_zonas (
  id text primary key,
  nombre text not null,
  estado text,                          -- active, pending, moved...
  pausada boolean not null default false,
  plan text,
  ns jsonb not null default '[]',
  ssl text, min_tls text, tls13 text, siempre_https text, hsts jsonb, reescritura_https text, nivel_seguridad text,
  dnssec text,
  cert_vence timestamptz, cert_emisor text, cert_estado text, cert_tipo text,
  eventos jsonb,                        -- firewall, últimas 24 h
  eventos_fecha timestamptz,
  errores jsonb not null default '{}',  -- partes que no se pudieron leer en la última corrida
  actualizado timestamptz not null default now(),
  primera_vez timestamptz not null default now()
);

create table if not exists public.cf_dns (
  id text primary key,
  zona_id text not null references public.cf_zonas(id) on delete cascade,
  nombre text not null,
  tipo text not null,
  contenido text not null default '',
  proxied boolean not null default false,
  proxiable boolean not null default false,
  ttl int,
  comentario text,
  modificado timestamptz,
  primera_vez timestamptz not null default now()
);
create index if not exists idx_cf_dns_zona on public.cf_dns (zona_id);

-- Registros "solo DNS" que muestran a propósito la IP del servidor (VPN, correo, etc.)
create table if not exists public.cf_dns_justif (
  nombre text not null,
  tipo text not null,
  nota text not null,
  por text,
  fecha timestamptz not null default now(),
  primary key (nombre, tipo)
);

create table if not exists public.cf_auditoria (
  id text primary key,
  fecha timestamptz not null,
  actor text, actor_tipo text, ip text, contexto text,
  accion text not null,                 -- create, update, delete, login...
  resultado text,
  producto text, recurso_tipo text, recurso_id text,
  zona text,
  categoria text not null default 'otro',   -- acceso, permisos, dns, seguridad, configuracion, zona, otro
  descripcion text,
  detalle text,
  avisar boolean not null default true,  -- false: vino en la primera lectura (historial)
  registrado timestamptz not null default now()
);
create index if not exists idx_cf_auditoria_fecha on public.cf_auditoria (fecha desc);

create table if not exists public.cf_trafico (
  zona_id text not null references public.cf_zonas(id) on delete cascade,
  dia date not null,
  solicitudes bigint not null default 0,
  cacheadas bigint not null default 0,
  amenazas bigint not null default 0,
  bytes bigint not null default 0,
  visitantes bigint not null default 0,
  primary key (zona_id, dia)
);

-- ----------------------------------------------------------
-- ¿La IP es pública? (registros A/AAAA que muestran el servidor real)
-- ----------------------------------------------------------
create or replace function public.cf_ip_publica(p text) returns boolean
language plpgsql immutable as $$
declare v inet;
begin
  begin v := p::inet; exception when others then return false; end;
  if family(v) = 4 then
    return not (v << '10.0.0.0/8' or v << '172.16.0.0/12' or v << '192.168.0.0/16' or v << '127.0.0.0/8'
                or v << '169.254.0.0/16' or v << '100.64.0.0/10' or v << '0.0.0.0/8');
  end if;
  return not (v << 'fc00::/7' or v << 'fe80::/10' or v = '::1'::inet);
end $$;

-- Registro que deja ver la IP real: A/AAAA a IP pública, sin el proxy de Cloudflare
create or replace function public.cf_expuesto(d cf_dns) returns boolean
language sql immutable as $$
  select d.tipo in ('A', 'AAAA') and not d.proxied and cf_ip_publica(d.contenido)
$$;

-- ----------------------------------------------------------
-- Semáforo por dominio: [{k, titulo, nivel (ok|aviso|mal|na|sin_dato), valor, texto}]
-- ----------------------------------------------------------
create or replace function public.cf_controles(p_zona text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  z cf_zonas;
  c cf_config;
  v_proxy int;
  v_expuestos int;
  r jsonb := '[]';
  n text;
  t text;
  v_dias numeric;
  v_sin_proxy text := 'No aplica: ningún registro pasa por el proxy de Cloudflare';
begin
  select * into z from cf_zonas where id = p_zona;
  if not found then return r; end if;
  select * into c from cf_config where id = 1;
  select count(*) filter (where proxied), count(*) filter (where cf_expuesto(d) and j.nombre is null)
    into v_proxy, v_expuestos
    from cf_dns d left join cf_dns_justif j on j.nombre = d.nombre and j.tipo = d.tipo
   where d.zona_id = z.id;

  -- Estado de la zona
  if z.pausada then n := 'mal'; t := 'Zona en pausa: Cloudflare solo resuelve el DNS, no protege ni cifra el tráfico';
  elsif coalesce(z.estado, '') <> 'active' then n := 'aviso'; t := 'Zona ' || coalesce(z.estado, 'sin estado') || ': los nameservers del dominio todavía no apuntan a Cloudflare';
  else n := 'ok'; t := 'Activa';
  end if;
  r := r || jsonb_build_object('k', 'zona', 'titulo', 'Estado de la zona', 'nivel', n, 'valor', case when z.pausada then 'en pausa' else z.estado end, 'texto', t);

  -- Modo SSL
  if v_proxy = 0 then n := 'na'; t := v_sin_proxy;
  elsif z.ssl is null then n := 'sin_dato'; t := 'No se pudo leer';
  elsif z.ssl = 'strict' then n := 'ok'; t := 'Full (strict): cifra hasta el servidor y valida su certificado';
  elsif z.ssl = 'full' then n := 'aviso'; t := 'Full: cifra hasta el servidor pero no valida su certificado (conviene Full strict)';
  elsif z.ssl = 'flexible' then n := 'mal'; t := 'Flexible: entre Cloudflare y el servidor el tráfico viaja sin cifrar';
  else n := 'mal'; t := 'SSL apagado: el sitio se sirve sin HTTPS';
  end if;
  r := r || jsonb_build_object('k', 'ssl', 'titulo', 'Modo SSL', 'nivel', n, 'valor', z.ssl, 'texto', t);

  -- TLS mínimo
  if v_proxy = 0 then n := 'na'; t := v_sin_proxy;
  elsif z.min_tls is null then n := 'sin_dato'; t := 'No se pudo leer';
  elsif z.min_tls in ('1.0', '1.1') then n := 'mal'; t := 'Acepta TLS ' || z.min_tls || ', versión insegura (se recomienda 1.2 o superior)';
  else n := 'ok'; t := 'TLS ' || z.min_tls || ' o superior';
  end if;
  r := r || jsonb_build_object('k', 'min_tls', 'titulo', 'TLS mínimo', 'nivel', n, 'valor', z.min_tls, 'texto', t);

  -- HTTPS forzado
  if v_proxy = 0 then n := 'na'; t := v_sin_proxy;
  elsif z.siempre_https is null then n := 'sin_dato'; t := 'No se pudo leer';
  elsif z.siempre_https = 'on' then n := 'ok'; t := 'Redirige todo el tráfico HTTP a HTTPS';
  else n := 'aviso'; t := 'Acepta conexiones HTTP sin cifrar (activar «Always Use HTTPS»)';
  end if;
  r := r || jsonb_build_object('k', 'https', 'titulo', 'HTTPS forzado', 'nivel', n, 'valor', z.siempre_https, 'texto', t);

  -- HSTS
  if v_proxy = 0 then n := 'na'; t := v_sin_proxy;
  elsif z.hsts is null then n := 'sin_dato'; t := 'No se pudo leer';
  elsif coalesce((z.hsts ->> 'enabled')::boolean, false) then
    n := 'ok'; t := 'Activado · ' || round(coalesce((z.hsts ->> 'max_age')::numeric, 0) / 86400) || ' días'
                    || case when (z.hsts ->> 'include_subdomains')::boolean then ' · incluye subdominios' else '' end;
  else n := 'aviso'; t := 'Desactivado: el navegador no recuerda que el sitio es solo HTTPS';
  end if;
  r := r || jsonb_build_object('k', 'hsts', 'titulo', 'HSTS', 'nivel', n, 'valor', case when coalesce((z.hsts ->> 'enabled')::boolean, false) then 'on' else 'off' end, 'texto', t);

  -- TLS 1.3
  if v_proxy = 0 then n := 'na'; t := v_sin_proxy;
  elsif z.tls13 is null then n := 'sin_dato'; t := 'No se pudo leer';
  elsif z.tls13 in ('on', 'zrt') then n := 'ok'; t := 'Habilitado';
  else n := 'aviso'; t := 'Deshabilitado';
  end if;
  r := r || jsonb_build_object('k', 'tls13', 'titulo', 'TLS 1.3', 'nivel', n, 'valor', z.tls13, 'texto', t);

  -- DNSSEC
  if z.dnssec is null then n := 'sin_dato'; t := 'No se pudo leer (requiere el permiso DNS: Read)';
  elsif z.dnssec = 'active' then n := 'ok'; t := 'Activo: las respuestas del DNS están firmadas';
  elsif z.dnssec = 'pending' then n := 'aviso'; t := 'Pendiente: falta cargar el registro DS en el registrador del dominio';
  else n := 'aviso'; t := 'Desactivado: las respuestas del DNS se pueden falsificar';
  end if;
  r := r || jsonb_build_object('k', 'dnssec', 'titulo', 'DNSSEC', 'nivel', n, 'valor', z.dnssec, 'texto', t);

  -- Certificado de borde
  if v_proxy = 0 then n := 'na'; t := v_sin_proxy;
  elsif z.cert_vence is null then n := 'sin_dato'; t := 'Sin certificado activo leído';
  else
    v_dias := floor(extract(epoch from (z.cert_vence - now())) / 86400);
    if v_dias < 0 then n := 'mal'; t := 'Vencido';
    elsif v_dias <= c.dias_cert then n := 'aviso'; t := 'Vence en ' || v_dias || ' días' || case when z.cert_tipo = 'universal' then ' (Cloudflare lo renueva solo)' else '' end;
    else n := 'ok'; t := 'Vence en ' || v_dias || ' días';
    end if;
  end if;
  r := r || jsonb_build_object('k', 'cert', 'titulo', 'Certificado', 'nivel', n, 'valor', z.cert_vence, 'texto', t);

  -- Registros que muestran la IP del servidor
  if v_expuestos > 0 then n := 'aviso'; t := v_expuestos || case when v_expuestos = 1 then ' registro muestra' else ' registros muestran' end
                                            || ' la IP real del servidor (solo DNS, sin justificar)';
  else n := 'ok'; t := 'Ningún registro sin justificar muestra la IP real del servidor';
  end if;
  r := r || jsonb_build_object('k', 'expuestos', 'titulo', 'IP de origen expuesta', 'nivel', n, 'valor', v_expuestos, 'texto', t);

  return r;
end $$;
revoke all on function public.cf_controles(text) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Tarea programada (se identifica con la clave CRON_SECRET)
-- ----------------------------------------------------------
create or replace function public.cf_auto_inicio(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  return (select jsonb_build_object('activo', activo, 'auditoria_hasta', auditoria_hasta) from cf_config where id = 1);
end $$;
revoke all on function public.cf_auto_inicio(text) from public, authenticated;
grant execute on function public.cf_auto_inicio(text) to anon;

create or replace function public.cf_auto_aplicar(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  z jsonb;
  a jsonb;
  ce jsonb;
  v_primera boolean;
  v_zonas int := 0;
  v_dns int := 0;
  v_nuevos int := 0;
  v_avisar int := 0;
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  v_primera := (select auditoria_hasta is null from cf_config where id = 1);

  for z in select * from jsonb_array_elements(coalesce(p -> 'zonas', '[]')) loop
    if coalesce(z ->> 'id', '') = '' then continue; end if;
    a  := case jsonb_typeof(z -> 'ajustes') when 'object' then z -> 'ajustes' end;
    ce := case jsonb_typeof(z -> 'cert') when 'object' then z -> 'cert' end;

    insert into cf_zonas as t (id, nombre, estado, pausada, plan, ns, ssl, min_tls, tls13, siempre_https, hsts, reescritura_https,
                               nivel_seguridad, dnssec, cert_vence, cert_emisor, cert_estado, cert_tipo, eventos, eventos_fecha, errores, actualizado)
    values (z ->> 'id', z ->> 'nombre', z ->> 'estado', coalesce((z ->> 'pausada')::boolean, false), z ->> 'plan', coalesce(z -> 'ns', '[]'),
            a ->> 'ssl', a ->> 'min_tls', a ->> 'tls13', a ->> 'siempre_https', case jsonb_typeof(a -> 'hsts') when 'object' then a -> 'hsts' end,
            a ->> 'reescritura_https', a ->> 'nivel_seguridad', z ->> 'dnssec',
            (ce ->> 'vence')::timestamptz, ce ->> 'emisor', ce ->> 'estado', ce ->> 'tipo',
            case jsonb_typeof(z -> 'eventos') when 'object' then z -> 'eventos' end,
            case jsonb_typeof(z -> 'eventos') when 'object' then now() end,
            coalesce(z -> 'errores', '{}'), now())
    on conflict (id) do update set
      nombre = excluded.nombre, estado = excluded.estado, pausada = excluded.pausada, plan = excluded.plan, ns = excluded.ns,
      -- si una parte no se pudo leer, se conserva el último dato bueno
      ssl = case when a is not null then excluded.ssl else t.ssl end,
      min_tls = case when a is not null then excluded.min_tls else t.min_tls end,
      tls13 = case when a is not null then excluded.tls13 else t.tls13 end,
      siempre_https = case when a is not null then excluded.siempre_https else t.siempre_https end,
      hsts = case when a is not null then excluded.hsts else t.hsts end,
      reescritura_https = case when a is not null then excluded.reescritura_https else t.reescritura_https end,
      nivel_seguridad = case when a is not null then excluded.nivel_seguridad else t.nivel_seguridad end,
      dnssec = case when (z -> 'errores') ? 'dnssec' then t.dnssec else excluded.dnssec end,
      cert_vence = case when (z -> 'errores') ? 'certificado' then t.cert_vence else excluded.cert_vence end,
      cert_emisor = case when (z -> 'errores') ? 'certificado' then t.cert_emisor else excluded.cert_emisor end,
      cert_estado = case when (z -> 'errores') ? 'certificado' then t.cert_estado else excluded.cert_estado end,
      cert_tipo = case when (z -> 'errores') ? 'certificado' then t.cert_tipo else excluded.cert_tipo end,
      eventos = coalesce(excluded.eventos, t.eventos),
      eventos_fecha = coalesce(excluded.eventos_fecha, t.eventos_fecha),
      errores = excluded.errores, actualizado = now();
    v_zonas := v_zonas + 1;

    -- Registros DNS: se reemplazan solo si se pudieron leer
    if jsonb_typeof(z -> 'registros') = 'array' then
      delete from cf_dns where zona_id = z ->> 'id'
         and id not in (select x ->> 'id' from jsonb_array_elements(z -> 'registros') x);
      insert into cf_dns as d (id, zona_id, nombre, tipo, contenido, proxied, proxiable, ttl, comentario, modificado)
      select x ->> 'id', z ->> 'id', lower(x ->> 'nombre'), x ->> 'tipo', left(coalesce(x ->> 'contenido', ''), 500),
             coalesce((x ->> 'proxied')::boolean, false), coalesce((x ->> 'proxiable')::boolean, false),
             (x ->> 'ttl')::int, left(x ->> 'comentario', 300), (x ->> 'modificado')::timestamptz
        from jsonb_array_elements(z -> 'registros') x
       where coalesce(x ->> 'id', '') <> ''
      on conflict (id) do update set
        nombre = excluded.nombre, tipo = excluded.tipo, contenido = excluded.contenido, proxied = excluded.proxied,
        proxiable = excluded.proxiable, ttl = excluded.ttl, comentario = excluded.comentario, modificado = excluded.modificado;
      v_dns := v_dns + jsonb_array_length(z -> 'registros');
    end if;

    -- Tráfico por día
    if jsonb_typeof(z -> 'trafico') = 'array' then
      insert into cf_trafico (zona_id, dia, solicitudes, cacheadas, amenazas, bytes, visitantes)
      select z ->> 'id', (x ->> 'dia')::date, coalesce((x ->> 'solicitudes')::bigint, 0), coalesce((x ->> 'cacheadas')::bigint, 0),
             coalesce((x ->> 'amenazas')::bigint, 0), coalesce((x ->> 'bytes')::bigint, 0), coalesce((x ->> 'visitantes')::bigint, 0)
        from jsonb_array_elements(z -> 'trafico') x
       where x ->> 'dia' is not null
      on conflict (zona_id, dia) do update set
        solicitudes = excluded.solicitudes, cacheadas = excluded.cacheadas, amenazas = excluded.amenazas,
        bytes = excluded.bytes, visitantes = excluded.visitantes;
    end if;
  end loop;

  -- Zonas que ya no están en la cuenta (nunca con una lista vacía)
  if jsonb_array_length(coalesce(p -> 'zonas', '[]')) > 0 then
    delete from cf_zonas where id not in (select x ->> 'id' from jsonb_array_elements(p -> 'zonas') x);
  end if;

  -- Auditoría
  with nuevos as (
    insert into cf_auditoria (id, fecha, actor, actor_tipo, ip, contexto, accion, resultado, producto, recurso_tipo, recurso_id,
                              zona, categoria, descripcion, detalle, avisar)
    select x ->> 'id', (x ->> 'fecha')::timestamptz, left(x ->> 'actor', 200), x ->> 'actor_tipo', left(x ->> 'ip', 60),
           x ->> 'contexto', coalesce(x ->> 'accion', 'otro'), x ->> 'resultado', left(x ->> 'producto', 100),
           left(x ->> 'recurso_tipo', 100), left(x ->> 'recurso_id', 200), x ->> 'zona', coalesce(x ->> 'categoria', 'otro'),
           left(x ->> 'descripcion', 300), left(x ->> 'detalle', 500), not v_primera
      from jsonb_array_elements(coalesce(p -> 'auditoria', '[]')) x
     where coalesce(x ->> 'id', '') <> '' and x ->> 'fecha' is not null
    on conflict (id) do nothing
    returning avisar
  )
  select count(*), count(*) filter (where avisar) into v_nuevos, v_avisar from nuevos;

  update cf_config set
    cuenta_id = coalesce(p -> 'cuenta' ->> 'id', cuenta_id),
    cuenta_nombre = coalesce(p -> 'cuenta' ->> 'nombre', cuenta_nombre),
    -- si la auditoría falló, la próxima corrida vuelve a leer desde el mismo punto
    auditoria_hasta = case when p ->> 'auditoria_error' is null then coalesce((p ->> 'auditoria_hasta')::timestamptz, now()) else auditoria_hasta end,
    auditoria_error = p ->> 'auditoria_error',
    avisos = coalesce(p -> 'avisos', '[]'),
    duracion_s = (p ->> 'duracion_s')::int,
    ultima_ejecucion = now(), ultimo_ok = now(), ultimo_error = null
  where id = 1;

  delete from cf_auditoria where fecha < now() - interval '2 years';
  delete from cf_trafico where dia < current_date - 400;

  -- Avisar ya, sin esperar la revisión de alertas de cada 10 minutos
  if v_avisar > 0 and to_regprocedure('public.alertas_evaluar(boolean)') is not null then
    begin
      perform alertas_evaluar(true);
    exception when others then null;   -- un problema con Teams no puede frenar la lectura
    end;
  end if;
  return jsonb_build_object('zonas', v_zonas, 'registros', v_dns, 'auditoria', v_nuevos, 'avisos', v_avisar, 'primera', v_primera);
end $$;
revoke all on function public.cf_auto_aplicar(text, jsonb) from public, authenticated;
grant execute on function public.cf_auto_aplicar(text, jsonb) to anon;

create or replace function public.cf_auto_error(p_token text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  update cf_config set ultima_ejecucion = now(), ultimo_error = left(p_error, 300) where id = 1;
end $$;
revoke all on function public.cf_auto_error(text, text) from public, authenticated;
grant execute on function public.cf_auto_error(text, text) to anon;

-- ----------------------------------------------------------
-- Pantalla
-- ----------------------------------------------------------
create or replace function public.cf_estado() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c cf_config;
begin
  if not puede_ver('seguridad') then raise exception 'Sin acceso'; end if;
  select * into c from cf_config where id = 1;
  return jsonb_build_object(
    'activo', c.activo, 'alertar_cambios', c.alertar_cambios, 'alertar_logins', c.alertar_logins, 'alertar_config', c.alertar_config,
    'alertar_ataques', c.alertar_ataques, 'umbral_mitigados', c.umbral_mitigados, 'dias_cert', c.dias_cert,
    'cuenta_nombre', c.cuenta_nombre, 'ultima_ejecucion', c.ultima_ejecucion, 'ultimo_ok', c.ultimo_ok, 'ultimo_error', c.ultimo_error,
    'auditoria_error', c.auditoria_error, 'auditoria_hasta', c.auditoria_hasta, 'avisos', c.avisos, 'duracion_s', c.duracion_s,
    'clave_configurada', coalesce((select token_hash is not null from prog_config where id = 1), false),
    'zonas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', z.id, 'nombre', z.nombre, 'estado', z.estado, 'pausada', z.pausada, 'plan', z.plan, 'ns', z.ns,
               'ssl', z.ssl, 'min_tls', z.min_tls, 'dnssec', z.dnssec, 'cert_vence', z.cert_vence, 'cert_emisor', z.cert_emisor, 'cert_tipo', z.cert_tipo,
               'eventos', z.eventos, 'eventos_fecha', z.eventos_fecha, 'errores', z.errores, 'actualizado', z.actualizado,
               'registros', (select count(*) from cf_dns d where d.zona_id = z.id),
               'con_proxy', (select count(*) from cf_dns d where d.zona_id = z.id and d.proxied),
               'controles', cf_controles(z.id)) order by z.nombre)
        from cf_zonas z), '[]'));
end $$;
revoke all on function public.cf_estado() from public, anon;
grant execute on function public.cf_estado() to authenticated;

create or replace function public.cf_listar() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not puede_ver('seguridad') then raise exception 'Sin acceso'; end if;
  return jsonb_build_object(
    'dns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'zona', z.nombre, 'nombre', d.nombre, 'tipo', d.tipo, 'contenido', d.contenido, 'proxied', d.proxied,
               'proxiable', d.proxiable, 'ttl', d.ttl, 'comentario', d.comentario, 'modificado', d.modificado, 'primera_vez', d.primera_vez,
               'expuesto', cf_expuesto(d), 'justificacion', j.nota, 'justif_por', j.por, 'justif_fecha', j.fecha)
               order by z.nombre, d.nombre, d.tipo)
        from cf_dns d join cf_zonas z on z.id = d.zona_id
        left join cf_dns_justif j on j.nombre = d.nombre and j.tipo = d.tipo), '[]'),
    'auditoria', coalesce((
      select jsonb_agg(to_jsonb(a) - 'registrado' order by a.fecha desc)
        from (select * from cf_auditoria where fecha > now() - interval '90 days' order by fecha desc limit 2000) a), '[]'),
    'trafico', coalesce((
      select jsonb_agg(jsonb_build_object('zona', z.nombre, 'dia', t.dia, 'solicitudes', t.solicitudes, 'cacheadas', t.cacheadas,
                                          'amenazas', t.amenazas, 'bytes', t.bytes, 'visitantes', t.visitantes) order by t.dia, z.nombre)
        from cf_trafico t join cf_zonas z on z.id = t.zona_id
       where t.dia > current_date - 31), '[]'));
end $$;
revoke all on function public.cf_listar() from public, anon;
grant execute on function public.cf_listar() to authenticated;

create or replace function public.cf_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede cambiar esta configuración'; end if;
  update cf_config set
    activo = coalesce((p ->> 'activo')::boolean, activo),
    alertar_cambios = coalesce((p ->> 'alertar_cambios')::boolean, alertar_cambios),
    alertar_logins = coalesce((p ->> 'alertar_logins')::boolean, alertar_logins),
    alertar_config = coalesce((p ->> 'alertar_config')::boolean, alertar_config),
    alertar_ataques = coalesce((p ->> 'alertar_ataques')::boolean, alertar_ataques),
    umbral_mitigados = greatest(1, coalesce((p ->> 'umbral_mitigados')::int, umbral_mitigados)),
    dias_cert = least(90, greatest(1, coalesce((p ->> 'dias_cert')::int, dias_cert)))
  where id = 1;
end $$;
revoke all on function public.cf_guardar(jsonb) from public, anon;
grant execute on function public.cf_guardar(jsonb) to authenticated;

create or replace function public.cf_justificar(p_nombre text, p_tipo text, p_nota text) returns void
language plpgsql security definer set search_path = public as $$
declare v_por text;
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede justificar registros'; end if;
  if length(trim(coalesce(p_nota, ''))) < 3 then raise exception 'Escribí el motivo (por ejemplo: «VPN de FortiClient, no admite proxy»)'; end if;
  select coalesce(nullif(nombre, ''), email) into v_por from perfiles where id = auth.uid();
  insert into cf_dns_justif (nombre, tipo, nota, por) values (lower(p_nombre), p_tipo, left(trim(p_nota), 300), v_por)
  on conflict (nombre, tipo) do update set nota = excluded.nota, por = excluded.por, fecha = now();
end $$;
revoke all on function public.cf_justificar(text, text, text) from public, anon;
grant execute on function public.cf_justificar(text, text, text) to authenticated;

create or replace function public.cf_quitar_justificacion(p_nombre text, p_tipo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede quitar justificaciones'; end if;
  delete from cf_dns_justif where nombre = lower(p_nombre) and tipo = p_tipo;
end $$;
revoke all on function public.cf_quitar_justificacion(text, text) from public, anon;
grant execute on function public.cf_quitar_justificacion(text, text) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.cf_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare
  c cf_config;
  zr record;
  k jsonb;
begin
  select * into c from cf_config where id = 1;
  if c.ultima_ejecucion is null then return; end if;   -- integración sin configurar

  -- Cambios en la cuenta (abiertos 7 días; salen una vez a Teams)
  if c.alertar_cambios then
    insert into _cond
    select 'cf:cambio:' || a.id, 'cloudflare',
           case when a.categoria = 'permisos' or (a.accion = 'delete' and a.categoria in ('dns', 'seguridad', 'zona')) then 'alta' else 'media' end,
           'Cloudflare: ' || case a.accion when 'create' then 'alta' when 'update' then 'cambio' when 'delete' then 'baja' else a.accion end
             || ' de ' || case a.categoria when 'dns' then 'registro DNS' when 'seguridad' then 'regla de seguridad' when 'configuracion' then 'configuración'
                                          when 'permisos' then 'permisos o tokens' when 'zona' then 'zona' else coalesce(a.recurso_tipo, 'recurso') end
             || coalesce(' en ' || a.zona, ''),
           concat_ws(' · ', a.detalle, 'por ' || coalesce(a.actor, 'desconocido'), case when a.ip is not null then 'desde ' || a.ip end,
                     case a.contexto when 'dash' then 'panel web' when 'api_token' then 'API' else a.contexto end,
                     case when a.resultado = 'failure' then 'FALLÓ' end,
                     to_char(a.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
           '/inventario/cloudflare?vista=cambios'
      from cf_auditoria a
     where a.avisar and a.accion <> 'login' and a.fecha > now() - interval '7 days'
     order by a.fecha desc limit 50
    on conflict do nothing;
  end if;

  -- Inicios de sesión (los fallidos se avisan siempre que estén activados los cambios o los inicios)
  if c.alertar_logins or c.alertar_cambios then
    insert into _cond
    select 'cf:login:' || a.id, 'cloudflare', case when a.resultado = 'failure' then 'alta' else 'media' end,
           case when a.resultado = 'failure' then 'Cloudflare: inicio de sesión fallido' else 'Cloudflare: inicio de sesión' end
             || coalesce(' de ' || a.actor, ''),
           concat_ws(' · ', case when a.ip is not null then 'desde ' || a.ip end,
                     to_char(a.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
           '/inventario/cloudflare?vista=cambios'
      from cf_auditoria a
     where a.avisar and a.accion = 'login' and a.fecha > now() - interval '7 days'
       and (a.resultado = 'failure' or c.alertar_logins)
     order by a.fecha desc limit 30
    on conflict do nothing;
  end if;

  -- Configuración débil (queda abierta mientras siga así) y certificado por vencer
  if c.alertar_config then
    for zr in select id, nombre from cf_zonas loop
      for k in select * from jsonb_array_elements(cf_controles(zr.id)) loop
        if k ->> 'nivel' = 'mal' or (k ->> 'k' = 'cert' and k ->> 'nivel' = 'aviso') then
          insert into _cond values ('cf:cfg:' || zr.id || ':' || (k ->> 'k'), 'cloudflare',
            case when k ->> 'nivel' = 'mal' then 'alta' else 'media' end,
            'Cloudflare ' || zr.nombre || ': ' || (k ->> 'titulo'), k ->> 'texto', '/inventario/cloudflare?vista=seguridad')
          on conflict do nothing;
        end if;
      end loop;
    end loop;
  end if;

  -- Pico de ataques (solicitudes frenadas o desafiadas en 24 h)
  if c.alertar_ataques then
    insert into _cond
    select 'cf:ataques:' || z.id, 'cloudflare', 'media',
           'Cloudflare ' || z.nombre || ': pico de ataques',
           replace(to_char((z.eventos ->> 'mitigados')::bigint, 'FM999,999,999'), ',', '.') || ' solicitudes frenadas en 24 h (umbral ' || c.umbral_mitigados || ')'
             || coalesce(' · principal origen ' || (z.eventos -> 'paises' -> 0 ->> 'k'), ''),
           '/inventario/cloudflare?vista=trafico'
      from cf_zonas z
     where z.eventos_fecha > now() - interval '2 hours'
       and coalesce((z.eventos ->> 'mitigados')::bigint, 0) >= c.umbral_mitigados
    on conflict do nothing;
  end if;

  -- La lectura dejó de funcionar
  if c.activo and coalesce(c.ultimo_ok, '-infinity') < now() - interval '2 hours' then
    insert into _cond values ('cf:lectura', 'cloudflare', 'media', 'Cloudflare: la lectura no funciona hace más de 2 horas',
      coalesce(c.ultimo_error, 'La tarea programada no está corriendo (revisá CLOUDFLARE_API_TOKEN y CRON_SECRET en Vercel)'),
      '/inventario/cloudflare')
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.cf_condiciones_alertas() from public, anon, authenticated;

-- Engancha las condiciones en la lista de "otros módulos" y suma Cloudflare a Integraciones, sin pisar lo que ya existe
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
  if position('cf_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.cf_condiciones_alertas()'') is not null then perform cf_condiciones_alertas(); end if;\n');
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
    if position('cf_config' in v_def) = 0 and position('  select coalesce(jsonb_agg(jsonb_build_object(' in v_def) > 0 then
      v_def := replace(v_def, '  select coalesce(jsonb_agg(jsonb_build_object(', $x$  begin
    insert into _int select 105, 'cloudflare', 'Cloudflare', 'Perímetro y nube', ultima_ejecucion is not null, ultimo_ok, 'API',
      (select count(*) from cf_zonas) || ' zona(s) · ' || (select count(*) from cf_dns) || ' registros DNS',
      coalesce(ultimo_error, auditoria_error), '/inventario/cloudflare', 45, 180 from cf_config where id = 1;
  exception when others then null; end;

  select coalesce(jsonb_agg(jsonb_build_object($x$);
      execute v_def;
    end if;
  end if;
end $$;

-- ----------------------------------------------------------
-- Permisos: se leen solo con cf_estado() / cf_listar(); se escriben solo desde la tarea y las funciones de arriba
-- ----------------------------------------------------------
alter table public.cf_config enable row level security;
alter table public.cf_zonas enable row level security;
alter table public.cf_dns enable row level security;
alter table public.cf_dns_justif enable row level security;
alter table public.cf_auditoria enable row level security;
alter table public.cf_trafico enable row level security;
revoke all on public.cf_config, public.cf_zonas, public.cf_dns, public.cf_dns_justif, public.cf_auditoria, public.cf_trafico from anon, authenticated;
