-- ==========================================================
-- Clave del BIOS (Dell, Lenovo, HP)
-- Ejecutar en el SQL Editor DESPUÉS de cifrado.sql.
-- ==========================================================

alter table public.inv_dispositivos
  add column if not exists bios_clave_admin boolean,     -- clave de administrador / setup
  add column if not exists bios_clave_sistema boolean,   -- clave de encendido
  add column if not exists bios_fuente text;             -- cómo se leyó (Dell WMI, Dell Command Monitor, Lenovo, HP)

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
    cifrado_producto      = p_datos->>'cifrado_producto',
    cifrado_estado        = p_datos->>'cifrado_estado',
    cifrado_detalle       = p_datos->>'cifrado_detalle',
    bios_clave_admin      = nullif(p_datos->>'bios_clave_admin', '')::boolean,
    bios_clave_sistema    = nullif(p_datos->>'bios_clave_sistema', '')::boolean,
    bios_fuente           = p_datos->>'bios_fuente',
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
