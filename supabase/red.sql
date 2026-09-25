-- ==========================================================
-- Solapa "Monitoreo de red": mapas publicados desde PRTG
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de accesos.sql.
-- ==========================================================

-- Nueva solapa en los grupos de acceso
alter table public.grupos_acceso drop constraint if exists grupos_acceso_modulos_check;
alter table public.grupos_acceso add constraint grupos_acceso_modulos_check
  check (modulos <@ array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red']);

create or replace function public.mis_modulos() returns text[]
language sql stable security definer set search_path = public as $$
  select case
           when p.rol = 'administrador' or p.grupo_id is null
             then array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red']
           else coalesce(g.modulos, '{}')
         end
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
   where p.id = auth.uid()
$$;

update public.grupos_acceso
   set modulos = modulos || array['red']
 where nombre = 'Ciberseguridad' and not ('red' = any(modulos));

-- Mapas de PRTG (la dirección incluye la clave secreta del mapa público)
create table if not exists public.red_mapas (
  id serial primary key,
  nombre text not null,
  url text not null check (url ~* '^https?://[^\s]+$'),
  alto int not null default 800 check (alto between 300 and 3000),
  orden int not null default 0,
  creado_en timestamptz not null default now()
);

alter table public.red_mapas enable row level security;

drop policy if exists red_mapas_select on public.red_mapas;
create policy red_mapas_select on public.red_mapas for select to authenticated
  using (puede_ver('red'));

drop policy if exists red_mapas_admin on public.red_mapas;
create policy red_mapas_admin on public.red_mapas for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('red'))
  with check (mi_rol() = 'administrador' and puede_ver('red'));
