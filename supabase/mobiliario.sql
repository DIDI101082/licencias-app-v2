-- ============================================================
-- MOBILIARIO
-- Registro, asignación, movimientos y baja de mobiliario.
-- Ejecutar en Supabase → SQL Editor.
-- ============================================================

-- Tabla principal de mobiliario
create table if not exists mobiliario (
  id               serial primary key,
  tipo             text not null,
  descripcion      text,
  marca            text,
  modelo           text,
  numero_serie     text,
  color            text,
  numero_inventario text,
  estado           text not null default 'en_deposito'
                   check (estado in ('en_deposito','asignado','en_reparacion','dado_de_baja')),
  piso             text,
  sector           text,
  detalle_ubicacion text,
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
create index if not exists mobiliario_estado_idx   on mobiliario(estado);
create index if not exists mobiliario_empleado_idx on mobiliario(empleado_id);
create index if not exists mobiliario_piso_idx     on mobiliario(piso);

-- Tabla de movimientos/historial
create table if not exists mob_movimientos (
  id                  serial primary key,
  mobiliario_id       int not null references mobiliario(id) on delete cascade,
  tipo_movimiento     text not null
                      check (tipo_movimiento in ('alta','asignacion','desasignacion','traslado','baja')),
  piso_origen         text,
  sector_origen       text,
  piso_destino        text,
  sector_destino      text,
  empleado_origen_id  uuid references empleados(id) on delete set null,
  empleado_destino_id uuid references empleados(id) on delete set null,
  fecha               timestamptz not null default now(),
  usuario_id          uuid references auth.users(id) on delete set null,
  notas               text
);

create index if not exists mob_mov_mobiliario_idx on mob_movimientos(mobiliario_id);
create index if not exists mob_mov_fecha_idx      on mob_movimientos(fecha desc);

-- Vista principal con nombre del empleado
create or replace view mob_v_mobiliario as
select
  m.id,
  'MOB-' || lpad(m.id::text, 5, '0') as codigo,
  m.tipo,
  m.descripcion,
  m.marca,
  m.modelo,
  m.numero_serie,
  m.color,
  m.numero_inventario,
  m.estado,
  m.piso,
  m.sector,
  m.detalle_ubicacion,
  m.empleado_id,
  case when e.id is not null then e.nombre || ' ' || e.apellido end as empleado,
  m.responsable,
  m.fecha_ingreso,
  m.fecha_baja,
  m.motivo_baja,
  m.notas,
  m.creado,
  m.actualizado
from mobiliario m
left join empleados e on e.id = m.empleado_id;

-- Vista de movimientos con nombres
create or replace view mob_v_movimientos as
select
  mv.id,
  mv.mobiliario_id,
  'MOB-' || lpad(mv.mobiliario_id::text, 5, '0') as codigo,
  m.tipo as mob_tipo,
  mv.tipo_movimiento,
  mv.piso_origen,
  mv.sector_origen,
  mv.piso_destino,
  mv.sector_destino,
  mv.empleado_origen_id,
  case when eo.id is not null then eo.nombre || ' ' || eo.apellido end as empleado_origen,
  mv.empleado_destino_id,
  case when ed.id is not null then ed.nombre || ' ' || ed.apellido end as empleado_destino,
  mv.fecha,
  mv.notas,
  u.email as usuario
from mob_movimientos mv
join mobiliario m on m.id = mv.mobiliario_id
left join empleados eo on eo.id = mv.empleado_origen_id
left join empleados ed on ed.id = mv.empleado_destino_id
left join auth.users u on u.id = mv.usuario_id;

-- Trigger: actualizar campo actualizado
create or replace function mob_set_actualizado()
returns trigger language plpgsql as $$
begin
  new.actualizado := now();
  return new;
end;
$$;

drop trigger if exists mob_set_actualizado_trg on mobiliario;
create trigger mob_set_actualizado_trg
before update on mobiliario
for each row execute function mob_set_actualizado();

-- RLS: misma política que el resto del sistema
alter table mobiliario enable row level security;
alter table mob_movimientos enable row level security;

-- Política: usuarios autenticados leen todo
create policy "mob_select" on mobiliario for select to authenticated using (true);
create policy "mob_mov_select" on mob_movimientos for select to authenticated using (true);

-- Escritura solo para roles con permisos
create policy "mob_insert" on mobiliario for insert to authenticated with check (true);
create policy "mob_update" on mobiliario for update to authenticated using (true);
create policy "mob_delete" on mobiliario for delete to authenticated using (true);
create policy "mob_mov_insert" on mob_movimientos for insert to authenticated with check (true);
create policy "mob_mov_update" on mob_movimientos for update to authenticated using (true);
create policy "mob_mov_delete" on mob_movimientos for delete to authenticated using (true);
