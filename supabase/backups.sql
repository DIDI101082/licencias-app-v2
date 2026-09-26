-- ==========================================================
-- BACKUPS (Veeam)
--   * Un script en el servidor de Veeam (tarea programada, cada hora) envía el resultado
--     de la última ejecución de cada trabajo de backup.
--   * La app muestra el estado de cada trabajo y alerta (Teams / tickets) cuando:
--       - un trabajo falló, o
--       - un trabajo no tiene un backup exitoso hace más de N horas, o
--       - el servidor de Veeam dejó de reportar.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de alertas.sql.
-- ==========================================================

create table if not exists public.backups_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  horas_max_sin_exito int not null default 26 check (horas_max_sin_exito between 1 and 720),
  horas_max_sin_reporte int not null default 3 check (horas_max_sin_reporte between 1 and 72),
  alertas boolean not null default true,
  servidor text,
  version_veeam text,
  ultimo_reporte timestamptz
);
insert into public.backups_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.backups_trabajos (
  nombre text primary key,
  tipo text,                          -- VM, agente, archivo, copia, etc. (como lo informa Veeam)
  habilitado boolean not null default true,
  ultimo_resultado text,              -- Success | Warning | Failed | None (en curso)
  ultimo_inicio timestamptz,
  ultimo_fin timestamptz,
  ultimo_exito timestamptz,
  tamano_gb numeric(12,1),
  detalle text,                       -- mensaje del último error/advertencia
  ignorar boolean not null default false,
  actualizado timestamptz not null default now()
);

-- Historial diario compacto (para el tablero): un registro por trabajo y día
create table if not exists public.backups_historial (
  nombre text not null,
  fecha date not null,
  resultado text not null,
  primary key (nombre, fecha)
);

-- ----------------------------------------------------------
-- Lo llama el script de Veeam
-- p_datos: {servidor, version, trabajos: [{nombre, tipo, habilitado, resultado, inicio, fin, ultimo_exito, tamano_gb, detalle}]}
-- ----------------------------------------------------------
create or replace function public.backups_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_hash text; t jsonb; n int := 0;
begin
  select token_hash into v_hash from backups_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'trabajos'), '') <> 'array' then raise exception 'Datos inválidos'; end if;

  for t in select * from jsonb_array_elements(p_datos -> 'trabajos') loop
    continue when coalesce(t ->> 'nombre', '') = '';
    insert into backups_trabajos as b (nombre, tipo, habilitado, ultimo_resultado, ultimo_inicio, ultimo_fin, ultimo_exito, tamano_gb, detalle, actualizado)
    values (left(t ->> 'nombre', 200), left(t ->> 'tipo', 60), coalesce((t ->> 'habilitado')::boolean, true), left(t ->> 'resultado', 20),
            (t ->> 'inicio')::timestamptz, (t ->> 'fin')::timestamptz, (t ->> 'ultimo_exito')::timestamptz,
            (t ->> 'tamano_gb')::numeric, left(t ->> 'detalle', 500), now())
    on conflict (nombre) do update set
      tipo = excluded.tipo, habilitado = excluded.habilitado, ultimo_resultado = excluded.ultimo_resultado,
      ultimo_inicio = excluded.ultimo_inicio, ultimo_fin = excluded.ultimo_fin,
      ultimo_exito = coalesce(excluded.ultimo_exito, b.ultimo_exito),
      tamano_gb = excluded.tamano_gb, detalle = excluded.detalle, actualizado = now();
    if t ->> 'fin' is not null and t ->> 'resultado' in ('Success', 'Warning', 'Failed') then
      insert into backups_historial (nombre, fecha, resultado)
      values (left(t ->> 'nombre', 200), ((t ->> 'fin')::timestamptz at time zone 'America/Argentina/Buenos_Aires')::date, t ->> 'resultado')
      on conflict (nombre, fecha) do update set resultado = excluded.resultado;
    end if;
    n := n + 1;
  end loop;

  update backups_config set ultimo_reporte = now(), servidor = left(p_datos ->> 'servidor', 100),
         version_veeam = left(p_datos ->> 'version', 40) where id = 1;
  delete from backups_historial where fecha < current_date - 400;
  return jsonb_build_object('ok', true, 'trabajos', n);
end $$;
revoke all on function public.backups_reportar(text, jsonb) from public;
grant execute on function public.backups_reportar(text, jsonb) to anon, authenticated;

-- Nuevo token para el script (se muestra una sola vez; se guarda solo el hash)
create or replace function public.backups_nuevo_token()
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v text := encode(gen_random_bytes(24), 'hex');
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  update backups_config set token_hash = inv_hash(v) where id = 1;
  return v;
end $$;
grant execute on function public.backups_nuevo_token() to authenticated;

create or replace function public.backups_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  update backups_config set
    horas_max_sin_exito = coalesce((p ->> 'horas_max_sin_exito')::int, horas_max_sin_exito),
    horas_max_sin_reporte = coalesce((p ->> 'horas_max_sin_reporte')::int, horas_max_sin_reporte),
    alertas = coalesce((p ->> 'alertas')::boolean, alertas)
  where id = 1;
end $$;
grant execute on function public.backups_config_guardar(jsonb) to authenticated;

create or replace function public.backups_ignorar(p_nombre text, p_ignorar boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  update backups_trabajos set ignorar = p_ignorar where nombre = p_nombre;
end $$;
grant execute on function public.backups_ignorar(text, boolean) to authenticated;

-- ----------------------------------------------------------
-- Alertas: se suman al motor existente (Logs → Alertas) mediante un "gancho" genérico
-- ----------------------------------------------------------
create or replace function public.alertas_condiciones_extra()
returns void language plpgsql security definer set search_path = public as $$
declare c backups_config;
begin
  select * into c from backups_config where id = 1;
  if c.alertas and c.token_hash is not null then
    -- El servidor de Veeam dejó de reportar
    if c.ultimo_reporte is not null and c.ultimo_reporte < now() - make_interval(hours => c.horas_max_sin_reporte) then
      insert into _cond values ('backup:puente', 'backup', 'alta', 'El servidor de Veeam dejó de reportar',
        'Último reporte hace ' || floor(extract(epoch from now() - c.ultimo_reporte) / 3600) || ' horas' || coalesce(' · ' || c.servidor, ''),
        '/inventario/backups')
      on conflict do nothing;
    end if;
    -- Trabajos fallidos o sin backup exitoso reciente (solo si el reporte está al día)
    if c.ultimo_reporte >= now() - make_interval(hours => c.horas_max_sin_reporte) then
      insert into _cond
      select 'backup:' || b.nombre, 'backup',
             case when b.ultimo_resultado = 'Failed' then 'critica' else 'alta' end,
             case when b.ultimo_resultado = 'Failed' then 'Backup fallido: ' || b.nombre
                  else 'Backup sin éxito reciente: ' || b.nombre end,
             concat_ws(' · ',
               'último exitoso ' || coalesce(to_char(b.ultimo_exito at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'nunca'),
               nullif(left(b.detalle, 150), '')),
             '/inventario/backups'
        from backups_trabajos b
       where b.habilitado and not b.ignorar
         and (b.ultimo_resultado = 'Failed'
              or coalesce(b.ultimo_exito, '-infinity') < now() - make_interval(hours => c.horas_max_sin_exito))
      on conflict do nothing;
    end if;
  end if;
end $$;
revoke all on function public.alertas_condiciones_extra() from public, anon, authenticated;

-- Agrega el gancho al motor de alertas (una sola vez; toma la versión que tengas instalada)
do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_evaluar(boolean)') is null then
    raise notice 'Falta alertas.sql: los backups se ven en la app pero sin alertas';
    return;
  end if;
  v_def := pg_get_functiondef('public.alertas_evaluar(boolean)'::regprocedure);
  if position('alertas_condiciones_extra' in v_def) > 0 then return; end if;
  if position('-- Abrir las nuevas' in v_def) = 0 then
    raise notice 'No se encontró dónde agregar el gancho en alertas_evaluar; los backups quedan sin alertas';
    return;
  end if;
  v_def := replace(v_def, '-- Abrir las nuevas',
    E'-- Condiciones de otros módulos (backups, etc.)\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
  execute v_def;
end $$;

-- ----------------------------------------------------------
-- Permisos: se ve con la solapa Seguridad; se escribe solo por funciones
-- ----------------------------------------------------------
alter table public.backups_config enable row level security;
alter table public.backups_trabajos enable row level security;
alter table public.backups_historial enable row level security;

drop policy if exists backups_trabajos_select on public.backups_trabajos;
create policy backups_trabajos_select on public.backups_trabajos for select to authenticated using (puede_ver('seguridad'));
drop policy if exists backups_historial_select on public.backups_historial;
create policy backups_historial_select on public.backups_historial for select to authenticated using (puede_ver('seguridad'));
revoke all on public.backups_config from anon, authenticated;
revoke insert, update, delete on public.backups_trabajos, public.backups_historial from anon, authenticated;

create or replace function public.backups_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('seguridad') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'servidor', servidor, 'version', version_veeam,
    'horas_max_sin_exito', horas_max_sin_exito, 'horas_max_sin_reporte', horas_max_sin_reporte, 'alertas', alertas)
  end from backups_config where id = 1
$$;
grant execute on function public.backups_estado() to authenticated;
