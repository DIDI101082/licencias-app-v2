-- ==========================================================
-- UniFi: ubicación por antena, ocupación por piso, inventario y alertas de red
--   * Cada antena puede tener una "zona" (por ejemplo "Piso 5" o "Córdoba · Sala"): con eso
--     Oficina / Home office muestra en qué piso está cada equipo, y cuenta también los
--     dispositivos sin agente.
--   * Ocupación: cada 10 minutos se guarda cuántos dispositivos hay por zona (máximo por hora).
--     Se conservan 120 días.
--   * Alertas nuevas (se configuran en Seguridad → WiFi → Configurar):
--       - antena desconectada, - red WiFi de la empresa sin contraseña,
--       - firmware con actualización disponible (apagada por defecto).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de unifi.sql.
-- ==========================================================

alter table public.unifi_equipos add column if not exists zona text;

alter table public.unifi_config
  add column if not exists alertar_antenas boolean not null default true,
  add column if not exists alertar_red_abierta boolean not null default true,
  add column if not exists alertar_firmware boolean not null default false;

-- Zona de cada antena (la asigna un administrador)
create or replace function public.unifi_zona_guardar(p_mac text, p_zona text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update unifi_equipos set zona = nullif(left(trim(p_zona), 60), '') where mac = unifi_mac(p_mac);
end $$;
grant execute on function public.unifi_zona_guardar(text, text) to authenticated;

-- Equipos UniFi con su código de inventario (si ya están cargados, por MAC o N° de serie)
create or replace view public.unifi_equipos_vista with (security_invoker = true) as
select q.*,
       coalesce(nullif(q.zona, ''), q.nombre, q.mac) as zona_efectiva,
       i.id as inventario_id, i.codigo as inventario_codigo
  from unifi_equipos q
  left join lateral (
    select e.id, e.codigo from inv_equipos e
     where unifi_mac(e.mac) = q.mac or (q.serie is not null and upper(e.numero_serie) = upper(q.serie))
     limit 1) i on true;
grant select on public.unifi_equipos_vista to authenticated;

-- ----------------------------------------------------------
-- Ocupación por zona (máximo de dispositivos conectados en cada hora)
-- ----------------------------------------------------------
create table if not exists public.unifi_ocupacion (
  fecha date not null,
  hora smallint not null check (hora between 0 and 23),
  zona text not null,
  empresa int not null default 0,      -- dispositivos en redes de la empresa (WiFi corporativo)
  invitados int not null default 0,
  con_agente int not null default 0,   -- de esos, cuántos son equipos con agente (≈ personas con notebook)
  primary key (fecha, hora, zona)
);

create or replace function public.unifi_registrar_ocupacion()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_local timestamp := now() at time zone 'America/Argentina/Buenos_Aires';
begin
  -- solo con datos frescos del puente
  if not exists (select 1 from unifi_config where id = 1 and ultimo_reporte > now() - interval '20 minutes') then return; end if;

  insert into unifi_ocupacion as o (fecha, hora, zona, empresa, invitados, con_agente)
  select v_local::date, extract(hour from v_local)::smallint, coalesce(nullif(ap.zona, ''), ap.nombre, c.ap_mac),
         count(*) filter (where not c.invitado),
         count(*) filter (where c.invitado),
         count(*) filter (where not c.invitado and c.dispositivo_id is not null)
    from unifi_clientes c
    join unifi_equipos ap on ap.mac = c.ap_mac
   where c.conectado and not c.cableado
   group by 3
  on conflict (fecha, hora, zona) do update set
    empresa = greatest(o.empresa, excluded.empresa),
    invitados = greatest(o.invitados, excluded.invitados),
    con_agente = greatest(o.con_agente, excluded.con_agente);

  delete from unifi_ocupacion where fecha < current_date - 120;
end $$;
revoke all on function public.unifi_registrar_ocupacion() from public, anon, authenticated;

do $$ begin
  begin perform cron.unschedule('accusys-unifi-ocupacion'); exception when others then null; end;
  perform cron.schedule('accusys-unifi-ocupacion', '*/10 * * * *', 'select public.unifi_registrar_ocupacion()');
exception when others then
  raise notice 'La ocupación por piso no quedó programada (falta pg_cron): %', sqlerrm;
end $$;

-- ----------------------------------------------------------
-- Datos para Oficina / Home office (con la solapa Home office alcanza; no hace falta Seguridad)
-- ----------------------------------------------------------
create or replace function public.unifi_ubicacion()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (puede_ver('ubicacion') or puede_ver('seguridad')) then raise exception 'Sin acceso'; end if;
  return jsonb_build_object(
    'actualizado', (select ultimo_reporte from unifi_config where id = 1),
    -- equipos con agente conectados a una antena: en qué zona están
    'dispositivos', coalesce((
      select jsonb_agg(jsonb_build_object('dispositivo_id', c.dispositivo_id, 'zona', coalesce(nullif(ap.zona, ''), ap.nombre, c.ap_mac),
                                          'antena', ap.nombre, 'ssid', c.ssid, 'invitado', c.invitado))
        from unifi_clientes c join unifi_equipos ap on ap.mac = c.ap_mac
       where c.conectado and c.dispositivo_id is not null), '[]'::jsonb),
    -- por zona: cuántos equipos con agente y cuántos otros dispositivos (celulares, equipos sin agente)
    'zonas', coalesce((
      select jsonb_agg(z order by z ->> 'zona')
        from (select jsonb_build_object('zona', coalesce(nullif(ap.zona, ''), ap.nombre, c.ap_mac),
                                        'con_agente', count(*) filter (where c.dispositivo_id is not null and not c.invitado),
                                        'otros', count(*) filter (where c.dispositivo_id is null and not c.invitado),
                                        'invitados', count(*) filter (where c.invitado)) as z
                from unifi_clientes c join unifi_equipos ap on ap.mac = c.ap_mac
               where c.conectado and not c.cableado
               group by coalesce(nullif(ap.zona, ''), ap.nombre, c.ap_mac)) x), '[]'::jsonb)
  );
end $$;
grant execute on function public.unifi_ubicacion() to authenticated;

create or replace function public.unifi_ocupacion_datos(p_dias int default 28)
returns table (fecha date, hora smallint, zona text, empresa int, invitados int, con_agente int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (puede_ver('ubicacion') or puede_ver('seguridad')) then raise exception 'Sin acceso'; end if;
  return query select o.fecha, o.hora, o.zona, o.empresa, o.invitados, o.con_agente
                 from unifi_ocupacion o
                where o.fecha >= current_date - least(greatest(p_dias, 1), 120)
                order by o.fecha, o.hora;
end $$;
grant execute on function public.unifi_ocupacion_datos(int) to authenticated;

alter table public.unifi_ocupacion enable row level security;
revoke all on public.unifi_ocupacion from anon, authenticated;

-- ----------------------------------------------------------
-- Configuración y estado (con las alertas nuevas)
-- ----------------------------------------------------------
create or replace function public.unifi_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('seguridad') then jsonb_build_object(
    'configurado', token_hash is not null, 'udm_url', udm_url, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'resumen', ultimo_resumen, 'alertas', alertas, 'alertar_aleatorias', alertar_aleatorias, 'alertar_cableados', alertar_cableados,
    'minutos_sin_reporte', minutos_sin_reporte, 'alertar_antenas', alertar_antenas, 'alertar_red_abierta', alertar_red_abierta,
    'alertar_firmware', alertar_firmware)
  end from unifi_config where id = 1
$$;
grant execute on function public.unifi_estado() to authenticated;

create or replace function public.unifi_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update unifi_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    alertar_aleatorias = coalesce((p ->> 'alertar_aleatorias')::boolean, alertar_aleatorias),
    alertar_cableados = coalesce((p ->> 'alertar_cableados')::boolean, alertar_cableados),
    alertar_antenas = coalesce((p ->> 'alertar_antenas')::boolean, alertar_antenas),
    alertar_red_abierta = coalesce((p ->> 'alertar_red_abierta')::boolean, alertar_red_abierta),
    alertar_firmware = coalesce((p ->> 'alertar_firmware')::boolean, alertar_firmware),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte)
  where id = 1;
end $$;
grant execute on function public.unifi_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas: las de unifi.sql + antena desconectada, red abierta y firmware
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
    return;
  end if;

  -- Posible red falsa (evil twin)
  insert into _cond
  select 'wifi:falsa:' || v.bssid, 'wifi', 'critica',
         'Posible red WiFi falsa: ' || v.ssid,
         concat_ws(' · ', 'BSSID ' || v.bssid, 'detectada por ' || coalesce(ap.zona, ap.nombre, v.visto_por), nullif(v.fabricante, ''),
                   case when v.senal is not null then 'señal ' || v.senal || ' dBm' end),
         '/inventario/wifi?vista=vecinas'
    from unifi_vecinas v left join unifi_equipos ap on ap.mac = v.visto_por
   where v.suplanta and v.ultima_vez > now() - interval '2 hours'
  on conflict do nothing;

  -- Antena no autorizada conectada a la red cableada (rogue AP)
  insert into _cond
  select 'wifi:rogue:' || v.bssid, 'wifi', 'alta',
         'Antena WiFi no autorizada en la red: ' || coalesce(v.ssid, v.bssid),
         concat_ws(' · ', 'BSSID ' || v.bssid, nullif(v.fabricante, ''), 'detectada por ' || coalesce(ap.zona, ap.nombre, v.visto_por)),
         '/inventario/wifi?vista=vecinas'
    from unifi_vecinas v left join unifi_equipos ap on ap.mac = v.visto_por
   where v.es_rogue and not v.suplanta and v.ultima_vez > now() - interval '2 hours'
  on conflict do nothing;

  -- Dispositivo desconocido en una red de la empresa
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

  -- Antena, switch o gateway UniFi desconectado
  if c.alertar_antenas then
    insert into _cond
    select 'wifi:equipo:' || q.mac, 'wifi', case when q.tipo in ('udm', 'ugw', 'uxg') then 'critica' else 'alta' end,
           case q.tipo when 'uap' then 'Antena WiFi desconectada: ' when 'usw' then 'Switch UniFi desconectado: ' else 'Equipo UniFi desconectado: ' end
             || coalesce(q.nombre, q.mac),
           concat_ws(' · ', nullif(q.zona, ''), q.modelo, 'IP ' || q.ip, q.sitio),
           '/inventario/wifi?vista=equipos'
      from unifi_equipos q
     where coalesce(q.estado, 0) <> 1 and q.actualizado > now() - interval '1 hour'
    on conflict do nothing;
  end if;

  -- Red WiFi de la empresa sin contraseña
  if c.alertar_red_abierta then
    insert into _cond
    select 'wifi:abierta:' || r.sitio || ':' || r.ssid, 'wifi', case when r.invitados then 'media' else 'alta' end,
           'Red WiFi sin contraseña: ' || r.ssid,
           concat_ws(' · ', case when r.invitados then 'red de invitados' else 'red de la empresa' end, nullif(r.sitio, '')),
           '/inventario/wifi?vista=equipos'
      from unifi_redes r
     where r.habilitada and r.seguridad = 'open'
    on conflict do nothing;
  end if;

  -- Firmware con actualización disponible (una alerta por equipo)
  if c.alertar_firmware then
    insert into _cond
    select 'wifi:firmware:' || q.mac, 'wifi', 'info',
           'Actualización de firmware disponible: ' || coalesce(q.nombre, q.mac),
           concat_ws(' · ', q.modelo, 'versión actual ' || q.firmware, nullif(q.zona, '')),
           '/inventario/wifi?vista=equipos'
      from unifi_equipos q
     where q.actualizable and q.actualizado > now() - interval '1 hour'
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.unifi_condiciones_alertas() from public, anon, authenticated;

-- ----------------------------------------------------------
-- Menos falsos positivos en "posible red falsa": las antenas UniFi publican varias BSSID derivadas
-- de su MAC (cambian el primer y el último byte). Si una red vecina comparte los bytes centrales
-- con la MAC o una BSSID de nuestros equipos, es nuestra (por ejemplo, una radio recién
-- reconfigurada) y no se marca como falsa. Una red falsa que copie nuestra BSSID exacta tampoco
-- aparece como vecina: la ven nuestras antenas como propia.
-- ----------------------------------------------------------
create or replace function public.unifi_bssid_propia(p_bssid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from unifi_equipos q
     where substr(q.mac, 4, 11) = substr(p_bssid, 4, 11)
        or exists (select 1 from unnest(q.bssids) b where b = p_bssid or substr(b, 4, 11) = substr(p_bssid, 4, 11)))
$$;

create or replace function public.unifi_vecinas_filtrar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.suplanta and unifi_bssid_propia(new.bssid) then new.suplanta := false; end if;
  return new;
end $$;
drop trigger if exists trg_unifi_vecinas_filtrar on public.unifi_vecinas;
create trigger trg_unifi_vecinas_filtrar before insert or update on public.unifi_vecinas
  for each row execute function public.unifi_vecinas_filtrar();

-- Aplicarlo a lo que ya estaba guardado
update public.unifi_vecinas set suplanta = suplanta where suplanta;
