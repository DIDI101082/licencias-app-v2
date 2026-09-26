-- ==========================================================
-- INTEGRACIÓN CON EL SISTEMA DE TICKETS
--   * Cada alerta nueva (desde la severidad elegida) y cada incidente registrado se envía
--     por HTTP POST (JSON) a la dirección de tu sistema de tickets.
--   * Si tu sistema responde con un id de ticket ({"id": ...}, {"ticket_id": ...} o {"numero": ...}),
--     queda guardado y se muestra en la alerta.
--   * Cuando la alerta se resuelve sola, se avisa al mismo ticket con evento "alerta_resuelta".
--   * La dirección y el token son secretos: nunca se muestran en la app ni en Logs.
-- Requiere la extensión "http" (ya activa por alertas.sql).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de alertas.sql (y de incidentes.sql si lo usás).
-- ==========================================================

create table if not exists public.tickets_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default false,
  url text,                              -- endpoint del sistema de tickets (POST JSON)
  token text,                            -- se envía como "Authorization: Bearer <token>"
  sector text not null default 'Ciberseguridad',
  severidad_min text not null default 'alta' check (severidad_min in ('critica', 'alta', 'media', 'info')),
  incidentes boolean not null default true,
  avisar_resueltas boolean not null default true,
  ultimo_envio timestamptz,
  ultimo_error text
);
insert into public.tickets_config (id) values (1) on conflict (id) do nothing;
alter table public.tickets_config enable row level security;
revoke all on public.tickets_config from anon, authenticated;   -- solo por funciones

alter table public.alertas
  add column if not exists ticket_ref text,
  add column if not exists ticket_error text;

-- ----------------------------------------------------------
-- Envío
-- ----------------------------------------------------------
create or replace function public.tickets_enviar(p jsonb, out ref text, out error text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  c tickets_config;
  r record;
  j jsonb;
  v_headers http_header[] := '{}';
begin
  select * into c from tickets_config where id = 1;
  if c.url is null then error := 'Falta configurar la dirección del sistema de tickets'; return; end if;
  if c.token is not null then v_headers := array[http_header('Authorization', 'Bearer ' || c.token)]; end if;
  begin
    begin perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000'); exception when others then null; end;
    select * into r from http(('POST', c.url, v_headers, 'application/json',
                               (p || jsonb_build_object('origen', 'accusys-cyber', 'sector', c.sector))::text)::http_request);
    if r.status between 200 and 299 then
      begin
        j := r.content::jsonb;
        ref := coalesce(j ->> 'id', j ->> 'ticket_id', j ->> 'numero', j ->> 'ticket', j #>> '{data,id}');
      exception when others then ref := null;
      end;
      update tickets_config set ultimo_envio = now(), ultimo_error = null where id = 1;
    else
      error := 'El sistema de tickets respondió ' || r.status || coalesce(': ' || left(r.content, 200), '');
    end if;
  exception when others then
    error := 'No se pudo conectar con el sistema de tickets: ' || sqlerrm;
  end;
  if error is not null then update tickets_config set ultimo_error = error where id = 1; end if;
end $$;
revoke all on function public.tickets_enviar(jsonb) from public, anon, authenticated;

create or replace function public.tickets_url_app(p_enlace text) returns text
language sql stable security definer set search_path = public as $$
  select case when coalesce(url_app, '') ~ '^https://' then rtrim(url_app, '/') || coalesce(p_enlace, '') end
    from alertas_config where id = 1
$$;

-- Alerta nueva → ticket; alerta resuelta → aviso al mismo ticket
create or replace function public.tickets_por_alerta()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c tickets_config;
  v_rango jsonb := '{"critica": 3, "alta": 2, "media": 1, "info": 0}';
  e record;
begin
  select * into c from tickets_config where id = 1;
  if c.url is null or not c.activo then return new; end if;

  if tg_op = 'INSERT' then
    if (v_rango ->> new.severidad)::int < (v_rango ->> c.severidad_min)::int then return new; end if;
    select * into e from tickets_enviar(jsonb_build_object(
      'evento', 'alerta_nueva', 'id', 'alerta-' || new.id, 'regla', new.regla, 'severidad', new.severidad,
      'titulo', new.titulo, 'detalle', new.detalle, 'url', tickets_url_app(new.enlace), 'fecha', new.abierta));
    update alertas set ticket_ref = e.ref, ticket_error = e.error where id = new.id;
  elsif tg_op = 'UPDATE' and old.resuelta is null and new.resuelta is not null and c.avisar_resueltas
        and (new.ticket_ref is not null or (new.ticket_error is null and (v_rango ->> new.severidad)::int >= (v_rango ->> c.severidad_min)::int)) then
    perform tickets_enviar(jsonb_build_object(
      'evento', 'alerta_resuelta', 'id', 'alerta-' || new.id, 'ticket_ref', new.ticket_ref, 'regla', new.regla,
      'severidad', new.severidad, 'titulo', 'Resuelto: ' || new.titulo, 'fecha', new.resuelta));
  end if;
  return new;
exception when others then
  return new;   -- nunca frenar el motor de alertas por un problema con los tickets
end $$;

drop trigger if exists trg_tickets_alerta on public.alertas;
create trigger trg_tickets_alerta after insert or update of resuelta on public.alertas
  for each row execute function public.tickets_por_alerta();

-- Incidente registrado → ticket (solo si ya se ejecutó incidentes.sql)
do $$
begin
  if to_regclass('public.incidentes') is null then return; end if;

  alter table public.incidentes add column if not exists ticket_ref text;

  create or replace function public.tickets_por_incidente()
  returns trigger language plpgsql security definer set search_path = public as $f$
  declare c tickets_config; e record; v_tipo text;
  begin
    select * into c from tickets_config where id = 1;
    if c.url is null or not c.activo or not c.incidentes then return new; end if;
    select nombre into v_tipo from incidentes_tipos where id = new.tipo;
    select * into e from tickets_enviar(jsonb_build_object(
      'evento', 'incidente_nuevo', 'id', 'INC-' || lpad(new.numero::text, 4, '0'), 'tipo', v_tipo,
      'severidad', new.severidad, 'titulo', 'INC-' || lpad(new.numero::text, 4, '0') || ' · ' || new.titulo,
      'detalle', new.descripcion, 'url', tickets_url_app('/inventario/incidentes/' || new.id), 'fecha', new.detectado));
    if e.ref is not null then
      update incidentes set ticket_ref = e.ref where id = new.id;
      insert into incidentes_eventos (incidente_id, tipo, texto, autor_nombre) values (new.id, 'nota', 'Ticket creado: ' || e.ref, 'Sistema');
    elsif e.error is not null then
      insert into incidentes_eventos (incidente_id, tipo, texto, autor_nombre) values (new.id, 'nota', 'No se pudo crear el ticket: ' || e.error, 'Sistema');
    end if;
    return new;
  exception when others then
    return new;
  end $f$;

  drop trigger if exists trg_tickets_incidente on public.incidentes;
  create trigger trg_tickets_incidente after insert on public.incidentes
    for each row execute function public.tickets_por_incidente();
end $$;

-- ----------------------------------------------------------
-- Configuración desde la app (solo administradores)
-- ----------------------------------------------------------
create or replace function public.tickets_config_ver()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c tickets_config;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  select * into c from tickets_config where id = 1;
  return jsonb_build_object(
    'activo', c.activo, 'sector', c.sector, 'severidad_min', c.severidad_min, 'incidentes', c.incidentes,
    'avisar_resueltas', c.avisar_resueltas, 'ultimo_envio', c.ultimo_envio, 'ultimo_error', c.ultimo_error,
    'url', case when c.url is null then null else substring(c.url from '^https?://([^/]+)') end,  -- solo el servidor
    'con_token', c.token is not null);
end $$;
grant execute on function public.tickets_config_ver() to authenticated;

-- p: {activo, sector, severidad_min, incidentes, avisar_resueltas, url?, token?}
-- url/token: si no vienen, no se tocan; si vienen vacíos, se quitan.
create or replace function public.tickets_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_url text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  if p ? 'url' then
    v_url := nullif(trim(p ->> 'url'), '');
    if v_url is not null and v_url !~* '^https://' then raise exception 'La dirección tiene que empezar con https://'; end if;
    update tickets_config set url = v_url where id = 1;
  end if;
  if p ? 'token' then update tickets_config set token = nullif(trim(p ->> 'token'), '') where id = 1; end if;
  update tickets_config set
    activo = coalesce((p ->> 'activo')::boolean, activo),
    sector = coalesce(nullif(trim(p ->> 'sector'), ''), sector),
    severidad_min = coalesce(p ->> 'severidad_min', severidad_min),
    incidentes = coalesce((p ->> 'incidentes')::boolean, incidentes),
    avisar_resueltas = coalesce((p ->> 'avisar_resueltas')::boolean, avisar_resueltas),
    ultimo_error = null
  where id = 1;
  perform alertas_registrar_cambio('Integración con tickets',
    jsonb_build_object('configuracion', jsonb_build_object('antes', '(oculto)', 'despues', '(cambiada)')));
end $$;
grant execute on function public.tickets_config_guardar(jsonb) to authenticated;

create or replace function public.tickets_probar()
returns text language plpgsql security definer set search_path = public as $$
declare e record;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  select * into e from tickets_enviar(jsonb_build_object(
    'evento', 'prueba', 'id', 'prueba-' || extract(epoch from now())::bigint, 'severidad', 'info',
    'titulo', 'Accusys Cyber · Ticket de prueba', 'detalle', 'Si ves este ticket, la integración funciona. Podés cerrarlo.',
    'fecha', now()));
  if e.error is not null then raise exception '%', e.error; end if;
  return coalesce('Ticket creado: ' || e.ref, 'Enviado (tu sistema no devolvió un id de ticket)');
end $$;
grant execute on function public.tickets_probar() to authenticated;
