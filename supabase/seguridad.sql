-- ==========================================================
-- Módulo SEGURIDAD (BitLocker, parches, admins, firewall, antivirus, TPM)
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de monitoreo.sql.
-- ==========================================================

alter table public.inv_dispositivos
  add column if not exists bitlocker_estado text,          -- cifrado | cifrando | suspendido | sin_cifrar | no_disponible
  add column if not exists bitlocker_detalle jsonb,        -- [{unidad, estado, porcentaje, proteccion}]
  add column if not exists ultimo_parche timestamptz,
  add column if not exists ultimo_parche_titulo text,
  add column if not exists reinicio_pendiente boolean,
  add column if not exists admins_locales jsonb,           -- [{nombre, tipo, origen, integrado}]
  add column if not exists firewall_perfiles jsonb,        -- {Domain: true, Private: true, Public: false}
  add column if not exists firewall_activo boolean,
  add column if not exists av_productos jsonb,             -- [{nombre, activo, actualizado}]
  add column if not exists av_firmas_fecha timestamptz,    -- solo Defender
  add column if not exists tpm_presente boolean,
  add column if not exists tpm_version text,
  add column if not exists secure_boot boolean,
  add column if not exists seguridad_actualizado timestamptz;

-- Administradores que no deben marcarse como problema (se editan desde la app)
alter table public.inv_agente_config
  add column if not exists admins_permitidos text[] not null
    default array['Domain Admins', 'Admins. del dominio'];

create or replace function public.inv_reportar_seguridad(
  p_token text, p_uuid text, p_hostname text, p_datos jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
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
    tpm_presente          = nullif(p_datos->>'tpm_presente', '')::boolean,
    tpm_version           = p_datos->>'tpm_version',
    secure_boot           = nullif(p_datos->>'secure_boot', '')::boolean,
    seguridad_actualizado = now()
  where uuid_equipo = v_uuid;

  if not found then
    raise exception 'El equipo todavía no está registrado';
  end if;
end $$;

revoke all on function public.inv_reportar_seguridad(text, text, text, jsonb) from public;
grant execute on function public.inv_reportar_seguridad(text, text, text, jsonb) to anon, authenticated;

-- Todos los roles necesitan leer la lista de admins permitidos para ver la pantalla
create or replace function public.inv_admins_permitidos()
returns text[] language sql stable security definer set search_path = public as $$
  select admins_permitidos from inv_agente_config where id = 1 and mi_rol() is not null
$$;
grant execute on function public.inv_admins_permitidos() to authenticated;
