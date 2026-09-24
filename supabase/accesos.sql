-- ==========================================================
-- Acceso por solapa (grupos de acceso) + corrección de seguridad
-- Ejecutar UNA VEZ en el SQL Editor.
--
-- Solapas: empleados, licencias, inventario, seguridad, ubicacion
--   * Administradores: ven todo siempre.
--   * Usuarios con grupo: ven solo las solapas de su grupo.
--   * Usuarios sin grupo: ven todo (para no dejar a nadie sin acceso
--     al activar esto). Asigná un grupo a cada usuario desde Usuarios.
-- El control se aplica en la BASE DE DATOS, no solo en el menú.
-- ==========================================================

create table if not exists public.grupos_acceso (
  id serial primary key,
  nombre text not null unique,
  modulos text[] not null default '{}'
    check (modulos <@ array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion'])
);

insert into public.grupos_acceso (nombre, modulos) values
  ('RRHH',           array['empleados', 'inventario']),
  ('CAU',            array['empleados', 'licencias', 'inventario']),
  ('Ciberseguridad', array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion'])
on conflict (nombre) do nothing;

alter table public.perfiles
  add column if not exists grupo_id int references public.grupos_acceso(id) on delete set null;

-- Solapas que puede ver el usuario actual
create or replace function public.mis_modulos() returns text[]
language sql stable security definer set search_path = public as $$
  select case
           when p.rol = 'administrador' or p.grupo_id is null
             then array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion']
           else coalesce(g.modulos, '{}')
         end
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
   where p.id = auth.uid()
$$;

create or replace function public.puede_ver(p_modulo text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_modulo = any(coalesce(mis_modulos(), '{}'))
$$;

grant execute on function public.mis_modulos() to authenticated;
grant execute on function public.puede_ver(text) to authenticated;

-- ----------------------------------------------------------
-- Políticas RESTRICTIVAS: se suman a las que ya existen (rol, área).
-- Aunque alguien consulte la base directamente, no recibe datos de
-- solapas que no le corresponden.
-- ----------------------------------------------------------
do $$
declare
  t text;
  reglas jsonb := jsonb_build_object(
    'licencias', 'licencias', 'asignaciones', 'licencias',
    'inv_equipos', 'inventario', 'inv_asignaciones', 'inventario', 'inv_mantenimientos', 'inventario',
    'inv_equipos_log', 'inventario', 'inv_categorias', 'inventario', 'inv_ubicaciones', 'inventario',
    'inv_proveedores', 'inventario', 'inv_productos', 'inventario', 'inv_dispositivo_apps', 'inventario',
    'inv_apps_cambios', 'inventario',
    'inv_amenazas', 'seguridad', 'inv_software_prohibido', 'seguridad',
    'inv_ubicacion_diaria', 'ubicacion', 'inv_redes', 'ubicacion'
  );
begin
  for t in select jsonb_object_keys(reglas) loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_acceso_solapa', t);
      execute format(
        'create policy %I on public.%I as restrictive for all to authenticated
           using (public.puede_ver(%L)) with check (public.puede_ver(%L))',
        t || '_acceso_solapa', t, reglas->>t, reglas->>t);
    end if;
  end loop;
end $$;

-- Los equipos del agente se usan en Inventario, Seguridad y Oficina/Home office
drop policy if exists inv_dispositivos_acceso_solapa on public.inv_dispositivos;
create policy inv_dispositivos_acceso_solapa on public.inv_dispositivos as restrictive for all to authenticated
  using (public.puede_ver('inventario') or public.puede_ver('seguridad') or public.puede_ver('ubicacion'))
  with check (public.puede_ver('inventario') or public.puede_ver('seguridad') or public.puede_ver('ubicacion'));

-- La vista de ocupación de licencias pasa a respetar los permisos de quien consulta
alter view public.licencias_ocupacion set (security_invoker = true);

-- Grupos: todos los usuarios leen (para armar su menú); solo el admin los modifica
alter table public.grupos_acceso enable row level security;
drop policy if exists grupos_acceso_select on public.grupos_acceso;
create policy grupos_acceso_select on public.grupos_acceso for select to authenticated using (true);
drop policy if exists grupos_acceso_admin on public.grupos_acceso;
create policy grupos_acceso_admin on public.grupos_acceso for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

-- ----------------------------------------------------------
-- CORRECCIÓN DE SEGURIDAD: hasta ahora cualquier usuario podía modificar
-- su propio perfil completo (incluido el rol) y hacerse administrador
-- consultando la base directamente. Desde ahora, solo un administrador
-- cambia rol, área, grupo o email. Cada usuario puede cambiar su nombre.
-- (Desde el SQL Editor de Supabase se sigue pudiendo, como siempre.)
-- ----------------------------------------------------------
create or replace function public.proteger_perfil()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(mi_rol(), '') <> 'administrador'
     and (new.rol, new.area, new.grupo_id, new.email) is distinct from (old.rol, old.area, old.grupo_id, old.email) then
    raise exception 'Solo un administrador puede cambiar el rol, el área, el grupo de acceso o el email';
  end if;
  return new;
end $$;

drop trigger if exists trg_proteger_perfil on public.perfiles;
create trigger trg_proteger_perfil before update on public.perfiles
  for each row execute function public.proteger_perfil();
