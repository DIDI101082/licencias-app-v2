-- ==========================================================
-- Acceso restringido por defecto: un usuario SIN grupo de acceso no ve ninguna solapa
-- hasta que un administrador le asigne un grupo en Usuarios.
-- (Antes, "sin grupo" veía todo: cualquier cuenta nueva, por Microsoft o por email,
--  accedía a toda la información.)
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de red.sql.
-- ==========================================================

create or replace function public.mis_modulos() returns text[]
language sql stable security definer set search_path = public as $$
  select case
           when p.rol = 'administrador'
             then array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red']
           else coalesce(g.modulos, '{}')      -- sin grupo: ninguna solapa
         end
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
   where p.id = auth.uid()
$$;

-- Para revisar antes de aplicar: usuarios que NO son administradores y no tienen grupo
-- (van a quedar sin acceso hasta que les asignes uno)
select email, rol from public.perfiles where rol <> 'administrador' and grupo_id is null;
