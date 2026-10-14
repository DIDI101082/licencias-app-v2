-- ============================================================
-- Inicio sin las alertas confirmadas. Ejecutar en Supabase (Accusys Cyber) > SQL Editor,
-- DESPUÉS de alertas-confirmar.sql. Se puede correr más de una vez.
-- ============================================================

-- ------------------------------------------------------------
-- Inicio: la tarjeta "Alertas abiertas" y "Lo urgente hoy" muestran solo las alertas SIN confirmar
-- (las confirmadas se cuentan aparte). Requiere haber corrido lo anterior de este archivo.
-- ------------------------------------------------------------
create or replace function public.inicio_datos() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb := '{}'::jsonb; v_logs boolean := puede_ver('auditoria');
begin
  if not (puede_ver('seguridad') or coalesce(mi_rol(), '') = 'administrador') then raise exception 'Sin acceso'; end if;
  begin
    r := r || jsonb_build_object(
      'alertas', (select coalesce(jsonb_object_agg(severidad, n), '{}') from (select severidad, count(*) n from alertas where resuelta is null and confirmada is null group by 1) z),
      'confirmadas', (select count(*) from alertas where resuelta is null and confirmada is not null),
      'por_dia', (select jsonb_agg(jsonb_build_object('dia', d::date, 'n', (select count(*) from alertas a
                    where (a.abierta at time zone 'America/Argentina/Buenos_Aires')::date = d::date)) order by d)
                    from generate_series(current_date - 13, current_date, interval '1 day') d),
      'urgentes', case when v_logs then (select coalesce(jsonb_agg(z), '[]') from (
                    select id, severidad, titulo, detalle, enlace, abierta from alertas where resuelta is null and confirmada is null
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
