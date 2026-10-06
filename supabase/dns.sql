-- ==========================================================
-- Infraestructura → DNS interno
--   * Un puente de solo lectura en UN servidor DNS del dominio (un controlador de dominio) envía cada hora
--     las zonas y los registros A, AAAA, CNAME y PTR, y prueba si cada IP responde (ping y, si no, puertos comunes).
--   * La app decide si cada registro está en uso combinando tres señales:
--       1. la fecha del registro (solo los dinámicos la tienen),
--       2. si la IP responde,
--       3. el cruce con Active Directory (equipo habilitado y con inicio de sesión reciente) y con el agente de inventario.
--   * Estados: activo, a revisar, sin uso. La app solo informa: no borra ni modifica nada en el DNS.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de monitoreo.sql y ad.sql (se puede repetir sin problema).
-- ==========================================================

create table if not exists public.dns_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  version_puente text,
  servidor text,                                -- servidor DNS donde corre el puente
  intervalo_min int,                            -- cada cuánto reporta (lo informa el puente)
  avisos jsonb not null default '[]',
  dias_sin_uso int not null default 30 check (dias_sin_uso between 15 and 365)
);
insert into public.dns_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.dns_zonas (
  nombre text primary key,
  tipo text,                                    -- Primary
  integrada boolean,                            -- integrada en Active Directory
  inversa boolean,
  dinamica text,                                -- actualizaciones dinámicas: Secure, NonsecureAndSecure, None
  aging boolean,                                -- caducidad (scavenging) activada en la zona
  leida boolean not null default true,          -- false = el puente no pudo leer sus registros en el último reporte
  registros int,
  actualizado timestamptz not null default now()
);

create table if not exists public.dns_registros (
  id bigserial primary key,
  zona text not null,
  nombre text not null,                         -- nombre dentro de la zona
  fqdn text not null,
  tipo text not null check (tipo in ('A', 'AAAA', 'CNAME', 'PTR')),
  dato text not null,                           -- IP (A, AAAA) o nombre de destino (CNAME, PTR)
  ip text,                                      -- PTR: la IP a la que corresponde
  estatico boolean not null default true,
  ts timestamptz,                               -- fecha del registro (solo dinámicos)
  ttl int,
  responde boolean,                             -- resultado del último chequeo (null = no se chequea)
  via text,                                     -- cómo respondió la última vez: ping, tcp:445, dns…
  ultima_respuesta timestamptz,
  ultimo_chequeo timestamptz,
  primera_vez timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  unique (zona, nombre, tipo, dato)
);
create index if not exists idx_dns_registros_dato on public.dns_registros (tipo, dato);
create index if not exists idx_dns_registros_fqdn on public.dns_registros (fqdn);

-- ----------------------------------------------------------
-- Lo llama el puente
-- ----------------------------------------------------------
create or replace function public.dns_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text; v_ahora timestamptz := now(); n int := 0;
begin
  select token_hash into v_hash from dns_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de DNS inválido';
  end if;

  if jsonb_typeof(p_datos -> 'zonas') = 'array' then
    insert into dns_zonas as z (nombre, tipo, integrada, inversa, dinamica, aging, leida, registros, actualizado)
    select distinct on (lower(x.nombre)) left(lower(x.nombre), 255), left(x.tipo, 30), x.integrada, coalesce(x.inversa, false), left(x.dinamica, 30),
           x.aging, coalesce(x.leida, true), x.registros, v_ahora
      from jsonb_to_recordset(p_datos -> 'zonas') as x(nombre text, tipo text, integrada boolean, inversa boolean, dinamica text,
                                                       aging boolean, leida boolean, registros int)
     where coalesce(x.nombre, '') <> ''
    on conflict (nombre) do update set tipo = excluded.tipo, integrada = excluded.integrada, inversa = excluded.inversa, dinamica = excluded.dinamica,
      aging = excluded.aging, leida = excluded.leida, registros = case when excluded.leida then excluded.registros else z.registros end,
      actualizado = v_ahora;
    delete from dns_zonas where actualizado < v_ahora;                                   -- zonas que ya no existen
    delete from dns_registros where zona not in (select nombre from dns_zonas);
  end if;

  if jsonb_typeof(p_datos -> 'registros') = 'array' then
    insert into dns_registros as r (zona, nombre, fqdn, tipo, dato, ip, estatico, ts, ttl, responde, via, ultima_respuesta, ultimo_chequeo, primera_vez, actualizado)
    select distinct on (lower(x.zona), lower(x.nombre), x.tipo, lower(x.dato))
           left(lower(x.zona), 255), left(lower(x.nombre), 255), left(lower(x.fqdn), 255), x.tipo, left(lower(x.dato), 255), nullif(left(x.ip, 60), ''),
           coalesce(x.estatico, true), x.ts, x.ttl, x.responde, case when x.responde then left(x.via, 20) end,
           case when x.responde then v_ahora end, case when x.responde is not null then v_ahora end, v_ahora, v_ahora
      from jsonb_to_recordset(p_datos -> 'registros') as x(zona text, nombre text, fqdn text, tipo text, dato text, ip text, estatico boolean,
                                                           ts timestamptz, ttl int, responde boolean, via text)
     where coalesce(x.zona, '') <> '' and coalesce(x.nombre, '') <> '' and coalesce(x.dato, '') <> '' and x.tipo in ('A', 'AAAA', 'CNAME', 'PTR')
     order by lower(x.zona), lower(x.nombre), x.tipo, lower(x.dato)
    on conflict (zona, nombre, tipo, dato) do update set fqdn = excluded.fqdn, ip = excluded.ip, estatico = excluded.estatico, ts = excluded.ts,
      ttl = excluded.ttl, responde = excluded.responde,
      via = case when excluded.responde then excluded.via else r.via end,
      ultima_respuesta = case when excluded.responde then v_ahora else r.ultima_respuesta end,
      ultimo_chequeo = case when excluded.responde is not null then v_ahora else r.ultimo_chequeo end,
      actualizado = v_ahora;
    get diagnostics n = row_count;
    -- Registros borrados del DNS (solo de las zonas que el puente pudo leer en este reporte)
    delete from dns_registros where actualizado < v_ahora and zona in (select nombre from dns_zonas where leida);
  end if;

  update dns_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20), servidor = left(p_datos ->> 'servidor', 100),
         intervalo_min = nullif(p_datos ->> 'intervalo', '')::int, avisos = coalesce(p_datos -> 'avisos', '[]')
   where id = 1;
  return jsonb_build_object('ok', true, 'registros', n);
end $$;
revoke all on function public.dns_reportar(text, jsonb) from public;
grant execute on function public.dns_reportar(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Lo que muestra la página: registros con su estado, y zonas
-- ----------------------------------------------------------
create or replace function public.dns_listar()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_dias int; v_desde timestamptz; v_r jsonb; v_z jsonb;
begin
  if not puede_ver('red') then raise exception 'Sin acceso'; end if;
  select dias_sin_uso into v_dias from dns_config where id = 1;
  v_desde := now() - make_interval(days => v_dias);

  with ad as (select lower(nombre) as host, bool_or(coalesce(habilitado, false)) as habilitado, max(ultimo_logon) as logon from ad_equipos group by 1),
  ag as (select lower(split_part(hostname, '.', 1)) as host, max(ultimo_reporte) as ultimo from inv_dispositivos where coalesce(hostname, '') <> '' group by 1),
  dup as (select tipo, dato, count(*) as n from dns_registros where tipo in ('A', 'AAAA') group by 1, 2),
  -- Registros de equipo (A y AAAA) con sus señales
  s as (
    select r.*, ad.host is not null as en_ad, ad.habilitado as ad_habilitado, ad.logon as ad_logon, ag.ultimo as agente, coalesce(dup.n, 1) as mismos,
           coalesce(r.ultima_respuesta > v_desde, false) as s_resp,
           coalesce(not r.estatico and r.ts > v_desde, false) as s_ts,
           -- la fecha vieja solo es evidencia si la zona tiene caducidad: sin ella el DNS no la renueva
           coalesce(not r.estatico and r.ts <= v_desde and z.aging, false) as ts_viejo,
           coalesce(ad.habilitado and ad.logon > v_desde, false) as s_ad,
           coalesce(ag.ultimo > v_desde, false) as s_ag
      from dns_registros r
      left join dns_zonas z on z.nombre = r.zona
      left join ad on ad.host = split_part(r.fqdn, '.', 1)
      left join ag on ag.host = split_part(r.fqdn, '.', 1)
      left join dup on dup.tipo = r.tipo and dup.dato = r.dato
     where r.tipo in ('A', 'AAAA')),
  h as (
    select s.*,
      case when s_ts or s_ad or s_ag then 'activo'
           when s_resp and (ts_viejo or en_ad) then 'revisar'
           when s_resp then 'activo'
           when ts_viejo or en_ad or primera_vez <= v_desde then 'sin_uso'
           else 'revisar' end as estado,
      case when s_ts or s_ad or s_ag then
             concat_ws(' · ', case when s_ad then 'equipo activo en Active Directory' end, case when s_ag then 'el agente de inventario reporta' end,
                       case when s_ts then 'se registró en el DNS hace poco' end, case when s_resp then 'la IP responde' end)
           when s_resp and (ts_viejo or en_ad) then
             'La IP responde, pero el nombre parece viejo (' ||
             concat_ws(' y ', case when ts_viejo then 'no se renueva en el DNS desde ' || to_char(ts at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') end,
                       case when en_ad and not coalesce(ad_habilitado, false) then 'el equipo está deshabilitado en Active Directory'
                            when en_ad then 'el equipo no inicia sesión en el dominio desde ' || coalesce(to_char(ad_logon at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), 'nunca') end) ||
             '): puede estar usando esa IP otro equipo'
           when s_resp then 'la IP responde'
           when ts_viejo or en_ad or primera_vez <= v_desde then
             concat_ws(' · ', case when primera_vez <= v_desde then 'La IP no responde hace más de ' || v_dias || ' días' else 'La IP no responde' end,
                       case when ts_viejo then 'no se renueva en el DNS desde ' || to_char(ts at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') end,
                       case when en_ad and not coalesce(ad_habilitado, false) then 'equipo deshabilitado en Active Directory'
                            when en_ad then 'sin inicio de sesión en el dominio desde ' || coalesce(to_char(ad_logon at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), 'nunca') end,
                       case when not en_ad then 'no figura en Active Directory' end)
           else 'La IP no responde. En observación: si sigue sin responder ' || v_dias || ' días desde que se lo vio por primera vez (' ||
                to_char(primera_vez at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') || '), pasa a sin uso' end as motivo
      from s),
  -- Alias: sirven si el destino existe y está en uso
  c as (
    select r.*,
      case when r.responde is false then 'sin_uso'
           when exists (select 1 from h where h.fqdn = r.dato) and not exists (select 1 from h where h.fqdn = r.dato and h.estado <> 'sin_uso') then 'revisar'
           when r.responde then 'activo' else 'revisar' end as estado,
      case when r.responde is false then 'Alias a un nombre que ya no resuelve (' || r.dato || ')'
           when exists (select 1 from h where h.fqdn = r.dato) and not exists (select 1 from h where h.fqdn = r.dato and h.estado <> 'sin_uso')
             then 'Alias a un registro que está sin uso (' || r.dato || ')'
           when r.responde then 'el destino resuelve' else 'Todavía no se pudo comprobar el destino' end as motivo
      from dns_registros r where r.tipo = 'CNAME'),
  -- Inversos: tienen que corresponder a un registro A en uso
  p as (
    select r.*,
      case when exists (select 1 from h where h.fqdn = r.dato and h.dato = r.ip and h.estado <> 'sin_uso') then 'activo'
           when exists (select 1 from h where h.fqdn = r.dato and h.dato = r.ip) then 'sin_uso'
           when exists (select 1 from dns_zonas z where not z.inversa and z.leida and r.dato like '%.' || z.nombre) then 'sin_uso'
           else 'revisar' end as estado,
      case when exists (select 1 from h where h.fqdn = r.dato and h.dato = r.ip and h.estado <> 'sin_uso') then 'corresponde a un registro A en uso'
           when exists (select 1 from h where h.fqdn = r.dato and h.dato = r.ip) then 'El registro A al que corresponde está sin uso'
           when exists (select 1 from dns_zonas z where not z.inversa and z.leida and r.dato like '%.' || z.nombre)
             then 'Inverso huérfano: no existe un registro A de ' || r.dato || ' con la IP ' || coalesce(r.ip, '—')
           else 'Apunta a un nombre de otra zona: no se puede comprobar desde acá' end as motivo
      from dns_registros r where r.tipo = 'PTR'),
  todo as (
    select id, zona, nombre, fqdn, tipo, dato, ip, estatico, ts, ttl, responde, via, ultima_respuesta, ultimo_chequeo, primera_vez, estado, motivo,
           en_ad, ad_habilitado, ad_logon, agente, mismos from h
    union all
    select id, zona, nombre, fqdn, tipo, dato, ip, estatico, ts, ttl, responde, via, ultima_respuesta, ultimo_chequeo, primera_vez, estado, motivo,
           null, null, null, null, 1 from c
    union all
    select id, zona, nombre, fqdn, tipo, dato, ip, estatico, ts, ttl, responde, via, ultima_respuesta, ultimo_chequeo, primera_vez, estado, motivo,
           null, null, null, null, 1 from p)
  select coalesce(jsonb_agg(to_jsonb(todo) order by fqdn, tipo, dato), '[]') into v_r from todo;

  select coalesce(jsonb_agg(to_jsonb(z) order by z.inversa, z.nombre), '[]') into v_z from dns_zonas z;
  return jsonb_build_object('registros', v_r, 'zonas', v_z, 'dias', v_dias);
end $$;
revoke execute on function public.dns_listar() from public, anon;
grant execute on function public.dns_listar() to authenticated;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.dns_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('red') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente, 'servidor', servidor,
    'intervalo_min', intervalo_min, 'avisos', avisos, 'dias_sin_uso', dias_sin_uso)
  end from dns_config where id = 1
$$;
revoke execute on function public.dns_estado() from public, anon;
grant execute on function public.dns_estado() to authenticated;

create or replace function public.dns_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update dns_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.dns_nuevo_puente(text) from public, anon;
grant execute on function public.dns_nuevo_puente(text) to authenticated;

create or replace function public.dns_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update dns_config set dias_sin_uso = coalesce((p ->> 'dias_sin_uso')::int, dias_sin_uso) where id = 1;
end $$;
revoke execute on function public.dns_config_guardar(jsonb) from public, anon;
grant execute on function public.dns_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Permisos: los datos se leen solo con dns_listar() (solapa Monitoreo de red) y los escribe solo el puente
-- ----------------------------------------------------------
alter table public.dns_config enable row level security;
alter table public.dns_zonas enable row level security;
alter table public.dns_registros enable row level security;
revoke all on public.dns_config, public.dns_zonas, public.dns_registros from anon, authenticated;

do $$
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  drop trigger if exists trg_auditoria on public.dns_config;
  create trigger trg_auditoria after insert or update or delete on public.dns_config for each row execute function public.auditar();
end $$;
