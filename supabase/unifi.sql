-- ==========================================================
-- WiFi y red UniFi (UDM Pro) → Accusys Cyber
--   * Un puente en un servidor interno consulta la UDM Pro (clave de API de solo lectura)
--     y envía cada pocos minutos: equipos UniFi, redes WiFi, clientes conectados y redes vecinas.
--     La UDM no queda publicada en internet.
--   * Dispositivos desconocidos: clientes que no coinciden con ningún equipo con agente,
--     ningún equipo del inventario ni la lista de aprobados.
--   * Posibles redes falsas: redes vecinas que usan el mismo nombre (SSID) que una red
--     de la empresa pero no son de nuestras antenas (técnica "evil twin").
--   * Antenas intrusas: redes que UniFi detecta conectadas a nuestra red cableada (rogue AP).
--   * Las alertas arrancan DESACTIVADAS: primero revisá y aprobá los dispositivos conocidos.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de servidores.sql.
-- ==========================================================

-- ----------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------
create table if not exists public.unifi_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  udm_url text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  version_puente text,
  ultimo_resumen jsonb,
  alertas boolean not null default false,
  alertar_aleatorias boolean not null default false,   -- MAC aleatoria: casi siempre celulares personales
  alertar_cableados boolean not null default false,    -- clientes por cable (impresoras, teléfonos IP, etc.)
  minutos_sin_reporte int not null default 20 check (minutos_sin_reporte between 5 and 720)
);
insert into public.unifi_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.unifi_equipos (
  mac text primary key,
  sitio text,
  nombre text,
  modelo text,
  tipo text,                 -- uap (antena), usw (switch), udm/ugw (gateway)
  ip text,
  firmware text,
  estado int,                -- 1 = conectado
  serie text,
  actualizable boolean,
  clientes int,
  bssids text[] not null default '{}',
  actualizado timestamptz not null default now()
);

create table if not exists public.unifi_redes (
  sitio text not null,
  ssid text not null,
  seguridad text,
  wpa text,
  wpa3 boolean,
  wpa3_transicion boolean,
  invitados boolean not null default false,
  habilitada boolean not null default true,
  oculta boolean,
  actualizado timestamptz not null default now(),
  primary key (sitio, ssid)
);

create table if not exists public.unifi_clientes (
  mac text primary key,
  sitio text,
  hostname text,
  nombre text,
  ip text,
  ssid text,
  ap_mac text,
  sw_mac text,
  cableado boolean not null default false,
  invitado boolean not null default false,
  fabricante text,
  red text,
  senal int,
  mac_aleatoria boolean not null default false,
  conectado boolean not null default false,
  primera_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now(),
  dispositivo_id uuid references public.inv_dispositivos(id) on delete set null,
  equipo_id uuid references public.inv_equipos(id) on delete set null
);
create index if not exists idx_unifi_clientes_conectado on public.unifi_clientes(conectado) where conectado;

-- Dispositivos que IT reconoce (impresoras, teléfonos IP, celulares corporativos, equipos de salas…)
create table if not exists public.unifi_conocidos (
  mac text primary key,
  descripcion text not null check (length(trim(descripcion)) > 0),
  aprobado_por text,
  aprobado_en timestamptz not null default now()
);

create table if not exists public.unifi_vecinas (
  bssid text primary key,
  sitio text,
  ssid text,
  canal int,
  senal int,
  seguridad text,
  fabricante text,
  visto_por text,            -- MAC de nuestra antena que la detectó
  es_rogue boolean not null default false,
  suplanta boolean not null default false,
  primera_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now()
);

-- ----------------------------------------------------------
-- Utilidades
-- ----------------------------------------------------------
-- MAC normalizada: aa:bb:cc:dd:ee:ff (acepta guiones, puntos o sin separador)
create or replace function public.unifi_mac(p text) returns text
language sql immutable as $$
  select case when length(h) = 12
              then substr(h,1,2)||':'||substr(h,3,2)||':'||substr(h,5,2)||':'||substr(h,7,2)||':'||substr(h,9,2)||':'||substr(h,11,2)
         end
    from (select lower(regexp_replace(coalesce(p, ''), '[^0-9a-fA-F]', '', 'g')) as h) x
$$;

-- Epoch en segundos (lo que devuelve UniFi) → timestamptz
create or replace function public.unifi_fecha(p jsonb) returns timestamptz
language sql immutable as $$
  select case when jsonb_typeof(p) = 'number' and (p::text)::numeric > 0 then to_timestamp((p::text)::numeric) end
$$;

-- ----------------------------------------------------------
-- Lo llama el puente
-- p_datos: {version, sitios:[…], equipos:[…], redes:[…], clientes:[…], vecinas:[…]}
-- ----------------------------------------------------------
create or replace function public.unifi_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  v_ahora timestamptz := now();
  e jsonb;
  v_mac text;
  n_eq int := 0; n_cl int := 0; n_ve int := 0; n_re int := 0;
begin
  select token_hash into v_hash from unifi_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente UniFi inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'clientes'), '') <> 'array' or coalesce(jsonb_typeof(p_datos -> 'equipos'), '') <> 'array' then
    raise exception 'Datos inválidos';
  end if;

  -- Equipos UniFi (antenas, switches, gateway)
  for e in select * from jsonb_array_elements(p_datos -> 'equipos') loop
    v_mac := unifi_mac(e ->> 'mac');
    continue when v_mac is null;
    insert into unifi_equipos as q (mac, sitio, nombre, modelo, tipo, ip, firmware, estado, serie, actualizable, clientes, bssids, actualizado)
    values (v_mac, left(e ->> 'sitio', 100), left(e ->> 'nombre', 100), left(e ->> 'modelo', 60), left(e ->> 'tipo', 20),
            left(e ->> 'ip', 60), left(e ->> 'firmware', 60), nullif(e ->> 'estado', '')::int, left(e ->> 'serie', 60),
            nullif(e ->> 'actualizable', '')::boolean, nullif(e ->> 'clientes', '')::int,
            coalesce((select array_agg(distinct unifi_mac(b)) from jsonb_array_elements_text(coalesce(e -> 'bssids', '[]')) b
                       where unifi_mac(b) is not null), '{}'),
            v_ahora)
    on conflict (mac) do update set sitio = excluded.sitio, nombre = excluded.nombre, modelo = excluded.modelo, tipo = excluded.tipo,
      ip = excluded.ip, firmware = excluded.firmware, estado = excluded.estado, serie = excluded.serie,
      actualizable = excluded.actualizable, clientes = excluded.clientes, bssids = excluded.bssids, actualizado = v_ahora;
    n_eq := n_eq + 1;
  end loop;
  delete from unifi_equipos where actualizado < v_ahora - interval '7 days';

  -- Redes WiFi de la empresa (sin contraseñas: el puente nunca las envía)
  if jsonb_typeof(p_datos -> 'redes') = 'array' then
    for e in select * from jsonb_array_elements(p_datos -> 'redes') loop
      continue when coalesce(e ->> 'ssid', '') = '';
      insert into unifi_redes as r (sitio, ssid, seguridad, wpa, wpa3, wpa3_transicion, invitados, habilitada, oculta, actualizado)
      values (coalesce(left(e ->> 'sitio', 100), ''), left(e ->> 'ssid', 64), left(e ->> 'seguridad', 30), left(e ->> 'wpa', 30),
              nullif(e ->> 'wpa3', '')::boolean, nullif(e ->> 'wpa3_transicion', '')::boolean,
              coalesce(nullif(e ->> 'invitados', '')::boolean, false), coalesce(nullif(e ->> 'habilitada', '')::boolean, true),
              nullif(e ->> 'oculta', '')::boolean, v_ahora)
      on conflict (sitio, ssid) do update set seguridad = excluded.seguridad, wpa = excluded.wpa, wpa3 = excluded.wpa3,
        wpa3_transicion = excluded.wpa3_transicion, invitados = excluded.invitados, habilitada = excluded.habilitada,
        oculta = excluded.oculta, actualizado = v_ahora;
      n_re := n_re + 1;
    end loop;
    delete from unifi_redes where actualizado < v_ahora;   -- redes borradas en la UDM
  end if;

  -- Clientes: la UDM informa solo los conectados ahora
  update unifi_clientes set conectado = false where conectado;
  for e in select * from jsonb_array_elements(p_datos -> 'clientes') loop
    v_mac := unifi_mac(e ->> 'mac');
    continue when v_mac is null;
    insert into unifi_clientes as c (mac, sitio, hostname, nombre, ip, ssid, ap_mac, sw_mac, cableado, invitado, fabricante, red, senal,
                                     mac_aleatoria, conectado, primera_vez, ultima_vez)
    values (v_mac, left(e ->> 'sitio', 100), nullif(left(e ->> 'hostname', 100), ''), nullif(left(e ->> 'nombre', 100), ''),
            nullif(left(e ->> 'ip', 60), ''), nullif(left(e ->> 'ssid', 64), ''), unifi_mac(e ->> 'ap_mac'), unifi_mac(e ->> 'sw_mac'),
            coalesce(nullif(e ->> 'cableado', '')::boolean, false), coalesce(nullif(e ->> 'invitado', '')::boolean, false),
            nullif(left(e ->> 'fabricante', 80), ''), nullif(left(e ->> 'red', 80), ''),
            case when e ->> 'senal' ~ '^-?\d+$' then (e ->> 'senal')::int end,
            substr(v_mac, 2, 1) in ('2', '6', 'a', 'e'), true,
            coalesce(unifi_fecha(e -> 'primera'), v_ahora), coalesce(unifi_fecha(e -> 'ultima'), v_ahora))
    on conflict (mac) do update set sitio = excluded.sitio, hostname = coalesce(excluded.hostname, c.hostname),
      nombre = coalesce(excluded.nombre, c.nombre), ip = excluded.ip, ssid = excluded.ssid, ap_mac = excluded.ap_mac,
      sw_mac = excluded.sw_mac, cableado = excluded.cableado, invitado = excluded.invitado,
      fabricante = coalesce(excluded.fabricante, c.fabricante), red = excluded.red, senal = excluded.senal,
      conectado = true, primera_vez = least(c.primera_vez, excluded.primera_vez), ultima_vez = excluded.ultima_vez;
    n_cl := n_cl + 1;
  end loop;

  -- Cruce con el agente (por MAC, nombre de equipo o IP actual) y con el inventario (por MAC)
  update unifi_clientes c set
    dispositivo_id = (
      select d.id from inv_dispositivos d
       where d.estado_registro = 'aprobado'
         and (unifi_mac(d.mac) = c.mac
              or (c.hostname is not null and lower(split_part(d.hostname, '.', 1)) = lower(split_part(c.hostname, '.', 1)))
              or (c.ip is not null and d.ultimo_reporte > v_ahora - interval '30 minutes'
                  and (d.ip = c.ip or exists (select 1 from jsonb_array_elements(coalesce(d.redes, '[]')) x where x ->> 'ip' = c.ip))))
       order by (unifi_mac(d.mac) = c.mac) desc, d.ultimo_reporte desc
       limit 1),
    equipo_id = (select q.id from inv_equipos q where unifi_mac(q.mac) = c.mac limit 1)
  where c.conectado;
  delete from unifi_clientes where ultima_vez < v_ahora - interval '60 days';

  -- Redes vecinas (las que detectan nuestras antenas)
  if jsonb_typeof(p_datos -> 'vecinas') = 'array' then
    for e in select * from jsonb_array_elements(p_datos -> 'vecinas') loop
      v_mac := unifi_mac(e ->> 'bssid');
      continue when v_mac is null;
      insert into unifi_vecinas as v (bssid, sitio, ssid, canal, senal, seguridad, fabricante, visto_por, es_rogue, primera_vez, ultima_vez)
      values (v_mac, left(e ->> 'sitio', 100), nullif(left(e ->> 'ssid', 64), ''),
              case when e ->> 'canal' ~ '^\d+$' then (e ->> 'canal')::int end,
              case when e ->> 'senal' ~ '^-?\d+$' then (e ->> 'senal')::int end,
              nullif(left(e ->> 'seguridad', 30), ''), nullif(left(e ->> 'fabricante', 80), ''), unifi_mac(e ->> 'visto_por'),
              coalesce(nullif(e ->> 'es_rogue', '')::boolean, false),
              coalesce(unifi_fecha(e -> 'ultima'), v_ahora), coalesce(unifi_fecha(e -> 'ultima'), v_ahora))
      on conflict (bssid) do update set sitio = excluded.sitio, ssid = coalesce(excluded.ssid, v.ssid), canal = excluded.canal,
        senal = excluded.senal, seguridad = excluded.seguridad, fabricante = coalesce(excluded.fabricante, v.fabricante),
        visto_por = excluded.visto_por, es_rogue = excluded.es_rogue,
        ultima_vez = greatest(v.ultima_vez, excluded.ultima_vez);
      n_ve := n_ve + 1;
    end loop;
  end if;
  -- Posible red falsa: mismo nombre que una red nuestra, pero no es de nuestras antenas
  update unifi_vecinas v set suplanta = (
    v.ssid is not null
    and exists (select 1 from unifi_redes r where r.habilitada and lower(r.ssid) = lower(v.ssid))
    and not exists (select 1 from unifi_equipos q where v.bssid = any(q.bssids) or q.mac = v.bssid));
  delete from unifi_vecinas where ultima_vez < v_ahora - interval '30 days';

  update unifi_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20),
    ultimo_resumen = jsonb_build_object('equipos', n_eq, 'redes', n_re, 'clientes', n_cl, 'vecinas', n_ve)
   where id = 1;
  return jsonb_build_object('ok', true, 'equipos', n_eq, 'redes', n_re, 'clientes', n_cl, 'vecinas', n_ve);
end $$;
revoke all on function public.unifi_reportar(text, jsonb) from public;
grant execute on function public.unifi_reportar(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Vista para la pantalla: cada cliente con su estado (respeta los permisos de quien consulta)
-- ----------------------------------------------------------
create or replace view public.unifi_clientes_vista with (security_invoker = true) as
select c.*,
       k.descripcion as conocido_descripcion,
       d.hostname as agente_hostname,
       q.codigo as inventario_codigo,
       ap.nombre as ap_nombre,
       (c.dispositivo_id is not null or c.equipo_id is not null or k.mac is not null) as conocido,
       (c.cableado or exists (select 1 from unifi_redes r where r.ssid = c.ssid and not r.invitados)) and not c.invitado as corporativa
  from unifi_clientes c
  left join unifi_conocidos k on k.mac = c.mac
  left join inv_dispositivos d on d.id = c.dispositivo_id
  left join inv_equipos q on q.id = c.equipo_id
  left join unifi_equipos ap on ap.mac = c.ap_mac;

-- ----------------------------------------------------------
-- Configuración y estado
-- ----------------------------------------------------------
create or replace function public.unifi_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('seguridad') then jsonb_build_object(
    'configurado', token_hash is not null, 'udm_url', udm_url, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'resumen', ultimo_resumen, 'alertas', alertas, 'alertar_aleatorias', alertar_aleatorias, 'alertar_cableados', alertar_cableados,
    'minutos_sin_reporte', minutos_sin_reporte)
  end from unifi_config where id = 1
$$;
grant execute on function public.unifi_estado() to authenticated;

-- Nuevo puente: guarda solo la huella del token (el token viaja únicamente dentro del instalador)
create or replace function public.unifi_nuevo_puente(p_token_hash text, p_udm_url text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update unifi_config set token_hash = p_token_hash, udm_url = left(p_udm_url, 200), creado_en = now() where id = 1;
end $$;
grant execute on function public.unifi_nuevo_puente(text, text) to authenticated;

create or replace function public.unifi_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update unifi_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    alertar_aleatorias = coalesce((p ->> 'alertar_aleatorias')::boolean, alertar_aleatorias),
    alertar_cableados = coalesce((p ->> 'alertar_cableados')::boolean, alertar_cableados),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte)
  where id = 1;
end $$;
grant execute on function public.unifi_config_guardar(jsonb) to authenticated;

-- Quién aprobó cada dispositivo conocido
create or replace function public.unifi_conocidos_autor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.mac := unifi_mac(new.mac);
  if new.mac is null then raise exception 'MAC inválida'; end if;
  new.aprobado_por := (select coalesce(nombre, email) from perfiles where id = auth.uid());
  new.aprobado_en := now();
  return new;
end $$;
drop trigger if exists trg_unifi_conocidos_autor on public.unifi_conocidos;
create trigger trg_unifi_conocidos_autor before insert or update on public.unifi_conocidos
  for each row execute function public.unifi_conocidos_autor();

-- ----------------------------------------------------------
-- Alertas (se suman al motor de Logs → Alertas por el gancho de otros módulos)
-- ----------------------------------------------------------
create or replace function public.unifi_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c unifi_config;
begin
  select * into c from unifi_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  -- El puente dejó de reportar
  if c.ultimo_reporte is null or c.ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte) then
    insert into _cond values ('wifi:puente', 'wifi', 'alta', 'El puente de UniFi dejó de reportar',
      coalesce('Último reporte ' || to_char(c.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'),
      '/inventario/wifi')
    on conflict do nothing;
    return;   -- sin datos frescos no se evalúa el resto (se mantienen las abiertas hasta que vuelva)
  end if;

  -- Posible red falsa (evil twin): mismo nombre que una red nuestra, vista en las últimas 2 horas
  insert into _cond
  select 'wifi:falsa:' || v.bssid, 'wifi', 'critica',
         'Posible red WiFi falsa: ' || v.ssid,
         concat_ws(' · ', 'BSSID ' || v.bssid, 'detectada por ' || coalesce(ap.nombre, v.visto_por), nullif(v.fabricante, ''),
                   case when v.senal is not null then 'señal ' || v.senal || ' dBm' end),
         '/inventario/wifi?vista=vecinas'
    from unifi_vecinas v left join unifi_equipos ap on ap.mac = v.visto_por
   where v.suplanta and v.ultima_vez > now() - interval '2 hours'
  on conflict do nothing;

  -- Antena no autorizada conectada a nuestra red cableada (rogue AP)
  insert into _cond
  select 'wifi:rogue:' || v.bssid, 'wifi', 'alta',
         'Antena WiFi no autorizada en la red: ' || coalesce(v.ssid, v.bssid),
         concat_ws(' · ', 'BSSID ' || v.bssid, nullif(v.fabricante, ''), 'detectada por ' || coalesce(ap.nombre, v.visto_por)),
         '/inventario/wifi?vista=vecinas'
    from unifi_vecinas v left join unifi_equipos ap on ap.mac = v.visto_por
   where v.es_rogue and not v.suplanta and v.ultima_vez > now() - interval '2 hours'
  on conflict do nothing;

  -- Dispositivo desconocido conectado ahora a una red de la empresa
  insert into _cond
  select 'wifi:desconocido:' || x.mac, 'wifi',
         case when x.mac_aleatoria then 'media' else 'alta' end,
         'Dispositivo desconocido en ' || case when x.cableado then 'la red cableada' else 'el WiFi ' || coalesce(x.ssid, '') end
           || ': ' || coalesce(x.hostname, x.nombre, x.fabricante, x.mac),
         concat_ws(' · ', 'MAC ' || x.mac || case when x.mac_aleatoria then ' (aleatoria)' else '' end, nullif(x.fabricante, ''),
                   'IP ' || x.ip, 'antena ' || x.ap_nombre),
         '/inventario/wifi'
    from unifi_clientes_vista x
   where x.conectado and x.corporativa and not x.conocido
     and (c.alertar_aleatorias or not x.mac_aleatoria)
     and (c.alertar_cableados or not x.cableado)
  on conflict do nothing;
end $$;
revoke all on function public.unifi_condiciones_alertas() from public, anon, authenticated;

-- Gancho común (incluye las condiciones de Backups y Servidores, sin cambios)
create or replace function public.alertas_condiciones_extra()
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.backups_condiciones_alertas()') is not null then perform backups_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_condiciones_alertas()') is not null then perform srv_condiciones_alertas(); end if;
  if to_regprocedure('public.unifi_condiciones_alertas()') is not null then perform unifi_condiciones_alertas(); end if;
end $$;
revoke all on function public.alertas_condiciones_extra() from public, anon, authenticated;

-- Asegura que el motor de alertas llame al gancho (si ya lo hace, no cambia nada)
do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_evaluar(boolean)') is null then
    raise notice 'Falta alertas.sql: la pantalla WiFi funciona, pero sin alertas';
    return;
  end if;
  v_def := pg_get_functiondef('public.alertas_evaluar(boolean)'::regprocedure);
  if position('alertas_condiciones_extra' in v_def) > 0 then return; end if;
  if position('-- Abrir las nuevas' in v_def) = 0 then
    raise notice 'No se encontró dónde agregar el gancho en alertas_evaluar; WiFi queda sin alertas';
    return;
  end if;
  v_def := replace(v_def, '-- Abrir las nuevas',
    E'-- Condiciones de otros módulos (backups, servidores, wifi, etc.)\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
  execute v_def;
end $$;

-- ----------------------------------------------------------
-- Permisos: se ve con la solapa Seguridad. Los datos los escribe solo el puente.
-- Aprobar dispositivos conocidos: administrador o lectura y escritura.
-- ----------------------------------------------------------
alter table public.unifi_config enable row level security;
alter table public.unifi_equipos enable row level security;
alter table public.unifi_redes enable row level security;
alter table public.unifi_clientes enable row level security;
alter table public.unifi_conocidos enable row level security;
alter table public.unifi_vecinas enable row level security;

revoke all on public.unifi_config from anon, authenticated;

drop policy if exists unifi_equipos_select on public.unifi_equipos;
create policy unifi_equipos_select on public.unifi_equipos for select to authenticated using (puede_ver('seguridad'));
drop policy if exists unifi_redes_select on public.unifi_redes;
create policy unifi_redes_select on public.unifi_redes for select to authenticated using (puede_ver('seguridad'));
drop policy if exists unifi_clientes_select on public.unifi_clientes;
create policy unifi_clientes_select on public.unifi_clientes for select to authenticated using (puede_ver('seguridad'));
drop policy if exists unifi_vecinas_select on public.unifi_vecinas;
create policy unifi_vecinas_select on public.unifi_vecinas for select to authenticated using (puede_ver('seguridad'));
revoke insert, update, delete on public.unifi_equipos, public.unifi_redes, public.unifi_clientes, public.unifi_vecinas from anon, authenticated;

drop policy if exists unifi_conocidos_select on public.unifi_conocidos;
create policy unifi_conocidos_select on public.unifi_conocidos for select to authenticated using (puede_ver('seguridad'));
drop policy if exists unifi_conocidos_escribir on public.unifi_conocidos;
create policy unifi_conocidos_escribir on public.unifi_conocidos for all to authenticated
  using (puede_ver('seguridad') and mi_rol() in ('administrador', 'lectura_escritura'))
  with check (puede_ver('seguridad') and mi_rol() in ('administrador', 'lectura_escritura'));

grant select on public.unifi_clientes_vista to authenticated;

-- Registro en Logs (la configuración y los dispositivos aprobados)
do $$
declare t text;
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  foreach t in array array['unifi_config', 'unifi_conocidos'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
