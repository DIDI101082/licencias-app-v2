-- ==========================================================
-- LICENCIAS DE MICROSOFT 365 (leídas de Entra ID, solo lectura)
--   * La app lee de Microsoft Graph qué licencias hay compradas y a quién están asignadas,
--     y las guarda en las mismas tablas del módulo Licencias: cada producto es una fila de
--     "licencias" y cada usuario que la tiene, una fila de "asignaciones". Así aparecen en
--     la ficha del empleado, en Asignaciones, en Reportes y en el checklist de baja.
--   * Microsoft 365 es la fuente: lo que se asigna o se quita allá se refleja acá. Desde la
--     app solo se editan el nombre, el costo, el vencimiento y las notas de cada licencia.
--   * También guarda las cuentas con licencia que no son empleados (buzones compartidos,
--     cuentas de servicio, usuarios sin área) para poder revisarlas.
--   * Se actualiza con la tarea de cada 15 minutos (/api/entra/auto) y con el botón
--     "Sincronizar ahora" de la pantalla Licencias.
-- Permisos de la app de Entra: User.Read.All (ya lo tiene). Para ver compradas y libres:
-- LicenseAssignment.Read.All, Organization.Read.All o Directory.Read.All.
-- Ejecutar en el SQL Editor, DESPUÉS de entra.sql, accesos.sql y postura.sql.
-- Se puede volver a ejecutar sin problema.
-- ==========================================================

alter table public.licencias
  add column if not exists origen text not null default 'manual',
  add column if not exists sku_id text unique,           -- ID del producto en Microsoft 365
  add column if not exists sku_codigo text,              -- código de Microsoft (ej. SPE_E3)
  add column if not exists m365_consumidas int;          -- asignadas en total, incluidas las cuentas que no son empleados
alter table public.asignaciones
  add column if not exists origen text not null default 'manual';

create table if not exists public.m365_config (
  id int primary key default 1 check (id = 1),
  automatica boolean not null default true,              -- se actualiza con la tarea de cada 15 minutos
  incluir_gratuitas boolean not null default false,      -- Power Automate gratuito, Teams Exploratory, etc.
  ultima_ejecucion timestamptz,
  ultimo_error text,
  resultado jsonb not null default '{}',
  avisos jsonb not null default '[]'
);
insert into public.m365_config (id) values (1) on conflict (id) do nothing;

-- Todas las cuentas con alguna licencia, sean o no empleados
create table if not exists public.m365_cuentas (
  entra_id text primary key,
  email text,
  nombre text,
  habilitada boolean not null default true,
  ultimo_ingreso timestamptz,
  empleado_id uuid references public.empleados(id) on delete set null,
  skus text[] not null default '{}',
  desde jsonb not null default '{}'                      -- producto → fecha en que se asignó
);

-- ----------------------------------------------------------
-- Aplica lo leído de Microsoft 365
-- ----------------------------------------------------------
create or replace function public.m365_aplicar_interno(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s jsonb;
  v_id uuid;
  v_productos int := 0;
  v_nuevas int := 0;
  v_liberadas int := 0;
  v_sin_totales boolean := coalesce((p ->> 'sin_totales')::boolean, false);
  v_res jsonb;
begin
  -- Nunca aplicar con una respuesta vacía de Entra (liberaría todas las licencias)
  if coalesce((p ->> 'total')::int, 0) = 0 then
    raise exception 'Microsoft 365 no devolvió usuarios: no se aplicó ningún cambio';
  end if;

  -- 1. Productos: se crean una vez; después solo se actualizan las cantidades
  for s in select * from jsonb_array_elements(coalesce(p -> 'skus', '[]')) loop
    select id into v_id from licencias where sku_id = s ->> 'sku_id';
    if v_id is null and s ->> 'nombre' is not null then
      -- Si ya estaba cargada a mano con el mismo nombre, se vincula en vez de duplicarla
      select id into v_id from licencias
       where sku_id is null and lower(trim(nombre)) = lower(trim(s ->> 'nombre')) order by created_at limit 1;
      if v_id is not null then
        update licencias set sku_id = s ->> 'sku_id', origen = 'm365' where id = v_id;
      end if;
    end if;
    if v_id is null then
      insert into licencias (nombre, proveedor, tipo, costo_unitario, periodicidad, seats_totales, origen, sku_id)
      values (coalesce(s ->> 'nombre', 'Licencia ' || left(s ->> 'sku_id', 8)), 'Microsoft', 'Microsoft 365', 0, 'mensual',
              coalesce((s ->> 'compradas')::int, (s ->> 'consumidas')::int, 0), 'm365', s ->> 'sku_id')
      returning id into v_id;
      v_productos := v_productos + 1;
    end if;
    update licencias set
      sku_codigo = coalesce(s ->> 'codigo', sku_codigo),
      m365_consumidas = (s ->> 'consumidas')::int,
      seats_totales = case when v_sin_totales or s ->> 'compradas' is null then seats_totales else (s ->> 'compradas')::int end
    where id = v_id
      and (sku_codigo is distinct from coalesce(s ->> 'codigo', sku_codigo)
           or m365_consumidas is distinct from (s ->> 'consumidas')::int
           or (not v_sin_totales and s ->> 'compradas' is not null and seats_totales <> (s ->> 'compradas')::int));
  end loop;

  -- 2. Cuentas con licencia (se vinculan al empleado por ID de Entra o por correo)
  delete from m365_cuentas;
  insert into m365_cuentas (entra_id, email, nombre, habilitada, ultimo_ingreso, skus, desde, empleado_id)
  select c ->> 'entra_id', lower(c ->> 'email'), c ->> 'nombre', coalesce((c ->> 'habilitada')::boolean, true),
         (c ->> 'ultimo_ingreso')::timestamptz,
         array(select jsonb_array_elements_text(coalesce(c -> 'skus', '[]'))), coalesce(c -> 'desde', '{}'),
         coalesce((select e.id from empleados e where e.entra_id = c ->> 'entra_id'),
                  (select e.id from empleados e where lower(e.email) = lower(c ->> 'email') limit 1))
    from jsonb_array_elements(coalesce(p -> 'cuentas', '[]')) c
  on conflict (entra_id) do nothing;

  -- 3. Asignaciones: las que faltan se crean y las que ya no están en Microsoft 365 se liberan
  insert into asignaciones (licencia_id, empleado_id, fecha_asignacion, origen, notas)
  select distinct on (l.id, c.empleado_id) l.id, c.empleado_id,
         least(coalesce((c.desde ->> x.sku)::timestamptz::date, current_date), current_date), 'm365', 'Asignada en Microsoft 365'
    from m365_cuentas c cross join unnest(c.skus) x(sku) join licencias l on l.sku_id = x.sku
   where c.empleado_id is not null
     and not exists (select 1 from asignaciones a
                      where a.licencia_id = l.id and a.empleado_id = c.empleado_id and a.fecha_liberacion is null);
  get diagnostics v_nuevas = row_count;

  update asignaciones a set fecha_liberacion = current_date
   where a.fecha_liberacion is null
     and a.licencia_id in (select id from licencias where sku_id is not null)
     and not exists (select 1 from m365_cuentas c join licencias l on l.sku_id = any(c.skus)
                      where c.empleado_id = a.empleado_id and l.id = a.licencia_id);
  get diagnostics v_liberadas = row_count;

  v_res := jsonb_build_object(
    'productos', jsonb_array_length(coalesce(p -> 'skus', '[]')), 'productos_nuevos', v_productos,
    'cuentas', (select count(*) from m365_cuentas), 'sin_empleado', (select count(*) from m365_cuentas where empleado_id is null),
    'asignadas', v_nuevas, 'liberadas', v_liberadas,
    'sin_totales', v_sin_totales, 'con_ingresos', coalesce((p ->> 'con_ingresos')::boolean, false));
  update m365_config set ultima_ejecucion = now(), ultimo_error = null, resultado = v_res,
                         avisos = coalesce(p -> 'avisos', '[]') where id = 1;
  return v_res;
end $$;
revoke all on function public.m365_aplicar_interno(jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Tarea programada (se identifica con la clave CRON_SECRET)
-- ----------------------------------------------------------
create or replace function public.m365_auto_inicio(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  return (select jsonb_build_object('automatica', automatica, 'incluir_gratuitas', incluir_gratuitas) from m365_config where id = 1);
end $$;
revoke all on function public.m365_auto_inicio(text) from public, authenticated;
grant execute on function public.m365_auto_inicio(text) to anon;

create or replace function public.m365_auto_aplicar(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  return m365_aplicar_interno(p);
end $$;
revoke all on function public.m365_auto_aplicar(text, jsonb) from public, authenticated;
grant execute on function public.m365_auto_aplicar(text, jsonb) to anon;

create or replace function public.m365_auto_error(p_token text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  update m365_config set ultima_ejecucion = now(), ultimo_error = left(p_error, 300) where id = 1;
end $$;
revoke all on function public.m365_auto_error(text, text) from public, authenticated;
grant execute on function public.m365_auto_error(text, text) to anon;

-- ----------------------------------------------------------
-- Pantalla (Licencias)
-- ----------------------------------------------------------
create or replace function public.m365_aplicar(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede sincronizar las licencias'; end if;
  return m365_aplicar_interno(p);
end $$;
revoke all on function public.m365_aplicar(jsonb) from public, anon;
grant execute on function public.m365_aplicar(jsonb) to authenticated;

create or replace function public.m365_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede cambiar esta configuración'; end if;
  update m365_config set
    automatica = coalesce((p ->> 'automatica')::boolean, automatica),
    incluir_gratuitas = coalesce((p ->> 'incluir_gratuitas')::boolean, incluir_gratuitas)
  where id = 1;
end $$;
revoke all on function public.m365_guardar(jsonb) from public, anon;
grant execute on function public.m365_guardar(jsonb) to authenticated;

-- Quien tiene rol de lectura y escritura ve solo las cuentas de su área, igual que en Asignaciones
create or replace function public.m365_estado() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c m365_config;
begin
  if not puede_ver('licencias') then raise exception 'Sin acceso'; end if;
  select * into c from m365_config where id = 1;
  return jsonb_build_object(
    'automatica', c.automatica, 'incluir_gratuitas', c.incluir_gratuitas, 'ultima_ejecucion', c.ultima_ejecucion,
    'ultimo_error', c.ultimo_error, 'resultado', c.resultado, 'avisos', c.avisos,
    'cuentas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'entra_id', m.entra_id, 'email', m.email, 'nombre', m.nombre, 'habilitada', m.habilitada,
               'ultimo_ingreso', m.ultimo_ingreso, 'empleado_id', m.empleado_id, 'area', e.area, 'skus', to_jsonb(m.skus))
             order by m.nombre)
        from m365_cuentas m left join empleados e on e.id = m.empleado_id
       where mi_rol() in ('administrador', 'solo_lectura') or (mi_rol() = 'lectura_escritura' and e.area = mi_area())), '[]'));
end $$;
revoke all on function public.m365_estado() from public, anon;
grant execute on function public.m365_estado() to authenticated;

-- ----------------------------------------------------------
-- Permisos: se leen solo con m365_estado(); se escriben solo desde la sincronización
-- ----------------------------------------------------------
alter table public.m365_config enable row level security;
alter table public.m365_cuentas enable row level security;
revoke all on public.m365_config, public.m365_cuentas from anon, authenticated;
