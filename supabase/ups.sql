-- ==========================================================
-- Infraestructura → UPS (SNMP v2c, solo lectura, MIB estándar UPS-MIB / RFC 1628)
--   * Un puente en un servidor interno consulta por SNMP las UPS cargadas en la app
--     (Emerson/Vertiv Liebert con placa Intellislot SIC, y cualquier marca que publique la UPS-MIB)
--     y envía los valores tal cual. La interpretación se hace acá: si hiciera falta corregir algo
--     se cambia este SQL sin reinstalar el puente.
--   * Guarda el estado de cada UPS, un historial de lecturas y los eventos: paso a batería,
--     vuelta de la red, batería baja, alarmas y UPS sin respuesta.
--   * Alertas (arrancan apagadas): UPS en batería, batería baja o poca autonomía, carga alta,
--     temperatura alta, batería a reemplazar, alarmas de la UPS, sin respuesta y puente caído.
-- Ejecutar UNA VEZ en el SQL Editor (después de alertas.sql).
-- ==========================================================

-- ----------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------
create table if not exists public.ups_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  version_puente text,
  alertas boolean not null default false,
  autonomia_minima int not null default 10 check (autonomia_minima between 1 and 600),
  carga_maxima int not null default 80 check (carga_maxima between 10 and 100),
  temp_maxima int not null default 40 check (temp_maxima between 15 and 80),
  minutos_sin_reporte int not null default 15 check (minutos_sin_reporte between 5 and 720)
);
insert into public.ups_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.ups_equipos (
  id serial primary key,
  nombre text not null check (length(trim(nombre)) > 0),
  ip text not null unique check (ip ~ '^[A-Za-z0-9.\-]+(:\d{1,5})?$'),
  ubicacion text,
  notas text,
  activo boolean not null default true,
  -- lo que informa el puente
  responde boolean,
  ultimo_ok timestamptz,
  ultimo_intento timestamptz,
  ultimo_error text,
  datos jsonb,                          -- valores SNMP sin interpretar (sufijo de OID → valor)
  fabricante text,
  modelo text,
  firmware text,
  estado_bateria int,                   -- 1 desconocido, 2 normal, 3 baja, 4 agotada
  carga_bateria numeric,                -- %
  autonomia_min numeric,
  segundos_en_bateria numeric,
  voltaje_bateria numeric,
  temp_bateria numeric,
  entrada_v numeric,
  entrada_hz numeric,
  salida_v numeric,
  salida_hz numeric,
  carga_pct numeric,                    -- la fase más cargada
  fuente_salida int,                    -- 3 normal, 4 bypass, 5 batería, 6 elevador, 7 reductor
  alarmas int[] not null default '{}',  -- códigos de alarma estándar (1 a 24)
  resultado_test int,
  en_bateria boolean,
  en_bateria_desde timestamptz,
  creado_en timestamptz not null default now()
);

create table if not exists public.ups_lecturas (
  ups_id int not null references public.ups_equipos(id) on delete cascade,
  fecha timestamptz not null default now(),
  carga_bateria numeric,
  autonomia_min numeric,
  carga_pct numeric,
  entrada_v numeric,
  temp_bateria numeric,
  en_bateria boolean,
  primary key (ups_id, fecha)
);

create table if not exists public.ups_eventos (
  id bigserial primary key,
  ups_id int not null references public.ups_equipos(id) on delete cascade,
  tipo text not null check (tipo in ('en_bateria', 'vuelve_red', 'bateria_baja', 'alarma', 'alarma_fin', 'sin_respuesta', 'responde')),
  detalle text,
  fecha timestamptz not null default now()
);
create index if not exists idx_ups_eventos_fecha on public.ups_eventos(fecha desc);

-- Nombres de las alarmas estándar de la UPS-MIB (1.3.6.1.2.1.33.1.6.3.N)
create or replace function public.ups_alarma_nombre(n int)
returns text language sql immutable as $$
  select (array['Batería defectuosa (reemplazar)', 'En batería', 'Batería baja', 'Batería agotada', 'Temperatura fuera de rango',
                'Entrada de red fuera de rango', 'Salida fuera de rango', 'Sobrecarga en la salida', 'En bypass', 'Falla de bypass',
                'Salida apagada a pedido', 'UPS apagada a pedido', 'Falla del cargador', 'Salida apagada', 'Sistema apagado',
                'Falla de ventilador', 'Fusible quemado', 'Falla general', 'Falló el test de diagnóstico', 'Comunicación perdida',
                'Esperando energía', 'Apagado pendiente', 'Apagado inminente', 'Test en curso'])[n]
$$;

-- Lectura de un valor numérico del SNMP (sufijo relativo a 1.3.6.1.2.1.33.1)
create or replace function public.ups_num(d jsonb, k text)
returns numeric language sql immutable as $$
  select case when (d ->> k) ~ '^-?\d+(\.\d+)?$' then (d ->> k)::numeric end
$$;

-- ----------------------------------------------------------
-- El puente pide la lista de UPS a consultar
-- ----------------------------------------------------------
create or replace function public.ups_objetivos(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_hash text;
begin
  select token_hash into v_hash from ups_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de UPS inválido';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ip', ip) order by id) from ups_equipos where activo), '[]'::jsonb);
end $$;
revoke all on function public.ups_objetivos(text) from public;
grant execute on function public.ups_objetivos(text) to anon, authenticated;

-- ----------------------------------------------------------
-- El puente envía lo que leyó
-- ----------------------------------------------------------
create or replace function public.ups_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  v_ahora timestamptz := now();
  s jsonb; d jsonb;
  u ups_equipos;
  v_alarmas int[]; v_nuevas int[]; v_fin int[];
  v_estado int; v_carga numeric; v_aut numeric; v_seg numeric; v_vbat numeric; v_temp numeric;
  v_in_v numeric; v_in_hz numeric; v_out_v numeric; v_out_hz numeric; v_load numeric;
  v_fuente int; v_test int; v_bat boolean;
  v_avisar boolean := false;
  n_ok int := 0; n_err int := 0;
begin
  select token_hash into v_hash from ups_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de UPS inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'ups'), '') <> 'array' then raise exception 'Datos inválidos'; end if;

  for s in select * from jsonb_array_elements(p_datos -> 'ups') loop
    select * into u from ups_equipos where id = (s ->> 'id')::int and activo;
    continue when not found;

    if not coalesce((s ->> 'ok')::boolean, false) then
      if u.responde is distinct from false then
        insert into ups_eventos (ups_id, tipo, detalle) values (u.id, 'sin_respuesta', left(s ->> 'error', 300));
      end if;
      update ups_equipos set responde = false, ultimo_intento = v_ahora, ultimo_error = left(s ->> 'error', 300) where id = u.id;
      n_err := n_err + 1;
      continue;
    end if;

    d := coalesce(s -> 'datos', '{}'::jsonb);
    v_estado := ups_num(d, '2.1.0')::int;
    v_seg    := ups_num(d, '2.2.0');
    v_aut    := ups_num(d, '2.3.0');
    v_carga  := ups_num(d, '2.4.0');
    v_vbat   := round(ups_num(d, '2.5.0') / 10, 1);
    v_temp   := ups_num(d, '2.7.0');
    v_in_hz  := round(ups_num(d, '3.3.1.2.1') / 10, 1);
    v_in_v   := ups_num(d, '3.3.1.3.1');
    v_fuente := ups_num(d, '4.1.0')::int;
    v_out_hz := round(ups_num(d, '4.2.0') / 10, 1);
    v_out_v  := ups_num(d, '4.4.1.2.1');
    v_test   := ups_num(d, '7.3.0')::int;
    -- Carga: la fase de salida más cargada
    select max(ups_num(d, k)) into v_load from jsonb_object_keys(d) k where k like '4.4.1.5.%';
    -- Alarmas presentes: cada fila de la tabla trae el OID de la alarma estándar (…33.1.6.3.N)
    select coalesce(array_agg(distinct (regexp_match(d ->> k, '33\.1\.6\.3\.(\d+)$'))[1]::int order by (regexp_match(d ->> k, '33\.1\.6\.3\.(\d+)$'))[1]::int), '{}')
      into v_alarmas
      from jsonb_object_keys(d) k where k like '6.2.1.2.%' and (d ->> k) ~ '33\.1\.6\.3\.\d+$';

    v_bat := v_fuente = 5 or 2 = any(v_alarmas) or coalesce(v_seg, 0) > 0;

    -- Eventos
    if u.responde is false then insert into ups_eventos (ups_id, tipo) values (u.id, 'responde'); end if;
    if v_bat and u.en_bateria is distinct from true then
      insert into ups_eventos (ups_id, tipo, detalle) values (u.id, 'en_bateria',
        concat_ws(' · ', 'Entrada ' || coalesce(v_in_v::text, '?') || ' V', 'batería ' || coalesce(v_carga::text, '?') || '%', 'autonomía ' || coalesce(v_aut::text, '?') || ' min'));
      v_avisar := true;
    elsif not v_bat and u.en_bateria then
      insert into ups_eventos (ups_id, tipo, detalle) values (u.id, 'vuelve_red', 'Estuvo en batería ' || coalesce(to_char(v_ahora - u.en_bateria_desde, 'HH24:MI'), '?') || ' h');
      v_avisar := true;
    end if;
    if v_estado in (3, 4) and coalesce(u.estado_bateria, 2) not in (3, 4) then
      insert into ups_eventos (ups_id, tipo, detalle) values (u.id, 'bateria_baja', 'Batería ' || coalesce(v_carga::text, '?') || '%, autonomía ' || coalesce(v_aut::text, '?') || ' min');
      v_avisar := true;
    end if;
    v_nuevas := array(select x from unnest(v_alarmas) x where x not in (2, 24) and not x = any(u.alarmas));
    v_fin := array(select x from unnest(u.alarmas) x where x not in (2, 24) and not x = any(v_alarmas));
    if u.responde is not null and cardinality(v_nuevas) > 0 then
      insert into ups_eventos (ups_id, tipo, detalle) values (u.id, 'alarma', (select string_agg(ups_alarma_nombre(x), ', ') from unnest(v_nuevas) x));
    end if;
    if cardinality(v_fin) > 0 then
      insert into ups_eventos (ups_id, tipo, detalle) values (u.id, 'alarma_fin', (select string_agg(ups_alarma_nombre(x), ', ') from unnest(v_fin) x));
    end if;

    update ups_equipos set responde = true, ultimo_ok = v_ahora, ultimo_intento = v_ahora, ultimo_error = null, datos = d,
      fabricante = left(coalesce(nullif(d ->> '1.1.0', ''), fabricante), 100), modelo = left(coalesce(nullif(d ->> '1.2.0', ''), modelo), 100),
      firmware = left(coalesce(nullif(concat_ws(' / ', nullif(d ->> '1.3.0', ''), nullif(d ->> '1.4.0', '')), ''), firmware), 150),
      estado_bateria = v_estado, carga_bateria = v_carga, autonomia_min = v_aut, segundos_en_bateria = v_seg,
      voltaje_bateria = v_vbat, temp_bateria = v_temp, entrada_v = v_in_v, entrada_hz = v_in_hz, salida_v = v_out_v,
      salida_hz = v_out_hz, carga_pct = v_load, fuente_salida = v_fuente, alarmas = v_alarmas, resultado_test = v_test,
      en_bateria = v_bat,
      en_bateria_desde = case when v_bat then coalesce(case when u.en_bateria then u.en_bateria_desde end, v_ahora) end
    where id = u.id;

    insert into ups_lecturas (ups_id, fecha, carga_bateria, autonomia_min, carga_pct, entrada_v, temp_bateria, en_bateria)
    values (u.id, v_ahora, v_carga, v_aut, v_load, v_in_v, v_temp, v_bat) on conflict do nothing;
    n_ok := n_ok + 1;
  end loop;

  update ups_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20) where id = 1;
  delete from ups_lecturas where fecha < v_ahora - interval '180 days';
  delete from ups_eventos where fecha < v_ahora - interval '2 years';

  -- Paso a batería, vuelta de la red o batería baja: avisar ya, sin esperar la revisión de cada 10 minutos
  if v_avisar and to_regprocedure('public.alertas_evaluar(boolean)') is not null then
    begin
      perform alertas_evaluar(true);
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'ups_ok', n_ok, 'ups_error', n_err);
end $$;
revoke all on function public.ups_reportar(text, jsonb) from public;
grant execute on function public.ups_reportar(text, jsonb) to anon, authenticated;

-- Historial por hora para el gráfico de cada UPS
create or replace function public.ups_historial(p_ups int, p_dias int default 30)
returns table (hora timestamptz, carga_bateria numeric, carga_pct numeric, entrada_v numeric, en_bateria boolean)
language sql stable security definer set search_path = public as $$
  select date_trunc('hour', fecha), round(min(carga_bateria), 1), round(max(carga_pct), 1), round(avg(entrada_v)), bool_or(en_bateria)
    from ups_lecturas
   where puede_ver('servidores') and ups_id = p_ups and fecha > now() - make_interval(days => least(greatest(p_dias, 1), 180))
   group by 1 order by 1
$$;
revoke execute on function public.ups_historial(int, int) from public, anon;
grant execute on function public.ups_historial(int, int) to authenticated;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.ups_config_ver()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('servidores') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'alertas', alertas, 'autonomia_minima', autonomia_minima, 'carga_maxima', carga_maxima,
    'temp_maxima', temp_maxima, 'minutos_sin_reporte', minutos_sin_reporte)
  end from ups_config where id = 1
$$;
revoke execute on function public.ups_config_ver() from public, anon;
grant execute on function public.ups_config_ver() to authenticated;

create or replace function public.ups_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update ups_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.ups_nuevo_puente(text) from public, anon;
grant execute on function public.ups_nuevo_puente(text) to authenticated;

create or replace function public.ups_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update ups_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    autonomia_minima = coalesce((p ->> 'autonomia_minima')::int, autonomia_minima),
    carga_maxima = coalesce((p ->> 'carga_maxima')::int, carga_maxima),
    temp_maxima = coalesce((p ->> 'temp_maxima')::int, temp_maxima),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte)
  where id = 1;
end $$;
revoke execute on function public.ups_config_guardar(jsonb) from public, anon;
grant execute on function public.ups_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.ups_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c ups_config;
begin
  select * into c from ups_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  if c.ultimo_reporte is null or c.ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte) then
    insert into _cond values ('ups:puente', 'ups', 'alta', 'El puente de UPS dejó de reportar',
      coalesce('Último reporte ' || to_char(c.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'),
      '/servidores/ups')
    on conflict do nothing;
    return;
  end if;

  -- Sin respuesta
  insert into _cond
  select 'ups:sin_respuesta:' || u.id, 'ups', 'critica', 'UPS sin respuesta: ' || u.nombre,
         concat_ws(' · ', u.ip, nullif(u.ubicacion, ''), u.ultimo_error, 'último dato ' || to_char(u.ultimo_ok at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
         '/servidores/ups'
    from ups_equipos u where u.activo and u.responde = false
  on conflict do nothing;

  -- En batería
  insert into _cond
  select 'ups:bateria:' || u.id || ':' || to_char(u.en_bateria_desde, 'YYYYMMDDHH24MI'), 'ups', 'critica', 'UPS en batería: ' || u.nombre,
         concat_ws(' · ', 'Desde ' || to_char(u.en_bateria_desde at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'),
                   'batería ' || round(u.carga_bateria) || '%', 'autonomía ' || round(u.autonomia_min) || ' min', nullif(u.ubicacion, '')),
         '/servidores/ups'
    from ups_equipos u where u.activo and u.responde and u.en_bateria
  on conflict do nothing;

  -- Batería baja o poca autonomía (estando en batería, o batería informada como baja)
  insert into _cond
  select 'ups:baja:' || u.id, 'ups', 'critica', 'UPS con batería baja: ' || u.nombre,
         concat_ws(' · ', 'Batería ' || round(u.carga_bateria) || '%', 'autonomía ' || round(u.autonomia_min) || ' min', 'mínimo ' || c.autonomia_minima || ' min'),
         '/servidores/ups'
    from ups_equipos u
   where u.activo and u.responde and (u.estado_bateria in (3, 4) or (u.en_bateria and u.autonomia_min < c.autonomia_minima))
  on conflict do nothing;

  -- Poca autonomía con red (la batería ya no aguanta lo que debería)
  insert into _cond
  select 'ups:autonomia:' || u.id, 'ups', 'alta', 'UPS con poca autonomía: ' || u.nombre,
         round(u.autonomia_min) || ' min con la carga actual (' || round(u.carga_pct) || '%) · mínimo ' || c.autonomia_minima || ' min',
         '/servidores/ups'
    from ups_equipos u
   where u.activo and u.responde and not u.en_bateria and u.carga_bateria >= 95 and u.autonomia_min < c.autonomia_minima
  on conflict do nothing;

  -- Carga alta
  insert into _cond
  select 'ups:carga:' || u.id, 'ups', 'alta', 'UPS con carga alta: ' || u.nombre,
         round(u.carga_pct) || '% · máximo ' || c.carga_maxima || '% · si se corta la luz dura menos', '/servidores/ups'
    from ups_equipos u where u.activo and u.responde and u.carga_pct >= c.carga_maxima
  on conflict do nothing;

  -- Temperatura de batería
  insert into _cond
  select 'ups:temp:' || u.id, 'ups', 'alta', 'UPS con temperatura alta: ' || u.nombre,
         u.temp_bateria || ' °C · máximo ' || c.temp_maxima || ' °C · revisar la ventilación del rack', '/servidores/ups'
    from ups_equipos u where u.activo and u.responde and u.temp_bateria >= c.temp_maxima
  on conflict do nothing;

  -- Alarmas de la UPS (sin contar "en batería" ni "test en curso", que ya se avisan aparte)
  insert into _cond
  select 'ups:alarma:' || u.id || ':' || a, 'ups',
         case when a in (1, 4, 7, 8, 10, 13, 17, 18, 23) then 'critica' else 'alta' end,
         case when u.nombre ~* '^ups' then '' else 'UPS ' end || u.nombre || ': ' || ups_alarma_nombre(a), concat_ws(' · ', u.ip, nullif(u.ubicacion, '')), '/servidores/ups'
    from ups_equipos u, unnest(u.alarmas) a
   where u.activo and u.responde and a not in (2, 3, 24)
  on conflict do nothing;

  -- En bypass (la carga queda sin protección)
  insert into _cond
  select 'ups:bypass:' || u.id, 'ups', 'critica', 'UPS en bypass: ' || u.nombre,
         'La carga está conectada directo a la red, sin protección de la UPS', '/servidores/ups'
    from ups_equipos u where u.activo and u.responde and u.fuente_salida = 4 and not (9 = any(u.alarmas))
  on conflict do nothing;
end $$;
revoke all on function public.ups_condiciones_alertas() from public, anon, authenticated;

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
  if position('ups_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.ups_condiciones_alertas()'') is not null then perform ups_condiciones_alertas(); end if;\n');
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
-- Permisos: se ve con la solapa Servidores; las UPS las carga un administrador
-- ----------------------------------------------------------
alter table public.ups_config enable row level security;
alter table public.ups_equipos enable row level security;
alter table public.ups_lecturas enable row level security;
alter table public.ups_eventos enable row level security;

revoke all on public.ups_config from anon, authenticated;

drop policy if exists ups_equipos_select on public.ups_equipos;
create policy ups_equipos_select on public.ups_equipos for select to authenticated using (puede_ver('servidores'));
drop policy if exists ups_equipos_admin on public.ups_equipos;
create policy ups_equipos_admin on public.ups_equipos for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('servidores')) with check (mi_rol() = 'administrador' and puede_ver('servidores'));
grant select, insert, update, delete on public.ups_equipos to authenticated;
grant usage on sequence public.ups_equipos_id_seq to authenticated;

drop policy if exists ups_lecturas_select on public.ups_lecturas;
create policy ups_lecturas_select on public.ups_lecturas for select to authenticated using (puede_ver('servidores'));
drop policy if exists ups_eventos_select on public.ups_eventos;
create policy ups_eventos_select on public.ups_eventos for select to authenticated using (puede_ver('servidores'));
revoke insert, update, delete on public.ups_lecturas, public.ups_eventos from anon, authenticated;
grant select on public.ups_lecturas, public.ups_eventos to authenticated;

do $$
declare t text;
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  foreach t in array array['ups_config', 'ups_equipos'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
