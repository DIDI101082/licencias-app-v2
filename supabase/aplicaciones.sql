-- ==========================================================
-- Módulo APLICACIONES INSTALADAS
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de monitoreo.sql.
-- ==========================================================

-- Aplicaciones que tiene hoy cada equipo
create table if not exists public.inv_dispositivo_apps (
  id bigserial primary key,
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  nombre text not null,
  version text not null default '',
  editor text,
  fecha_instalacion date,
  primera_vez timestamptz not null default now(),   -- cuándo la vio el agente por primera vez
  ultimo_visto timestamptz not null default now(),
  unique (dispositivo_id, nombre, version)
);
create index if not exists idx_inv_apps_nombre on public.inv_dispositivo_apps(nombre);

-- Historial: qué se instaló, desinstaló o actualizó
create table if not exists public.inv_apps_cambios (
  id bigserial primary key,
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  nombre text not null,
  accion text not null check (accion in ('instalada','desinstalada','actualizada')),
  version_anterior text,
  version_nueva text,
  fecha timestamptz not null default now()
);
create index if not exists idx_inv_apps_cambios_fecha on public.inv_apps_cambios(fecha desc);

alter table public.inv_dispositivos add column if not exists apps_cantidad int;
alter table public.inv_dispositivos add column if not exists apps_actualizado timestamptz;

-- ----------------------------------------------------------
-- Función que llama el agente con la lista completa de apps
-- ----------------------------------------------------------
create or replace function public.inv_reportar_aplicaciones(
  p_token text, p_uuid text, p_hostname text, p_apps jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_disp uuid;
  v_primera boolean;
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;

  -- mismo criterio de identificación que inv_reportar_dispositivo
  v_uuid := nullif(trim(p_uuid), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then
    v_uuid := nullif(trim(p_hostname), '');
  end if;
  select id into v_disp from inv_dispositivos where uuid_equipo = v_uuid;
  if v_disp is null then
    raise exception 'El equipo todavía no está registrado';
  end if;

  drop table if exists _apps;
  create temp table _apps on commit drop as
  select distinct on (nombre, version) nombre, version, editor, fecha_instalacion
  from (
    select trim(regexp_replace(a->>'nombre', '\s+', ' ', 'g')) as nombre,
           coalesce(nullif(trim(a->>'version'), ''), '') as version,
           nullif(trim(a->>'editor'), '') as editor,
           case when a->>'fecha_instalacion' ~ '^\d{8}$'
                then to_date(a->>'fecha_instalacion', 'YYYYMMDD') end as fecha_instalacion
    from jsonb_array_elements(coalesce(p_apps, '[]'::jsonb)) a
  ) x
  where nombre <> '';

  -- En el primer reporte no se registran "instaladas" (serían todas)
  v_primera := not exists (select 1 from inv_dispositivo_apps where dispositivo_id = v_disp);

  if not v_primera then
    insert into inv_apps_cambios (dispositivo_id, nombre, accion, version_anterior, version_nueva)
    select v_disp, coalesce(n.nombre, a.nombre),
           case when a.nombre is null then 'instalada'
                when n.nombre is null then 'desinstalada'
                else 'actualizada' end,
           a.versiones, n.versiones
    from (select nombre, string_agg(version, ', ' order by version) versiones from _apps group by nombre) n
    full join (select nombre, string_agg(version, ', ' order by version) versiones
                 from inv_dispositivo_apps where dispositivo_id = v_disp group by nombre) a
      on a.nombre = n.nombre
    where a.nombre is null or n.nombre is null or a.versiones is distinct from n.versiones;
  end if;

  delete from inv_dispositivo_apps d
   where d.dispositivo_id = v_disp
     and not exists (select 1 from _apps n where n.nombre = d.nombre and n.version = d.version);

  insert into inv_dispositivo_apps (dispositivo_id, nombre, version, editor, fecha_instalacion)
  select v_disp, nombre, version, editor, fecha_instalacion from _apps
  on conflict (dispositivo_id, nombre, version) do update set
    editor = excluded.editor,
    fecha_instalacion = excluded.fecha_instalacion,
    ultimo_visto = now();

  update inv_dispositivos
     set apps_cantidad = (select count(*) from _apps), apps_actualizado = now()
   where id = v_disp;
end $$;

revoke all on function public.inv_reportar_aplicaciones(text, text, text, jsonb) from public;
grant execute on function public.inv_reportar_aplicaciones(text, text, text, jsonb) to anon, authenticated;

-- Resumen por aplicación (en cuántos equipos está y con qué versiones)
create or replace view public.inv_v_apps_resumen with (security_invoker = true) as
select nombre,
       max(editor) as editor,
       count(distinct dispositivo_id)::int as equipos,
       array_agg(distinct version order by version) filter (where version <> '') as versiones
  from inv_dispositivo_apps
 group by nombre;

-- ----------------------------------------------------------
-- Row Level Security: todos los roles leen; solo el agente escribe
-- (a través de la función). El admin puede borrar historial.
-- ----------------------------------------------------------
alter table public.inv_dispositivo_apps enable row level security;
alter table public.inv_apps_cambios enable row level security;

drop policy if exists inv_dispositivo_apps_select on public.inv_dispositivo_apps;
create policy inv_dispositivo_apps_select on public.inv_dispositivo_apps for select to authenticated
  using (mi_rol() is not null);

drop policy if exists inv_apps_cambios_select on public.inv_apps_cambios;
create policy inv_apps_cambios_select on public.inv_apps_cambios for select to authenticated
  using (mi_rol() is not null);

drop policy if exists inv_apps_cambios_admin on public.inv_apps_cambios;
create policy inv_apps_cambios_admin on public.inv_apps_cambios for delete to authenticated
  using (mi_rol() = 'administrador');
