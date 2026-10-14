-- ============================================================
-- Rendimiento: políticas de seguridad (RLS) e índices
-- Ejecutar en Supabase > SQL Editor. Se puede correr más de una vez.
-- No cambia QUIÉN ve QUÉ: solo hace que la base calcule los permisos una vez por consulta
-- en lugar de una vez por fila, y agrega los índices que faltan en las relaciones entre tablas.
-- ============================================================

-- ---------- 1. Permisos una vez por consulta ----------
-- Las políticas llaman a puede_ver('…'), mi_rol(), mi_area(), auth.uid()… Escritas así, Postgres las vuelve a
-- ejecutar en CADA fila (y cada una hace su propia consulta a perfiles y grupos). Envueltas en (select …)
-- se calculan una sola vez por consulta. Es la recomendación de Supabase para RLS:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
-- Solo se envuelven llamadas cuyos argumentos son constantes (no dependen de la fila), así el resultado es idéntico.
set search_path = public, extensions;

create schema if not exists auditoria_privada;
create table if not exists auditoria_privada.politicas_respaldo (
  id bigserial primary key,
  esquema text, tabla text, politica text, usando text, chequeo text,
  guardado timestamptz not null default now()
);

do $$
declare
  p record;
  fns text;
  patron text;
  nuevo_q text; nuevo_c text;
  n int := 0;
begin
  -- Funciones "estables" del esquema public que reciben solo texto (o nada): candidatas a envolver
  select string_agg(distinct proname, '|') into fns
    from pg_proc
   where pronamespace = 'public'::regnamespace
     and provolatile in ('s', 'i')
     and prokind = 'f'
     and (pronargs = 0 or proargtypes::oid[] <@ array['text'::regtype::oid])
     and prorettype in ('bool'::regtype, 'text'::regtype, 'uuid'::regtype, 'text[]'::regtype, 'jsonb'::regtype);
  fns := coalesce(fns || '|', '') || 'auth\.uid|auth\.jwt|auth\.role';

  -- nombre(  'lit'::text, 'lit'::text  )  sin un SELECT justo antes (las ya envueltas se dejan como están)
  patron := '(?<!SELECT )(?<![\w.])((?:public\.)?(?:' || fns || ')\((?:''[^'']*''::text(?:, )?)*\))';

  for p in select * from pg_policies where schemaname = 'public' loop
    nuevo_q := case when p.qual is null then null else regexp_replace(p.qual, patron, '( SELECT \1)', 'g') end;
    nuevo_c := case when p.with_check is null then null else regexp_replace(p.with_check, patron, '( SELECT \1)', 'g') end;
    continue when nuevo_q is not distinct from p.qual and nuevo_c is not distinct from p.with_check;

    insert into auditoria_privada.politicas_respaldo (esquema, tabla, politica, usando, chequeo)
    values (p.schemaname, p.tablename, p.policyname, p.qual, p.with_check);

    execute format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename)
         || case when nuevo_q is not null then format(' using (%s)', nuevo_q) else '' end
         || case when nuevo_c is not null then format(' with check (%s)', nuevo_c) else '' end;
    n := n + 1;
  end loop;
  raise notice 'Políticas optimizadas: %', n;
end $$;

-- ---------- 2. Índices en las relaciones entre tablas ----------
-- Cada columna que apunta a otra tabla (empleado_id, equipo_id, dispositivo_id…) y no tiene índice
-- obliga a recorrer la tabla entera en los cruces y al borrar. Se crean los que faltan.
do $$
declare
  f record;
  n int := 0;
begin
  for f in
    select c.conrelid::regclass as tabla, a.attname as columna, c.conrelid as relid, c.conkey[1] as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.connamespace = 'public'::regnamespace
       and array_length(c.conkey, 1) = 1
       and not exists (
         select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
  loop
    execute format('create index if not exists %I on %s (%I)',
                   left('idx_' || replace(f.tabla::text, 'public.', '') || '_' || f.columna, 63), f.tabla, f.columna);
    n := n + 1;
  end loop;
  raise notice 'Índices creados: %', n;
end $$;

-- ---------- 3. Índices para las búsquedas más comunes ----------
-- Solo si la tabla y las columnas existen (no todos los módulos están instalados en todas las bases).
do $$
declare
  ix text[];
  ixs text[][] := array[
    array['inv_dispositivos', 'idx_inv_dispositivos_estado_host', 'estado_registro, hostname'],
    array['inv_dispositivos', 'idx_inv_dispositivos_ultimo_reporte', 'ultimo_reporte desc'],
    array['inv_dispositivo_apps', 'idx_inv_dispositivo_apps_nombre', 'nombre'],
    array['fg_trafico', 'idx_fg_trafico_fecha', 'fecha'],
    array['auditoria', 'idx_auditoria_fecha', 'fecha desc'],
    array['eset_detecciones', 'idx_eset_detecciones_disp_fecha', 'dispositivo_id, fecha desc'],
    array['empleados', 'idx_empleados_email_lower', 'lower(email)']
  ];
begin
  foreach ix slice 1 in array ixs loop
    begin
      if to_regclass('public.' || ix[1]) is not null then
        execute format('create index if not exists %I on public.%I (%s)', ix[2], ix[1], ix[3]);
      end if;
    exception when undefined_column or undefined_function then
      raise notice 'Se omite % (columnas distintas en esta base)', ix[2];
    end;
  end loop;
end $$;

-- ---------- 4. Estadísticas al día para que el planificador elija bien ----------
analyze;

-- Para volver atrás una política (no debería hacer falta): los textos originales quedan en
-- auditoria_privada.politicas_respaldo.
