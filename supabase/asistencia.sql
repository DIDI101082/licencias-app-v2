-- ==========================================================
-- Asistencia semanal: días en la oficina vs. home office por persona
-- Se calcula con el historial diario de ubicación de sus equipos.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de ubicacion.sql y accesos.sql.
-- ==========================================================

-- Política de la empresa (editable desde la app)
create table if not exists public.asistencia_config (
  id int primary key default 1 check (id = 1),
  dias_oficina_semana int not null default 3 check (dias_oficina_semana between 0 and 5)
);
insert into public.asistencia_config (id) values (1) on conflict (id) do nothing;

-- Feriados: no cuentan como día hábil
create table if not exists public.asistencia_feriados (
  fecha date primary key,
  nombre text not null
);

-- Días justificados por persona (vacaciones, licencia, viaje, etc.)
create table if not exists public.asistencia_excepciones (
  empleado_id uuid not null references public.empleados(id) on delete cascade,
  fecha date not null,
  motivo text not null,
  cargado_por uuid references public.perfiles(id) default auth.uid(),
  cargado_en timestamptz not null default now(),
  primary key (empleado_id, fecha)
);

-- Un registro por persona con cada día hábil del período y su estado:
--   feriado | justificado | oficina | home | sin_datos
-- Respeta los permisos de quien consulta (security invoker).
create or replace function public.inv_asistencia(p_desde date, p_hasta date)
returns table (empleado_id uuid, empleado text, area text, dias jsonb)
language sql stable as $$
  with dias as (
    select d::date as fecha
      from generate_series(p_desde, p_hasta, interval '1 day') d
     where extract(isodow from d) < 6
  ),
  personas as (
    select distinct e.id, trim(concat_ws(' ', e.nombre, e.apellido)) as nombre, e.area
      from empleados e
      join inv_equipos q on q.empleado_id = e.id
      join inv_dispositivos d on d.equipo_id = q.id and d.estado_registro = 'aprobado'
     where e.activo
       and puede_ver('ubicacion')   -- sin acceso a la solapa, no devuelve nada
  ),
  marcas as (
    select q.empleado_id, u.fecha,
           bool_or(u.tipo in ('oficina', 'invitados')) as oficina,
           bool_or(u.tipo in ('vpn', 'remoto')) as home,
           max(u.sede) filter (where u.tipo in ('oficina', 'invitados')) as sede
      from inv_ubicacion_diaria u
      join inv_dispositivos d on d.id = u.dispositivo_id
      join inv_equipos q on q.id = d.equipo_id
     where u.fecha between p_desde and p_hasta and q.empleado_id is not null
     group by q.empleado_id, u.fecha
  )
  select p.id, p.nombre, p.area,
         jsonb_agg(jsonb_build_object(
           'fecha', dd.fecha,
           'estado', case
                       when f.fecha is not null then 'feriado'
                       when x.fecha is not null then 'justificado'
                       when m.oficina then 'oficina'
                       when m.home then 'home'
                       else 'sin_datos'
                     end,
           'sede', case when m.oficina then m.sede end,
           'detalle', coalesce(f.nombre, x.motivo)
         ) order by dd.fecha)
    from personas p
    cross join dias dd
    left join marcas m on m.empleado_id = p.id and m.fecha = dd.fecha
    left join asistencia_feriados f on f.fecha = dd.fecha
    left join asistencia_excepciones x on x.empleado_id = p.id and x.fecha = dd.fecha
   group by p.id, p.nombre, p.area
   order by p.nombre
$$;

grant execute on function public.inv_asistencia(date, date) to authenticated;

-- ----------------------------------------------------------
-- Permisos: lo ve quien tiene la solapa Oficina / Home office.
-- Feriados y política: solo administradores.
-- Días justificados: administradores y usuarios con edición de esa solapa.
-- ----------------------------------------------------------
alter table public.asistencia_config enable row level security;
alter table public.asistencia_feriados enable row level security;
alter table public.asistencia_excepciones enable row level security;

drop policy if exists asistencia_config_select on public.asistencia_config;
create policy asistencia_config_select on public.asistencia_config for select to authenticated
  using (puede_ver('ubicacion'));
drop policy if exists asistencia_config_admin on public.asistencia_config;
create policy asistencia_config_admin on public.asistencia_config for update to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

drop policy if exists asistencia_feriados_select on public.asistencia_feriados;
create policy asistencia_feriados_select on public.asistencia_feriados for select to authenticated
  using (puede_ver('ubicacion'));
drop policy if exists asistencia_feriados_admin on public.asistencia_feriados;
create policy asistencia_feriados_admin on public.asistencia_feriados for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

drop policy if exists asistencia_excepciones_select on public.asistencia_excepciones;
create policy asistencia_excepciones_select on public.asistencia_excepciones for select to authenticated
  using (puede_ver('ubicacion'));
drop policy if exists asistencia_excepciones_editar on public.asistencia_excepciones;
create policy asistencia_excepciones_editar on public.asistencia_excepciones for all to authenticated
  using (puede_ver('ubicacion') and mi_rol() in ('administrador', 'lectura_escritura'))
  with check (puede_ver('ubicacion') and mi_rol() in ('administrador', 'lectura_escritura'));
