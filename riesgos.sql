-- ==========================================================
-- Módulo RIESGOS: amenazas de Defender + software prohibido
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de seguridad.sql
-- y aplicaciones.sql.
-- ==========================================================

alter table public.inv_dispositivos
  add column if not exists av_escaneo_rapido timestamptz,
  add column if not exists av_escaneo_completo timestamptz,
  add column if not exists av_proteccion_alteraciones boolean;

-- Detecciones de Microsoft Defender (se conserva el historial)
create table if not exists public.inv_amenazas (
  id bigserial primary key,
  dispositivo_id uuid not null references public.inv_dispositivos(id) on delete cascade,
  deteccion_id text not null,
  nombre text,
  severidad int,          -- 0 desconocida, 1 baja, 2 moderada, 4 alta, 5 grave
  categoria int,
  estado_id int,          -- ThreatStatusID de Defender
  recursos jsonb,         -- archivos o rutas afectadas
  usuario text,
  proceso text,
  ejecutada boolean,
  detectada timestamptz,
  cambio_estado timestamptz,
  revisada boolean not null default false,   -- la marca IT desde la app
  unique (dispositivo_id, deteccion_id)
);
create index if not exists idx_inv_amenazas_detectada on public.inv_amenazas(detectada desc);

-- Lista de software prohibido (coincide si el nombre de la app CONTIENE el patrón)
create table if not exists public.inv_software_prohibido (
  id serial primary key,
  patron text not null unique,
  motivo text,
  created_at timestamptz not null default now()
);

create or replace view public.inv_v_software_prohibido with (security_invoker = true) as
select p.id as regla_id, p.patron, p.motivo,
       a.nombre as aplicacion, a.version, a.primera_vez,
       d.id as dispositivo_id, d.hostname, d.usuario, d.equipo_id
  from inv_software_prohibido p
  join inv_dispositivo_apps a on a.nombre ilike '%' || p.patron || '%'
  join inv_dispositivos d on d.id = a.dispositivo_id;

-- ----------------------------------------------------------
-- Versión nueva de la función del agente: suma escaneos,
-- protección contra alteraciones y amenazas detectadas.
-- ----------------------------------------------------------
create or replace function public.inv_reportar_seguridad(
  p_token text, p_uuid text, p_hostname text, p_datos jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_disp uuid;
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;

  v_uuid := nullif(trim(p_uuid), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then
    v_uuid := nullif(trim(p_hostname), '');
  end if;

  update inv_dispositivos set
    bitlocker_estado      = p_datos->>'bitlocker_estado',
    bitlocker_detalle     = p_datos->'bitlocker_detalle',
    ultimo_parche         = nullif(p_datos->>'ultimo_parche', '')::timestamptz,
    ultimo_parche_titulo  = p_datos->>'ultimo_parche_titulo',
    reinicio_pendiente    = nullif(p_datos->>'reinicio_pendiente', '')::boolean,
    admins_locales        = p_datos->'admins_locales',
    firewall_perfiles     = p_datos->'firewall_perfiles',
    firewall_activo       = nullif(p_datos->>'firewall_activo', '')::boolean,
    av_productos          = p_datos->'av_productos',
    av_firmas_fecha       = nullif(p_datos->>'av_firmas_fecha', '')::timestamptz,
    av_escaneo_rapido     = nullif(p_datos->>'av_escaneo_rapido', '')::timestamptz,
    av_escaneo_completo   = nullif(p_datos->>'av_escaneo_completo', '')::timestamptz,
    av_proteccion_alteraciones = nullif(p_datos->>'av_proteccion_alteraciones', '')::boolean,
    tpm_presente          = nullif(p_datos->>'tpm_presente', '')::boolean,
    tpm_version           = p_datos->>'tpm_version',
    secure_boot           = nullif(p_datos->>'secure_boot', '')::boolean,
    seguridad_actualizado = now()
  where uuid_equipo = v_uuid
  returning id into v_disp;

  if v_disp is null then
    raise exception 'El equipo todavía no está registrado';
  end if;

  insert into inv_amenazas (dispositivo_id, deteccion_id, nombre, severidad, categoria, estado_id,
                            recursos, usuario, proceso, ejecutada, detectada, cambio_estado)
  select v_disp, a->>'deteccion_id', a->>'nombre',
         nullif(a->>'severidad', '')::int, nullif(a->>'categoria', '')::int, nullif(a->>'estado_id', '')::int,
         a->'recursos', a->>'usuario', a->>'proceso', nullif(a->>'ejecutada', '')::boolean,
         nullif(a->>'detectada', '')::timestamptz, nullif(a->>'cambio_estado', '')::timestamptz
    from jsonb_array_elements(coalesce(p_datos->'amenazas', '[]'::jsonb)) a
   where nullif(a->>'deteccion_id', '') is not null
  on conflict (dispositivo_id, deteccion_id) do update set
    estado_id = excluded.estado_id,
    cambio_estado = excluded.cambio_estado,
    recursos = excluded.recursos,
    nombre = coalesce(excluded.nombre, inv_amenazas.nombre),
    severidad = coalesce(excluded.severidad, inv_amenazas.severidad),
    ejecutada = coalesce(excluded.ejecutada, inv_amenazas.ejecutada),
    -- si Defender cambió el estado (por ejemplo, volvió a fallar), se vuelve a mostrar como no revisada
    revisada = case when excluded.estado_id is distinct from inv_amenazas.estado_id then false
                    else inv_amenazas.revisada end;
end $$;

revoke all on function public.inv_reportar_seguridad(text, text, text, jsonb) from public;
grant execute on function public.inv_reportar_seguridad(text, text, text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------
alter table public.inv_amenazas enable row level security;
alter table public.inv_software_prohibido enable row level security;

drop policy if exists inv_amenazas_select on public.inv_amenazas;
create policy inv_amenazas_select on public.inv_amenazas for select to authenticated
  using (mi_rol() is not null);
drop policy if exists inv_amenazas_revisar on public.inv_amenazas;
create policy inv_amenazas_revisar on public.inv_amenazas for update to authenticated
  using (mi_rol() in ('administrador', 'lectura_escritura'))
  with check (mi_rol() in ('administrador', 'lectura_escritura'));

drop policy if exists inv_software_prohibido_select on public.inv_software_prohibido;
create policy inv_software_prohibido_select on public.inv_software_prohibido for select to authenticated
  using (mi_rol() is not null);
drop policy if exists inv_software_prohibido_admin on public.inv_software_prohibido;
create policy inv_software_prohibido_admin on public.inv_software_prohibido for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');
