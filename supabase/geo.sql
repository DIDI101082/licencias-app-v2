-- ==========================================================
-- Ubicación aproximada de los equipos según su IP pública (IP2Location.io)
--   * Se consulta solo cuando cambia la IP de un equipo; cada IP se guarda 30 días
--   * Si el servicio falla, el reporte del agente sigue normal
--   * Plan gratuito: requiere mostrar "Geolocalización por IP2Location.io" (la app lo hace)
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de instalacion-segura.sql.
-- ==========================================================

-- Extensión de Supabase para hacer consultas web desde la base
create extension if not exists http with schema extensions;

-- Clave gratuita de IP2Location.io (opcional; sin clave: 1.000 consultas por día)
alter table public.inv_agente_config add column if not exists geo_api_key text;
-- Países desde los que es normal que reporten los equipos (el resto genera alerta en Riesgos)
alter table public.inv_agente_config add column if not exists geo_paises_permitidos text[] not null default array['AR'];

-- Todos los que ven Seguridad necesitan leer la lista de países permitidos (no la clave)
create or replace function public.inv_paises_permitidos() returns text[]
language sql stable security definer set search_path = public as $$
  select geo_paises_permitidos from inv_agente_config where id = 1 and (puede_ver('seguridad') or puede_ver('ubicacion'))
$$;
grant execute on function public.inv_paises_permitidos() to authenticated;

create table if not exists public.inv_geo_cache (
  ip text primary key,
  pais_codigo text,
  pais text,
  region text,
  ciudad text,
  isp text,
  asn text,
  lat numeric,
  lon numeric,
  es_proxy boolean,
  actualizado timestamptz not null default now()
);

alter table public.inv_dispositivos
  add column if not exists geo_ip text,
  add column if not exists geo_pais_codigo text,
  add column if not exists geo_pais text,
  add column if not exists geo_region text,
  add column if not exists geo_ciudad text,
  add column if not exists geo_isp text,
  add column if not exists geo_es_proxy boolean,
  add column if not exists geo_actualizado timestamptz;

-- Por día, desde qué ciudades y proveedores reportó cada equipo
create table if not exists public.inv_geo_historial (
  id bigserial primary key,
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  fecha date not null,
  pais_codigo text not null default '',
  pais text,
  region text not null default '',
  ciudad text not null default '',
  isp text,
  ip text,
  primera timestamptz not null default now(),
  ultima timestamptz not null default now(),
  unique (dispositivo_id, fecha, pais_codigo, region, ciudad)
);
create index if not exists idx_inv_geo_historial_fecha on public.inv_geo_historial(fecha);

-- Consulta una IP (usa lo guardado si tiene menos de 30 días). Nunca corta el reporte del agente.
create or replace function public.inv_geo_consultar(p_ip text)
returns public.inv_geo_cache language plpgsql security definer set search_path = public, extensions as $$
declare
  c inv_geo_cache;
  r record;
  j jsonb;
  v_clave text;
begin
  if p_ip is null or p_ip !~ '^[0-9a-fA-F:.]{3,45}$' then
    return null;
  end if;
  select * into c from inv_geo_cache where ip = p_ip;
  if found and c.actualizado > now() - interval '30 days' then
    return c;
  end if;

  begin
    select nullif(trim(geo_api_key), '') into v_clave from inv_agente_config where id = 1;
    begin
      perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '3000');
    exception when others then null;
    end;
    select * into r from http_get('https://api.ip2location.io/?ip=' || p_ip || coalesce('&key=' || v_clave, ''));
    if r.status = 200 then
      j := r.content::jsonb;
      insert into inv_geo_cache (ip, pais_codigo, pais, region, ciudad, isp, asn, lat, lon, es_proxy, actualizado)
      values (p_ip, j->>'country_code', j->>'country_name', j->>'region_name', j->>'city_name', j->>'as', j->>'asn',
              nullif(j->>'latitude', '')::numeric, nullif(j->>'longitude', '')::numeric,
              nullif(j->>'is_proxy', '')::boolean, now())
      on conflict (ip) do update set
        pais_codigo = excluded.pais_codigo, pais = excluded.pais, region = excluded.region, ciudad = excluded.ciudad,
        isp = excluded.isp, asn = excluded.asn, lat = excluded.lat, lon = excluded.lon, es_proxy = excluded.es_proxy,
        actualizado = now()
      returning * into c;
    end if;
  exception when others then
    -- sin conexión, límite alcanzado o respuesta inválida: se queda con lo guardado (si hay)
    null;
  end;
  return c;
end $$;
revoke all on function public.inv_geo_consultar(text) from public, anon, authenticated;

-- Antes de guardar el reporte: completar la ubicación si la IP cambió o está vencida
create or replace function public.inv_geo_antes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c inv_geo_cache;
begin
  if new.ip_publica is null then
    return new;
  end if;
  if new.ip_publica is not distinct from new.geo_ip and new.geo_actualizado > now() - interval '30 days' then
    return new;
  end if;
  c := inv_geo_consultar(new.ip_publica);
  if c.ip is not null then
    new.geo_ip := c.ip;
    new.geo_pais_codigo := c.pais_codigo;
    new.geo_pais := c.pais;
    new.geo_region := c.region;
    new.geo_ciudad := c.ciudad;
    new.geo_isp := c.isp;
    new.geo_es_proxy := c.es_proxy;
    new.geo_actualizado := now();
  end if;
  return new;
end $$;

-- Después de guardar: registrar la ciudad del día en el historial
create or replace function public.inv_geo_despues()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.geo_ip is not null and new.geo_ip = new.ip_publica then
    insert into inv_geo_historial (dispositivo_id, fecha, pais_codigo, pais, region, ciudad, isp, ip)
    values (new.id, (now() at time zone 'America/Argentina/Buenos_Aires')::date,
            coalesce(new.geo_pais_codigo, ''), new.geo_pais, coalesce(new.geo_region, ''), coalesce(new.geo_ciudad, ''),
            new.geo_isp, new.ip_publica)
    on conflict (dispositivo_id, fecha, pais_codigo, region, ciudad)
    do update set ultima = now(), isp = excluded.isp, ip = excluded.ip;
  end if;
  return new;
end $$;

drop trigger if exists trg_inv_geo_antes on public.inv_dispositivos;
create trigger trg_inv_geo_antes before insert or update of ip_publica on public.inv_dispositivos
  for each row execute function public.inv_geo_antes();

drop trigger if exists trg_inv_geo_despues on public.inv_dispositivos;
create trigger trg_inv_geo_despues after insert or update of ip_publica on public.inv_dispositivos
  for each row execute function public.inv_geo_despues();

-- Permisos: el historial lo ven quienes ven Seguridad u Oficina/Home office; la caché nadie desde la app
alter table public.inv_geo_cache enable row level security;
alter table public.inv_geo_historial enable row level security;

drop policy if exists inv_geo_historial_select on public.inv_geo_historial;
create policy inv_geo_historial_select on public.inv_geo_historial for select to authenticated
  using (puede_ver('seguridad') or puede_ver('ubicacion'));
