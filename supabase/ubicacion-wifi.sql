-- ==========================================================
-- Corrección: nombre del WiFi como patrón (Accusys_P5 o Accusys_Wifi_P5)
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de ubicacion.sql.
-- ==========================================================

create or replace function public.inv_clasificar_ubicacion(p_redes jsonb, p_ssid text)
returns table (tipo text, sede text, red text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_ips inet[];
begin
  select coalesce(array_agg((x->>'ip')::inet), '{}')
    into v_ips
    from jsonb_array_elements(coalesce(p_redes, '[]'::jsonb)) x
   where x->>'ip' ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$';

  return query
  select case r.tipo when 'corporativa' then 'oficina' else r.tipo end, r.sede, r.nombre
    from inv_redes r
   where exists (select 1 from unnest(v_ips) i where i << r.cidr)
     -- si la red tiene WiFi propio y el equipo está en OTRO WiFi, es una red de su casa con el mismo rango
     -- (el nombre se compara como patrón: % es comodín y no importan las mayúsculas)
     and not (r.ssid is not null and p_ssid is not null and not (p_ssid ilike r.ssid))
   order by case r.tipo when 'corporativa' then 1 when 'invitados' then 2 else 3 end,
            (r.ssid is not null and p_ssid ilike r.ssid) desc
   limit 1;
  if found then return; end if;

  -- Sin coincidencia por IP pero con un WiFi conocido
  return query select case r.tipo when 'corporativa' then 'oficina' else r.tipo end, r.sede, r.nombre
    from inv_redes r where r.ssid is not null and p_ssid ilike r.ssid limit 1;
  if found then return; end if;

  if array_length(v_ips, 1) > 0 then
    return query select 'remoto'::text, 'Home office'::text, null::text;
  else
    return query select 'desconocido'::text, null::text, null::text;
  end if;
end $$;

-- Los WiFi de la oficina, como patrón: aceptan "Accusys_P5", "Accusys_Wifi_P5", etc.
update public.inv_redes set ssid = 'Accusys%P4' where cidr = '192.168.204.0/24';
update public.inv_redes set ssid = 'Accusys%P5' where cidr = '192.168.205.0/24';
update public.inv_redes set ssid = 'Accusys%P7' where cidr = '192.168.207.0/24';

-- Reclasificar ya mismo los equipos con los datos que informaron en su último reporte
update public.inv_dispositivos d set
  (ubicacion_tipo, ubicacion_sede, ubicacion_red) =
    (select u.tipo, u.sede, u.red from public.inv_clasificar_ubicacion(d.redes, d.ssid) u)
where d.redes is not null;

-- Historial de hoy: quitar los "home office" que en realidad estaban en la oficina
delete from public.inv_ubicacion_diaria h
using public.inv_dispositivos d
where h.dispositivo_id = d.id
  and h.fecha = (now() at time zone 'America/Argentina/Buenos_Aires')::date
  and h.tipo = 'remoto'
  and d.ubicacion_tipo in ('oficina', 'invitados');

insert into public.inv_ubicacion_diaria (dispositivo_id, fecha, tipo, sede)
select id, (now() at time zone 'America/Argentina/Buenos_Aires')::date, ubicacion_tipo, ubicacion_sede
from public.inv_dispositivos
where ubicacion_tipo in ('oficina', 'invitados') and ubicacion_actualizada::date >= current_date - 1
on conflict (dispositivo_id, fecha, tipo) do nothing;
