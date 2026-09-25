-- ==========================================================
-- Diagrama de red: a qué equipo se conecta cada equipo de PRTG
-- (si no hay nada cargado, la app arma una conexión automática)
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de red-auto.sql.
-- ==========================================================

create table if not exists public.red_conexiones (
  objid int primary key,              -- equipo de PRTG
  conecta_a int not null,             -- otro equipo de PRTG, o -1 = Internet
  actualizado timestamptz not null default now(),
  check (objid <> conecta_a)
);

alter table public.red_conexiones enable row level security;

drop policy if exists red_conexiones_select on public.red_conexiones;
create policy red_conexiones_select on public.red_conexiones for select to authenticated
  using (puede_ver('red'));

drop policy if exists red_conexiones_admin on public.red_conexiones;
create policy red_conexiones_admin on public.red_conexiones for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('red'))
  with check (mi_rol() = 'administrador' and puede_ver('red'));
