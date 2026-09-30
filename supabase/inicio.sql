-- ==========================================================
-- INICIO E INTEGRACIONES
--   * integraciones_estado(): estado de todos los puentes y conexiones en un solo lugar
--     (último reporte, versión, errores), con semáforo según cada cuánto deberían reportar.
--   * inicio_datos(): lo que muestra la página de Inicio (alertas, Secure Score, vencimientos).
-- Se ve con la solapa Seguridad. Los detalles de las alertas, solo con la solapa Logs.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de postura.sql (se puede volver a ejecutar).
-- ==========================================================

create or replace function public.integraciones_estado() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb := '[]'::jsonb;
begin
  if not (puede_ver('seguridad') or coalesce(mi_rol(), '') = 'administrador') then raise exception 'Sin acceso'; end if;

  -- una fila por integración; aviso_min / mal_min: minutos sin reportar para pasar a amarillo / rojo
  create temp table if not exists _int (orden int, clave text, nombre text, area text, configurada boolean, ultimo timestamptz,
    version text, detalle text, error text, enlace text, aviso_min int, mal_min int) on commit drop;
  truncate _int;

  begin
    insert into _int select 10, 'prtg', 'PRTG', 'Red', c.token_hash is not null, e.actualizado, e.version_puente,
      coalesce(e.equipos, 0) || ' equipos monitoreados', null, '/red', 30, 240
      from red_puente_config c cross join red_prtg_estado e where c.id = 1 and e.id = 1;
  exception when others then null; end;

  begin
    if exists (select 1 from fg_equipos) then
      insert into _int select 20, 'fg:' || f.nombre, 'FortiGate ' || f.nombre, 'Red', true, f.actualizado, c.version_puente,
        nullif(concat_ws(' · ', f.modelo, 'FortiOS ' || f.version), ''), f.ultimo_error, '/red/fortigate', 45, 360
        from fg_equipos f cross join fg_config c where c.id = 1;
    else
      insert into _int select 20, 'fg', 'FortiGate', 'Red', token_hash is not null, ultimo_reporte, version_puente, null, null, '/red/fortigate', 45, 360
        from fg_config where id = 1;
    end if;
  exception when others then null; end;

  begin
    insert into _int select 30, 'unifi', 'UniFi (WiFi)', 'Red', token_hash is not null, ultimo_reporte, version_puente, null, null,
      '/inventario/wifi', minutos_sin_reporte, greatest(minutos_sin_reporte * 6, 240) from unifi_config where id = 1;
  exception when others then null; end;

  begin
    insert into _int select 40, 'switches', 'Switches', 'Red', token_hash is not null, ultimo_reporte, version_puente, null, null,
      '/red/switches', minutos_sin_reporte, greatest(minutos_sin_reporte * 6, 240) from sw_config where id = 1;
  exception when others then null; end;

  begin
    if exists (select 1 from ad_dcs) then
      insert into _int select 50, 'ad:' || d.nombre, 'Active Directory · ' || d.nombre, 'Identidad', true, d.ultimo_reporte, d.version_puente,
        d.so, case when jsonb_array_length(coalesce(d.avisos, '[]')) > 0 then left(d.avisos ->> 0, 200) end,
        '/inventario/ad', c.minutos_sin_reporte, greatest(c.minutos_sin_reporte * 6, 240)
        from ad_dcs d cross join ad_config c where c.id = 1;
    else
      insert into _int select 50, 'ad', 'Active Directory', 'Identidad', token_hash is not null, ultimo_reporte, version_puente, null, null,
        '/inventario/ad', minutos_sin_reporte, greatest(minutos_sin_reporte * 6, 240) from ad_config where id = 1;
    end if;
  exception when others then null; end;

  begin
    insert into _int select 60, 'virt', 'Virtualización y storage', 'Servidores', token_hash is not null, ultimo_reporte, version_puente, null,
      nullif(concat_ws(' · ', 'vCenter: ' || error_vcenter, 'Storage: ' || error_storage), ''), '/servidores/virtualizacion', 45, 360
      from virt_config where id = 1;
  exception when others then null; end;

  begin
    insert into _int select 70, 'veeam', 'Veeam Backup', 'Servidores', token_hash is not null, ultimo_reporte, 'Veeam ' || version_veeam, servidor, null,
      '/inventario/backups', horas_max_sin_reporte * 60, horas_max_sin_reporte * 60 * 4 from backups_config where id = 1;
  exception when others then null; end;

  begin
    insert into _int select 80, 'eset', 'ESET PROTECT', 'Equipos', activo, ultima_sync, 'Nube',
      coalesce(detecciones_ultima_sync, 0) || ' detecciones en la última sincronización', ultimo_error, '/inventario/riesgos', 60, 360
      from eset_config where id = 1;
  exception when others then null; end;

  begin
    insert into _int
    select 90, 'agente', 'Agente de equipos', 'Equipos', count(*) > 0, max(ultimo_reporte), max(agente_version),
           count(*) filter (where ultimo_reporte > now() - interval '24 hours') || ' de ' || count(*) || ' equipos reportaron en 24 h', null,
           '/inventario/monitoreo', 60, 1440
      from inv_dispositivos where estado_registro = 'aprobado';
  exception when others then null; end;

  begin
    insert into _int select 100, 'prog', 'Verificaciones diarias', 'Perímetro y nube', token_hash is not null, ultima_ejecucion, 'Vercel',
      'Secure Score, correo, superficie expuesta y certificados',
      nullif((select string_agg(k || ': ' || v, ' · ') from jsonb_each_text(resultado) as t(k, v) where k <> 'duracion_s' and v <> 'ok' and v <> 'sin datos'), ''),
      '/inventario/securescore', 26 * 60, 50 * 60 from prog_config where id = 1;
  exception when others then null; end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'clave', clave, 'nombre', nombre, 'area', area, 'ultimo', ultimo, 'version', version, 'detalle', detalle, 'error', error, 'enlace', enlace,
      'estado', case when not coalesce(configurada, false) then 'sin_configurar'
                     when ultimo is null or ultimo < now() - make_interval(mins => mal_min) then 'mal'
                     when ultimo < now() - make_interval(mins => aviso_min) or error is not null then 'aviso'
                     else 'ok' end) order by orden, nombre), '[]'::jsonb)
    into r from _int;
  return r;
end $$;
grant execute on function public.integraciones_estado() to authenticated;

create or replace function public.inicio_datos() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb := '{}'::jsonb; v_logs boolean := puede_ver('auditoria');
begin
  if not (puede_ver('seguridad') or coalesce(mi_rol(), '') = 'administrador') then raise exception 'Sin acceso'; end if;
  begin
    r := r || jsonb_build_object(
      'alertas', (select coalesce(jsonb_object_agg(severidad, n), '{}') from (select severidad, count(*) n from alertas where resuelta is null group by 1) z),
      'por_dia', (select jsonb_agg(jsonb_build_object('dia', d::date, 'n', (select count(*) from alertas a
                    where (a.abierta at time zone 'America/Argentina/Buenos_Aires')::date = d::date)) order by d)
                    from generate_series(current_date - 13, current_date, interval '1 day') d),
      'urgentes', case when v_logs then (select coalesce(jsonb_agg(z), '[]') from (
                    select id, severidad, titulo, detalle, enlace, abierta from alertas where resuelta is null
                     order by case severidad when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, abierta desc limit 6) z) end);
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('securescore', (select jsonb_build_object('actual', actual, 'maximo', maximo, 'promedio', promedio_similares, 'fecha', fecha)
                                                  from ss_historial order by fecha desc limit 1),
                                 'securescore_30', (select actual from ss_historial where fecha <= current_date - 30 order by fecha desc limit 1));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('vencimientos', (select coalesce(jsonb_agg(jsonb_build_object('descripcion', descripcion, 'fecha', fecha_vencimiento, 'enlace', enlace) order by fecha_vencimiento), '[]')
      from (select descripcion, fecha_vencimiento, enlace from vencimientos_todos
             where fecha_vencimiento <= current_date + 30 order by fecha_vencimiento limit 8) z));
  exception when others then
    begin
      r := r || jsonb_build_object('vencimientos', (select coalesce(jsonb_agg(jsonb_build_object('descripcion', descripcion, 'fecha', fecha_vencimiento, 'enlace', enlace) order by fecha_vencimiento), '[]')
        from (select descripcion, fecha_vencimiento, enlace from vencimientos_v where fecha_vencimiento <= current_date + 30 order by fecha_vencimiento limit 8) z));
    exception when others then null; end;
  end;
  return r;
end $$;
grant execute on function public.inicio_datos() to authenticated;
