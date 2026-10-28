-- ==========================================================
-- HELPDESK: AVISO A TEAMS CUANDO ENTRA UN TICKET NUEVO A UN SECTOR (canal propio)
--   * Cada ticket que aparece por primera vez en la lectura del sistema de tickets queda con su hora
--     de detección. Si está asignado a uno de los sectores elegidos (por defecto Ciberseguridad) y no
--     está cerrado, se avisa a un canal de Teams PROPIO (otro webhook, distinto del de Alertas).
--   * Sale apenas termina la lectura (cada 15 minutos): una tarjeta con todos los tickets nuevos.
--   * Cada ticket se avisa una sola vez. Los que ya existían al ejecutar este archivo no avisan.
--   * No pasa por Alertas: no abre alertas ni tickets.
-- Ejecutar en el SQL Editor, DESPUÉS de alertas.sql, tickets.sql y tickets-lectura.sql.
-- Se puede volver a ejecutar sin problema.
-- ==========================================================

-- Hora en que la lectura vio cada ticket por primera vez (las filas que ya existen quedan sin hora: no avisan)
alter table public.tickets_ext add column if not exists detectado timestamptz;
alter table public.tickets_ext alter column detectado set default now();
alter table public.tickets_ext add column if not exists avisado timestamptz;

alter table public.tickets_config
  add column if not exists aviso_activo boolean not null default true,
  add column if not exists aviso_sectores text not null default 'Ciberseguridad',   -- separados por coma
  add column if not exists aviso_webhook text,                                      -- canal de Teams propio
  add column if not exists aviso_ultimo timestamptz,
  add column if not exists aviso_error text;

-- ----------------------------------------------------------
-- Envío de la tarjeta (al webhook propio). Devuelve null si salió bien, o el error.
-- ----------------------------------------------------------
create or replace function public.helpdesk_teams(p_titulo text, p_lineas text[], p_url text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  c tickets_config;
  v_app text := (select url_app from alertas_config where id = 1);
  v_body jsonb := '[]'::jsonb;
  v_acciones jsonb := '[]'::jsonb;
  v_linea text;
  r record;
begin
  select * into c from tickets_config where id = 1;
  if c.aviso_webhook is null then return 'Falta cargar el webhook del canal de Teams'; end if;

  v_body := v_body || jsonb_build_object('type', 'TextBlock', 'size', 'Medium', 'weight', 'Bolder', 'wrap', true, 'text', p_titulo);
  foreach v_linea in array coalesce(p_lineas, '{}') loop
    v_body := v_body || jsonb_build_object('type', 'TextBlock', 'wrap', true, 'spacing', 'Small', 'text', v_linea);
  end loop;
  if coalesce(p_url, '') ~ '^https?://' then
    v_acciones := v_acciones || jsonb_build_object('type', 'Action.OpenUrl', 'title', 'Abrir el ticket', 'url', p_url);
  end if;
  if coalesce(v_app, '') ~ '^https://' then
    v_acciones := v_acciones || jsonb_build_object('type', 'Action.OpenUrl', 'title', 'Ver en Accusys Cyber', 'url', rtrim(v_app, '/') || '/helpdesk');
  end if;

  begin
    begin
      perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');
    exception when others then null;
    end;
    select * into r from extensions.http((
      'POST',
      c.aviso_webhook,
      array[extensions.http_header('Content-Type', 'application/json')],
      'application/json',
      jsonb_build_object(
        'type', 'message',
        'attachments', jsonb_build_array(jsonb_build_object(
          'contentType', 'application/vnd.microsoft.card.adaptive', 'contentUrl', null,
          'content', jsonb_build_object('$schema', 'http://adaptivecards.io/schemas/adaptive-card.json', 'type', 'AdaptiveCard', 'version', '1.4',
                                        'msteams', jsonb_build_object('width', 'Full'), 'body', v_body, 'actions', v_acciones))))::text
    )::extensions.http_request);
    if r.status between 200 and 299 then
      update tickets_config set aviso_ultimo = now(), aviso_error = null where id = 1;
      return null;
    end if;
    update tickets_config set aviso_error = 'Teams respondió ' || r.status || ': ' || left(coalesce(r.content, ''), 200) where id = 1;
    return 'Teams respondió ' || r.status;
  exception when others then
    update tickets_config set aviso_error = left(sqlerrm, 300) where id = 1;
    return left(sqlerrm, 300);
  end;
end $$;
revoke all on function public.helpdesk_teams(text, text[], text) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Tickets nuevos de los sectores elegidos, todavía sin avisar
-- ----------------------------------------------------------
create or replace function public.helpdesk_avisar()
returns int language plpgsql security definer set search_path = public as $$
declare
  c tickets_config;
  v_ids text[];
  v_lineas text[];
  v_url text;
  v_n int;
begin
  select * into c from tickets_config where id = 1;
  if c.id is null or not coalesce(c.aviso_activo, false) or c.aviso_webhook is null or tickets_norm(c.aviso_sectores) = '' then return 0; end if;

  select array_agg(t.id order by coalesce(t.creado, t.detectado)),
         array_agg('**' || coalesce('#' || nullif(t.numero, ''), '#' || t.id) || ' · ' || coalesce(left(t.titulo, 140), '(sin título)') || '**'
                   || coalesce(' — ' || nullif(concat_ws(' · ', 'de ' || nullif(t.solicitante, ''), nullif(t.cliente, ''), nullif(t.tipo, ''),
                                                    'prioridad ' || nullif(t.prioridad, ''), 'asignado a ' || nullif(t.asignado, ''),
                                                    to_char(coalesce(t.creado, t.detectado) at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')), ''), '')
                   order by coalesce(t.creado, t.detectado)),
         min(t.url)
    into v_ids, v_lineas, v_url
    from (select distinct on (x.id) x.* from tickets_ext x
           where x.bandeja = 'asignado' and x.grupo <> 'cerrado' and x.avisado is null
             and x.detectado > now() - interval '24 hours'
             and coalesce(x.creado, x.detectado) > now() - interval '3 days'
             and exists (select 1
                           from unnest(string_to_array(coalesce(x.sector, ''), ',')) ts,
                                unnest(string_to_array(c.aviso_sectores, ',')) s
                          where tickets_norm(s) <> '' and tickets_norm(ts) = tickets_norm(s))
           order by x.id) t;

  v_n := coalesce(cardinality(v_ids), 0);
  if v_n = 0 then return 0; end if;

  if helpdesk_teams(
       case when v_n = 1 then 'HelpDesk · Ticket nuevo para ' || trim(c.aviso_sectores)
            else 'HelpDesk · ' || v_n || ' tickets nuevos para ' || trim(c.aviso_sectores) end,
       v_lineas[1:20] || case when v_n > 20 then array['…y ' || (v_n - 20) || ' más.'] else '{}'::text[] end,
       case when v_n = 1 then v_url end) is null then
    update tickets_ext set avisado = now() where id = any(v_ids) and avisado is null;
  end if;
  return v_n;
end $$;
revoke all on function public.helpdesk_avisar() from public, anon, authenticated;

-- ----------------------------------------------------------
-- Lectura automática: después de leer, avisar los tickets nuevos
-- ----------------------------------------------------------
create or replace function public.tickets_leer_auto()
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select lectura_activa and lectura_url is not null from tickets_config where id = 1) then
    perform tickets_leer();
    if to_regprocedure('public.helpdesk_avisar()') is not null then
      begin
        perform helpdesk_avisar();
      exception when others then
        update tickets_config set aviso_error = left(sqlerrm, 300) where id = 1;   -- nunca frenar la lectura
      end;
    end if;
  end if;
end $$;

-- ----------------------------------------------------------
-- Pantalla HelpDesk (solo administradores)
-- ----------------------------------------------------------
create or replace function public.helpdesk_aviso_ver()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  return (select jsonb_build_object('activo', aviso_activo, 'sectores', aviso_sectores,
                                    'webhook', aviso_webhook is not null, 'ultimo', aviso_ultimo, 'error', aviso_error)
            from tickets_config where id = 1);
end $$;
revoke all on function public.helpdesk_aviso_ver() from public, anon;
grant execute on function public.helpdesk_aviso_ver() to authenticated;

-- p: {activo?, sectores?, webhook?}   webhook: si no viene, no se toca; si viene vacío, se quita.
create or replace function public.helpdesk_aviso_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_url text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  if p ? 'webhook' then
    v_url := nullif(trim(p ->> 'webhook'), '');
    if v_url is not null and v_url !~* '^https://' then raise exception 'La dirección del webhook tiene que empezar con https://'; end if;
    update tickets_config set aviso_webhook = v_url, aviso_error = null where id = 1;
  end if;
  update tickets_config set
    aviso_activo = coalesce((p ->> 'activo')::boolean, aviso_activo),
    aviso_sectores = coalesce(nullif(trim(p ->> 'sectores'), ''), aviso_sectores)
  where id = 1;
end $$;
revoke all on function public.helpdesk_aviso_guardar(jsonb) from public, anon;
grant execute on function public.helpdesk_aviso_guardar(jsonb) to authenticated;

create or replace function public.helpdesk_aviso_probar()
returns text language plpgsql security definer set search_path = public as $$
declare v_err text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  v_err := helpdesk_teams('HelpDesk · Prueba de aviso',
                          array['Este canal va a recibir los tickets nuevos de: ' || (select aviso_sectores from tickets_config where id = 1)]);
  if v_err is not null then raise exception '%', v_err; end if;
  return 'Mensaje de prueba enviado';
end $$;
revoke all on function public.helpdesk_aviso_probar() from public, anon;
grant execute on function public.helpdesk_aviso_probar() to authenticated;
