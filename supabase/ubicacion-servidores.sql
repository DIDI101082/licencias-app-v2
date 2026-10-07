-- ==========================================================
-- Oficina y home office: los servidores no son "home office"
--   * Nuevo tipo de red "servidores" (VLAN de servidores / datacenter).
--   * Un servidor nunca se clasifica como home office (con o sin VPN): figura como
--     "Servidores", con el nombre de su VLAN o "Red no identificada" si la red no está cargada.
--   * Las redes de servidores solo se aplican a servidores: una notebook cuya casa usa el
--     mismo rango (192.168.50.x es común en routers hogareños) sigue siendo home office.
--   * Los servidores no entran en el historial de oficina / home office.
-- Qué es un servidor: el tipo fijado a mano en Monitoreo o, si está vacío, la misma deducción
-- que usa la app (máquina virtual, hostname SRV-/VSRV-, Windows Server o Linux).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de ubicacion-wifi.sql y tipo-dispositivo.sql.
-- ==========================================================

alter table public.inv_redes drop constraint if exists inv_redes_tipo_check;
alter table public.inv_redes add constraint inv_redes_tipo_check
  check (tipo in ('corporativa', 'invitados', 'vpn', 'servidores'));

-- VLAN de servidores (rangos tomados de los equipos que hoy reportan; se pueden corregir desde
-- la app, en Oficina y home office → Redes de la empresa)
insert into public.inv_redes (nombre, sede, cidr, tipo, ssid) values
  ('VLAN servidores · 172.28.194.x', 'Datacenter', '172.28.194.0/24', 'servidores', null),
  ('VLAN servidores · 172.28.195.x', 'Datacenter', '172.28.195.0/24', 'servidores', null),
  ('VLAN servidores · 192.168.50.x', 'Datacenter', '192.168.50.0/24', 'servidores', null)
on conflict (cidr) do nothing;

-- ¿El equipo es un servidor? (misma regla que tipoEquipo en lib/monitoreo.ts)
create or replace function public.inv_es_servidor(p_disp uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when d.tipo is not null then d.tipo = 'servidor'
      else (coalesce(d.fabricante, '') || ' ' || coalesce(d.modelo, ''))
             ~* 'vmware|virtual ?machine|virtualbox|hyper-v|kvm|qemu|xen|proxmox|parallels'
        or coalesce(d.hostname, '') ~* '^v?srv[-_]'
        or coalesce(d.so_nombre, '') ~* 'server'
        or (coalesce(d.so_nombre, '') <> '' and d.so_nombre !~* 'windows|mac ?os|darwin')
    end
    from inv_dispositivos d where d.id = p_disp), false);
$$;
revoke all on function public.inv_es_servidor(uuid) from public, anon;

-- La clasificación ahora recibe si el equipo es un servidor
drop function if exists public.inv_clasificar_ubicacion(jsonb, text);
create or replace function public.inv_clasificar_ubicacion(p_redes jsonb, p_ssid text, p_servidor boolean)
returns table (tipo text, sede text, red text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_ips inet[];
begin
  select coalesce(array_agg((x->>'ip')::inet), '{}')
    into v_ips
    from jsonb_array_elements(coalesce(p_redes, '[]'::jsonb)) x
   where x->>'ip' ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$';

  -- Servidores: nunca home office. Se busca su red (primero las de servidores) solo para mostrarla.
  if p_servidor then
    return query
    select 'servidores'::text, r.sede, r.nombre
      from inv_redes r
     where r.tipo <> 'vpn' and exists (select 1 from unnest(v_ips) i where i << r.cidr)
     order by case r.tipo when 'servidores' then 1 when 'corporativa' then 2 else 3 end
     limit 1;
    if found then return; end if;
    if array_length(v_ips, 1) > 0 then
      return query select 'servidores'::text, 'Servidores'::text, null::text;
    else
      return query select 'desconocido'::text, null::text, null::text;
    end if;
    return;
  end if;

  return query
  select case r.tipo when 'corporativa' then 'oficina' else r.tipo end, r.sede, r.nombre
    from inv_redes r
   where r.tipo <> 'servidores'
     and exists (select 1 from unnest(v_ips) i where i << r.cidr)
     -- si la red tiene WiFi propio y el equipo está en OTRO WiFi, es una red de su casa con el mismo rango
     -- (el nombre se compara como patrón: % es comodín y no importan las mayúsculas)
     and not (r.ssid is not null and p_ssid is not null and not (p_ssid ilike r.ssid))
   order by case r.tipo when 'corporativa' then 1 when 'invitados' then 2 else 3 end,
            (r.ssid is not null and p_ssid ilike r.ssid) desc
   limit 1;
  if found then return; end if;

  -- Sin coincidencia por IP pero con un WiFi conocido
  return query select case r.tipo when 'corporativa' then 'oficina' else r.tipo end, r.sede, r.nombre
    from inv_redes r where r.tipo <> 'servidores' and r.ssid is not null and p_ssid ilike r.ssid limit 1;
  if found then return; end if;

  if array_length(v_ips, 1) > 0 then
    return query select 'remoto'::text, 'Home office'::text, null::text;
  else
    return query select 'desconocido'::text, null::text, null::text;
  end if;
end $$;
revoke all on function public.inv_clasificar_ubicacion(jsonb, text, boolean) from public, anon;

-- La llama el agente en cada reporte (misma firma: no hay que reinstalar el agente)
create or replace function public.inv_reportar_ubicacion(
  p_token text, p_uuid text, p_hostname text, p_secreto text, p_redes jsonb, p_ssid text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_disp uuid;
  v_servidor boolean;
  u record;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  v_disp := inv_verificar_equipo(p_token, p_uuid, p_hostname, p_secreto);
  if v_disp is null then
    return;
  end if;

  v_servidor := inv_es_servidor(v_disp);
  select * into u from inv_clasificar_ubicacion(p_redes, nullif(trim(p_ssid), ''), v_servidor);

  update inv_dispositivos set
    redes = p_redes,
    ssid = nullif(trim(p_ssid), ''),
    ubicacion_tipo = u.tipo,
    ubicacion_sede = u.sede,
    ubicacion_red = u.red,
    ubicacion_actualizada = now()
  where id = v_disp;

  -- El historial es de oficina / home office: los servidores no cuentan
  if u.tipo not in ('desconocido', 'servidores') then
    insert into inv_ubicacion_diaria (dispositivo_id, fecha, tipo, sede)
    values (v_disp, v_hoy, u.tipo, u.sede)
    on conflict (dispositivo_id, fecha, tipo) do update set ultima = now(), sede = excluded.sede;
  end if;
end $$;

-- Reclasificar ya mismo todos los equipos con los datos de su último reporte
update public.inv_dispositivos d set
  (ubicacion_tipo, ubicacion_sede, ubicacion_red) =
    (select u.tipo, u.sede, u.red
       from public.inv_clasificar_ubicacion(d.redes, d.ssid, public.inv_es_servidor(d.id)) u)
where d.redes is not null;

-- Historial: quitar los días en que un servidor figuró como oficina / home office
delete from public.inv_ubicacion_diaria h
where public.inv_es_servidor(h.dispositivo_id);

-- Control: así quedaron los servidores
select hostname, ubicacion_sede, ubicacion_red, ip
  from public.inv_dispositivos
 where ubicacion_tipo = 'servidores'
 order by hostname;
