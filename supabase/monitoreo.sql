-- ==========================================================
-- Módulo MONITOREO (agente en las PCs/notebooks)
-- Ejecutar UNA VEZ en el SQL Editor, en el mismo proyecto,
-- DESPUÉS de inventario.sql.
-- ==========================================================

-- Configuración del agente: un token secreto que el agente manda en cada reporte
create table if not exists public.inv_agente_config (
  id int primary key default 1 check (id = 1),
  token text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  intervalo_min int not null default 5
);
insert into public.inv_agente_config (id) values (1) on conflict (id) do nothing;

-- Lo último que informó cada equipo
create table if not exists public.inv_dispositivos (
  id uuid primary key default gen_random_uuid(),
  uuid_equipo text not null unique,        -- UUID de hardware (SMBIOS), o hostname si no hay
  hostname text,
  numero_serie text,
  fabricante text,
  modelo text,
  so_nombre text,
  so_version text,
  so_build text,
  so_arquitectura text,
  procesador text,
  nucleos int,
  ram_total_gb numeric(8,1),
  ram_libre_gb numeric(8,1),
  discos jsonb not null default '[]',      -- [{unidad, total_gb, libre_gb}]
  almacenamiento text,
  ip text,
  mac text,
  usuario text,
  dominio text,
  arranque timestamptz,
  bateria_pct int,
  antivirus_activo boolean,
  agente_version text,
  equipo_id uuid references public.inv_equipos(id) on delete set null,
  primer_reporte timestamptz not null default now(),
  ultimo_reporte timestamptz not null default now()
);

create index if not exists idx_inv_dispositivos_equipo on public.inv_dispositivos(equipo_id);

-- ----------------------------------------------------------
-- Función que llama el agente. Valida el token, guarda los
-- datos, vincula con el inventario por N° de serie y mantiene
-- actualizados los datos técnicos del equipo en el inventario.
-- ----------------------------------------------------------
create or replace function public.inv_reportar_dispositivo(p_token text, p_datos jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_serie text;
  v_equipo uuid;
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;

  v_uuid := nullif(trim(p_datos->>'uuid'), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then
    v_uuid := nullif(trim(p_datos->>'hostname'), '');
  end if;
  if v_uuid is null then
    raise exception 'El reporte no trae identificador';
  end if;

  v_serie := nullif(trim(p_datos->>'numero_serie'), '');
  if v_serie is not null and lower(v_serie) in
     ('to be filled by o.e.m.', 'default string', 'system serial number', 'none', '0', 'not specified') then
    v_serie := null;
  end if;
  if v_serie is not null then
    select id into v_equipo from inv_equipos where upper(numero_serie) = upper(v_serie) limit 1;
  end if;

  insert into inv_dispositivos as d (
    uuid_equipo, hostname, numero_serie, fabricante, modelo, so_nombre, so_version, so_build,
    so_arquitectura, procesador, nucleos, ram_total_gb, ram_libre_gb, discos, almacenamiento,
    ip, mac, usuario, dominio, arranque, bateria_pct, antivirus_activo, agente_version,
    equipo_id, ultimo_reporte
  ) values (
    v_uuid,
    p_datos->>'hostname',
    v_serie,
    p_datos->>'fabricante',
    p_datos->>'modelo',
    p_datos->>'so_nombre',
    p_datos->>'so_version',
    p_datos->>'so_build',
    p_datos->>'so_arquitectura',
    p_datos->>'procesador',
    nullif(p_datos->>'nucleos', '')::int,
    nullif(p_datos->>'ram_total_gb', '')::numeric,
    nullif(p_datos->>'ram_libre_gb', '')::numeric,
    coalesce(p_datos->'discos', '[]'::jsonb),
    p_datos->>'almacenamiento',
    p_datos->>'ip',
    p_datos->>'mac',
    p_datos->>'usuario',
    p_datos->>'dominio',
    nullif(p_datos->>'arranque', '')::timestamptz,
    nullif(p_datos->>'bateria_pct', '')::int,
    nullif(p_datos->>'antivirus_activo', '')::boolean,
    p_datos->>'agente_version',
    v_equipo,
    now()
  )
  on conflict (uuid_equipo) do update set
    hostname = excluded.hostname,
    numero_serie = excluded.numero_serie,
    fabricante = excluded.fabricante,
    modelo = excluded.modelo,
    so_nombre = excluded.so_nombre,
    so_version = excluded.so_version,
    so_build = excluded.so_build,
    so_arquitectura = excluded.so_arquitectura,
    procesador = excluded.procesador,
    nucleos = excluded.nucleos,
    ram_total_gb = excluded.ram_total_gb,
    ram_libre_gb = excluded.ram_libre_gb,
    discos = excluded.discos,
    almacenamiento = excluded.almacenamiento,
    ip = excluded.ip,
    mac = excluded.mac,
    usuario = excluded.usuario,
    dominio = excluded.dominio,
    arranque = excluded.arranque,
    bateria_pct = excluded.bateria_pct,
    antivirus_activo = excluded.antivirus_activo,
    agente_version = excluded.agente_version,
    equipo_id = coalesce(excluded.equipo_id, d.equipo_id),
    ultimo_reporte = now();

  -- Mantener al día los datos técnicos del equipo vinculado en el inventario
  select equipo_id into v_equipo from inv_dispositivos where uuid_equipo = v_uuid;
  if v_equipo is not null then
    update inv_equipos e set
      hostname = coalesce(p_datos->>'hostname', e.hostname),
      sistema_operativo = coalesce(p_datos->>'so_nombre', e.sistema_operativo),
      procesador = coalesce(p_datos->>'procesador', e.procesador),
      ram_gb = coalesce(round(nullif(p_datos->>'ram_total_gb', '')::numeric)::int, e.ram_gb),
      almacenamiento = coalesce(p_datos->>'almacenamiento', e.almacenamiento),
      mac = coalesce(p_datos->>'mac', e.mac)
    where e.id = v_equipo
      and (e.hostname, e.sistema_operativo, e.procesador, e.ram_gb, e.almacenamiento, e.mac)
          is distinct from
          (coalesce(p_datos->>'hostname', e.hostname),
           coalesce(p_datos->>'so_nombre', e.sistema_operativo),
           coalesce(p_datos->>'procesador', e.procesador),
           coalesce(round(nullif(p_datos->>'ram_total_gb', '')::numeric)::int, e.ram_gb),
           coalesce(p_datos->>'almacenamiento', e.almacenamiento),
           coalesce(p_datos->>'mac', e.mac));
  end if;
end $$;

-- El agente no inicia sesión: llama a esta función con la clave pública + el token
revoke all on function public.inv_reportar_dispositivo(text, jsonb) from public;
grant execute on function public.inv_reportar_dispositivo(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------
alter table public.inv_agente_config enable row level security;
alter table public.inv_dispositivos enable row level security;

drop policy if exists inv_agente_config_admin on public.inv_agente_config;
create policy inv_agente_config_admin on public.inv_agente_config for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

drop policy if exists inv_dispositivos_select on public.inv_dispositivos;
create policy inv_dispositivos_select on public.inv_dispositivos for select to authenticated
  using (mi_rol() is not null);

drop policy if exists inv_dispositivos_admin on public.inv_dispositivos;
create policy inv_dispositivos_admin on public.inv_dispositivos for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

-- Actualizaciones en vivo en la pantalla de Monitoreo
do $$ begin
  alter publication supabase_realtime add table public.inv_dispositivos;
exception when duplicate_object then null;
end $$;
