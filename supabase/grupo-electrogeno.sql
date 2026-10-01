-- ==========================================================
-- Infraestructura → Grupo electrógeno (DSE4520 MKII + DSE855, Modbus TCP, solo lectura)
--   * Un puente en un servidor interno lee el controlador por Modbus TCP cada pocos minutos
--     y envía los registros tal cual (GenComm de Deep Sea). La interpretación se hace acá,
--     así que si hubiera que corregir un registro se cambia este SQL sin reinstalar el puente.
--   * Guarda el estado actual, un historial de lecturas (para ver el consumo de combustible)
--     y los eventos: corte y vuelta de la red, arranque y parada del grupo, cambio de modo.
--   * Alertas (arrancan apagadas): corte de red, grupo en marcha, grupo fuera de automático,
--     combustible bajo, batería baja, grupo sin respuesta y puente sin reportar.
-- Ejecutar UNA VEZ en el SQL Editor (después de alertas.sql).
-- ==========================================================

-- ----------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------
create table if not exists public.ge_config (
  id int primary key default 1 check (id = 1),
  nombre text not null default 'Grupo electrógeno',
  token_hash text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  version_puente text,
  ip text,
  alertas boolean not null default false,
  alertar_en_marcha boolean not null default true,
  combustible_minimo int not null default 40 check (combustible_minimo between 5 and 95),
  bateria_minima numeric not null default 11.8 check (bateria_minima between 5 and 30),
  minutos_sin_reporte int not null default 15 check (minutos_sin_reporte between 5 and 720),
  litros_tanque int check (litros_tanque between 1 and 100000)
);
insert into public.ge_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.ge_estado (
  id int primary key default 1 check (id = 1),
  responde boolean,
  ultimo_ok timestamptz,
  ultimo_intento timestamptz,
  ultimo_error text,
  registros jsonb,                     -- lo que mandó el puente, sin interpretar
  modo int,                            -- 0 Stop, 1 Auto, 2 Manual, 3 Prueba con carga, 4 Auto con restauración manual, 7 Off
  flags int,
  combustible_pct numeric,
  bateria_v numeric,
  alternador_v numeric,
  rpm numeric,
  temp_refrigerante numeric,
  presion_aceite numeric,
  gen_hz numeric,
  gen_v1 numeric, gen_v2 numeric, gen_v3 numeric,
  red_hz numeric,
  red_v1 numeric, red_v2 numeric, red_v3 numeric,
  kw numeric,
  horas_motor numeric,
  arranques int,
  en_marcha boolean,
  red_ok boolean,
  en_marcha_desde timestamptz,
  red_cortada_desde timestamptz
);
insert into public.ge_estado (id) values (1) on conflict (id) do nothing;

create table if not exists public.ge_lecturas (
  fecha timestamptz primary key default now(),
  combustible_pct numeric,
  bateria_v numeric,
  rpm numeric,
  kw numeric,
  red_ok boolean,
  en_marcha boolean
);

create table if not exists public.ge_eventos (
  id bigserial primary key,
  tipo text not null check (tipo in ('corte_red', 'vuelve_red', 'arranque', 'parada', 'modo', 'sin_respuesta', 'responde')),
  detalle text,
  fecha timestamptz not null default now()
);
create index if not exists idx_ge_eventos_fecha on public.ge_eventos(fecha desc);

-- ----------------------------------------------------------
-- Lectura de registros GenComm (página * 256 + desplazamiento)
-- Valores fuera de rango (sensor ausente o sin medición) quedan en null.
-- ----------------------------------------------------------
create or replace function public.ge_u16(r jsonb, a int)
returns numeric language sql immutable as $$
  select case when (r ->> a::text) ~ '^\d+$' and (r ->> a::text)::numeric < 65530 then (r ->> a::text)::numeric end
$$;
create or replace function public.ge_s16(r jsonb, a int)
returns numeric language sql immutable as $$
  select case when v is null then null when v between 32762 and 32767 or v >= 65530 then null
              when v >= 32768 then v - 65536 else v end
    from (select case when (r ->> a::text) ~ '^\d+$' then (r ->> a::text)::numeric end as v) x
$$;
create or replace function public.ge_u32(r jsonb, a int)
returns numeric language sql immutable as $$
  select case when (r ->> a::text) ~ '^\d+$' and (r ->> (a + 1)::text) ~ '^\d+$'
              and (r ->> a::text)::numeric < 65535
         then (r ->> a::text)::numeric * 65536 + (r ->> (a + 1)::text)::numeric end
$$;
create or replace function public.ge_s32(r jsonb, a int)
returns numeric language sql immutable as $$
  select case when v is null then null when v >= 2147483648 then (case when v < 4294967290 then v - 4294967296 end) else v end
    from (select case when (r ->> a::text) ~ '^\d+$' and (r ->> (a + 1)::text) ~ '^\d+$'
                      then (r ->> a::text)::numeric * 65536 + (r ->> (a + 1)::text)::numeric end as v) x
$$;

-- ----------------------------------------------------------
-- El puente envía lo que leyó
-- ----------------------------------------------------------
create or replace function public.ge_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  v_ahora timestamptz := now();
  v_ant ge_estado;
  r jsonb;
  v_modo int; v_flags int;
  v_comb numeric; v_bat numeric; v_alt numeric; v_rpm numeric; v_temp numeric; v_aceite numeric;
  v_ghz numeric; v_g1 numeric; v_g2 numeric; v_g3 numeric;
  v_rhz numeric; v_r1 numeric; v_r2 numeric; v_r3 numeric;
  v_kw numeric; v_horas numeric; v_arr numeric;
  v_marcha boolean; v_red boolean;
  v_modos text[] := array['Stop', 'Automático', 'Manual', 'Prueba con carga', 'Automático con restauración manual', 'Configuración', 'Prueba sin carga', 'Off'];
begin
  select token_hash into v_hash from ge_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente del grupo electrógeno inválido';
  end if;
  select * into v_ant from ge_estado where id = 1;
  update ge_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20),
                       ip = coalesce(left(p_datos ->> 'ip', 60), ip) where id = 1;

  -- No respondió
  if not coalesce((p_datos ->> 'ok')::boolean, false) then
    if v_ant.responde is distinct from false then
      insert into ge_eventos (tipo, detalle) values ('sin_respuesta', left(p_datos ->> 'error', 300));
    end if;
    update ge_estado set responde = false, ultimo_intento = v_ahora, ultimo_error = left(p_datos ->> 'error', 300) where id = 1;
    return jsonb_build_object('ok', true, 'responde', false);
  end if;

  r := coalesce(p_datos -> 'registros', '{}'::jsonb);
  -- Página 3: modo de control y estado
  v_modo   := ge_u16(r, 772)::int;
  v_flags  := ge_u16(r, 774)::int;
  -- Página 4: instrumentos del motor, generador y red
  v_aceite := ge_u16(r, 1024);
  v_temp   := ge_s16(r, 1025);
  v_comb   := ge_u16(r, 1027);
  v_alt    := round(ge_u16(r, 1028) / 10, 1);
  v_bat    := round(ge_u16(r, 1029) / 10, 1);
  v_rpm    := ge_u16(r, 1030);
  v_ghz    := round(ge_u16(r, 1031) / 10, 1);
  v_g1     := round(ge_u32(r, 1032) / 10, 1);
  v_g2     := round(ge_u32(r, 1034) / 10, 1);
  v_g3     := round(ge_u32(r, 1036) / 10, 1);
  v_rhz    := round(ge_u16(r, 1059) / 10, 1);
  v_r1     := round(ge_u32(r, 1060) / 10, 1);
  v_r2     := round(ge_u32(r, 1062) / 10, 1);
  v_r3     := round(ge_u32(r, 1064) / 10, 1);
  -- Página 6: potencia total del generador (W). Página 7: acumulados
  v_kw     := round(ge_s32(r, 1536) / 1000, 1);
  v_horas  := round(ge_u32(r, 1798) / 3600, 1);
  v_arr    := ge_u32(r, 1808);

  v_marcha := coalesce(v_rpm, 0) > 300 or coalesce(v_ghz, 0) > 20;
  v_red    := coalesce(v_rhz, 0) > 40 and greatest(coalesce(v_r1, 0), coalesce(v_r2, 0), coalesce(v_r3, 0)) > 150;

  -- Eventos por cambio de estado
  if v_ant.responde is false then insert into ge_eventos (tipo) values ('responde'); end if;
  if v_ant.red_ok is true and not v_red then
    insert into ge_eventos (tipo, detalle) values ('corte_red', 'Red ' || coalesce(round(v_r1)::text, '0') || ' V / ' || coalesce(v_rhz::text, '0') || ' Hz');
  elsif v_ant.red_ok is false and v_red then
    insert into ge_eventos (tipo, detalle) values ('vuelve_red', 'Sin red durante ' || coalesce(to_char(v_ahora - v_ant.red_cortada_desde, 'HH24:MI'), '?') || ' h');
  end if;
  if v_ant.en_marcha is false and v_marcha then
    insert into ge_eventos (tipo, detalle) values ('arranque', concat_ws(' · ', case when not v_red then 'Por corte de red' end, 'Modo ' || coalesce(v_modos[v_modo + 1], v_modo::text)));
  elsif v_ant.en_marcha is true and not v_marcha then
    insert into ge_eventos (tipo, detalle) values ('parada', 'Funcionó ' || coalesce(to_char(v_ahora - v_ant.en_marcha_desde, 'HH24:MI'), '?') || ' h');
  end if;
  if v_ant.modo is not null and v_modo is not null and v_ant.modo <> v_modo then
    insert into ge_eventos (tipo, detalle) values ('modo', coalesce(v_modos[v_ant.modo + 1], v_ant.modo::text) || ' → ' || coalesce(v_modos[v_modo + 1], v_modo::text));
  end if;

  update ge_estado set responde = true, ultimo_ok = v_ahora, ultimo_intento = v_ahora, ultimo_error = null, registros = r,
    modo = v_modo, flags = v_flags, combustible_pct = v_comb, bateria_v = v_bat, alternador_v = v_alt, rpm = v_rpm,
    temp_refrigerante = v_temp, presion_aceite = v_aceite, gen_hz = v_ghz, gen_v1 = v_g1, gen_v2 = v_g2, gen_v3 = v_g3,
    red_hz = v_rhz, red_v1 = v_r1, red_v2 = v_r2, red_v3 = v_r3, kw = v_kw, horas_motor = v_horas, arranques = v_arr,
    en_marcha = v_marcha, red_ok = v_red,
    en_marcha_desde = case when v_marcha then coalesce(case when v_ant.en_marcha then v_ant.en_marcha_desde end, v_ahora) end,
    red_cortada_desde = case when not v_red then coalesce(case when v_ant.red_ok is false then v_ant.red_cortada_desde end, v_ahora) end
  where id = 1;

  insert into ge_lecturas (fecha, combustible_pct, bateria_v, rpm, kw, red_ok, en_marcha)
  values (v_ahora, v_comb, v_bat, v_rpm, v_kw, v_red, v_marcha) on conflict (fecha) do nothing;
  -- Corte de luz o arranque: avisar ya, sin esperar la revisión de cada 10 minutos
  if (v_ant.red_ok is true and not v_red) or (v_ant.en_marcha is false and v_marcha)
     or (v_ant.red_ok is false and v_red) then
    if to_regprocedure('public.alertas_evaluar(boolean)') is not null then
      begin
        perform alertas_evaluar(true);
      exception when others then null;   -- un problema con Teams no puede frenar el reporte
      end;
    end if;
  end if;

  delete from ge_lecturas where fecha < v_ahora - interval '180 days';
  delete from ge_eventos where fecha < v_ahora - interval '2 years';
  return jsonb_build_object('ok', true, 'responde', true);
end $$;
revoke all on function public.ge_reportar(text, jsonb) from public;
grant execute on function public.ge_reportar(text, jsonb) to anon, authenticated;

-- Historial por hora para el gráfico (combustible y batería), sin traer todas las lecturas
create or replace function public.ge_historial(p_dias int default 30)
returns table (hora timestamptz, combustible numeric, bateria numeric, en_marcha boolean, sin_red boolean)
language sql stable security definer set search_path = public as $$
  select date_trunc('hour', fecha), round(avg(combustible_pct), 1), round(min(bateria_v), 1), bool_or(en_marcha), bool_or(not red_ok)
    from ge_lecturas
   where puede_ver('servidores') and fecha > now() - make_interval(days => least(greatest(p_dias, 1), 180))
   group by 1 order by 1
$$;
revoke execute on function public.ge_historial(int) from public, anon;
grant execute on function public.ge_historial(int) to authenticated;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.ge_config_ver()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('servidores') then jsonb_build_object(
    'configurado', token_hash is not null, 'nombre', nombre, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'ip', ip, 'alertas', alertas, 'alertar_en_marcha', alertar_en_marcha, 'combustible_minimo', combustible_minimo,
    'bateria_minima', bateria_minima, 'minutos_sin_reporte', minutos_sin_reporte, 'litros_tanque', litros_tanque)
  end from ge_config where id = 1
$$;
revoke execute on function public.ge_config_ver() from public, anon;
grant execute on function public.ge_config_ver() to authenticated;

create or replace function public.ge_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update ge_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.ge_nuevo_puente(text) from public, anon;
grant execute on function public.ge_nuevo_puente(text) to authenticated;

create or replace function public.ge_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update ge_config set
    nombre = coalesce(nullif(trim(p ->> 'nombre'), ''), nombre),
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    alertar_en_marcha = coalesce((p ->> 'alertar_en_marcha')::boolean, alertar_en_marcha),
    combustible_minimo = coalesce((p ->> 'combustible_minimo')::int, combustible_minimo),
    bateria_minima = coalesce((p ->> 'bateria_minima')::numeric, bateria_minima),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte),
    litros_tanque = case when p ? 'litros_tanque' then nullif(p ->> 'litros_tanque', '')::int else litros_tanque end
  where id = 1;
end $$;
revoke execute on function public.ge_config_guardar(jsonb) from public, anon;
grant execute on function public.ge_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.ge_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c ge_config; e ge_estado;
  v_hora text;
begin
  select * into c from ge_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;
  select * into e from ge_estado where id = 1;

  if c.ultimo_reporte is null or c.ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte) then
    insert into _cond values ('ge:puente', 'grupo', 'alta', 'El puente del grupo electrógeno dejó de reportar',
      coalesce('Último reporte ' || to_char(c.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'),
      '/servidores/grupo-electrogeno')
    on conflict do nothing;
    return;
  end if;

  if e.responde is false then
    insert into _cond values ('ge:sin_respuesta', 'grupo', 'critica', c.nombre || ': no responde',
      concat_ws(' · ', c.ip, e.ultimo_error, 'último dato ' || to_char(e.ultimo_ok at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')),
      '/servidores/grupo-electrogeno')
    on conflict do nothing;
    return;
  end if;

  -- Corte de la red eléctrica
  if e.red_ok is false then
    v_hora := to_char(e.red_cortada_desde at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI');
    insert into _cond values ('ge:corte:' || to_char(e.red_cortada_desde, 'YYYYMMDDHH24MI'), 'grupo', 'critica',
      'Corte de luz: ' || case when e.en_marcha then c.nombre || ' en marcha' else c.nombre || ' NO arrancó' end,
      concat_ws(' · ', 'Sin red desde ' || v_hora, 'Combustible ' || round(e.combustible_pct) || '%',
                case when e.en_marcha and e.kw is not null then e.kw || ' kW' end),
      '/servidores/grupo-electrogeno')
    on conflict do nothing;
  elsif e.en_marcha and c.alertar_en_marcha then
    -- En marcha con red presente (prueba o arranque manual)
    insert into _cond values ('ge:marcha:' || to_char(e.en_marcha_desde, 'YYYYMMDDHH24MI'), 'grupo', 'media',
      c.nombre || ' en marcha con red presente',
      'Desde ' || to_char(e.en_marcha_desde at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') || ' · puede ser una prueba',
      '/servidores/grupo-electrogeno')
    on conflict do nothing;
  end if;

  -- Fuera de automático: ante un corte no arranca solo
  if e.modo is not null and e.modo not in (1, 4) and not e.en_marcha then
    insert into _cond values ('ge:modo', 'grupo', 'alta', c.nombre || ' fuera de automático',
      'Modo ' || (array['Stop', 'Automático', 'Manual', 'Prueba con carga', 'Automático con restauración manual', 'Configuración', 'Prueba sin carga', 'Off'])[e.modo + 1]
        || ': si se corta la luz no va a arrancar solo',
      '/servidores/grupo-electrogeno')
    on conflict do nothing;
  end if;

  -- Combustible bajo
  if e.combustible_pct is not null and e.combustible_pct < c.combustible_minimo then
    insert into _cond values ('ge:combustible', 'grupo', case when e.combustible_pct < c.combustible_minimo / 2 then 'critica' else 'alta' end,
      c.nombre || ': combustible bajo (' || round(e.combustible_pct) || '%)',
      concat_ws(' · ', 'Mínimo configurado ' || c.combustible_minimo || '%',
                case when c.litros_tanque is not null then 'quedan unos ' || round(c.litros_tanque * e.combustible_pct / 100) || ' L de ' || c.litros_tanque end,
                'coordinar la recarga'),
      '/servidores/grupo-electrogeno')
    on conflict do nothing;
  end if;

  -- Batería de arranque baja (con el motor parado)
  if e.bateria_v is not null and not e.en_marcha and e.bateria_v < c.bateria_minima then
    insert into _cond values ('ge:bateria', 'grupo', 'alta', c.nombre || ': batería de arranque baja (' || e.bateria_v || ' V)',
      'Mínimo configurado ' || c.bateria_minima || ' V · revisar cargador y batería', '/servidores/grupo-electrogeno')
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.ge_condiciones_alertas() from public, anon, authenticated;

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
  if position('ge_condiciones_alertas' in v_def) = 0 then
    v_def := regexp_replace(v_def, E'begin\\n',
      E'begin\n  if to_regprocedure(''public.ge_condiciones_alertas()'') is not null then perform ge_condiciones_alertas(); end if;\n');
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
-- Permisos: se ve con la solapa Servidores; la configura un administrador
-- ----------------------------------------------------------
alter table public.ge_config enable row level security;
alter table public.ge_estado enable row level security;
alter table public.ge_lecturas enable row level security;
alter table public.ge_eventos enable row level security;

revoke all on public.ge_config from anon, authenticated;
drop policy if exists ge_estado_select on public.ge_estado;
create policy ge_estado_select on public.ge_estado for select to authenticated using (puede_ver('servidores'));
drop policy if exists ge_lecturas_select on public.ge_lecturas;
create policy ge_lecturas_select on public.ge_lecturas for select to authenticated using (puede_ver('servidores'));
drop policy if exists ge_eventos_select on public.ge_eventos;
create policy ge_eventos_select on public.ge_eventos for select to authenticated using (puede_ver('servidores'));
revoke insert, update, delete on public.ge_estado, public.ge_lecturas, public.ge_eventos from anon, authenticated;
grant select on public.ge_estado, public.ge_lecturas, public.ge_eventos to authenticated;

do $$
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  drop trigger if exists trg_auditoria on public.ge_config;
  create trigger trg_auditoria after insert or update or delete on public.ge_config for each row execute function public.auditar();
end $$;
