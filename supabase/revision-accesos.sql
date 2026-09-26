-- ==========================================================
-- REVISIÓN PERIÓDICA DE ACCESOS (recertificación)
--   * Cada trimestre se abre una campaña: una foto de todos los usuarios de la app
--     con su rol, grupo de acceso, último ingreso y si siguen como empleados activos.
--   * Por cada usuario se decide: mantener, cambiar o quitar el acceso, con nota.
--   * "Quitar" se puede aplicar desde la misma pantalla (le saca el grupo de acceso).
--   * Queda todo en Logs como evidencia para auditorías (ISO 27001, BCRA, clientes).
--   * Si pasan 90 días sin revisión, llega un recordatorio por Alertas.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de vulnerabilidades.sql.
-- ==========================================================

create table if not exists public.revision_campanas (
  id serial primary key,
  nombre text not null,
  creada timestamptz not null default now(),
  creada_por uuid references public.perfiles(id) on delete set null default auth.uid(),
  creada_por_nombre text,
  vence date not null,
  estado text not null default 'abierta' check (estado in ('abierta', 'cerrada')),
  cerrada timestamptz,
  cerrada_por_nombre text,
  conclusion text
);

create table if not exists public.revision_items (
  id bigserial primary key,
  campana_id int not null references public.revision_campanas(id) on delete cascade,
  usuario_id uuid,                     -- sin FK: el usuario puede eliminarse y la evidencia queda
  email text not null,
  nombre text,
  rol text,
  grupo text,
  modulos text[],
  ultimo_ingreso timestamptz,
  empleado_activo boolean,             -- null: no figura en Empleados
  observaciones text[],                -- lo que conviene mirar: sin ingresos, ex empleado, admin, etc.
  decision text not null default 'pendiente' check (decision in ('pendiente', 'mantener', 'cambiar', 'quitar')),
  nota text,
  decidido_por_nombre text,
  decidido_en timestamptz,
  aplicado timestamptz,
  unique (campana_id, usuario_id)
);
create index if not exists idx_revision_items_campana on public.revision_items(campana_id);

create or replace function public.revision_puede() returns boolean
language sql stable security definer set search_path = public as $$
  select puede_ver('auditoria') and coalesce(mi_rol() in ('administrador', 'lectura_escritura'), false)
$$;

create or replace function public.revision_crear(p_nombre text, p_vence date)
returns int language plpgsql security definer set search_path = public as $$
declare v_id int; v_yo text;
begin
  if mi_rol() is distinct from 'administrador' then
    raise exception 'Solo un administrador puede abrir una revisión';
  end if;
  if exists (select 1 from revision_campanas where estado = 'abierta') then
    raise exception 'Ya hay una revisión abierta: cerrala antes de abrir otra';
  end if;
  select coalesce(nombre, email) into v_yo from perfiles where id = auth.uid();

  insert into revision_campanas (nombre, vence, creada_por_nombre)
  values (coalesce(nullif(trim(p_nombre), ''), 'Revisión ' || to_char(current_date, 'YYYY') || '-T' || extract(quarter from current_date)),
          coalesce(p_vence, current_date + 15), v_yo)
  returning id into v_id;

  insert into revision_items (campana_id, usuario_id, email, nombre, rol, grupo, modulos, ultimo_ingreso, empleado_activo, observaciones)
  select v_id, p.id, p.email, p.nombre, p.rol, g.nombre,
         case when p.rol = 'administrador' then array['todas'] else coalesce(g.modulos, '{}') end,
         i.ultimo, e.activo,
         array_remove(array[
           case when p.rol = 'administrador' then 'Administrador (acceso total)' end,
           case when e.activo is false then 'Ya no es empleado activo' end,
           case when e.id is null then 'No figura en Empleados' end,
           case when i.ultimo is null then 'Nunca ingresó' when i.ultimo < now() - interval '90 days' then 'Sin ingresos hace más de 90 días' end,
           case when p.rol <> 'administrador' and g.id is null then 'Sin grupo (no ve ninguna solapa)' end,
           case when p.email !~* '@accusys' then 'Email externo a la empresa' end
         ], null)
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
    left join lateral (select max(fecha) as ultimo from auditoria_ingresos a where a.usuario_id = p.id and a.accion = 'login') i on true
    left join lateral (select id, activo from empleados where lower(email) = lower(p.email) order by activo desc limit 1) e on true;
  return v_id;
end $$;
grant execute on function public.revision_crear(text, date) to authenticated;

create or replace function public.revision_decidir(p_item bigint, p_decision text, p_nota text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_estado text; v_yo text;
begin
  if not revision_puede() then raise exception 'No tenés permiso para revisar accesos'; end if;
  if p_decision not in ('pendiente', 'mantener', 'cambiar', 'quitar') then raise exception 'Decisión inválida'; end if;
  select c.estado into v_estado from revision_items i join revision_campanas c on c.id = i.campana_id where i.id = p_item;
  if v_estado is distinct from 'abierta' then raise exception 'La revisión ya está cerrada'; end if;
  if p_decision in ('cambiar', 'quitar') and nullif(trim(p_nota), '') is null then
    raise exception 'Contá en la nota qué hay que cambiar o por qué se quita';
  end if;
  select coalesce(nombre, email) into v_yo from perfiles where id = auth.uid();
  update revision_items set
    decision = p_decision,
    nota = nullif(trim(p_nota), ''),
    decidido_por_nombre = case when p_decision = 'pendiente' then null else v_yo end,
    decidido_en = case when p_decision = 'pendiente' then null else now() end
  where id = p_item;
end $$;
grant execute on function public.revision_decidir(bigint, text, text) to authenticated;

-- Aplica "quitar": le saca el grupo de acceso (deja de ver todas las solapas). Eliminar el usuario se hace en Usuarios.
create or replace function public.revision_aplicar(p_item bigint)
returns void language plpgsql security definer set search_path = public as $$
declare it revision_items;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  select * into it from revision_items where id = p_item;
  if it.decision <> 'quitar' then raise exception 'Solo se aplican las decisiones de quitar acceso'; end if;
  if it.usuario_id = auth.uid() then raise exception 'No podés quitarte el acceso a vos mismo'; end if;
  update perfiles set grupo_id = null, rol = 'solo_lectura' where id = it.usuario_id;
  update revision_items set aplicado = now() where id = p_item;
end $$;
grant execute on function public.revision_aplicar(bigint) to authenticated;

create or replace function public.revision_cerrar(p_campana int, p_conclusion text)
returns void language plpgsql security definer set search_path = public as $$
declare v_yo text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if exists (select 1 from revision_items where campana_id = p_campana and decision = 'pendiente') then
    raise exception 'Quedan usuarios sin revisar';
  end if;
  select coalesce(nombre, email) into v_yo from perfiles where id = auth.uid();
  update revision_campanas set estado = 'cerrada', cerrada = now(), cerrada_por_nombre = v_yo,
         conclusion = nullif(trim(p_conclusion), '')
   where id = p_campana and estado = 'abierta';
end $$;
grant execute on function public.revision_cerrar(int, text) to authenticated;

alter table public.revision_campanas enable row level security;
alter table public.revision_items enable row level security;
drop policy if exists revision_campanas_select on public.revision_campanas;
create policy revision_campanas_select on public.revision_campanas for select to authenticated using (puede_ver('auditoria'));
drop policy if exists revision_items_select on public.revision_items;
create policy revision_items_select on public.revision_items for select to authenticated using (puede_ver('auditoria'));
revoke insert, update, delete on public.revision_campanas, public.revision_items from anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['revision_campanas', 'revision_items'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
