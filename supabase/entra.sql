-- ==========================================================
-- Empleados: importación desde Excel y sincronización con Entra ID
-- Ejecutar UNA VEZ en el SQL Editor.
-- ==========================================================

alter table public.empleados
  add column if not exists entra_id text unique,     -- ID del usuario en Entra ID (Azure AD)
  add column if not exists origen text not null default 'manual',
  add column if not exists sincronizado timestamptz;

-- Historial de sincronizaciones e importaciones
create table if not exists public.empleados_sync (
  id bigserial primary key,
  fuente text not null check (fuente in ('entra', 'excel')),
  nuevos int not null default 0,
  actualizados int not null default 0,
  desactivados int not null default 0,
  usuario uuid references public.perfiles(id) default auth.uid(),
  fecha timestamptz not null default now()
);

alter table public.empleados_sync enable row level security;

drop policy if exists empleados_sync_select on public.empleados_sync;
create policy empleados_sync_select on public.empleados_sync for select to authenticated
  using (mi_rol() is not null);

drop policy if exists empleados_sync_insert on public.empleados_sync;
create policy empleados_sync_insert on public.empleados_sync for insert to authenticated
  with check (mi_rol() = 'administrador');
