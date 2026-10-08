-- ==========================================================
-- Mapa de conectividad (Infraestructura → Mapa de conectividad)
--   El esquema se arma solo con lo que informan los puentes. Esta tabla guarda solo lo que un
--   administrador corrige o agrega a mano.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de red.sql. Se puede repetir.
-- ==========================================================

-- Esquema: de dónde cuelga cada equipo cuando se corrige a mano (sin fila = automático).
--   clave / padre: "fg:<nombre del FortiGate>", "sw:<id de sw_switches>", "u:<mac de unifi_equipos>" o "vm" (VMware)
create table if not exists public.red_esquema (
  clave text primary key,
  padre text not null,
  actualizado timestamptz not null default now(),
  check (clave <> padre)
);
-- Equipos agregados a mano (clave "m:<id>", no monitoreados) y nombre de los enlaces de Internet (clave "wan:<fortigate>:<interfaz>")
alter table public.red_esquema add column if not exists nombre text;
alter table public.red_esquema add column if not exists tipo text;
alter table public.red_esquema add column if not exists detalle text;
alter table public.red_esquema enable row level security;
drop policy if exists red_esquema_select on public.red_esquema;
create policy red_esquema_select on public.red_esquema for select to authenticated
  using (puede_ver('red'));
drop policy if exists red_esquema_admin on public.red_esquema;
create policy red_esquema_admin on public.red_esquema for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('red'))
  with check (mi_rol() = 'administrador' and puede_ver('red'));
