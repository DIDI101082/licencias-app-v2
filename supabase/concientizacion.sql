-- ==========================================================
-- CONCIENTIZACIÓN EN SEGURIDAD
--   * Capacitaciones (con vigencia: por ejemplo, anual) y quién las completó.
--   * Simulaciones de phishing: resultados por campaña y, si se cargan, por persona
--     (quién hizo clic, quién ingresó la contraseña y quién lo reportó).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de acceso-restringido.sql.
-- ==========================================================

create table if not exists public.capacitaciones (
  id serial primary key,
  nombre text not null,
  descripcion text,
  obligatoria boolean not null default true,
  vigencia_meses int check (vigencia_meses between 1 and 60),   -- null = no vence
  creado timestamptz not null default now()
);

create table if not exists public.capacitaciones_completadas (
  capacitacion_id int not null references public.capacitaciones(id) on delete cascade,
  empleado_id uuid not null references public.empleados(id) on delete cascade,
  fecha date not null default current_date,
  nota text,
  primary key (capacitacion_id, empleado_id, fecha)
);
create index if not exists idx_cap_comp_emp on public.capacitaciones_completadas(empleado_id);

create table if not exists public.phishing_campanas (
  id serial primary key,
  nombre text not null,
  fecha date not null default current_date,
  plantilla text,                     -- qué simulaba (ej.: "factura falsa", "reseteo de contraseña")
  enviados int not null default 0 check (enviados >= 0),
  clics int not null default 0 check (clics >= 0),
  credenciales int not null default 0 check (credenciales >= 0),
  reportaron int not null default 0 check (reportaron >= 0),
  notas text,
  creado timestamptz not null default now()
);

create table if not exists public.phishing_resultados (
  campana_id int not null references public.phishing_campanas(id) on delete cascade,
  empleado_id uuid not null references public.empleados(id) on delete cascade,
  clic boolean not null default false,
  credenciales boolean not null default false,
  reporto boolean not null default false,
  primary key (campana_id, empleado_id)
);

-- Estado de cada empleado activo respecto de las capacitaciones obligatorias
create or replace view public.capacitaciones_v_estado with (security_invoker = true) as
select e.id as empleado_id, trim(concat_ws(' ', e.nombre, e.apellido)) as empleado, e.area,
       c.id as capacitacion_id, c.nombre as capacitacion,
       u.fecha as ultima,
       case when u.fecha is null then null
            when c.vigencia_meses is null then null
            else (u.fecha + make_interval(months => c.vigencia_meses))::date end as vence,
       case when u.fecha is null then 'pendiente'
            when c.vigencia_meses is not null and u.fecha + make_interval(months => c.vigencia_meses) < current_date then 'vencida'
            else 'al_dia' end as estado
  from empleados e
  cross join capacitaciones c
  left join lateral (select max(fecha) as fecha from capacitaciones_completadas x
                      where x.capacitacion_id = c.id and x.empleado_id = e.id) u on true
 where e.activo and c.obligatoria;

-- ----------------------------------------------------------
-- Permisos: lo ve quien tiene Seguridad; lo edita administrador o lectura_escritura con Seguridad
-- ----------------------------------------------------------
create or replace function public.concientizacion_puede_editar() returns boolean
language sql stable security definer set search_path = public as $$
  select puede_ver('seguridad') and coalesce(mi_rol() in ('administrador', 'lectura_escritura'), false)
$$;
grant execute on function public.concientizacion_puede_editar() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['capacitaciones', 'capacitaciones_completadas', 'phishing_campanas', 'phishing_resultados'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''seguridad''))', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_editar', t);
    execute format('create policy %I on public.%I for all to authenticated using (concientizacion_puede_editar()) with check (concientizacion_puede_editar())', t || '_editar', t);
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;

-- Capacitación anual sugerida (solo si la tabla está vacía)
insert into public.capacitaciones (nombre, descripcion, obligatoria, vigencia_meses)
select 'Concientización en seguridad de la información',
       'Phishing, contraseñas y MFA, manejo de información confidencial, uso aceptable de equipos y cómo reportar incidentes.',
       true, 12
 where not exists (select 1 from public.capacitaciones);
