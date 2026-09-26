-- ==========================================================
-- Identidad (Entra ID): historial diario de la postura de cuentas
-- MFA, cuentas inactivas, administradores e invitados.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de acceso-restringido.sql.
-- ==========================================================

create table if not exists public.identidad_resumen (
  fecha date primary key,
  miembros int not null default 0,
  sin_mfa int,              -- null = no disponible (sin licencia P1/P2 o sin permiso)
  inactivos int,
  admins int,
  admins_sin_mfa int,
  invitados int not null default 0,
  invitados_pendientes int not null default 0,
  dias_inactivo int not null default 90,
  actualizado timestamptz not null default now()
);

alter table public.identidad_resumen enable row level security;

drop policy if exists identidad_resumen_select on public.identidad_resumen;
create policy identidad_resumen_select on public.identidad_resumen for select to authenticated
  using (puede_ver('seguridad'));

-- La API la actualiza con la sesión de quien consulta (solo quien ve Seguridad)
drop policy if exists identidad_resumen_insert on public.identidad_resumen;
create policy identidad_resumen_insert on public.identidad_resumen for insert to authenticated
  with check (puede_ver('seguridad'));

drop policy if exists identidad_resumen_update on public.identidad_resumen;
create policy identidad_resumen_update on public.identidad_resumen for update to authenticated
  using (puede_ver('seguridad')) with check (puede_ver('seguridad'));

revoke delete on public.identidad_resumen from anon, authenticated;
