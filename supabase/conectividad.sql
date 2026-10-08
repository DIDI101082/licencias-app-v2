-- ==========================================================
-- Mapa de conectividad: desde dónde se conectan los equipos y a qué servidores llegan.
--   Carga manual desde la app (Infraestructura → Mapa de conectividad).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de red.sql y switches.sql. Se puede repetir.
-- ==========================================================

-- Puntos del mapa: orígenes (desde dónde), pasos (por dónde) y destinos (a qué)
create table if not exists public.red_conect_nodos (
  id serial primary key,
  columna text not null check (columna in ('origen', 'paso', 'destino')),
  nombre text not null,
  detalle text,                       -- IP, rango, VLAN, etc.
  grupo text,                         -- sede, VLAN o sector (agrupa dentro de la columna)
  orden int not null default 0,
  creado_en timestamptz not null default now(),
  unique (columna, nombre)
);

-- Conexiones: origen → (paso opcional) → destino
create table if not exists public.red_conect_enlaces (
  id serial primary key,
  origen_id int not null references public.red_conect_nodos(id) on delete cascade,
  via_id int references public.red_conect_nodos(id) on delete set null,
  destino_id int not null references public.red_conect_nodos(id) on delete cascade,
  servicio text,                      -- ej: "RDP 3389", "HTTPS 443", "SMB"
  estado text not null default 'permitido' check (estado in ('permitido', 'restringido', 'revisar')),
  nota text,
  creado_en timestamptz not null default now(),
  check (origen_id <> destino_id)
);
create index if not exists idx_red_conect_enlaces_origen on public.red_conect_enlaces(origen_id);
create index if not exists idx_red_conect_enlaces_destino on public.red_conect_enlaces(destino_id);

alter table public.red_conect_nodos enable row level security;
alter table public.red_conect_enlaces enable row level security;

drop policy if exists red_conect_nodos_select on public.red_conect_nodos;
create policy red_conect_nodos_select on public.red_conect_nodos for select to authenticated
  using (puede_ver('red'));
drop policy if exists red_conect_nodos_admin on public.red_conect_nodos;
create policy red_conect_nodos_admin on public.red_conect_nodos for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('red'))
  with check (mi_rol() = 'administrador' and puede_ver('red'));

drop policy if exists red_conect_enlaces_select on public.red_conect_enlaces;
create policy red_conect_enlaces_select on public.red_conect_enlaces for select to authenticated
  using (puede_ver('red'));
drop policy if exists red_conect_enlaces_admin on public.red_conect_enlaces;
create policy red_conect_enlaces_admin on public.red_conect_enlaces for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('red'))
  with check (mi_rol() = 'administrador' and puede_ver('red'));

-- Esquema: rol de cada switch (core o piso). Vacío = automático (nombre con "core" o vecino del FortiGate).
alter table public.sw_switches add column if not exists rol text check (rol in ('core', 'piso'));
