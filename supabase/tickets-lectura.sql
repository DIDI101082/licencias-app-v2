-- ==========================================================
-- LECTURA DEL SISTEMA DE TICKETS (helpdesk → Accusys Cyber)
--   * Cada 15 minutos la base consulta por HTTP GET un endpoint de solo lectura del sistema de
--     tickets y guarda una copia: número, título, estado, sector, asignado y fechas.
--   * Con eso la pantalla Gobierno → Tickets muestra abiertos, en espera, cerrados y cuánto
--     tiempo lleva cada uno. Accusys Cyber nunca modifica tickets por esta vía.
--   * Se puede limitar a uno o más sectores (por ejemplo, solo los tickets de Ciberseguridad):
--     se piden con ?sector=... y, además, se descarta cualquier ticket de otro sector que llegue.
--   * La dirección y el token son secretos: nunca se muestran en la app ni en Logs.
--   * El formato que tiene que devolver el endpoint está en docs/integracion-tickets.md.
-- Requiere las extensiones "http" y "pg_cron" (ya activas por alertas.sql).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de tickets.sql.
-- ==========================================================

alter table public.tickets_config
  add column if not exists lectura_activa boolean not null default false,
  add column if not exists lectura_url text,          -- endpoint GET del sistema de tickets
  add column if not exists lectura_token text,        -- se envía como "Authorization: Bearer <token>"
  add column if not exists lectura_generados boolean not null default true,   -- leer también la bandeja de generados (tipoBandeja=1)
  add column if not exists lectura_sectores text,     -- sectores a leer, separados por coma (vacío = todos)
  add column if not exists lectura_ultima timestamptz,
  add column if not exists lectura_total int,
  add column if not exists lectura_error text;

create table if not exists public.tickets_ext (
  id text primary key,                   -- identificador del ticket en el sistema de tickets
  numero text,                           -- número visible (si es distinto del id)
  titulo text,
  estado text,                           -- tal como lo informa el sistema de tickets
  grupo text not null default 'abierto' check (grupo in ('abierto', 'en_espera', 'cerrado')),
  sector text,
  prioridad text,
  solicitante text,
  asignado text,
  creado timestamptz,
  actualizado timestamptz,
  cerrado timestamptz,
  url text,
  visto timestamptz not null default now()   -- última lectura en la que vino
);
alter table public.tickets_ext
  add column if not exists tipo text,        -- tipo de ticket (Incidente, Solicitud…)
  add column if not exists sla text,         -- estado del SLA tal como lo informa el sistema de tickets
  add column if not exists cliente text;
-- Bandeja: tickets asignados a la subárea (los que hay que resolver) o generados por ella.
-- Un mismo ticket puede estar en las dos, así que la clave es (id, bandeja).
alter table public.tickets_ext
  add column if not exists bandeja text not null default 'asignado' check (bandeja in ('asignado', 'generado'));
do $$
begin
  if not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                  where i.indrelid = 'public.tickets_ext'::regclass and i.indisprimary and a.attname = 'bandeja') then
    alter table public.tickets_ext drop constraint if exists tickets_ext_pkey;
    alter table public.tickets_ext add primary key (id, bandeja);
  end if;
end $$;
create index if not exists idx_tickets_ext_grupo on public.tickets_ext(grupo);

alter table public.tickets_ext enable row level security;
revoke insert, update, delete on public.tickets_ext from anon, authenticated;
drop policy if exists tickets_ext_select on public.tickets_ext;
create policy tickets_ext_select on public.tickets_ext for select to authenticated
  using (mi_rol() is not null and puede_ver('auditoria'));

-- Estado del sistema de tickets → abierto / en espera / cerrado
create or replace function public.tickets_grupo(p_estado text, p_cerrado timestamptz)
returns text language sql immutable as $$
  select case
    when p_estado ~* 'cerrad|resuel|finaliz|complet|cancel|anulad|rechaz|closed|resolved|done' then 'cerrado'
    -- "Pendiente" es un ticket recién creado, todavía sin asignar: cuenta como abierto
    when p_estado ~* 'espera|paus|deten|hold|waiting' then 'en_espera'
    when coalesce(trim(p_estado), '') = '' and p_cerrado is not null then 'cerrado'
    else 'abierto'
  end
$$;

-- Fecha en texto → timestamptz (acepta ISO 8601 o segundos/milisegundos Unix; si no se entiende, null).
-- Una fecha sin zona horaria ("2026-06-20T10:34:11") se toma como hora de Argentina.
create or replace function public.tickets_fecha(p text)
returns timestamptz language plpgsql immutable as $$
begin
  if coalesce(trim(p), '') = '' then return null; end if;
  if p ~ '^\d{13}$' then return to_timestamp(p::bigint / 1000.0); end if;
  if p ~ '^\d{10}$' then return to_timestamp(p::bigint); end if;
  if p ~* '(z|[+-]\d{2}(:?\d{2})?)$' then return p::timestamptz; end if;
  return p::timestamp at time zone 'America/Argentina/Buenos_Aires';
exception when others then
  return null;
end $$;

-- ----------------------------------------------------------
-- Lectura
-- ----------------------------------------------------------
-- Lee UNA bandeja (una dirección) y guarda sus tickets. No toca la configuración.
create or replace function public.tickets_leer_una(p_url text, p_bandeja text, v_ahora timestamptz)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c tickets_config;
  r record;
  j jsonb;
  v_lista jsonb;
  v_headers http_header[] := '{}';
  v_error text;
  v_sectores text[];
  v_url text;
  n int := 0;
  n_quitados int := 0;
begin
  select * into c from tickets_config where id = 1;
  -- Sectores a leer, en minúsculas y sin espacios de más (null = todos)
  select array_agg(lower(trim(x))) into v_sectores
    from unnest(string_to_array(coalesce(c.lectura_sectores, ''), ',')) x where trim(x) <> '';
  if p_url is null then
    v_error := 'Falta configurar la dirección de lectura del sistema de tickets';
  else
    -- El token va en los dos encabezados habituales: "X-API-Key" y "Authorization: Bearer"
    if c.lectura_token is not null then
      v_headers := array[http_header('X-API-Key', c.lectura_token), http_header('Authorization', 'Bearer ' || c.lectura_token)];
    end if;
    v_headers := v_headers || http_header('Accept', 'application/json');
    begin
      begin perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '20000'); exception when others then null; end;
      v_url := p_url;
      if v_sectores is not null then
        v_url := v_url || case when v_url like '%?%' then '&' else '?' end || 'sector='
                 || (select string_agg(urlencode(trim(x)), ',') from unnest(string_to_array(c.lectura_sectores, ',')) x where trim(x) <> '');
      end if;
      select * into r from http(('GET', v_url, v_headers, null, null)::http_request);
      if r.status between 200 and 299 then
        begin
          j := r.content::jsonb;
        exception when others then
          v_error := 'El sistema de tickets no respondió con un JSON';
        end;
      else
        -- Se informa la ruta consultada (sin parámetros) para detectar una dirección mal cargada
        v_error := 'El sistema de tickets respondió ' || r.status || ' en ' || coalesce(substring(p_url from '^https?://[^/?#]+([^?#]*)'), '') 
                   || case when substring(p_url from '^https?://[^/?#]+([^?#]*)') in ('', '/') then ' (la dirección no tiene ruta: falta la parte /api/...)' else '' end
                   || coalesce(': ' || nullif(left(r.content, 200), ''), '');
      end if;
    exception when others then
      v_error := 'No se pudo conectar con el sistema de tickets: ' || sqlerrm;
    end;
  end if;

  if v_error is null then
    -- Acepta una lista directa o un objeto con la lista en tickets / data / items / results
    v_lista := case when jsonb_typeof(j) = 'array' then j
                    else coalesce(j -> 'tickets', j -> 'data', j -> 'items', j -> 'results') end;
    if jsonb_typeof(v_lista) is distinct from 'array' then
      -- Se muestra el comienzo de la respuesta para poder adaptar la lectura al formato real
      v_error := 'La respuesta no trae la lista de tickets (se espera {"tickets": [...]}). Recibido: ' || left(r.content, 600);
    end if;
  end if;

  if v_error is not null then
    return jsonb_build_object('ok', false, 'error', v_error);
  end if;

  with datos as (
    -- Nombres de campo aceptados: los del formato propio y los de la Helpdesk Dashboard API
    -- (bandeja por subárea: idTicket, fechaAlta, asignados[], estadoSla, fechaUltimoCambioEstado…)
    select coalesce(x ->> 'id', x ->> 'idTicket', x ->> 'ticket_id', x ->> 'numero') as id,
           coalesce(x ->> 'numero', x ->> 'number', x ->> 'codigo') as numero,
           coalesce(x ->> 'titulo', x ->> 'asunto', x ->> 'title', x ->> 'subject') as titulo,
           coalesce(x ->> 'estado', x ->> 'status') as estado,
           -- sector: el informado o, si no viene, la subárea (tipo 2) o el grupo (tipo 3) al que está asignado
           coalesce(x ->> 'sector', x ->> 'area', x ->> 'departamento', x ->> 'cola',
                    (select string_agg(a ->> 'nombre', ', ' order by a ->> 'tipo') from jsonb_array_elements(
                       case when jsonb_typeof(x -> 'asignados') = 'array' then x -> 'asignados' else '[]'::jsonb end) a
                      where a ->> 'tipo' in ('2', '3'))) as sector,
           coalesce(x ->> 'prioridad', x ->> 'priority') as prioridad,
           coalesce(x ->> 'solicitante', x ->> 'usuario', x ->> 'requester', x ->> 'autor') as solicitante,
           -- asignado: el informado o, si no viene, las personas (tipo 1) de la lista de asignados
           coalesce(x ->> 'asignado', x ->> 'asignado_a', x ->> 'responsable', x ->> 'assignee',
                    (select string_agg(a ->> 'nombre', ', ') from jsonb_array_elements(
                       case when jsonb_typeof(x -> 'asignados') = 'array' then x -> 'asignados' else '[]'::jsonb end) a
                      where a ->> 'tipo' = '1')) as asignado,
           tickets_fecha(coalesce(x ->> 'creado', x ->> 'fecha_creacion', x ->> 'created_at', x ->> 'fechaAlta')) as creado,
           tickets_fecha(coalesce(x ->> 'actualizado', x ->> 'fecha_actualizacion', x ->> 'updated_at', x ->> 'fechaUltimaModificacion')) as actualizado,
           tickets_fecha(coalesce(x ->> 'cerrado', x ->> 'fecha_cierre', x ->> 'closed_at', x ->> 'fechaCierre')) as cerrado,
           -- la bandeja no informa fecha de cierre: para un ticket cerrado se usa su último cambio de estado
           tickets_fecha(x ->> 'fechaUltimoCambioEstado') as cambio_estado,
           coalesce(x ->> 'tipo', x ->> 'tipoTicket') as tipo,
           coalesce(x ->> 'sla', x ->> 'estadoSla') as sla,
           nullif(trim(x ->> 'cliente'), '') as cliente,
           x ->> 'url' as url
      from jsonb_array_elements(v_lista) x
     where jsonb_typeof(x) = 'object'
  ), ins as (
    insert into tickets_ext as t (id, numero, titulo, estado, grupo, sector, prioridad, solicitante, asignado, creado, actualizado, cerrado, url, tipo, sla, cliente, bandeja, visto)
    select distinct on (d.id)
           left(d.id, 100), left(d.numero, 100), left(d.titulo, 500), left(d.estado, 100), tickets_grupo(d.estado, d.cerrado),
           left(d.sector, 150), left(d.prioridad, 60), left(d.solicitante, 200), left(d.asignado, 200),
           d.creado, d.actualizado, case when tickets_grupo(d.estado, d.cerrado) = 'cerrado' then coalesce(d.cerrado, d.cambio_estado) end,
           case when d.url ~* '^https?://' then left(d.url, 500) end, left(d.tipo, 100), left(d.sla, 60), left(d.cliente, 200), p_bandeja, v_ahora
      from datos d
     where coalesce(d.id, '') <> ''
       -- los cerrados hace más de un año no se guardan
       and not (tickets_grupo(d.estado, d.cerrado) = 'cerrado' and coalesce(d.cerrado, d.cambio_estado) < v_ahora - interval '365 days')
       and (v_sectores is null or lower(trim(d.sector)) = any(v_sectores))
    on conflict (id, bandeja) do update set
      numero = excluded.numero, titulo = excluded.titulo, estado = excluded.estado, grupo = excluded.grupo,
      sector = excluded.sector, prioridad = excluded.prioridad, solicitante = excluded.solicitante, asignado = excluded.asignado,
      creado = coalesce(excluded.creado, t.creado), actualizado = excluded.actualizado,
      cerrado = case when excluded.grupo = 'cerrado' then coalesce(excluded.cerrado, t.cerrado) end,
      url = excluded.url, tipo = excluded.tipo, sla = excluded.sla, cliente = excluded.cliente, visto = excluded.visto
    returning 1
  )
  select count(*) into n from ins;

  -- Cerrado sin ninguna fecha informada: se toma el momento en que se lo vio cerrado por primera vez
  update tickets_ext set cerrado = visto where grupo = 'cerrado' and cerrado is null;

  -- El endpoint devuelve todos los tickets sin cerrar: uno que figuraba abierto y ya no viene, se eliminó
  -- o se cerró hace mucho. Nunca se limpia con una respuesta vacía. Los cerrados se conservan un año.
  if n > 0 then
    delete from tickets_ext where bandeja = p_bandeja and grupo <> 'cerrado' and visto < v_ahora;
    get diagnostics n_quitados = row_count;
    -- Si se limitó a ciertos sectores, no queda guardado nada de los demás
    if v_sectores is not null then
      delete from tickets_ext where bandeja = p_bandeja and (sector is null or not (lower(trim(sector)) = any(v_sectores)));
    end if;
    delete from tickets_ext where grupo = 'cerrado' and coalesce(cerrado, actualizado, visto) < v_ahora - interval '365 days';
  end if;

  return jsonb_build_object('ok', true, 'tickets', n, 'quitados', n_quitados);
end $$;
revoke all on function public.tickets_leer_una(text, text, timestamptz) from public, anon, authenticated;

-- Lectura completa: la bandeja configurada y, si está activado y la dirección es la de asignados
-- (tipoBandeja=2), también la de generados (la misma dirección con tipoBandeja=1).
create or replace function public.tickets_leer()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c tickets_config;
  v_ahora timestamptz := clock_timestamp();
  v_bandeja text;
  a jsonb;
  g jsonb;
  n int;
begin
  select * into c from tickets_config where id = 1;
  v_bandeja := case when c.lectura_url ~* 'tipoBandeja=1(\D|$)' then 'generado' else 'asignado' end;
  a := tickets_leer_una(c.lectura_url, v_bandeja, v_ahora);
  if not (a ->> 'ok')::boolean then
    update tickets_config set lectura_error = left(a ->> 'error', 900) where id = 1;
    return a;
  end if;
  n := (a ->> 'tickets')::int;

  if c.lectura_generados and c.lectura_url ~* 'tipoBandeja=2(\D|$)' then
    g := tickets_leer_una(regexp_replace(c.lectura_url, 'tipoBandeja=2', 'tipoBandeja=1', 'i'), 'generado', v_ahora);
    if not (g ->> 'ok')::boolean then
      -- Los asignados quedaron leídos; se informa el problema con la otra bandeja
      update tickets_config set lectura_ultima = v_ahora, lectura_total = n,
             lectura_error = left('Bandeja de generados: ' || (g ->> 'error'), 900) where id = 1;
      return jsonb_build_object('ok', false, 'error', 'Se leyeron ' || n || ' tickets asignados, pero falló la bandeja de generados: ' || (g ->> 'error'));
    end if;
    n := n + (g ->> 'tickets')::int;
  else
    delete from tickets_ext where bandeja <> v_bandeja;   -- no queda guardada una bandeja que ya no se lee
  end if;

  update tickets_config set lectura_ultima = v_ahora, lectura_total = n, lectura_error = null where id = 1;
  return jsonb_build_object('ok', true, 'tickets', n, 'asignados', case when v_bandeja = 'asignado' then (a ->> 'tickets')::int else 0 end,
                            'generados', case when v_bandeja = 'generado' then (a ->> 'tickets')::int else coalesce((g ->> 'tickets')::int, 0) end);
end $$;
revoke all on function public.tickets_leer() from public, anon, authenticated;

-- Tarea programada: solo si la lectura está encendida
create or replace function public.tickets_leer_auto()
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select lectura_activa and lectura_url is not null from tickets_config where id = 1) then
    perform tickets_leer();
  end if;
end $$;
revoke all on function public.tickets_leer_auto() from public, anon, authenticated;

-- ----------------------------------------------------------
-- Desde la app (solo administradores)
-- ----------------------------------------------------------
create or replace function public.tickets_lectura_ver()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c tickets_config;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  select * into c from tickets_config where id = 1;
  return jsonb_build_object(
    'activa', c.lectura_activa, 'generados', c.lectura_generados, 'sectores', c.lectura_sectores, 'ultima', c.lectura_ultima, 'total', c.lectura_total, 'error', c.lectura_error,
    'url', substring(c.lectura_url from '^https?://([^?#]+)'),  -- servidor y ruta, sin parámetros (ahí podría ir una clave)
    'con_token', c.lectura_token is not null);
end $$;
grant execute on function public.tickets_lectura_ver() to authenticated;

-- p: {activa, sectores?, url?, token?}   sectores: lista separada por coma (vacío = todos). url/token: si no vienen, no se tocan; si vienen vacíos, se quitan.
create or replace function public.tickets_lectura_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_url text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  if p ? 'url' then
    v_url := nullif(trim(p ->> 'url'), '');
    if v_url is not null and v_url !~* '^https://' then raise exception 'La dirección tiene que empezar con https://'; end if;
    update tickets_config set lectura_url = v_url where id = 1;
  end if;
  if p ? 'token' then update tickets_config set lectura_token = nullif(trim(p ->> 'token'), '') where id = 1; end if;
  if p ? 'sectores' then update tickets_config set lectura_sectores = nullif(trim(p ->> 'sectores'), '') where id = 1; end if;
  update tickets_config set lectura_activa = coalesce((p ->> 'activa')::boolean, lectura_activa),
         lectura_generados = coalesce((p ->> 'generados')::boolean, lectura_generados), lectura_error = null where id = 1;
  perform alertas_registrar_cambio('Lectura del sistema de tickets',
    jsonb_build_object('configuracion', jsonb_build_object('antes', '(oculto)', 'despues', '(cambiada)')));
end $$;
grant execute on function public.tickets_lectura_guardar(jsonb) to authenticated;

create or replace function public.tickets_leer_ahora()
returns text language plpgsql security definer set search_path = public as $$
declare j jsonb;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  j := tickets_leer();
  if not (j ->> 'ok')::boolean then raise exception '%', j ->> 'error'; end if;
  return 'Se leyeron ' || (j ->> 'tickets') || ' tickets (' || (j ->> 'asignados') || ' asignados, ' || (j ->> 'generados') || ' generados)';
end $$;
grant execute on function public.tickets_leer_ahora() to authenticated;

-- ----------------------------------------------------------
-- Tarea programada (pg_cron). Si da aviso, activá "pg_cron" en Database → Extensions y volvé a ejecutar.
-- ----------------------------------------------------------
do $$
begin
  perform cron.schedule('accusys-tickets', '*/15 * * * *', 'select public.tickets_leer_auto()');
exception when others then
  raise notice 'La lectura automática de tickets no quedó programada (falta pg_cron): %', sqlerrm;
end $$;
