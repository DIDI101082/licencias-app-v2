-- ==========================================================
-- Migración: pasar del esquema de roles viejo (rrhh/manager)
-- al nuevo (administrador/lectura_escritura/solo_lectura).
-- Ejecutar UNA SOLA VEZ en el SQL Editor de Supabase, en el
-- proyecto que ya tenías funcionando.
-- ==========================================================

-- 1. Sacar el check constraint viejo del campo rol
alter table perfiles drop constraint if exists perfiles_rol_check;

-- 2. Migrar los valores existentes
update perfiles set rol = 'administrador' where rol = 'rrhh';
update perfiles set rol = 'lectura_escritura' where rol = 'manager';

-- 3. Poner el nuevo check constraint y el nuevo default
alter table perfiles alter column rol set default 'solo_lectura';
alter table perfiles add constraint perfiles_rol_check
  check (rol in ('administrador', 'lectura_escritura', 'solo_lectura'));

-- 4. Actualizar la función que crea el perfil de cuentas nuevas
create or replace function crear_perfil_nuevo_usuario()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.perfiles (id, nombre, email, rol)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'nombre',
      new.email
    ),
    new.email,
    'solo_lectura'
  );
  return new;
end;
$$;

-- 5. Reemplazar las políticas de RLS viejas por las nuevas

drop policy if exists "perfiles_rrhh_all" on perfiles;
drop policy if exists "perfiles_administrador_all" on perfiles;
create policy "perfiles_administrador_all" on perfiles for all
  using (mi_rol() = 'administrador');

drop policy if exists "empleados_rrhh_all" on empleados;
drop policy if exists "empleados_manager_select" on empleados;
drop policy if exists "empleados_manager_insert" on empleados;
drop policy if exists "empleados_manager_update" on empleados;
drop policy if exists "empleados_administrador_all" on empleados;
drop policy if exists "empleados_le_select" on empleados;
drop policy if exists "empleados_le_insert" on empleados;
drop policy if exists "empleados_le_update" on empleados;
drop policy if exists "empleados_solo_lectura_select" on empleados;
create policy "empleados_administrador_all" on empleados for all
  using (mi_rol() = 'administrador');
create policy "empleados_le_select" on empleados for select
  using (mi_rol() = 'lectura_escritura' and area = mi_area());
create policy "empleados_le_insert" on empleados for insert
  with check (mi_rol() = 'lectura_escritura' and area = mi_area());
create policy "empleados_le_update" on empleados for update
  using (mi_rol() = 'lectura_escritura' and area = mi_area());
create policy "empleados_solo_lectura_select" on empleados for select
  using (mi_rol() = 'solo_lectura');

drop policy if exists "licencias_rrhh_all" on licencias;
drop policy if exists "licencias_manager_select" on licencias;
drop policy if exists "licencias_administrador_all" on licencias;
drop policy if exists "licencias_le_select" on licencias;
drop policy if exists "licencias_solo_lectura_select" on licencias;
create policy "licencias_administrador_all" on licencias for all
  using (mi_rol() = 'administrador');
create policy "licencias_le_select" on licencias for select
  using (mi_rol() = 'lectura_escritura');
create policy "licencias_solo_lectura_select" on licencias for select
  using (mi_rol() = 'solo_lectura');

drop policy if exists "asignaciones_rrhh_all" on asignaciones;
drop policy if exists "asignaciones_manager_select" on asignaciones;
drop policy if exists "asignaciones_manager_insert" on asignaciones;
drop policy if exists "asignaciones_manager_update" on asignaciones;
drop policy if exists "asignaciones_administrador_all" on asignaciones;
drop policy if exists "asignaciones_le_select" on asignaciones;
drop policy if exists "asignaciones_le_insert" on asignaciones;
drop policy if exists "asignaciones_le_update" on asignaciones;
drop policy if exists "asignaciones_solo_lectura_select" on asignaciones;
create policy "asignaciones_administrador_all" on asignaciones for all
  using (mi_rol() = 'administrador');
create policy "asignaciones_le_select" on asignaciones for select
  using (
    mi_rol() = 'lectura_escritura'
    and empleado_id in (select id from empleados where area = mi_area())
  );
create policy "asignaciones_le_insert" on asignaciones for insert
  with check (
    mi_rol() = 'lectura_escritura'
    and empleado_id in (select id from empleados where area = mi_area())
  );
create policy "asignaciones_le_update" on asignaciones for update
  using (
    mi_rol() = 'lectura_escritura'
    and empleado_id in (select id from empleados where area = mi_area())
  );
create policy "asignaciones_solo_lectura_select" on asignaciones for select
  using (mi_rol() = 'solo_lectura');

-- Listo. Verificá con: select email, rol, area from perfiles;
