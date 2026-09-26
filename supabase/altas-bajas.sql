-- ==========================================================
-- ALTAS Y BAJAS DE EMPLEADOS (onboarding / offboarding) + ACTAS
--   * Cuando entra un empleado (alta manual, Excel o Entra ID) se abre su checklist de alta.
--   * Cuando se desactiva, se abre el checklist de baja (cuentas, licencias, equipos, accesos).
--   * Cada tarea tiene responsable (RRHH, CAU, Ciberseguridad) y queda quién y cuándo la hizo.
--   * Actas de entrega y devolución de equipos numeradas, para imprimir y firmar.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de alertas.sql.
-- ==========================================================

-- Tareas modelo (se editan desde la app)
create table if not exists public.empleados_plantilla (
  id serial primary key,
  tipo text not null check (tipo in ('alta', 'baja')),
  orden int not null default 0,
  descripcion text not null,
  responsable text not null default 'CAU',
  activo boolean not null default true
);

insert into public.empleados_plantilla (tipo, orden, descripcion, responsable)
select * from (values
  ('alta', 10, 'Crear la cuenta en Entra ID / Microsoft 365', 'CAU'),
  ('alta', 20, 'Configurar MFA (doble factor) en la cuenta', 'Ciberseguridad'),
  ('alta', 30, 'Agregar a los grupos, carpetas y sistemas que requiere el puesto', 'CAU'),
  ('alta', 40, 'Asignar las licencias de software', 'CAU'),
  ('alta', 50, 'Entregar notebook y periféricos con acta de entrega firmada', 'CAU'),
  ('alta', 60, 'Instalar el agente Accusys Cyber y aprobar el equipo', 'Ciberseguridad'),
  ('alta', 70, 'Verificar cifrado de disco, antivirus y actualizaciones del equipo', 'Ciberseguridad'),
  ('alta', 80, 'Firma de política de uso aceptable y acuerdo de confidencialidad', 'RRHH'),
  ('alta', 90, 'Capacitación de concientización en seguridad', 'Ciberseguridad'),
  ('baja', 10, 'Deshabilitar la cuenta en Entra ID y cerrar todas las sesiones', 'Ciberseguridad'),
  ('baja', 20, 'Quitar MFA, dispositivos móviles registrados y accesos VPN', 'Ciberseguridad'),
  ('baja', 30, 'Quitar de grupos, carpetas compartidas y sistemas', 'CAU'),
  ('baja', 40, 'Definir qué pasa con el correo y el OneDrive (reenvío o resguardo)', 'CAU'),
  ('baja', 50, 'Liberar las licencias de software', 'CAU'),
  ('baja', 60, 'Recuperar notebook y periféricos con acta de devolución firmada', 'CAU'),
  ('baja', 70, 'Borrado seguro o reinstalación del equipo devuelto', 'CAU'),
  ('baja', 80, 'Quitar el acceso a Accusys Cyber (si tenía usuario)', 'Ciberseguridad'),
  ('baja', 90, 'Cierre de legajo', 'RRHH')
) v(tipo, orden, descripcion, responsable)
where not exists (select 1 from public.empleados_plantilla);

create table if not exists public.empleados_movimientos (
  id bigserial primary key,
  empleado_id uuid not null references public.empleados(id) on delete cascade,
  tipo text not null check (tipo in ('alta', 'baja')),
  estado text not null default 'abierto' check (estado in ('abierto', 'completo', 'descartado')),
  origen text not null default 'automatico' check (origen in ('automatico', 'manual')),
  fecha date not null default current_date,
  notas text,
  creado timestamptz not null default now(),
  cerrado timestamptz,
  cerrado_por uuid references public.perfiles(id) on delete set null
);
create index if not exists idx_emp_mov_empleado on public.empleados_movimientos(empleado_id);
create unique index if not exists uq_emp_mov_abierto on public.empleados_movimientos(empleado_id, tipo) where estado = 'abierto';

create table if not exists public.empleados_tareas (
  id bigserial primary key,
  movimiento_id bigint not null references public.empleados_movimientos(id) on delete cascade,
  orden int not null default 0,
  descripcion text not null,
  responsable text not null,
  hecha boolean not null default false,
  hecha_en timestamptz,
  hecha_por uuid references public.perfiles(id) on delete set null,
  hecha_por_nombre text,
  nota text
);
create index if not exists idx_emp_tareas_mov on public.empleados_tareas(movimiento_id);

-- Abre un movimiento con las tareas de la plantilla (si ya hay uno abierto del mismo tipo, lo devuelve)
create or replace function public.empleados_abrir_movimiento(p_empleado uuid, p_tipo text, p_origen text default 'automatico')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  select id into v_id from empleados_movimientos where empleado_id = p_empleado and tipo = p_tipo and estado = 'abierto';
  if v_id is not null then
    return v_id;
  end if;
  -- una baja cierra (descarta) el alta que haya quedado abierta, y viceversa
  update empleados_movimientos set estado = 'descartado', cerrado = now(),
         notas = concat_ws(E'\n', notas, 'Descartado automáticamente por ' || case p_tipo when 'baja' then 'la baja' else 'el reingreso' end)
   where empleado_id = p_empleado and estado = 'abierto' and tipo <> p_tipo;

  insert into empleados_movimientos (empleado_id, tipo, origen) values (p_empleado, p_tipo, p_origen) returning id into v_id;
  insert into empleados_tareas (movimiento_id, orden, descripcion, responsable)
  select v_id, orden, descripcion, responsable from empleados_plantilla where tipo = p_tipo and activo order by orden, id;
  return v_id;
end $$;
revoke all on function public.empleados_abrir_movimiento(uuid, text, text) from public, anon, authenticated;

-- Automático: alta al crear un empleado activo; baja al desactivarlo; alta al reactivarlo
create or replace function public.empleados_detectar_movimiento()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.activo then
    perform empleados_abrir_movimiento(new.id, 'alta');
  elsif tg_op = 'UPDATE' and old.activo and not new.activo then
    perform empleados_abrir_movimiento(new.id, 'baja');
  elsif tg_op = 'UPDATE' and not old.activo and new.activo then
    perform empleados_abrir_movimiento(new.id, 'alta');
  end if;
  return new;
exception when others then
  return new;   -- nunca impedir el alta/baja del empleado
end $$;

drop trigger if exists trg_empleados_movimiento on public.empleados;
create trigger trg_empleados_movimiento after insert or update of activo on public.empleados
  for each row execute function public.empleados_detectar_movimiento();

-- ----------------------------------------------------------
-- Acciones desde la app
-- ----------------------------------------------------------
create or replace function public.empleados_puede_gestionar() returns boolean
language sql stable security definer set search_path = public as $$
  select puede_ver('empleados') and coalesce(mi_rol() in ('administrador', 'lectura_escritura'), false)
$$;

create or replace function public.empleados_iniciar(p_empleado uuid, p_tipo text)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not empleados_puede_gestionar() then
    raise exception 'No tenés permiso para gestionar altas y bajas';
  end if;
  if p_tipo not in ('alta', 'baja') then
    raise exception 'Tipo inválido';
  end if;
  return empleados_abrir_movimiento(p_empleado, p_tipo, 'manual');
end $$;
grant execute on function public.empleados_iniciar(uuid, text) to authenticated;

create or replace function public.empleados_tarea_marcar(p_tarea bigint, p_hecha boolean, p_nota text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_mov bigint; v_estado text;
begin
  if not empleados_puede_gestionar() then
    raise exception 'No tenés permiso para marcar tareas';
  end if;
  select t.movimiento_id, m.estado into v_mov, v_estado
    from empleados_tareas t join empleados_movimientos m on m.id = t.movimiento_id where t.id = p_tarea;
  if v_mov is null then raise exception 'Tarea inexistente'; end if;
  if v_estado <> 'abierto' then raise exception 'El checklist ya está cerrado'; end if;

  update empleados_tareas set
    hecha = p_hecha,
    hecha_en = case when p_hecha then now() end,
    hecha_por = case when p_hecha then auth.uid() end,
    hecha_por_nombre = case when p_hecha then (select coalesce(nombre, email) from perfiles where id = auth.uid()) end,
    nota = coalesce(nullif(trim(p_nota), ''), nota)
  where id = p_tarea;
end $$;
grant execute on function public.empleados_tarea_marcar(bigint, boolean, text) to authenticated;

create or replace function public.empleados_movimiento_cerrar(p_mov bigint, p_estado text, p_notas text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not empleados_puede_gestionar() then
    raise exception 'No tenés permiso';
  end if;
  if p_estado not in ('completo', 'descartado', 'abierto') then
    raise exception 'Estado inválido';
  end if;
  if p_estado = 'completo' and exists (select 1 from empleados_tareas where movimiento_id = p_mov and not hecha) then
    raise exception 'Quedan tareas sin hacer';
  end if;
  update empleados_movimientos set
    estado = p_estado,
    cerrado = case when p_estado = 'abierto' then null else now() end,
    cerrado_por = case when p_estado = 'abierto' then null else auth.uid() end,
    notas = coalesce(nullif(trim(p_notas), ''), notas)
  where id = p_mov;
end $$;
grant execute on function public.empleados_movimiento_cerrar(bigint, text, text) to authenticated;

-- Descartar en bloque (por ejemplo, las altas que se abrieron al importar todo el Excel)
create or replace function public.empleados_descartar_altas(p_antes date)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if mi_rol() is distinct from 'administrador' then
    raise exception 'Solo un administrador';
  end if;
  update empleados_movimientos set estado = 'descartado', cerrado = now(), cerrado_por = auth.uid(),
         notas = concat_ws(E'\n', notas, 'Descartada en bloque (carga inicial)')
   where tipo = 'alta' and estado = 'abierto' and fecha <= p_antes;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.empleados_descartar_altas(date) to authenticated;

-- Resumen para la pantalla: movimientos con avance, licencias y equipos pendientes
create or replace view public.empleados_v_movimientos with (security_invoker = true) as
select m.*,
       e.nombre, e.apellido, e.email, e.area, e.puesto, e.activo,
       (select count(*) from empleados_tareas t where t.movimiento_id = m.id)::int as tareas,
       (select count(*) from empleados_tareas t where t.movimiento_id = m.id and t.hecha)::int as hechas,
       (select count(*) from asignaciones a where a.empleado_id = m.empleado_id and a.fecha_liberacion is null)::int as licencias_activas,
       (select count(*) from inv_equipos q where q.empleado_id = m.empleado_id and q.estado in ('asignado', 'prestado'))::int as equipos_asignados
  from empleados_movimientos m
  join empleados e on e.id = m.empleado_id;

-- ----------------------------------------------------------
-- Actas de entrega y devolución
-- ----------------------------------------------------------
create sequence if not exists public.empleados_actas_numero_seq;

create table if not exists public.empleados_actas (
  id bigserial primary key,
  numero int not null unique default nextval('public.empleados_actas_numero_seq'),
  empleado_id uuid not null references public.empleados(id) on delete cascade,
  tipo text not null check (tipo in ('entrega', 'devolucion')),
  fecha timestamptz not null default now(),
  empleado jsonb not null,          -- datos de la persona al momento del acta
  equipos jsonb not null,           -- [{codigo, categoria, marca, modelo, numero_serie, condicion, accesorios}]
  observaciones text,
  generado_por uuid references public.perfiles(id) on delete set null default auth.uid(),
  generado_por_nombre text
);
create index if not exists idx_emp_actas_empleado on public.empleados_actas(empleado_id, fecha desc);

create or replace function public.empleados_acta_crear(p_empleado uuid, p_tipo text, p_equipos uuid[], p_observaciones text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_emp jsonb; v_eq jsonb; v_nombre text;
begin
  if not (puede_ver('empleados') or puede_ver('inventario')) or coalesce(mi_rol(), 'solo_lectura') = 'solo_lectura' then
    raise exception 'No tenés permiso para generar actas';
  end if;
  if p_tipo not in ('entrega', 'devolucion') then raise exception 'Tipo inválido'; end if;
  if coalesce(cardinality(p_equipos), 0) = 0 then raise exception 'Elegí al menos un equipo'; end if;

  select jsonb_build_object('nombre', trim(concat_ws(' ', nombre, apellido)), 'email', email, 'area', area, 'puesto', puesto)
    into v_emp from empleados where id = p_empleado;
  if v_emp is null then raise exception 'Empleado inexistente'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'codigo', q.codigo, 'categoria', c.nombre, 'marca', q.marca, 'modelo', q.modelo,
           'numero_serie', q.numero_serie, 'condicion', q.condicion) order by q.codigo), '[]')
    into v_eq
    from inv_equipos q left join inv_categorias c on c.id = q.categoria_id
   where q.id = any(p_equipos);

  select coalesce(nombre, email) into v_nombre from perfiles where id = auth.uid();
  insert into empleados_actas (empleado_id, tipo, empleado, equipos, observaciones, generado_por_nombre)
  values (p_empleado, p_tipo, v_emp, v_eq, nullif(trim(p_observaciones), ''), v_nombre)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.empleados_acta_crear(uuid, text, uuid[], text) to authenticated;

-- ----------------------------------------------------------
-- Permisos
-- ----------------------------------------------------------
alter table public.empleados_plantilla enable row level security;
alter table public.empleados_movimientos enable row level security;
alter table public.empleados_tareas enable row level security;
alter table public.empleados_actas enable row level security;

drop policy if exists empleados_plantilla_select on public.empleados_plantilla;
create policy empleados_plantilla_select on public.empleados_plantilla for select to authenticated using (puede_ver('empleados'));
drop policy if exists empleados_plantilla_admin on public.empleados_plantilla;
create policy empleados_plantilla_admin on public.empleados_plantilla for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

-- movimientos y tareas: se leen con la solapa Empleados; se modifican solo por las funciones
drop policy if exists empleados_movimientos_select on public.empleados_movimientos;
create policy empleados_movimientos_select on public.empleados_movimientos for select to authenticated using (puede_ver('empleados'));
drop policy if exists empleados_tareas_select on public.empleados_tareas;
create policy empleados_tareas_select on public.empleados_tareas for select to authenticated using (puede_ver('empleados'));
revoke insert, update, delete on public.empleados_movimientos, public.empleados_tareas from anon, authenticated;

drop policy if exists empleados_actas_select on public.empleados_actas;
create policy empleados_actas_select on public.empleados_actas for select to authenticated
  using (puede_ver('empleados') or puede_ver('inventario'));
revoke insert, update, delete on public.empleados_actas from anon, authenticated;

-- Registro en Logs
do $$
declare t text;
begin
  foreach t in array array['empleados_plantilla', 'empleados_movimientos', 'empleados_tareas', 'empleados_actas'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
