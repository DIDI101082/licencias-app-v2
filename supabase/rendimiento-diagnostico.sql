-- ============================================================
-- Diagnóstico de rendimiento (solo lectura: no cambia nada)
-- Ejecutar en Supabase > SQL Editor y mandar el resultado.
-- Muestra las consultas que hace la app (no las internas de Supabase), ordenadas por tiempo total.
-- ============================================================
select 'info' as tipo, null::numeric as total_seg, null::bigint as veces, null::numeric as promedio_ms, null::bigint as filas,
       'Estadísticas desde ' || coalesce((select to_char(stats_reset at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') from extensions.pg_stat_statements_info), '?')
       || ' · políticas optimizadas: ' || coalesce((select count(*)::text from auditoria_privada.politicas_respaldo), 'rendimiento.sql no se ejecutó') as detalle
union all
(select r.rolname,
        round(s.total_exec_time::numeric / 1000, 1),
        s.calls,
        round(s.mean_exec_time::numeric, 1),
        s.rows,
        left(regexp_replace(s.query, '\s+', ' ', 'g'), 200)
   from extensions.pg_stat_statements s
   join pg_roles r on r.oid = s.userid
  where r.rolname in ('authenticated', 'anon', 'service_role')
  order by s.total_exec_time desc
  limit 20)
union all
(select r.rolname || ' (más lentas)',
        round(s.total_exec_time::numeric / 1000, 1),
        s.calls,
        round(s.mean_exec_time::numeric, 1),
        s.rows,
        left(regexp_replace(s.query, '\s+', ' ', 'g'), 200)
   from extensions.pg_stat_statements s
   join pg_roles r on r.oid = s.userid
  where r.rolname in ('authenticated', 'anon', 'service_role') and s.calls >= 5
  order by s.mean_exec_time desc
  limit 10);
