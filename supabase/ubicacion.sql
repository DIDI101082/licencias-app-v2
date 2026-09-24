-- ==========================================================
-- Ubicación de los equipos: oficina / home office / VPN
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de registro.sql.
-- ==========================================================

-- Redes de la empresa (se editan desde la app)
create table if not exists public.inv_redes (
  id serial primary key,
  nombre text not null,                 -- ej: "Piso 4 · cableada"
  sede text not null,                   -- ej: "Oficina central", "Oficina CBA"
  cidr cidr not null unique,
  tipo text not null check (tipo in ('corporativa', 'invitados', 'vpn')),
  ssid text                             -- nombre del WiFi, si corresponde
);

insert into public.inv_redes (nombre, sede, cidr, tipo, ssid) values
  ('Piso 4 · cableada',        'Oficina central', '192.168.203.0/24', 'corporativa', null),
  ('Piso 4 · WiFi',            'Oficina central', '192.168.204.0/24', 'corporativa', 'Accusys_P4'),
  ('Piso 4 · WiFi invitados',  'Oficina central', '192.168.104.0/24', 'invitados',   null),
  ('Piso 5 · WiFi',            'Oficina central', '192.168.205.0/24', 'corporativa', 'Accusys_P5'),
  ('Piso 5 · WiFi invitados',  'Oficina central', '192.168.105.0/24', 'invitados',   null),
  ('Piso 7 · WiFi',            'Oficina central', '192.168.207.0/24', 'corporativa', 'Accusys_P7'),
  ('Piso 7 · WiFi invitados',  'Oficina central', '192.168.107.0/24', 'invitados',   null),
  ('Oficina CBA · WiFi',       'Oficina CBA',     '192.168.208.0/24', 'corporativa', null),
  ('VPN FortiClient',          'Home office',     '192.168.51.0/24',  'vpn',         null)
on conflict (cidr) do nothing;

alter table public.inv_dispositivos
  add column if not exists redes jsonb,              -- [{ip, adaptador, gateway}]
  add column if not exists ssid text,
  add column if not exists ubicacion_tipo text,      -- oficina | invitados | vpn | remoto | desconocido
  add column if not exists ubicacion_sede text,
  add column if not exists ubicacion_red text,
  add column if not exists ubicacion_actualizada timestamptz;

-- Historial diario: en qué tipo de ubicación estuvo cada equipo cada día
create table if not exists public.inv_ubicacion_diaria (
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  fecha date not null,
  tipo text not null,
  sede text,
  primera timestamptz not null default now(),
  ultima timestamptz not null default now(),
  primary key (dispositivo_id, fecha, tipo)
);
create index if not exists idx_inv_ubicacion_diaria_fecha on public.inv_ubicacion_diaria(fecha);

-- Clasifica según las IP del equipo. Prioridad: red corporativa > invitados > VPN > remoto
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
     and not (r.ssid is not null and p_ssid is not null and r.ssid <> p_ssid)
   order by case r.tipo when 'corporativa' then 1 when 'invitados' then 2 else 3 end,
            (r.ssid is not null and r.ssid = p_ssid) desc
   limit 1;
  if found then return; end if;

  -- Sin coincidencia por IP pero con un WiFi conocido
  return query select case r.tipo when 'corporativa' then 'oficina' else r.tipo end, r.sede, r.nombre
    from inv_redes r where r.ssid is not null and r.ssid = p_ssid limit 1;
  if found then return; end if;

  if array_length(v_ips, 1) > 0 then
    return query select 'remoto'::text, 'Home office'::text, null::text;
  else
    return query select 'desconocido'::text, null::text, null::text;
  end if;
end $$;

-- La llama el agente en cada reporte (solo equipos aprobados guardan datos)
create or replace function public.inv_reportar_ubicacion(
  p_token text, p_uuid text, p_hostname text, p_secreto text, p_redes jsonb, p_ssid text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_disp uuid;
  u record;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  v_disp := inv_verificar_equipo(p_token, p_uuid, p_hostname, p_secreto);
  if v_disp is null then
    return;
  end if;

  select * into u from inv_clasificar_ubicacion(p_redes, nullif(trim(p_ssid), ''));

  update inv_dispositivos set
    redes = p_redes,
    ssid = nullif(trim(p_ssid), ''),
    ubicacion_tipo = u.tipo,
    ubicacion_sede = u.sede,
    ubicacion_red = u.red,
    ubicacion_actualizada = now()
  where id = v_disp;

  if u.tipo <> 'desconocido' then
    insert into inv_ubicacion_diaria (dispositivo_id, fecha, tipo, sede)
    values (v_disp, v_hoy, u.tipo, u.sede)
    on conflict (dispositivo_id, fecha, tipo) do update set ultima = now(), sede = excluded.sede;
  end if;
end $$;

revoke all on function public.inv_reportar_ubicacion(text, text, text, text, jsonb, text) from public;
grant execute on function public.inv_reportar_ubicacion(text, text, text, text, jsonb, text) to anon, authenticated;
revoke all on function public.inv_clasificar_ubicacion(jsonb, text) from public, anon;

-- Row Level Security
alter table public.inv_redes enable row level security;
alter table public.inv_ubicacion_diaria enable row level security;

drop policy if exists inv_redes_select on public.inv_redes;
create policy inv_redes_select on public.inv_redes for select to authenticated using (mi_rol() is not null);
drop policy if exists inv_redes_admin on public.inv_redes;
create policy inv_redes_admin on public.inv_redes for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

drop policy if exists inv_ubicacion_diaria_select on public.inv_ubicacion_diaria;
create policy inv_ubicacion_diaria_select on public.inv_ubicacion_diaria for select to authenticated
  using (mi_rol() is not null);
