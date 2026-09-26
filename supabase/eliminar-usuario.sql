-- ==========================================================
-- Eliminar usuarios desde la pantalla Usuarios (solo administradores)
--   * No permite eliminarse a uno mismo
--   * Conserva el historial: donde el usuario figura como autor
--     (asignaciones, códigos de instalación, días justificados, etc.) queda vacío
--   * Borra la cuenta de inicio de sesión y su perfil
-- Ejecutar UNA VEZ en el SQL Editor.
-- ==========================================================

create or replace function public.eliminar_usuario(p_id uuid)
returns void language plpgsql security definer set search_path = public, auth as $$
declare
  r record;
begin
  if coalesce(mi_rol(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede eliminar usuarios';
  end if;
  if p_id = auth.uid() then
    raise exception 'No podés eliminar tu propio usuario';
  end if;
  if not exists (select 1 from perfiles where id = p_id) then
    raise exception 'El usuario no existe';
  end if;

  -- Todas las columnas que apuntan a perfiles (se detectan solas, incluso en tablas futuras)
  for r in
    select c.conrelid::regclass as tabla, a.attname as columna
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.contype = 'f' and c.confrelid = 'public.perfiles'::regclass
  loop
    execute format('update %s set %I = null where %I = $1', r.tabla, r.columna, r.columna) using p_id;
  end loop;

  -- La cuenta de inicio de sesión (el perfil se borra en cascada)
  delete from auth.users where id = p_id;
end $$;

revoke all on function public.eliminar_usuario(uuid) from public, anon;
grant execute on function public.eliminar_usuario(uuid) to authenticated;
