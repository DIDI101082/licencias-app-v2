-- ==========================================================
-- IDENTIDAD: SEGUIMIENTO DE MFA (quién se queda sin segundo factor)
--   * La tarea de cada 15 minutos (/api/entra/auto) lee de Entra ID el registro de MFA de cada
--     cuenta (solo lectura) y lo compara con la lectura anterior.
--   * Si una cuenta que tenía MFA deja de tenerlo, queda registrado el cambio (con los métodos
--     que tenía) y, si es una cuenta nominal o con rol de administrador, se avisa por Teams.
--     También se registra cuando una cuenta vuelve a registrar MFA.
--   * Cuenta NOMINAL = la de una persona: figura como empleado activo en Empleados
--     (por ID de Entra o por correo). Buzones compartidos, salas y cuentas de servicio no lo son.
-- Requiere en la app de Entra el permiso AuditLog.Read.All y licencia Entra ID P1 o P2
-- (lo mismo que ya usa la pantalla Identidad).
-- Ejecutar en el SQL Editor, DESPUÉS de identidad.sql, postura.sql y alertas.sql.
-- Se puede volver a ejecutar sin problema.
-- ==========================================================

create table if not exists public.identidad_mfa_config (
  id int primary key default 1 check (id = 1),
  alertar boolean not null default true,
  ultima_ejecucion timestamptz,
  ultimo_error text
);
insert into public.identidad_mfa_config (id) values (1) on conflict (id) do nothing;

-- Última lectura de cada cuenta
create table if not exists public.identidad_mfa (
  entra_id text primary key,
  upn text,
  nombre text,
  mfa boolean not null,
  metodos text[] not null default '{}',
  admin boolean not null default false,
  perdio timestamptz,                    -- cuándo se detectó que se quedó sin MFA (null si nunca lo perdió o ya lo recuperó)
  actualizado timestamptz not null default now()
);

create table if not exists public.identidad_mfa_eventos (
  id bigserial primary key,
  fecha timestamptz not null default now(),
  tipo text not null check (tipo in ('desactivado', 'activado')),
  entra_id text,
  upn text,
  nombre text,
  nominal boolean not null default false,
  admin boolean not null default false,
  metodos text[] not null default '{}'   -- desactivado: los que tenía; activado: los que registró
);
create index if not exists idx_identidad_mfa_eventos_fecha on public.identidad_mfa_eventos (fecha desc);

create or replace function public.identidad_es_nominal(p_entra_id text, p_upn text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from empleados e where e.activo and (e.entra_id = p_entra_id or lower(e.email) = lower(p_upn)))
$$;
revoke all on function public.identidad_es_nominal(text, text) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Tarea programada (se identifica con la clave CRON_SECRET)
-- ----------------------------------------------------------
create or replace function public.identidad_mfa_auto_aplicar(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u jsonb;
  a identidad_mfa;
  v_mfa boolean;
  v_metodos text[];
  v_primera boolean;
  n_off int := 0;
  n_on int := 0;
  n_alerta int := 0;
  v_nominal boolean;
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  -- Nunca aplicar con una respuesta vacía (marcaría a todos como sin MFA o los borraría)
  if jsonb_array_length(coalesce(p -> 'usuarios', '[]')) = 0 then
    raise exception 'Entra ID no devolvió el registro de MFA: no se aplicó ningún cambio';
  end if;
  v_primera := not exists (select 1 from identidad_mfa);

  for u in select * from jsonb_array_elements(p -> 'usuarios') loop
    v_mfa := coalesce((u ->> 'mfa')::boolean, false);
    v_metodos := array(select jsonb_array_elements_text(coalesce(u -> 'metodos', '[]')));
    select * into a from identidad_mfa where entra_id = u ->> 'id';
    if not found then
      -- Cuenta nueva (o primera lectura): se toma como punto de partida, sin registrar cambio
      insert into identidad_mfa (entra_id, upn, nombre, mfa, metodos, admin)
      values (u ->> 'id', u ->> 'upn', u ->> 'nombre', v_mfa, v_metodos, coalesce((u ->> 'admin')::boolean, false));
    else
      if a.mfa is distinct from v_mfa then
        v_nominal := identidad_es_nominal(u ->> 'id', u ->> 'upn');
        insert into identidad_mfa_eventos (tipo, entra_id, upn, nombre, nominal, admin, metodos)
        values (case when v_mfa then 'activado' else 'desactivado' end, u ->> 'id', u ->> 'upn', u ->> 'nombre', v_nominal,
                coalesce((u ->> 'admin')::boolean, false), case when v_mfa then v_metodos else a.metodos end);
        if v_mfa then n_on := n_on + 1;
        else
          n_off := n_off + 1;
          if v_nominal or coalesce((u ->> 'admin')::boolean, false) then n_alerta := n_alerta + 1; end if;
        end if;
      end if;
      update identidad_mfa set
        upn = u ->> 'upn', nombre = u ->> 'nombre', mfa = v_mfa, metodos = v_metodos,
        admin = coalesce((u ->> 'admin')::boolean, false),
        perdio = case when v_mfa then null when a.mfa then now() else perdio end,
        actualizado = now()
      where entra_id = u ->> 'id'
        and (a.mfa is distinct from v_mfa or a.metodos is distinct from v_metodos or a.upn is distinct from u ->> 'upn'
             or a.nombre is distinct from u ->> 'nombre' or a.admin is distinct from coalesce((u ->> 'admin')::boolean, false));
    end if;
  end loop;

  -- Cuentas que ya no existen en Entra ID
  delete from identidad_mfa
   where entra_id not in (select x ->> 'id' from jsonb_array_elements(p -> 'usuarios') x);
  delete from identidad_mfa_eventos where fecha < now() - interval '2 years';
  update identidad_mfa_config set ultima_ejecucion = now(), ultimo_error = null where id = 1;

  -- Alguien nominal o administrador se quedó sin MFA: avisar ya, sin esperar la revisión de cada 10 minutos
  if n_alerta > 0 and to_regprocedure('public.alertas_evaluar(boolean)') is not null then
    begin
      perform alertas_evaluar(true);
    exception when others then null;   -- un problema con Teams no puede frenar la lectura
    end;
  end if;
  return jsonb_build_object('cuentas', jsonb_array_length(p -> 'usuarios'), 'primera', v_primera, 'desactivados', n_off, 'activados', n_on);
end $$;
revoke all on function public.identidad_mfa_auto_aplicar(text, jsonb) from public, authenticated;
grant execute on function public.identidad_mfa_auto_aplicar(text, jsonb) to anon;

create or replace function public.identidad_mfa_auto_error(p_token text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  update identidad_mfa_config set ultima_ejecucion = now(), ultimo_error = left(p_error, 300) where id = 1;
end $$;
revoke all on function public.identidad_mfa_auto_error(text, text) from public, authenticated;
grant execute on function public.identidad_mfa_auto_error(text, text) to anon;

-- ----------------------------------------------------------
-- Pantalla (Identidad)
-- ----------------------------------------------------------
create or replace function public.identidad_mfa_estado() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c identidad_mfa_config;
begin
  if not puede_ver('seguridad') then raise exception 'Sin acceso'; end if;
  select * into c from identidad_mfa_config where id = 1;
  return jsonb_build_object(
    'alertar', c.alertar, 'ultima_ejecucion', c.ultima_ejecucion, 'ultimo_error', c.ultimo_error,
    'eventos', coalesce((select jsonb_agg(to_jsonb(e) order by e.fecha desc)
                           from (select * from identidad_mfa_eventos order by fecha desc limit 100) e), '[]'),
    -- para marcar en la pantalla qué cuentas son nominales
    'nominales_id', coalesce((select jsonb_agg(entra_id) from empleados where activo and entra_id is not null), '[]'),
    'nominales_email', coalesce((select jsonb_agg(lower(email)) from empleados where activo), '[]'));
end $$;
revoke all on function public.identidad_mfa_estado() from public, anon;
grant execute on function public.identidad_mfa_estado() to authenticated;

create or replace function public.identidad_mfa_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede cambiar esta configuración'; end if;
  update identidad_mfa_config set alertar = coalesce((p ->> 'alertar')::boolean, alertar) where id = 1;
end $$;
revoke all on function public.identidad_mfa_guardar(jsonb) from public, anon;
grant execute on function public.identidad_mfa_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas: cuenta nominal o administradora que se quedó sin MFA (queda abierta hasta que lo vuelva a registrar)
-- ----------------------------------------------------------
create or replace function public.identidad_mfa_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce((select alertar from identidad_mfa_config where id = 1), false) then return; end if;
  insert into _cond
  select 'mfa:perdio:' || m.entra_id, 'mfa', case when m.admin then 'critica' else 'alta' end,
         'Se quedó sin MFA: ' || coalesce(m.nombre, m.upn, '?'),
         concat_ws(' · ', m.upn, case when m.admin then 'tiene rol de administrador' end,
                   'detectado ' || to_char(m.perdio at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
         '/inventario/identidad'
    from identidad_mfa m
   where not m.mfa and m.perdio > now() - interval '30 days'
     and (m.admin or identidad_es_nominal(m.entra_id, m.upn))
  on conflict do nothing;
end $$;
revoke all on function public.identidad_mfa_condiciones_alertas() from public, anon, authenticated;

-- Engancha las condiciones en la lista de "otros módulos" sin pisar lo que ya existe
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
  if position('identidad_mfa_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.identidad_mfa_condiciones_alertas()'') is not null then perform identidad_mfa_condiciones_alertas(); end if;\n');
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
end $$;

-- ----------------------------------------------------------
-- Permisos: se leen solo con identidad_mfa_estado(); se escriben solo desde la tarea
-- ----------------------------------------------------------
alter table public.identidad_mfa_config enable row level security;
alter table public.identidad_mfa enable row level security;
alter table public.identidad_mfa_eventos enable row level security;
revoke all on public.identidad_mfa_config, public.identidad_mfa, public.identidad_mfa_eventos from anon, authenticated;
