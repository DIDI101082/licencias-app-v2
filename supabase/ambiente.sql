-- ==========================================================
-- Infraestructura → Temperatura y humedad (sensores de ambiente por SNMP, solo lectura)
--   * Pensado para el Xiolab Sense IP2G de la sala de servidores, pero sirve para cualquier sensor con SNMP.
--   * Como Xiolab no publica su MIB, el puente lee todo lo que el sensor ofrece por SNMP
--     (rama 1.3.6.1.4.1) y lo envía. En la app se elige qué valor es la temperatura y cuál la
--     humedad, comparando con lo que muestra la página web del sensor. Desde ahí se calculan solos.
--   * Una misma IP puede cargarse más de una vez (por ejemplo, dos sondas del mismo equipo),
--     cada una con sus propios valores elegidos.
--   * Alertas (arrancan apagadas): temperatura alta o crítica, temperatura baja, humedad fuera de
--     rango, sensor sin respuesta y puente caído. La temperatura crítica se avisa al instante.
-- Ejecutar UNA VEZ en el SQL Editor (después de alertas.sql).
-- ==========================================================

-- ----------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------
create table if not exists public.amb_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  version_puente text,
  alertas boolean not null default false,
  temp_max numeric not null default 27 check (temp_max between 10 and 60),       -- alta
  temp_critica numeric not null default 30 check (temp_critica between 10 and 70), -- crítica
  temp_min numeric not null default 15 check (temp_min between -10 and 40),
  hum_min numeric not null default 20 check (hum_min between 0 and 100),
  hum_max numeric not null default 70 check (hum_max between 0 and 100),
  minutos_sin_reporte int not null default 15 check (minutos_sin_reporte between 5 and 720)
);
insert into public.amb_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.amb_sensores (
  id serial primary key,
  nombre text not null check (length(trim(nombre)) > 0),
  ip text not null check (ip ~ '^[A-Za-z0-9.\-]+(:\d{1,5})?$'),
  ubicacion text,
  activo boolean not null default true,
  -- valores elegidos (OID completo y divisor: 1, 10 o 100)
  oid_temp text,
  escala_temp numeric not null default 1 check (escala_temp > 0),
  oid_hum text,
  escala_hum numeric not null default 1 check (escala_hum > 0),
  -- lo que informa el puente
  responde boolean,
  ultimo_ok timestamptz,
  ultimo_intento timestamptz,
  ultimo_error text,
  sys_descr text,
  version_snmp text,
  valores jsonb,                        -- OID → valor, todo lo numérico que publica el equipo
  temperatura numeric,
  humedad numeric,
  temp_estado text,                     -- normal, alta, critica, baja
  hum_estado text,                      -- normal, alta, baja
  temp_fuera_desde timestamptz,
  creado_en timestamptz not null default now()
);
create index if not exists idx_amb_sensores_ip on public.amb_sensores(ip);

create table if not exists public.amb_lecturas (
  sensor_id int not null references public.amb_sensores(id) on delete cascade,
  fecha timestamptz not null default now(),
  temperatura numeric,
  humedad numeric,
  primary key (sensor_id, fecha)
);

create table if not exists public.amb_eventos (
  id bigserial primary key,
  sensor_id int not null references public.amb_sensores(id) on delete cascade,
  tipo text not null check (tipo in ('temp_alta', 'temp_critica', 'temp_baja', 'temp_normal', 'hum_fuera', 'hum_normal', 'sin_respuesta', 'responde')),
  detalle text,
  fecha timestamptz not null default now()
);
create index if not exists idx_amb_eventos_fecha on public.amb_eventos(fecha desc);

-- Primer número de un texto ("23.5", "235", "23,5 C") dividido por la escala
create or replace function public.amb_valor(v text, escala numeric)
returns numeric language sql immutable as $$
  select case when m is null then null else round(replace(m[1], ',', '.')::numeric / nullif(escala, 0), 1) end
    from (select regexp_match(coalesce(v, ''), '(-?\d+(?:[.,]\d+)?)') as m) x
$$;

-- ----------------------------------------------------------
-- El puente pide las IPs a consultar (una vez cada una aunque tenga varios sensores)
-- ----------------------------------------------------------
create or replace function public.amb_objetivos(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_hash text;
begin
  select token_hash into v_hash from amb_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de temperatura inválido';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('ip', ip, 'version', version_snmp) order by ip)
                     from (select ip, max(version_snmp) as version_snmp from amb_sensores where activo group by ip) x), '[]'::jsonb);
end $$;
revoke all on function public.amb_objetivos(text) from public;
grant execute on function public.amb_objetivos(text) to anon, authenticated;

-- ----------------------------------------------------------
-- El puente envía lo que leyó de cada IP
-- ----------------------------------------------------------
create or replace function public.amb_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  c amb_config;
  v_ahora timestamptz := now();
  e jsonb; d jsonb;
  s amb_sensores;
  v_t numeric; v_h numeric; v_te text; v_he text;
  v_avisar boolean := false;
  n_ok int := 0; n_err int := 0;
begin
  select * into c from amb_config where id = 1;
  v_hash := c.token_hash;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de temperatura inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'equipos'), '') <> 'array' then raise exception 'Datos inválidos'; end if;

  for e in select * from jsonb_array_elements(p_datos -> 'equipos') loop
    for s in select * from amb_sensores where ip = e ->> 'ip' and activo loop
      if not coalesce((e ->> 'ok')::boolean, false) then
        if s.responde is distinct from false then
          insert into amb_eventos (sensor_id, tipo, detalle) values (s.id, 'sin_respuesta', left(e ->> 'error', 300));
        end if;
        update amb_sensores set responde = false, ultimo_intento = v_ahora, ultimo_error = left(e ->> 'error', 300) where id = s.id;
        n_err := n_err + 1;
        continue;
      end if;

      d := coalesce(e -> 'datos', '{}'::jsonb);
      v_t := case when s.oid_temp is not null then amb_valor(d ->> s.oid_temp, s.escala_temp) end;
      v_h := case when s.oid_hum is not null then amb_valor(d ->> s.oid_hum, s.escala_hum) end;
      v_te := case when v_t is null then null when v_t >= c.temp_critica then 'critica' when v_t >= c.temp_max then 'alta'
                   when v_t <= c.temp_min then 'baja' else 'normal' end;
      v_he := case when v_h is null then null when v_h > c.hum_max then 'alta' when v_h < c.hum_min then 'baja' else 'normal' end;

      if s.responde is false then insert into amb_eventos (sensor_id, tipo) values (s.id, 'responde'); end if;
      -- Cambios de estado de temperatura
      if v_te is not null and v_te is distinct from coalesce(s.temp_estado, 'normal') then
        insert into amb_eventos (sensor_id, tipo, detalle) values (s.id,
          case v_te when 'critica' then 'temp_critica' when 'alta' then 'temp_alta' when 'baja' then 'temp_baja' else 'temp_normal' end,
          v_t || ' °C');
        if v_te = 'critica' or (v_te = 'alta' and coalesce(s.temp_estado, 'normal') = 'normal') then v_avisar := true; end if;
      end if;
      if v_he is not null and v_he is distinct from coalesce(s.hum_estado, 'normal') then
        insert into amb_eventos (sensor_id, tipo, detalle) values (s.id, case when v_he = 'normal' then 'hum_normal' else 'hum_fuera' end, v_h || ' %');
      end if;

      update amb_sensores set responde = true, ultimo_ok = v_ahora, ultimo_intento = v_ahora, ultimo_error = null,
        sys_descr = left(coalesce(nullif(e ->> 'sys_descr', ''), sys_descr), 300), version_snmp = left(e ->> 'version', 5),
        valores = d, temperatura = v_t, humedad = v_h, temp_estado = v_te, hum_estado = v_he,
        temp_fuera_desde = case when v_te in ('alta', 'critica', 'baja') then coalesce(case when s.temp_estado in ('alta', 'critica', 'baja') then s.temp_fuera_desde end, v_ahora) end
      where id = s.id;

      if v_t is not null or v_h is not null then
        insert into amb_lecturas (sensor_id, fecha, temperatura, humedad) values (s.id, v_ahora, v_t, v_h) on conflict do nothing;
      end if;
      n_ok := n_ok + 1;
    end loop;
  end loop;

  update amb_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20) where id = 1;
  delete from amb_lecturas where fecha < v_ahora - interval '365 days';
  delete from amb_eventos where fecha < v_ahora - interval '2 years';

  -- Temperatura alta o crítica: avisar ya, sin esperar la revisión de cada 10 minutos
  if v_avisar and c.alertas and to_regprocedure('public.alertas_evaluar(boolean)') is not null then
    begin
      perform alertas_evaluar(true);
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'sensores_ok', n_ok, 'sensores_error', n_err);
end $$;
revoke all on function public.amb_reportar(text, jsonb) from public;
grant execute on function public.amb_reportar(text, jsonb) to anon, authenticated;

-- Historial por hora para el gráfico de cada sensor
create or replace function public.amb_historial(p_sensor int, p_dias int default 30)
returns table (hora timestamptz, temp_prom numeric, temp_max numeric, humedad numeric)
language sql stable security definer set search_path = public as $$
  select date_trunc('hour', fecha), round(avg(temperatura), 1), round(max(temperatura), 1), round(avg(humedad), 1)
    from amb_lecturas
   where puede_ver('servidores') and sensor_id = p_sensor and fecha > now() - make_interval(days => least(greatest(p_dias, 1), 365))
   group by 1 order by 1
$$;
revoke execute on function public.amb_historial(int, int) from public, anon;
grant execute on function public.amb_historial(int, int) to authenticated;

-- Elegir los valores de temperatura y humedad de un sensor (y recalcular con el último dato)
create or replace function public.amb_elegir(p_sensor int, p_oid_temp text, p_escala_temp numeric, p_oid_hum text, p_escala_hum numeric)
returns void language plpgsql security definer set search_path = public as $$
declare s amb_sensores;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  select * into s from amb_sensores where id = p_sensor;
  if not found then raise exception 'Sensor inexistente'; end if;
  update amb_sensores set
    oid_temp = nullif(trim(p_oid_temp), ''), escala_temp = coalesce(p_escala_temp, 1),
    oid_hum = nullif(trim(p_oid_hum), ''), escala_hum = coalesce(p_escala_hum, 1),
    temperatura = case when nullif(trim(p_oid_temp), '') is not null then amb_valor(s.valores ->> trim(p_oid_temp), coalesce(p_escala_temp, 1)) end,
    humedad = case when nullif(trim(p_oid_hum), '') is not null then amb_valor(s.valores ->> trim(p_oid_hum), coalesce(p_escala_hum, 1)) end,
    temp_estado = null, hum_estado = null, temp_fuera_desde = null
  where id = p_sensor;
end $$;
revoke execute on function public.amb_elegir(int, text, numeric, text, numeric) from public, anon;
grant execute on function public.amb_elegir(int, text, numeric, text, numeric) to authenticated;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.amb_config_ver()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('servidores') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'alertas', alertas, 'temp_max', temp_max, 'temp_critica', temp_critica, 'temp_min', temp_min,
    'hum_min', hum_min, 'hum_max', hum_max, 'minutos_sin_reporte', minutos_sin_reporte)
  end from amb_config where id = 1
$$;
revoke execute on function public.amb_config_ver() from public, anon;
grant execute on function public.amb_config_ver() to authenticated;

create or replace function public.amb_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update amb_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.amb_nuevo_puente(text) from public, anon;
grant execute on function public.amb_nuevo_puente(text) to authenticated;

create or replace function public.amb_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update amb_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    temp_max = coalesce((p ->> 'temp_max')::numeric, temp_max),
    temp_critica = coalesce((p ->> 'temp_critica')::numeric, temp_critica),
    temp_min = coalesce((p ->> 'temp_min')::numeric, temp_min),
    hum_min = coalesce((p ->> 'hum_min')::numeric, hum_min),
    hum_max = coalesce((p ->> 'hum_max')::numeric, hum_max),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte)
  where id = 1;
end $$;
revoke execute on function public.amb_config_guardar(jsonb) from public, anon;
grant execute on function public.amb_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.amb_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c amb_config;
begin
  select * into c from amb_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  if c.ultimo_reporte is null or c.ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte) then
    insert into _cond values ('amb:puente', 'ambiente', 'alta', 'El puente de temperatura dejó de reportar',
      coalesce('Último reporte ' || to_char(c.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'),
      '/servidores/ambiente')
    on conflict do nothing;
    return;
  end if;

  insert into _cond
  select 'amb:sin_respuesta:' || s.id, 'ambiente', 'alta', 'Sensor de temperatura sin respuesta: ' || s.nombre,
         concat_ws(' · ', s.ip, nullif(s.ubicacion, ''), s.ultimo_error), '/servidores/ambiente'
    from amb_sensores s where s.activo and s.responde = false
  on conflict do nothing;

  -- Temperatura (la clave incluye el nivel: si pasa de alta a crítica, llega un aviso nuevo)
  insert into _cond
  select 'amb:temp:' || s.id || ':' || s.temp_estado, 'ambiente',
         case s.temp_estado when 'critica' then 'critica' when 'alta' then 'alta' else 'media' end,
         case s.temp_estado when 'baja' then 'Temperatura baja: ' when 'critica' then 'Temperatura CRÍTICA: ' else 'Temperatura alta: ' end || s.nombre || ' (' || s.temperatura || ' °C)',
         concat_ws(' · ', 'Desde ' || to_char(s.temp_fuera_desde at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'),
                   case s.temp_estado when 'critica' then 'crítica desde ' || c.temp_critica || ' °C' when 'alta' then 'máximo ' || c.temp_max || ' °C' else 'mínimo ' || c.temp_min || ' °C' end,
                   case when s.temp_estado in ('alta', 'critica') then 'revisar el aire acondicionado' end, nullif(s.ubicacion, '')),
         '/servidores/ambiente'
    from amb_sensores s where s.activo and s.responde and s.temp_estado in ('alta', 'critica', 'baja')
  on conflict do nothing;

  -- Humedad
  insert into _cond
  select 'amb:hum:' || s.id, 'ambiente', 'media',
         'Humedad ' || case s.hum_estado when 'alta' then 'alta' else 'baja' end || ': ' || s.nombre || ' (' || s.humedad || ' %)',
         'Rango aceptado ' || c.hum_min || ' a ' || c.hum_max || ' %' || case s.hum_estado when 'alta' then ' · riesgo de condensación' else ' · riesgo de electricidad estática' end,
         '/servidores/ambiente'
    from amb_sensores s where s.activo and s.responde and s.hum_estado in ('alta', 'baja')
  on conflict do nothing;
end $$;
revoke all on function public.amb_condiciones_alertas() from public, anon, authenticated;

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
  if position('amb_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.amb_condiciones_alertas()'') is not null then perform amb_condiciones_alertas(); end if;\n');
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
-- Permisos: se ve con la solapa Servidores; los sensores los carga un administrador
-- ----------------------------------------------------------
alter table public.amb_config enable row level security;
alter table public.amb_sensores enable row level security;
alter table public.amb_lecturas enable row level security;
alter table public.amb_eventos enable row level security;

revoke all on public.amb_config from anon, authenticated;

drop policy if exists amb_sensores_select on public.amb_sensores;
create policy amb_sensores_select on public.amb_sensores for select to authenticated using (puede_ver('servidores'));
drop policy if exists amb_sensores_admin on public.amb_sensores;
create policy amb_sensores_admin on public.amb_sensores for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('servidores')) with check (mi_rol() = 'administrador' and puede_ver('servidores'));
grant select, insert, update, delete on public.amb_sensores to authenticated;
grant usage on sequence public.amb_sensores_id_seq to authenticated;

drop policy if exists amb_lecturas_select on public.amb_lecturas;
create policy amb_lecturas_select on public.amb_lecturas for select to authenticated using (puede_ver('servidores'));
drop policy if exists amb_eventos_select on public.amb_eventos;
create policy amb_eventos_select on public.amb_eventos for select to authenticated using (puede_ver('servidores'));
revoke insert, update, delete on public.amb_lecturas, public.amb_eventos from anon, authenticated;
grant select on public.amb_lecturas, public.amb_eventos to authenticated;

do $$
declare t text;
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  foreach t in array array['amb_config', 'amb_sensores'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
