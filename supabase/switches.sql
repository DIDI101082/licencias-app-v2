-- ==========================================================
-- Red → Switches (SNMP v2c, solo lectura)
--   * Un puente en un servidor interno consulta por SNMP los switches cargados en la app
--     (DCN, Cisco, MikroTik o cualquier marca con IF-MIB) cada pocos minutos y envía:
--     estado de cada puerto, velocidad, tráfico, errores, tabla de direcciones MAC, vecinos
--     (LLDP / CDP) y consumo PoE. La community queda solo en el servidor del puente.
--   * Con la tabla MAC se sabe qué equipo hay en cada boca (cruzado con el agente, el inventario
--     y UniFi) y se detectan dispositivos desconocidos conectados por cable.
--   * Alertas (arrancan apagadas): switch sin respuesta o reiniciado, enlace troncal caído,
--     puerto que se cae y vuelve, puerto con errores o saturado, PoE al límite, desconocidos.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de unifi.sql (usa su lista de dispositivos aprobados).
-- ==========================================================

-- ----------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------
create table if not exists public.sw_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  version_puente text,
  alertas boolean not null default false,
  alertar_desconocidos boolean not null default false,
  umbral_uso int not null default 85 check (umbral_uso between 10 and 100),
  umbral_errores int not null default 100 check (umbral_errores between 1 and 1000000),
  minutos_sin_reporte int not null default 20 check (minutos_sin_reporte between 5 and 720)
);
insert into public.sw_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.sw_switches (
  id serial primary key,
  nombre text not null check (length(trim(nombre)) > 0),
  ip text not null unique check (ip ~ '^[A-Za-z0-9.\-]+(:\d{1,5})?$'),
  zona text,
  notas text,
  activo boolean not null default true,
  -- lo que informa el puente
  responde boolean,
  sys_nombre text,
  sys_descr text,
  uptime_seg bigint,
  poe_total numeric,
  poe_uso numeric,
  ultimo_ok timestamptz,
  ultimo_intento timestamptz,
  ultimo_error text,
  reinicio_en timestamptz,
  creado_en timestamptz not null default now()
);

create table if not exists public.sw_puertos (
  switch_id int not null references public.sw_switches(id) on delete cascade,
  ifindex int not null,
  nombre text,
  descr text,
  alias text,
  tipo int,
  admin_up boolean,
  oper_up boolean,
  velocidad_mbps numeric,
  in_octets numeric,
  out_octets numeric,
  in_bps numeric,
  out_bps numeric,
  uso_pct numeric,
  err_total numeric,
  err_delta numeric,
  ultimo_cambio timestamptz,
  cambios_1h int not null default 0,
  troncal boolean,                             -- fijado a mano (vacío = automático)
  troncal_detectado boolean not null default false,   -- se marca solo y no se desmarca (un troncal caído pierde su vecino)
  vecino text,
  vecino_puerto text,
  vecino_protocolo text,
  macs int not null default 0,
  actualizado timestamptz not null default now(),
  primary key (switch_id, ifindex)
);

create table if not exists public.sw_macs (
  switch_id int not null references public.sw_switches(id) on delete cascade,
  mac text not null,
  vlan int not null default 0,
  ifindex int not null,
  primera_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now(),
  primary key (switch_id, mac, vlan)
);
create index if not exists idx_sw_macs_mac on public.sw_macs(mac);
create index if not exists idx_sw_macs_puerto on public.sw_macs(switch_id, ifindex);

create table if not exists public.sw_eventos (
  id bigserial primary key,
  switch_id int not null references public.sw_switches(id) on delete cascade,
  ifindex int,
  tipo text not null check (tipo in ('caido', 'activo', 'reinicio', 'sin_respuesta', 'responde')),
  detalle text,
  fecha timestamptz not null default now()
);
create index if not exists idx_sw_eventos_fecha on public.sw_eventos(fecha desc);
create index if not exists idx_sw_eventos_puerto on public.sw_eventos(switch_id, ifindex, fecha desc);

-- ----------------------------------------------------------
-- El puente pide la lista de switches a consultar
-- ----------------------------------------------------------
create or replace function public.sw_objetivos(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_hash text;
begin
  select token_hash into v_hash from sw_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de switches inválido';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ip', ip) order by id) from sw_switches where activo), '[]'::jsonb);
end $$;
revoke all on function public.sw_objetivos(text) from public;
grant execute on function public.sw_objetivos(text) to anon, authenticated;

-- ----------------------------------------------------------
-- El puente envía lo que leyó
-- ----------------------------------------------------------
create or replace function public.sw_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  v_ahora timestamptz := now();
  s jsonb; p jsonb; m jsonb; v jsonb;
  v_sw sw_switches;
  v_ant sw_puertos;
  v_up bigint;
  v_in numeric; v_out numeric; v_err numeric; v_dt numeric;
  v_inbps numeric; v_outbps numeric;
  v_oper boolean; v_admin boolean; v_vel numeric; v_cambio numeric;
  v_mac text;
  n_ok int := 0; n_err int := 0;
begin
  select token_hash into v_hash from sw_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de switches inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'switches'), '') <> 'array' then raise exception 'Datos inválidos'; end if;

  for s in select * from jsonb_array_elements(p_datos -> 'switches') loop
    select * into v_sw from sw_switches where id = (s ->> 'id')::int and activo;
    continue when not found;

    -- No respondió
    if not coalesce((s ->> 'ok')::boolean, false) then
      if v_sw.responde is distinct from false then
        insert into sw_eventos (switch_id, tipo, detalle) values (v_sw.id, 'sin_respuesta', left(s ->> 'error', 300));
      end if;
      update sw_switches set responde = false, ultimo_intento = v_ahora, ultimo_error = left(s ->> 'error', 300) where id = v_sw.id;
      n_err := n_err + 1;
      continue;
    end if;

    v_up := case when s ->> 'uptime' ~ '^\d+$' then (s ->> 'uptime')::bigint / 100 end;
    if v_sw.responde is false then
      insert into sw_eventos (switch_id, tipo) values (v_sw.id, 'responde');
    end if;
    -- Reinicio: el tiempo encendido bajó respecto del reporte anterior
    if v_up is not null and v_sw.uptime_seg is not null and v_up + 60 < v_sw.uptime_seg then
      insert into sw_eventos (switch_id, tipo, detalle) values (v_sw.id, 'reinicio', 'Encendido hace ' || (v_up / 60) || ' minutos');
    end if;
    update sw_switches set responde = true, ultimo_ok = v_ahora, ultimo_intento = v_ahora, ultimo_error = null,
      sys_nombre = left(s ->> 'sys_nombre', 100), sys_descr = left(s ->> 'sys_descr', 300), uptime_seg = v_up,
      reinicio_en = case when v_up is not null then v_ahora - make_interval(secs => v_up) else reinicio_en end,
      poe_total = case when s ->> 'poe_total' ~ '^[\d.]+$' then (s ->> 'poe_total')::numeric end,
      poe_uso = case when s ->> 'poe_uso' ~ '^[\d.]+$' then (s ->> 'poe_uso')::numeric end
     where id = v_sw.id;

    -- Puertos
    for p in select * from jsonb_array_elements(coalesce(s -> 'puertos', '[]')) loop
      continue when coalesce(p ->> 'ifindex', '') !~ '^\d+$';
      select * into v_ant from sw_puertos where switch_id = v_sw.id and ifindex = (p ->> 'ifindex')::int;
      v_in := case when p ->> 'in' ~ '^\d+$' then (p ->> 'in')::numeric end;
      v_out := case when p ->> 'out' ~ '^\d+$' then (p ->> 'out')::numeric end;
      v_err := coalesce(case when p ->> 'err_in' ~ '^\d+$' then (p ->> 'err_in')::numeric end, 0)
             + coalesce(case when p ->> 'err_out' ~ '^\d+$' then (p ->> 'err_out')::numeric end, 0);
      v_oper := (p ->> 'oper') = '1';
      v_admin := (p ->> 'admin') = '1';
      v_vel := case when p ->> 'velocidad' ~ '^[\d.]+$' then (p ->> 'velocidad')::numeric end;
      v_cambio := case when p ->> 'cambio' ~ '^\d+$' then (p ->> 'cambio')::numeric / 100 end;
      v_dt := case when v_ant.actualizado is not null then extract(epoch from v_ahora - v_ant.actualizado) end;
      -- Tráfico: diferencia de contadores (si el contador se reinició o dio la vuelta, no se calcula)
      v_inbps := case when v_dt between 30 and 3600 and v_in >= v_ant.in_octets then round((v_in - v_ant.in_octets) * 8 / v_dt) end;
      v_outbps := case when v_dt between 30 and 3600 and v_out >= v_ant.out_octets then round((v_out - v_ant.out_octets) * 8 / v_dt) end;

      if v_ant.switch_id is not null and v_admin and v_ant.oper_up is distinct from v_oper then
        insert into sw_eventos (switch_id, ifindex, tipo, detalle)
        values (v_sw.id, (p ->> 'ifindex')::int, case when v_oper then 'activo' else 'caido' end, left(coalesce(p ->> 'nombre', ''), 100));
      end if;

      insert into sw_puertos as t (switch_id, ifindex, nombre, descr, alias, tipo, admin_up, oper_up, velocidad_mbps,
                                   in_octets, out_octets, in_bps, out_bps, uso_pct, err_total, err_delta, ultimo_cambio,
                                   troncal_detectado, actualizado)
      values (v_sw.id, (p ->> 'ifindex')::int, left(p ->> 'nombre', 100), left(p ->> 'descr', 200), nullif(left(p ->> 'alias', 200), ''),
              nullif(p ->> 'tipo', '')::int, v_admin, v_oper, v_vel, v_in, v_out, v_inbps, v_outbps,
              case when v_vel > 0 and v_oper then round(greatest(coalesce(v_inbps, 0), coalesce(v_outbps, 0)) * 100 / (v_vel * 1000000), 1) end,
              v_err,
              case when v_ant.err_total is not null and v_err >= v_ant.err_total then v_err - v_ant.err_total end,
              case when v_cambio > 0 and v_up is not null and v_cambio <= v_up then v_ahora - make_interval(secs => v_up - v_cambio) end,
              coalesce(p ->> 'alias', '') ~* '(uplink|troncal|trunk|core|fibra|backbone)',
              v_ahora)
      on conflict (switch_id, ifindex) do update set nombre = excluded.nombre, descr = excluded.descr, alias = excluded.alias,
        tipo = excluded.tipo, admin_up = excluded.admin_up, oper_up = excluded.oper_up, velocidad_mbps = excluded.velocidad_mbps,
        in_octets = excluded.in_octets, out_octets = excluded.out_octets, in_bps = excluded.in_bps, out_bps = excluded.out_bps,
        uso_pct = excluded.uso_pct, err_total = excluded.err_total, err_delta = excluded.err_delta,
        ultimo_cambio = coalesce(excluded.ultimo_cambio, t.ultimo_cambio),
        troncal_detectado = t.troncal_detectado or excluded.troncal_detectado, actualizado = v_ahora;
    end loop;
    delete from sw_puertos where switch_id = v_sw.id and actualizado < v_ahora;

    -- Tabla MAC
    for m in select * from jsonb_array_elements(coalesce(s -> 'macs', '[]')) loop
      v_mac := unifi_mac(m ->> 'mac');
      continue when v_mac is null or coalesce(m ->> 'ifindex', '') !~ '^\d+$';
      insert into sw_macs as t (switch_id, mac, vlan, ifindex, primera_vez, ultima_vez)
      values (v_sw.id, v_mac, coalesce(nullif(m ->> 'vlan', '')::int, 0), (m ->> 'ifindex')::int, v_ahora, v_ahora)
      on conflict (switch_id, mac, vlan) do update set ifindex = excluded.ifindex, ultima_vez = v_ahora;
    end loop;
    update sw_puertos t set macs = (select count(*) from sw_macs x where x.switch_id = t.switch_id and x.ifindex = t.ifindex and x.ultima_vez = v_ahora)
     where t.switch_id = v_sw.id;

    -- Vecinos (LLDP / CDP)
    update sw_puertos set vecino = null, vecino_puerto = null, vecino_protocolo = null where switch_id = v_sw.id;
    for v in select * from jsonb_array_elements(coalesce(s -> 'vecinos', '[]')) loop
      continue when coalesce(v ->> 'ifindex', '') !~ '^\d+$';
      update sw_puertos set vecino = left(v ->> 'nombre', 100), vecino_puerto = left(v ->> 'puerto', 100),
             vecino_protocolo = left(v ->> 'protocolo', 10), troncal_detectado = true
       where switch_id = v_sw.id and ifindex = (v ->> 'ifindex')::int;
    end loop;
    -- Un puerto con muchas MAC es un enlace hacia otro equipo de red
    update sw_puertos set troncal_detectado = true where switch_id = v_sw.id and macs > 3 and not troncal_detectado;

    -- Cambios de estado en la última hora (para detectar puertos que se caen y vuelven)
    update sw_puertos t set cambios_1h = (select count(*) from sw_eventos e where e.switch_id = t.switch_id and e.ifindex = t.ifindex
                                            and e.tipo in ('caido', 'activo') and e.fecha > v_ahora - interval '1 hour')
     where t.switch_id = v_sw.id;
    n_ok := n_ok + 1;
  end loop;

  delete from sw_macs where ultima_vez < v_ahora - interval '30 days';
  delete from sw_eventos where fecha < v_ahora - interval '90 days';
  update sw_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20) where id = 1;
  return jsonb_build_object('ok', true, 'switches_ok', n_ok, 'switches_error', n_err);
end $$;
revoke all on function public.sw_reportar(text, jsonb) from public;
grant execute on function public.sw_reportar(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Vistas para la pantalla (respetan los permisos de quien consulta)
-- ----------------------------------------------------------
create or replace view public.sw_puertos_vista with (security_invoker = true) as
select p.*, coalesce(p.troncal, p.troncal_detectado) as es_troncal
  from sw_puertos p;

-- Dispositivos conectados ahora en puertos de acceso (no troncales), uno por MAC
create or replace view public.sw_dispositivos_vista with (security_invoker = true) as
select distinct on (m.mac)
       m.mac, m.vlan, m.switch_id, s.nombre as switch_nombre, s.zona, m.ifindex, p.nombre as puerto, p.alias as puerto_alias,
       m.primera_vez, m.ultima_vez,
       substr(m.mac, 2, 1) in ('2', '6', 'a', 'e') as mac_aleatoria,
       d.id as dispositivo_id, d.hostname as agente_hostname,
       q.id as inventario_id, q.codigo as inventario_codigo,
       u.nombre as unifi_nombre,
       k.descripcion as conocido_descripcion,
       c.hostname as unifi_hostname, c.fabricante as fabricante,
       (d.id is not null or q.id is not null or u.mac is not null or k.mac is not null) as conocido
  from sw_macs m
  join sw_switches s on s.id = m.switch_id
  join sw_puertos p on p.switch_id = m.switch_id and p.ifindex = m.ifindex
  left join lateral (select x.id, x.hostname from inv_dispositivos x where x.estado_registro = 'aprobado' and unifi_mac(x.mac) = m.mac limit 1) d on true
  left join lateral (select x.id, x.codigo from inv_equipos x where unifi_mac(x.mac) = m.mac limit 1) q on true
  left join unifi_equipos u on u.mac = m.mac
  left join unifi_conocidos k on k.mac = m.mac
  left join unifi_clientes c on c.mac = m.mac
 where s.activo and m.ultima_vez > now() - interval '20 minutes'
   and not coalesce(p.troncal, p.troncal_detectado)
 order by m.mac, p.macs, m.ultima_vez desc;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.sw_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('red') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'alertas', alertas, 'alertar_desconocidos', alertar_desconocidos, 'umbral_uso', umbral_uso,
    'umbral_errores', umbral_errores, 'minutos_sin_reporte', minutos_sin_reporte)
  end from sw_config where id = 1
$$;
revoke execute on function public.sw_estado() from public, anon;
grant execute on function public.sw_estado() to authenticated;

create or replace function public.sw_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update sw_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.sw_nuevo_puente(text) from public, anon;
grant execute on function public.sw_nuevo_puente(text) to authenticated;

create or replace function public.sw_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update sw_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    alertar_desconocidos = coalesce((p ->> 'alertar_desconocidos')::boolean, alertar_desconocidos),
    umbral_uso = coalesce((p ->> 'umbral_uso')::int, umbral_uso),
    umbral_errores = coalesce((p ->> 'umbral_errores')::int, umbral_errores),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte)
  where id = 1;
end $$;
revoke execute on function public.sw_config_guardar(jsonb) from public, anon;
grant execute on function public.sw_config_guardar(jsonb) to authenticated;

-- Marcar o desmarcar un puerto como troncal (null = automático)
create or replace function public.sw_troncal_guardar(p_switch int, p_ifindex int, p_valor boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update sw_puertos set troncal = p_valor where switch_id = p_switch and ifindex = p_ifindex;
end $$;
revoke execute on function public.sw_troncal_guardar(int, int, boolean) from public, anon;
grant execute on function public.sw_troncal_guardar(int, int, boolean) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.sw_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c sw_config;
begin
  select * into c from sw_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  if c.ultimo_reporte is null or c.ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte) then
    insert into _cond values ('sw:puente', 'switch', 'alta', 'El puente de switches dejó de reportar',
      coalesce('Último reporte ' || to_char(c.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'),
      '/red/switches')
    on conflict do nothing;
    return;
  end if;

  -- Switch que no responde
  insert into _cond
  select 'sw:caido:' || s.id, 'switch', 'critica', 'Switch sin respuesta: ' || s.nombre,
         concat_ws(' · ', s.ip, nullif(s.zona, ''), 'último dato ' || to_char(s.ultimo_ok at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
         '/red/switches'
    from sw_switches s where s.activo and s.responde = false
  on conflict do nothing;

  -- Reinicio en las últimas 2 horas
  insert into _cond
  select 'sw:reinicio:' || s.id || ':' || to_char(s.reinicio_en, 'YYYYMMDDHH24MI'), 'switch', 'media', 'Switch reiniciado: ' || s.nombre,
         concat_ws(' · ', s.ip, 'encendido desde ' || to_char(s.reinicio_en at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
         '/red/switches'
    from sw_switches s where s.activo and s.responde and s.reinicio_en > now() - interval '2 hours'
  on conflict do nothing;

  -- Enlace troncal caído
  insert into _cond
  select 'sw:troncal:' || p.switch_id || ':' || p.ifindex, 'switch', 'critica',
         'Enlace troncal caído: ' || s.nombre || ' ' || coalesce(p.nombre, p.ifindex::text),
         concat_ws(' · ', nullif(p.alias, ''), 'desde ' || to_char(p.ultimo_cambio at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
         '/red/switches?switch=' || p.switch_id
    from sw_puertos p join sw_switches s on s.id = p.switch_id
   where s.activo and s.responde and p.admin_up and not p.oper_up and coalesce(p.troncal, p.troncal_detectado)
  on conflict do nothing;

  -- Puerto que se cae y vuelve
  insert into _cond
  select 'sw:flap:' || p.switch_id || ':' || p.ifindex, 'switch', 'alta',
         'Puerto inestable: ' || s.nombre || ' ' || coalesce(p.nombre, p.ifindex::text),
         p.cambios_1h || ' cambios de estado en la última hora' || coalesce(' · ' || nullif(p.alias, ''), ''),
         '/red/switches?switch=' || p.switch_id
    from sw_puertos p join sw_switches s on s.id = p.switch_id
   where s.activo and p.cambios_1h >= 4
  on conflict do nothing;

  -- Errores en el último intervalo
  insert into _cond
  select 'sw:errores:' || p.switch_id || ':' || p.ifindex, 'switch', 'media',
         'Puerto con errores: ' || s.nombre || ' ' || coalesce(p.nombre, p.ifindex::text),
         p.err_delta || ' errores en los últimos minutos (cable, conector o dúplex)' || coalesce(' · ' || nullif(p.alias, ''), ''),
         '/red/switches?switch=' || p.switch_id
    from sw_puertos p join sw_switches s on s.id = p.switch_id
   where s.activo and p.err_delta >= c.umbral_errores
  on conflict do nothing;

  -- Puerto saturado
  insert into _cond
  select 'sw:uso:' || p.switch_id || ':' || p.ifindex, 'switch', 'media',
         'Puerto saturado: ' || s.nombre || ' ' || coalesce(p.nombre, p.ifindex::text),
         p.uso_pct || '% de ' || p.velocidad_mbps || ' Mbps' || coalesce(' · ' || nullif(p.alias, ''), ''),
         '/red/switches?switch=' || p.switch_id
    from sw_puertos p join sw_switches s on s.id = p.switch_id
   where s.activo and p.uso_pct >= c.umbral_uso
  on conflict do nothing;

  -- PoE al límite
  insert into _cond
  select 'sw:poe:' || s.id, 'switch', 'media', 'PoE al límite: ' || s.nombre,
         round(s.poe_uso) || ' W de ' || round(s.poe_total) || ' W', '/red/switches?switch=' || s.id
    from sw_switches s where s.activo and s.poe_total > 0 and s.poe_uso >= s.poe_total * 0.9
  on conflict do nothing;

  -- Dispositivo desconocido conectado por cable
  if c.alertar_desconocidos then
    insert into _cond
    select 'sw:desconocido:' || x.mac, 'switch', case when x.mac_aleatoria then 'media' else 'alta' end,
           'Dispositivo desconocido por cable en ' || x.switch_nombre || ' ' || coalesce(x.puerto, x.ifindex::text),
           concat_ws(' · ', 'MAC ' || x.mac, nullif(x.fabricante, ''), case when x.vlan > 0 then 'VLAN ' || x.vlan end, nullif(x.zona, '')),
           '/red/switches?vista=dispositivos'
      from sw_dispositivos_vista x where not x.conocido
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.sw_condiciones_alertas() from public, anon, authenticated;

-- Gancho común (Backups, Servidores y WiFi sin cambios)
create or replace function public.alertas_condiciones_extra()
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.backups_condiciones_alertas()') is not null then perform backups_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_condiciones_alertas()') is not null then perform srv_condiciones_alertas(); end if;
  if to_regprocedure('public.unifi_condiciones_alertas()') is not null then perform unifi_condiciones_alertas(); end if;
  if to_regprocedure('public.sw_condiciones_alertas()') is not null then perform sw_condiciones_alertas(); end if;
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
    E'-- Condiciones de otros módulos (backups, servidores, wifi, switches)\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
  execute v_def;
end $$;

-- ----------------------------------------------------------
-- Permisos: se ve con la solapa Red; los switches los carga un administrador
-- ----------------------------------------------------------
alter table public.sw_config enable row level security;
alter table public.sw_switches enable row level security;
alter table public.sw_puertos enable row level security;
alter table public.sw_macs enable row level security;
alter table public.sw_eventos enable row level security;

revoke all on public.sw_config from anon, authenticated;

drop policy if exists sw_switches_select on public.sw_switches;
create policy sw_switches_select on public.sw_switches for select to authenticated using (puede_ver('red'));
drop policy if exists sw_switches_admin on public.sw_switches;
create policy sw_switches_admin on public.sw_switches for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('red')) with check (mi_rol() = 'administrador' and puede_ver('red'));

drop policy if exists sw_puertos_select on public.sw_puertos;
create policy sw_puertos_select on public.sw_puertos for select to authenticated using (puede_ver('red'));
drop policy if exists sw_macs_select on public.sw_macs;
create policy sw_macs_select on public.sw_macs for select to authenticated using (puede_ver('red'));
drop policy if exists sw_eventos_select on public.sw_eventos;
create policy sw_eventos_select on public.sw_eventos for select to authenticated using (puede_ver('red'));
revoke insert, update, delete on public.sw_puertos, public.sw_macs, public.sw_eventos from anon, authenticated;

grant select on public.sw_puertos_vista, public.sw_dispositivos_vista to authenticated;

do $$
declare t text;
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  foreach t in array array['sw_config', 'sw_switches'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
