-- ==========================================================
-- HELPDESK: AVISO A TEAMS CUANDO ENTRA UN TICKET NUEVO A UN SECTOR
--   * Cada ticket que aparece por primera vez en la lectura del sistema de tickets queda con su
--     hora de detección. Si está asignado a uno de los sectores elegidos (por defecto Ciberseguridad)
--     y no está cerrado, abre una alerta y sale una tarjeta a Teams (por el mismo canal de Alertas).
--   * El aviso sale apenas termina la lectura (cada 15 minutos), sin esperar la revisión de alertas.
--   * Los tickets que ya existían al ejecutar este archivo no avisan: solo los que entren desde ahora.
--   * Estas alertas nunca generan un ticket en el sistema de tickets (evita que un aviso cree un
--     ticket que a su vez vuelva a avisar).
-- Ejecutar en el SQL Editor, DESPUÉS de alertas.sql, tickets.sql y tickets-lectura.sql.
-- Se puede volver a ejecutar sin problema.
-- ==========================================================

-- Hora en que la lectura vio cada ticket por primera vez (las filas que ya existen quedan sin hora: no avisan)
alter table public.tickets_ext add column if not exists detectado timestamptz;
alter table public.tickets_ext alter column detectado set default now();

alter table public.tickets_config
  add column if not exists aviso_activo boolean not null default true,
  add column if not exists aviso_sectores text not null default 'Ciberseguridad';   -- separados por coma

-- ----------------------------------------------------------
-- Condición de alerta: ticket nuevo (detectado en las últimas 24 h y creado hace menos de 3 días)
-- ----------------------------------------------------------
create or replace function public.helpdesk_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c tickets_config;
begin
  select * into c from tickets_config where id = 1;
  if c.id is null or not coalesce(c.aviso_activo, false) or tickets_norm(c.aviso_sectores) = '' then return; end if;

  insert into _cond
  select 'helpdesk:nuevo:' || t.id, 'helpdesk_nuevo', 'info',
         'Ticket nuevo para ' || coalesce(nullif(t.sector, ''), 'el área') || ': '
           || coalesce('#' || nullif(t.numero, '') || ' ', '#' || t.id || ' ') || coalesce(left(t.titulo, 120), '(sin título)'),
         concat_ws(' · ', 'de ' || nullif(t.solicitante, ''), nullif(t.cliente, ''), nullif(t.tipo, ''),
                   'prioridad ' || nullif(t.prioridad, ''), 'asignado a ' || nullif(t.asignado, ''),
                   to_char(coalesce(t.creado, t.detectado) at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
         '/helpdesk'
    from tickets_ext t
   where t.bandeja = 'asignado' and t.grupo <> 'cerrado'
     and t.detectado > now() - interval '24 hours'
     and coalesce(t.creado, t.detectado) > now() - interval '3 days'
     and exists (select 1
                   from unnest(string_to_array(coalesce(t.sector, ''), ',')) ts,
                        unnest(string_to_array(c.aviso_sectores, ',')) s
                  where tickets_norm(s) <> '' and tickets_norm(ts) = tickets_norm(s))
  on conflict do nothing;
end $$;
revoke all on function public.helpdesk_condiciones_alertas() from public, anon, authenticated;

-- ----------------------------------------------------------
-- Lectura automática: después de leer, si entró algún ticket nuevo, avisar enseguida
-- ----------------------------------------------------------
create or replace function public.tickets_leer_auto()
returns void language plpgsql security definer set search_path = public as $$
declare v_desde timestamptz := now();
begin
  if (select lectura_activa and lectura_url is not null from tickets_config where id = 1) then
    perform tickets_leer();
    if exists (select 1 from tickets_ext where detectado >= v_desde)
       and to_regprocedure('public.alertas_evaluar(boolean)') is not null then
      begin
        perform alertas_evaluar(true);
      exception when others then null;   -- un problema con Teams no puede frenar la lectura
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
  return (select jsonb_build_object('activo', aviso_activo, 'sectores', aviso_sectores) from tickets_config where id = 1);
end $$;
revoke all on function public.helpdesk_aviso_ver() from public, anon;
grant execute on function public.helpdesk_aviso_ver() to authenticated;

create or replace function public.helpdesk_aviso_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  update tickets_config set
    aviso_activo = coalesce((p ->> 'activo')::boolean, aviso_activo),
    aviso_sectores = coalesce(nullif(trim(p ->> 'sectores'), ''), aviso_sectores)
  where id = 1;
end $$;
revoke all on function public.helpdesk_aviso_guardar(jsonb) from public, anon;
grant execute on function public.helpdesk_aviso_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Enganches: condiciones de alertas y exclusión de la integración alerta → ticket
-- ----------------------------------------------------------
do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_condiciones_extra()') is null then
    execute $f$
      create function public.alertas_condiciones_extra()
      returns void language plpgsql security definer set search_path = public as $b$
      begin
        null;
      end $b$;
    $f$;
    revoke all on function public.alertas_condiciones_extra() from public, anon, authenticated;
  end if;

  v_def := pg_get_functiondef('public.alertas_condiciones_extra()'::regprocedure);
  if position('helpdesk_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.helpdesk_condiciones_alertas()'') is not null then perform helpdesk_condiciones_alertas(); end if;\n');
    execute v_def;
  end if;

  if to_regprocedure('public.alertas_evaluar(boolean)') is not null then
    v_def := pg_get_functiondef('public.alertas_evaluar(boolean)'::regprocedure);
    if position('alertas_condiciones_extra' in v_def) = 0 and position('-- Abrir las nuevas' in v_def) > 0 then
      v_def := replace(v_def, '-- Abrir las nuevas',
        E'-- Condiciones de otros módulos\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
      execute v_def;
    end if;
  end if;

  -- Un aviso de ticket nuevo nunca debe abrir otro ticket
  if to_regprocedure('public.tickets_por_alerta()') is not null then
    v_def := pg_get_functiondef('public.tickets_por_alerta()'::regprocedure);
    if position('helpdesk_nuevo' in v_def) = 0 then
      v_def := regexp_replace(v_def, E'begin\\n',
        E'begin\n  if new.regla = ''helpdesk_nuevo'' then return new; end if;\n');
      execute v_def;
    end if;
  end if;
end $$;
