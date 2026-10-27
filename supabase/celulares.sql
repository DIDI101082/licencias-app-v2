-- ============================================================
-- CELULARES CORPORATIVOS
-- Registro, asignación y seguimiento de celulares corporativos.
-- Ejecutar en Supabase → SQL Editor.
-- ============================================================

-- Tabla principal
create table if not exists cel_celulares (
  id               serial primary key,
  marca            text not null,
  modelo           text not null,
  imei             text,
  imei2            text,
  numero_linea     text,
  operadora        text,
  numero_sim       text,
  plan             text,
  color            text,
  almacenamiento   text,
  numero_inventario text,
  estado           text not null default 'en_deposito'
                   check (estado in ('en_deposito','asignado','en_reparacion','dado_de_baja')),
  piso             text,
  sector           text,
  empleado_id      uuid references empleados(id) on delete set null,
  responsable      text,
  fecha_ingreso    date,
  fecha_baja       date,
  motivo_baja      text,
  notas            text,
  creado_por       uuid references auth.users(id) on delete set null,
  creado           timestamptz not null default now(),
  actualizado      timestamptz not null default now()
);

-- Índices
create index if not exists cel_estado_idx   on cel_celulares(estado);
create index if not exists cel_empleado_idx on cel_celulares(empleado_id);
create index if not exists cel_imei_idx     on cel_celulares(imei);

-- Historial de movimientos
create table if not exists cel_movimientos (
  id                  serial primary key,
  celular_id          int not null references cel_celulares(id) on delete cascade,
  tipo_movimiento     text not null
                      check (tipo_movimiento in ('alta','asignacion','desasignacion','traslado','baja')),
  empleado_origen_id  uuid references empleados(id) on delete set null,
  empleado_destino_id uuid references empleados(id) on delete set null,
  fecha               timestamptz not null default now(),
  usuario_id          uuid references auth.users(id) on delete set null,
  notas               text
);

create index if not exists cel_mov_celular_idx on cel_movimientos(celular_id);
create index if not exists cel_mov_fecha_idx   on cel_movimientos(fecha desc);

-- Vista principal con nombre del empleado
create or replace view cel_v_celulares as
select
  c.id,
  'CEL-' || lpad(c.id::text, 5, '0') as codigo,
  c.marca,
  c.modelo,
  c.imei,
  c.imei2,
  c.numero_linea,
  c.operadora,
  c.numero_sim,
  c.plan,
  c.color,
  c.almacenamiento,
  c.numero_inventario,
  c.estado,
  c.piso,
  c.sector,
  c.empleado_id,
  case when e.id is not null then e.nombre || ' ' || e.apellido end as empleado,
  c.responsable,
  c.fecha_ingreso,
  c.fecha_baja,
  c.motivo_baja,
  c.notas,
  c.creado,
  c.actualizado
from cel_celulares c
left join empleados e on e.id = c.empleado_id;

-- Vista de movimientos con nombres
create or replace view cel_v_movimientos as
select
  mv.id,
  mv.celular_id,
  'CEL-' || lpad(mv.celular_id::text, 5, '0') as codigo,
  mv.tipo_movimiento,
  mv.empleado_origen_id,
  case when eo.id is not null then eo.nombre || ' ' || eo.apellido end as empleado_origen,
  mv.empleado_destino_id,
  case when ed.id is not null then ed.nombre || ' ' || ed.apellido end as empleado_destino,
  mv.fecha,
  mv.notas,
  u.email as usuario
from cel_movimientos mv
left join empleados eo on eo.id = mv.empleado_origen_id
left join empleados ed on ed.id = mv.empleado_destino_id
left join auth.users u on u.id = mv.usuario_id;

-- Trigger: actualizar campo actualizado
create or replace function cel_set_actualizado()
returns trigger language plpgsql as $$
begin
  new.actualizado := now();
  return new;
end;
$$;

drop trigger if exists cel_set_actualizado_trg on cel_celulares;
create trigger cel_set_actualizado_trg
before update on cel_celulares
for each row execute function cel_set_actualizado();

-- RLS
alter table cel_celulares enable row level security;
alter table cel_movimientos enable row level security;

create policy "cel_select"     on cel_celulares for select to authenticated using (true);
create policy "cel_insert"     on cel_celulares for insert to authenticated with check (true);
create policy "cel_update"     on cel_celulares for update to authenticated using (true);
create policy "cel_delete"     on cel_celulares for delete to authenticated using (true);
create policy "cel_mov_select" on cel_movimientos for select to authenticated using (true);
create policy "cel_mov_insert" on cel_movimientos for insert to authenticated with check (true);
create policy "cel_mov_update" on cel_movimientos for update to authenticated using (true);
create policy "cel_mov_delete" on cel_movimientos for delete to authenticated using (true);
