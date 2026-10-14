-- ============================================================
-- Diagnóstico de rendimiento (solo lectura: no cambia nada)
-- Ejecutar en Supabase > SQL Editor y mandar el resultado.
-- Conviene correrlo después de usar la app un rato (un día de uso normal es ideal).
-- ============================================================
with consultas as (
  select 'consulta' as tipo,
         round(s.total_exec_time::numeric / 1000, 1) as total_seg,
         s.calls as veces,
         round(s.mean_exec_time::numeric, 1) as promedio_ms,
         s.rows as filas,
         left(regexp_replace(s.query, '\s+', ' ', 'g'), 160) as detalle
    from extensions.pg_stat_statements s
   where s.query !~* '^\s*(begin|commit|set |show |select set_config|with pgrst_source as \(select pg_catalog)'
     and s.userid = (select oid from pg_roles where rolname = 'authenticator')
   order by s.total_exec_time desc
   limit 15
), tablas as (
  select 'tabla' as tipo,
         round(pg_total_relation_size(c.oid) / 1048576.0, 1) as total_seg,  -- acá: MB
         coalesce(st.seq_scan, 0) as veces,                                  -- acá: recorridos completos
         round(coalesce(st.n_live_tup, 0)::numeric, 0) as promedio_ms,       -- acá: filas
         coalesce(st.idx_scan, 0) as filas,                                  -- acá: búsquedas por índice
         c.relname as detalle
    from pg_class c
    left join pg_stat_user_tables st on st.relid = c.oid
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
   order by pg_total_relation_size(c.oid) desc
   limit 15
)
select * from consultas
union all
select * from tablas;
-- En las filas "tabla": total_seg = MB, veces = recorridos completos, promedio_ms = filas, filas = búsquedas por índice.
