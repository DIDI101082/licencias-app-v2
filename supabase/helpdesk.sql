-- ==========================================================
-- Solapa HELPDESK
--   * Los tickets del helpdesk pasan a tener solapa propia (antes estaban en Gobierno → Tickets),
--     con su permiso en los grupos de acceso.
--   * Seguimiento de cada ticket: se leen de la Helpdesk Dashboard API sus mensajes y su recorrido
--     (asignaciones, cambios de estado y de subárea). Con eso se sabe:
--       - de dónde a dónde fue el ticket,
--       - quién escribió último y, por lo tanto, a quién le falta responder,
--       - cuánto se tardó en dar la primera respuesta (primer mensaje público que no es del solicitante).
--   * Solo lectura: Accusys Cyber no escribe nada en el helpdesk.
--   * Las notas internas (mensajes privados) se guardan sin su texto, salvo que un administrador
--     active "Incluir notas internas".
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de tickets-lectura.sql y servidores.sql.
-- ==========================================================

-- ----------------------------------------------------------
-- Nueva solapa "HelpDesk" en los grupos de acceso
-- ----------------------------------------------------------
alter table public.grupos_acceso drop constraint if exists grupos_acceso_modulos_check;
alter table public.grupos_acceso add constraint grupos_acceso_modulos_check
  check (modulos <@ array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red', 'auditoria', 'servidores', 'helpdesk']);

create or replace function public.mis_modulos() returns text[]
language sql stable security definer set search_path = public as $$
  select case
           when p.rol = 'administrador'
             then array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red', 'auditoria', 'servidores', 'helpdesk']
           else coalesce(g.modulos, '{}')      -- sin grupo: ninguna solapa
         end
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
   where p.id = auth.uid()
$$;

update public.grupos_acceso
   set modulos = modulos || array['helpdesk']
 where nombre = 'Ciberseguridad' and not ('helpdesk' = any(modulos));

-- Los tickets se ven con el permiso de la solapa HelpDesk (antes, con el de Logs)
drop policy if exists tickets_ext_select on public.tickets_ext;
create policy tickets_ext_select on public.tickets_ext for select to authenticated
  using (mi_rol() is not null and puede_ver('helpdesk'));

-- ----------------------------------------------------------
-- Seguimiento
-- ----------------------------------------------------------
alter table public.tickets_config
  add column if not exists seg_activo boolean not null default true,      -- leer el seguimiento de los tickets sin cerrar
  add column if not exists seg_privados boolean not null default false,   -- guardar también el texto de las notas internas
  add column if not exists seg_ultima timestamptz,
  add column if not exists seg_error text;

alter table public.tickets_ext
  add column if not exists seg_leido timestamptz,          -- cuándo se leyó su seguimiento
  add column if not exists seg_actualizado timestamptz,    -- "actualizado" del ticket en ese momento
  add column if not exists respuesta_de text check (respuesta_de in ('atencion', 'solicitante')),  -- a quién le falta responder
  add column if not exists ult_msj_autor text,
  add column if not exists ult_msj_fecha timestamptz,
  add column if not exists mensajes int,
  add column if not exists recorrido text,                 -- subáreas por las que pasó: "A → B → C"
  add column if not exists primera_resp timestamptz,       -- primer mensaje público de alguien que no es quien pidió el ticket
  add column if not exists primera_resp_autor text;

create table if not exists public.tickets_eventos (
  id_ticket text not null,
  origen text not null check (origen in ('mensaje', 'metrica')),
  ext_id text not null,                  -- id del mensaje o de la métrica en el helpdesk
  fecha timestamptz,
  usuario text,                          -- quién escribió o quién quedó como responsable
  proceso text,                          -- métrica: Asignación, Cambio Estado, Mensaje…
  estado text,
  area text,
  subarea text,
  actor text,                            -- métrica: Autor o Responsable
  texto text,                            -- mensaje (vacío si es nota interna y no se guardan)
  privado boolean not null default false,
  primary key (id_ticket, origen, ext_id)
);
alter table public.tickets_eventos enable row level security;
revoke insert, update, delete on public.tickets_eventos from anon, authenticated;
drop policy if exists tickets_eventos_select on public.tickets_eventos;
create policy tickets_eventos_select on public.tickets_eventos for select to authenticated
  using (mi_rol() is not null and puede_ver('helpdesk'));

-- Texto de un mensaje sin etiquetas HTML
create or replace function public.tickets_texto(p text)
returns text language sql immutable as $$
  select nullif(trim(regexp_replace(replace(replace(replace(replace(
           regexp_replace(regexp_replace(coalesce(p, ''), '<\s*(br|/p|/div|/li)\s*/?>', E'\n', 'gi'), '<[^>]+>', '', 'g'),
           '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), E'[ \t]+', ' ', 'g')), '')
$$;

-- Lee mensajes y recorrido de UN ticket y calcula a quién le falta responder
create or replace function public.tickets_seguimiento_leer_uno(p_id text, p_timeout_ms int default 10000)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c tickets_config;
  v_base text;
  v_headers http_header[];
  r record;
  j_msj jsonb;
  j_met jsonb;
  v_solicitante text;
  u record;
  pr record;
  v_respuesta text;
  v_recorrido text;
  n_msj int;
begin
  if p_id !~ '^\d{1,20}$' then return jsonb_build_object('ok', false, 'error', 'Ticket inválido'); end if;
  select * into c from tickets_config where id = 1;
  v_base := substring(c.lectura_url from '^(https://[^?#]+/api/dashboard/)');
  if v_base is null then
    return jsonb_build_object('ok', false, 'error', 'El seguimiento necesita la Helpdesk Dashboard API (dirección con /api/dashboard/)');
  end if;
  v_headers := array[http_header('X-API-Key', coalesce(c.lectura_token, '')), http_header('Accept', 'application/json')];

  begin
    begin perform http_set_curlopt('CURLOPT_TIMEOUT_MS', p_timeout_ms::text); exception when others then null; end;
    select * into r from http(('GET', v_base || 'ticket-mensajes/ticket/' || p_id, v_headers, null, null)::http_request);
    if r.status not between 200 and 299 then
      return jsonb_build_object('ok', false, 'error', 'Mensajes del ticket ' || p_id || ': el helpdesk respondió ' || r.status);
    end if;
    j_msj := r.content::jsonb;
    select * into r from http(('GET', v_base || 'ticket-metricas/ticket/' || p_id, v_headers, null, null)::http_request);
    if r.status not between 200 and 299 then
      return jsonb_build_object('ok', false, 'error', 'Recorrido del ticket ' || p_id || ': el helpdesk respondió ' || r.status);
    end if;
    j_met := r.content::jsonb;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'No se pudo leer el seguimiento del ticket ' || p_id || ': ' || sqlerrm);
  end;
  if jsonb_typeof(j_msj) is distinct from 'array' or jsonb_typeof(j_met) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'error', 'El seguimiento del ticket ' || p_id || ' no vino como lista');
  end if;

  delete from tickets_eventos where id_ticket = p_id;

  -- Mensajes (el de id 0 es la descripción original del ticket)
  insert into tickets_eventos (id_ticket, origen, ext_id, fecha, usuario, texto, privado)
  select distinct on (x ->> 'id') p_id, 'mensaje', coalesce(x ->> 'id', '0'), tickets_fecha(x ->> 'fecha'), left(x ->> 'nombreUsuario', 200),
         case when coalesce((x ->> 'esPrivado')::boolean, false) and not c.seg_privados then null else left(tickets_texto(x ->> 'mensaje'), 4000) end,
         coalesce((x ->> 'esPrivado')::boolean, false)
    from jsonb_array_elements(j_msj) x
   where jsonb_typeof(x) = 'object';

  -- Recorrido: cada proceso aplicado al ticket, con el área, la subárea y el estado de ese momento
  insert into tickets_eventos (id_ticket, origen, ext_id, fecha, usuario, proceso, estado, area, subarea, actor)
  select distinct on (x ->> 'id') p_id, 'metrica', x ->> 'id', tickets_fecha(x ->> 'fecha'), left(x ->> 'nombreResponsable', 200),
         left(x ->> 'nombreProceso', 100), left(x ->> 'nombreEstado', 100), left(x ->> 'nombreArea', 150), left(x ->> 'nombreSubarea', 150),
         left(x ->> 'tipoActor', 40)
    from jsonb_array_elements(j_met) x
   where jsonb_typeof(x) = 'object' and coalesce(x ->> 'id', '') <> '';

  -- ¿A quién le falta responder? Se mira el último mensaje público (las notas internas no cuentan):
  -- si lo escribió quien pidió el ticket (o no hay ninguno), falta la respuesta de quien lo atiende.
  select solicitante into v_solicitante from tickets_ext where id = p_id and solicitante is not null limit 1;
  select e.usuario, e.fecha into u
    from tickets_eventos e
   where e.id_ticket = p_id and e.origen = 'mensaje' and not e.privado
   order by e.fecha desc nulls last, e.ext_id::bigint desc
   limit 1;
  v_respuesta := case when u.usuario is null or tickets_norm(u.usuario) = tickets_norm(v_solicitante) then 'atencion' else 'solicitante' end;
  select count(*) into n_msj from tickets_eventos where id_ticket = p_id and origen = 'mensaje' and ext_id <> '0';

  -- Subáreas por las que pasó, en orden y sin repetir las consecutivas
  select string_agg(q.subarea, ' → ' order by q.orden) into v_recorrido
    from (select e.subarea, row_number() over (order by e.fecha, e.ext_id::bigint) as orden,
                 lag(e.subarea) over (order by e.fecha, e.ext_id::bigint) as anterior
            from tickets_eventos e
           where e.id_ticket = p_id and e.origen = 'metrica' and coalesce(e.subarea, '') <> '') q
   where q.subarea is distinct from q.anterior;

  -- Primera respuesta: el primer mensaje público que no es de quien pidió el ticket (ni su descripción)
  select e.usuario, e.fecha into pr
    from tickets_eventos e
   where e.id_ticket = p_id and e.origen = 'mensaje' and not e.privado and e.ext_id <> '0' and e.fecha is not null
     and tickets_norm(e.usuario) <> tickets_norm(v_solicitante)
   order by e.fecha, e.ext_id::bigint
   limit 1;

  update tickets_ext set seg_leido = now(), seg_actualizado = actualizado, respuesta_de = v_respuesta,
         ult_msj_autor = u.usuario, ult_msj_fecha = u.fecha, mensajes = n_msj, recorrido = left(v_recorrido, 1000),
         primera_resp = pr.fecha, primera_resp_autor = pr.usuario
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.tickets_seguimiento_leer_uno(text, int) from public, anon, authenticated;

-- Lee el seguimiento de los tickets sin cerrar que cambiaron desde la última vez (o que nunca se leyeron).
-- La tarea programada llama con un lote grande; desde la app, un administrador llama con lotes chicos.
create or replace function public.tickets_seguimiento_lote(p_max int default 3)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c tickets_config;
  v_id text;
  r jsonb;
  n int := 0;
  v_error text;
  v_pend int;
begin
  if auth.uid() is not null and mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  select * into c from tickets_config where id = 1;
  if c.lectura_url is null then return jsonb_build_object('ok', false, 'error', 'Falta configurar la lectura de tickets', 'leidos', 0, 'pendientes', 0); end if;

  for v_id in
    select t.id from tickets_ext t
     where (t.grupo <> 'cerrado'
            and (t.seg_leido is null or t.actualizado is distinct from t.seg_actualizado or t.seg_leido < now() - interval '6 hours'))
        -- La tarea programada completa además, una sola vez, los cerrados de los últimos 90 días:
        -- hacen falta para medir el tiempo de primera respuesta
        or (auth.uid() is null and t.grupo = 'cerrado' and t.seg_leido is null and t.cerrado > now() - interval '90 days')
     group by t.id
     order by bool_or(t.grupo <> 'cerrado') desc, min(t.seg_leido) nulls first, max(t.cerrado) desc nulls last
     limit greatest(1, least(coalesce(p_max, 3), 60))
  loop
    r := tickets_seguimiento_leer_uno(v_id, case when auth.uid() is null then 10000 else 3000 end);
    if not (r ->> 'ok')::boolean then v_error := r ->> 'error'; exit; end if;
    n := n + 1;
  end loop;

  select count(distinct t.id) into v_pend from tickets_ext t
   where t.grupo <> 'cerrado' and (t.seg_leido is null or t.actualizado is distinct from t.seg_actualizado);
  update tickets_config set seg_ultima = now(), seg_error = left(v_error, 500) where id = 1;
  return jsonb_build_object('ok', v_error is null, 'error', v_error, 'leidos', n, 'pendientes', v_pend);
end $$;
revoke all on function public.tickets_seguimiento_lote(int) from public, anon;
grant execute on function public.tickets_seguimiento_lote(int) to authenticated;

create or replace function public.tickets_seguimiento_auto()
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select lectura_activa and seg_activo and lectura_url is not null from tickets_config where id = 1) then
    perform tickets_seguimiento_lote(40);
  end if;
end $$;
revoke all on function public.tickets_seguimiento_auto() from public, anon, authenticated;

-- Seguimiento de un ticket para mostrarlo en la app. Si nunca se leyó o tiene más de 10 minutos, lo trae del helpdesk.
create or replace function public.tickets_seguimiento(p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_leido timestamptz;
  r jsonb;
  v_error text;
begin
  if mi_rol() is null or not puede_ver('helpdesk') then raise exception 'Sin acceso'; end if;
  select max(seg_leido) into v_leido from tickets_ext where id = p_id;
  if not found or not exists (select 1 from tickets_ext where id = p_id) then raise exception 'Ticket inexistente'; end if;
  if v_leido is null or v_leido < now() - interval '10 minutes' then
    r := tickets_seguimiento_leer_uno(p_id, 3000);
    if not (r ->> 'ok')::boolean then v_error := r ->> 'error'; end if;
  end if;
  return jsonb_build_object(
    'error', v_error,
    'leido', (select max(seg_leido) from tickets_ext where id = p_id),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object(
        'origen', e.origen, 'id', e.ext_id, 'fecha', e.fecha, 'usuario', e.usuario, 'proceso', e.proceso, 'estado', e.estado,
        'area', e.area, 'subarea', e.subarea, 'actor', e.actor, 'texto', e.texto, 'privado', e.privado)
        order by e.fecha nulls first, e.origen desc, e.ext_id::bigint)
      from tickets_eventos e where e.id_ticket = p_id), '[]'::jsonb));
end $$;
revoke all on function public.tickets_seguimiento(text) from public, anon;
grant execute on function public.tickets_seguimiento(text) to authenticated;

-- Tickets cuyo seguimiento ya estaba leído antes de sumar la primera respuesta: se calcula con lo guardado
update public.tickets_ext t set (primera_resp, primera_resp_autor) = (
  select e.fecha, e.usuario
    from public.tickets_eventos e
   where e.id_ticket = t.id and e.origen = 'mensaje' and not e.privado and e.ext_id <> '0' and e.fecha is not null
     and public.tickets_norm(e.usuario) <> public.tickets_norm(t.solicitante)
   order by e.fecha, e.ext_id::bigint
   limit 1)
 where t.seg_leido is not null and t.primera_resp is null;

-- Configuración del seguimiento (solo administradores). Sin parámetro, devuelve la actual.
create or replace function public.tickets_seguimiento_config(p jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c tickets_config;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  if p is not null then
    update tickets_config set seg_activo = coalesce((p ->> 'activo')::boolean, seg_activo),
                              seg_privados = coalesce((p ->> 'privados')::boolean, seg_privados) where id = 1;
    -- Si se dejan de guardar las notas internas, se borra el texto de las que ya estaban
    if (p ->> 'privados')::boolean is false then update tickets_eventos set texto = null where privado; end if;
    perform alertas_registrar_cambio('Seguimiento de tickets', p);
  end if;
  select * into c from tickets_config where id = 1;
  return jsonb_build_object('activo', c.seg_activo, 'privados', c.seg_privados, 'ultima', c.seg_ultima, 'error', c.seg_error,
    'pendientes', (select count(distinct id) from tickets_ext where grupo <> 'cerrado' and (seg_leido is null or actualizado is distinct from seg_actualizado)),
    -- cerrados de los últimos 90 días que la tarea programada todavía no leyó (para el tiempo de primera respuesta)
    'cerrados_pendientes', (select count(distinct id) from tickets_ext where grupo = 'cerrado' and seg_leido is null and cerrado > now() - interval '90 days'));
end $$;
revoke all on function public.tickets_seguimiento_config(jsonb) from public, anon;
grant execute on function public.tickets_seguimiento_config(jsonb) to authenticated;

-- Al dejar de figurar un ticket, se borra su seguimiento
create or replace function public.tickets_eventos_limpiar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from tickets_ext where id = old.id) then
    delete from tickets_eventos where id_ticket = old.id;
  end if;
  return null;
end $$;
drop trigger if exists trg_tickets_eventos_limpiar on public.tickets_ext;
create trigger trg_tickets_eventos_limpiar after delete on public.tickets_ext
  for each row execute function public.tickets_eventos_limpiar();

-- ----------------------------------------------------------
-- Tarea programada (pg_cron): unos minutos después de cada lectura de bandejas
-- ----------------------------------------------------------
do $$
begin
  perform cron.schedule('accusys-tickets-seguimiento', '5-59/15 * * * *', 'select public.tickets_seguimiento_auto()');
exception when others then
  raise notice 'El seguimiento automático no quedó programado (falta pg_cron): %', sqlerrm;
end $$;
