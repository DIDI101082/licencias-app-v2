-- ==========================================================
-- Páginas por grupo de acceso: dentro de una solapa habilitada, un grupo
-- puede ver solo algunas páginas (ej.: RRHH → en Inventario IT solo "Escanear").
--
-- grupos_acceso.paginas = { "modulo": ["/pagina", ...] }
--   * Un módulo que NO figura en paginas → se ven todas sus páginas (como hasta ahora).
--   * Los administradores ven todo siempre.
-- Altas y bajas además se controla en la base de datos: sin esa página,
-- no se pueden consultar ni gestionar movimientos ni tareas.
-- Ejecutar UNA VEZ en el SQL Editor.
-- ==========================================================

alter table public.grupos_acceso add column if not exists paginas jsonb not null default '{}';
alter table public.grupos_acceso drop constraint if exists grupos_acceso_paginas_check;
alter table public.grupos_acceso add constraint grupos_acceso_paginas_check check (jsonb_typeof(paginas) = 'object');

-- Páginas habilitadas del usuario actual ('{}' = sin restricciones)
create or replace function public.mis_paginas() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when p.rol = 'administrador' then '{}'::jsonb else coalesce(g.paginas, '{}'::jsonb) end
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
   where p.id = auth.uid()
$$;

create or replace function public.puede_ver_pagina(p_modulo text, p_pagina text) returns boolean
language sql stable security definer set search_path = public as $$
  select puede_ver(p_modulo)
     and (jsonb_typeof(coalesce(mis_paginas(), '{}'::jsonb) -> p_modulo) is distinct from 'array'
          or (mis_paginas() -> p_modulo) ? p_pagina)
$$;

grant execute on function public.mis_paginas() to authenticated;
grant execute on function public.puede_ver_pagina(text, text) to authenticated;

-- ----------------------------------------------------------
-- Altas y bajas: se exige la página, no solo la solapa Empleados
-- ----------------------------------------------------------
create or replace function public.empleados_puede_gestionar() returns boolean
language sql stable security definer set search_path = public as $$
  select puede_ver_pagina('empleados', '/empleados/movimientos')
     and coalesce(mi_rol() in ('administrador', 'lectura_escritura'), false)
$$;

do $$
declare t text;
begin
  foreach t in array array['empleados_movimientos', 'empleados_tareas', 'empleados_plantilla'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_pagina', t);
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (puede_ver_pagina(''empleados'', ''/empleados/movimientos''))', t || '_pagina', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------
-- Grupo RRHH: Empleados (solo la lista), Licencias (todo), Inventario IT (solo Escanear)
-- ----------------------------------------------------------
update public.grupos_acceso
   set modulos = array['empleados', 'licencias', 'inventario'],
       paginas = '{"empleados": ["/empleados"], "inventario": ["/inventario/escanear"]}'::jsonb
 where lower(nombre) = 'rrhh';

select nombre, modulos, paginas from public.grupos_acceso order by nombre;
