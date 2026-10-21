-- ==========================================================
-- Órdenes remotas para equipos (Windows Update, etc.)
-- Ejecutar en Supabase > SQL Editor. Se puede correr más de una vez.
-- ==========================================================

create table if not exists public.inv_ordenes (
  id            bigserial primary key,
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  tipo          text not null,                         -- 'windows_update'
  estado        text not null default 'pendiente',     -- pendiente | ejecutando | completada | error
  creada        timestamptz not null default now(),
  creada_por    uuid references auth.users(id),
  creada_por_nombre text,
  ejecutada     timestamptz,
  resultado     text,
  detalle       jsonb                                  -- info adicional (actualizaciones instaladas, etc.)
);

-- Solo admins y lectura_escritura pueden crear/ver órdenes
alter table public.inv_ordenes enable row level security;

drop policy if exists "ver_ordenes"       on public.inv_ordenes;
drop policy if exists "crear_ordenes"     on public.inv_ordenes;
drop policy if exists "actualizar_ordenes" on public.inv_ordenes;

create policy "ver_ordenes" on public.inv_ordenes
  for select using (puede_ver('inventario'));

create policy "crear_ordenes" on public.inv_ordenes
  for insert with check (
    puede_ver('inventario') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')
  );

create policy "actualizar_ordenes" on public.inv_ordenes
  for update using (true);   -- el agente actualiza vía función security definer

-- -------------------------------------------------------
-- Función para crear una orden (llamada desde la app)
-- -------------------------------------------------------
create or replace function public.inv_crear_orden(
  p_dispositivo_id uuid,
  p_tipo text
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_nombre text;
  v_id bigint;
begin
  if not (puede_ver('inventario') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then
    raise exception 'Sin permiso para crear órdenes';
  end if;
  -- Solo una orden pendiente/ejecutando por equipo y tipo a la vez
  if exists (
    select 1 from inv_ordenes
    where dispositivo_id = p_dispositivo_id and tipo = p_tipo and estado in ('pendiente', 'ejecutando')
  ) then
    raise exception 'Ya hay una orden de ese tipo en curso para este equipo';
  end if;
  select coalesce(nullif(nombre, ''), email) into v_nombre from perfiles where id = auth.uid();
  insert into inv_ordenes (dispositivo_id, tipo, creada_por, creada_por_nombre)
    values (p_dispositivo_id, p_tipo, auth.uid(), v_nombre)
    returning id into v_id;
  return v_id;
end $$;
revoke all on function public.inv_crear_orden(uuid, text) from public, anon;
grant execute on function public.inv_crear_orden(uuid, text) to authenticated;

-- -------------------------------------------------------
-- Función para que el agente consulte órdenes pendientes (por token + uuid)
-- -------------------------------------------------------
create or replace function public.inv_ordenes_pendientes(
  p_token text, p_uuid text, p_hostname text
) returns table (id bigint, tipo text) language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_disp_id uuid;
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;
  v_uuid := nullif(trim(p_uuid), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then v_uuid := nullif(trim(p_hostname), ''); end if;
  select d.id into v_disp_id from inv_dispositivos d where d.uuid_equipo = v_uuid;
  if v_disp_id is null then return; end if;

  -- Marcar como ejecutando las que están pendientes
  update inv_ordenes set estado = 'ejecutando'
  where dispositivo_id = v_disp_id and estado = 'pendiente';

  return query
    select o.id, o.tipo from inv_ordenes o
    where o.dispositivo_id = v_disp_id and o.estado = 'ejecutando'
    order by o.creada;
end $$;
revoke all on function public.inv_ordenes_pendientes(text, text, text) from public;
grant execute on function public.inv_ordenes_pendientes(text, text, text) to anon, authenticated;

-- -------------------------------------------------------
-- Función para que el agente reporte el resultado
-- -------------------------------------------------------
create or replace function public.inv_orden_resultado(
  p_token text, p_id bigint, p_estado text, p_resultado text, p_detalle jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;
  update inv_ordenes
    set estado = p_estado, resultado = p_resultado, detalle = p_detalle, ejecutada = now()
  where id = p_id and estado = 'ejecutando';
end $$;
revoke all on function public.inv_orden_resultado(text, bigint, text, text, jsonb) from public;
grant execute on function public.inv_orden_resultado(text, bigint, text, text, jsonb) to anon, authenticated;
