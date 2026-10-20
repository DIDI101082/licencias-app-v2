-- ============================================================
-- FortiClient EMS — módulo Accusys Cyber
-- Ejecutar una sola vez en Supabase SQL Editor
-- ============================================================

-- ── Tabla de configuración (fila única) ──────────────────────
create table if not exists ems_config (
  id                   int primary key default 1 check (id = 1),
  token_hash           text,                        -- SHA-256 hex del token del puente
  ultimo_reporte       timestamptz,
  version_puente       text,
  alertas              boolean not null default false,
  minutos_sin_reporte  int     not null default 60,
  dias_aviso           int     not null default 30, -- aviso antes de que venzan licencias
  alertar_sin_ztna     boolean not null default true,
  alertar_vuln_critica boolean not null default true,
  alertar_desconexion  boolean not null default true
);

insert into ems_config (id) values (1) on conflict do nothing;

-- ── Endpoints ────────────────────────────────────────────────
create table if not exists ems_endpoints (
  uid              text primary key,               -- device uid del EMS
  hostname         text,
  usuario          text,
  ip               text,
  version_cliente  text,
  estado           text,                            -- online | offline | quarantine
  os               text,
  so_version       text,
  dominio          text,
  sitio            text,
  grupo            text,
  politica         text,
  score_postura    int,                             -- 0-100
  ultimo_visto     timestamptz,
  actualizado      timestamptz not null default now()
);

-- ── Cumplimiento / postura ZTNA ──────────────────────────────
create table if not exists ems_cumplimiento (
  id              bigserial primary key,
  endpoint_uid    text references ems_endpoints(uid) on delete cascade,
  regla           text not null,
  estado          text not null,                   -- pass | fail | warning
  severidad       text not null default 'info',    -- critical | high | medium | low | info
  detalle         text,
  actualizado     timestamptz not null default now()
);

create index if not exists ems_cumplimiento_uid_idx on ems_cumplimiento(endpoint_uid);

-- ── VPN activa ───────────────────────────────────────────────
create table if not exists ems_vpn (
  id           bigserial primary key,
  endpoint_uid text references ems_endpoints(uid) on delete cascade,
  usuario      text,
  ip_publica   text,
  ip_tunel     text,
  desde        timestamptz,
  pais_codigo  text,
  pais         text,
  ciudad       text,
  isp          text,
  actualizado  timestamptz not null default now()
);

create index if not exists ems_vpn_uid_idx on ems_vpn(endpoint_uid);

-- ── Historial de sesiones VPN ────────────────────────────────
create table if not exists ems_vpn_historial (
  id           bigserial primary key,
  fecha        timestamptz not null,
  usuario      text,
  endpoint_uid text,
  hostname     text,
  ip_publica   text,
  accion       text,                               -- connect | disconnect
  duracion_seg int,
  pais_codigo  text,
  pais         text
);

create index if not exists ems_vpn_hist_fecha_idx on ems_vpn_historial(fecha desc);

-- ── Vulnerabilidades detectadas ──────────────────────────────
create table if not exists ems_vulnerabilidades (
  id           bigserial primary key,
  endpoint_uid text references ems_endpoints(uid) on delete cascade,
  cve_id       text,
  severidad    text not null default 'medium',     -- critical | high | medium | low
  producto     text,
  version      text,
  descripcion  text,
  actualizado  timestamptz not null default now()
);

create index if not exists ems_vuln_uid_idx      on ems_vulnerabilidades(endpoint_uid);
create index if not exists ems_vuln_cve_idx      on ems_vulnerabilidades(cve_id);
create index if not exists ems_vuln_sev_idx      on ems_vulnerabilidades(severidad);

-- ── Accesos a la consola EMS ─────────────────────────────────
create table if not exists ems_accesos (
  id        bigserial primary key,
  fecha     timestamptz not null,
  usuario   text,
  ip        text,
  accion    text,                                  -- login | logout | failed
  resultado text,
  detalle   text
);

create index if not exists ems_accesos_fecha_idx on ems_accesos(fecha desc);

-- ── Licencias EMS ────────────────────────────────────────────
create table if not exists ems_licencias (
  id          bigserial primary key,
  tipo        text not null,                       -- FortiClient EMS | ZTNA | Chromebook...
  total       int,
  usadas      int,
  disponibles int,
  vence       date,
  estado      text not null default 'ok',          -- ok | por_vencer | vencida
  actualizado timestamptz not null default now()
);

-- ── Grupos y políticas ───────────────────────────────────────
create table if not exists ems_politicas (
  id                  bigserial primary key,
  nombre              text not null,
  tipo                text,                        -- ZTNA | EMS Policy | Endpoint Profile…
  endpoints_asignados int  not null default 0,
  endpoints_activos   int  not null default 0,
  actualizado         timestamptz not null default now()
);

-- ── RLS ──────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_policies where tablename = 'ems_config' and policyname = 'ems_config_ver') then
    alter table ems_config         enable row level security;
    alter table ems_endpoints      enable row level security;
    alter table ems_cumplimiento   enable row level security;
    alter table ems_vpn            enable row level security;
    alter table ems_vpn_historial  enable row level security;
    alter table ems_vulnerabilidades enable row level security;
    alter table ems_accesos        enable row level security;
    alter table ems_licencias      enable row level security;
    alter table ems_politicas      enable row level security;

    create policy ems_config_ver         on ems_config         for select using (puede_ver('red'));
    create policy ems_endpoints_ver      on ems_endpoints       for select using (puede_ver('red'));
    create policy ems_cumpl_ver          on ems_cumplimiento    for select using (puede_ver('red'));
    create policy ems_vpn_ver            on ems_vpn             for select using (puede_ver('red'));
    create policy ems_vpn_hist_ver       on ems_vpn_historial   for select using (puede_ver('red'));
    create policy ems_vuln_ver           on ems_vulnerabilidades for select using (puede_ver('red'));
    create policy ems_accesos_ver        on ems_accesos         for select using (puede_ver('red'));
    create policy ems_licencias_ver      on ems_licencias       for select using (puede_ver('red'));
    create policy ems_politicas_ver      on ems_politicas       for select using (puede_ver('red'));
  end if;
end $$;

-- ── Helper: estado del módulo para la UI ─────────────────────
create or replace function ems_estado()
returns jsonb language sql security definer as $$
  select jsonb_build_object(
    'configurado',          token_hash is not null,
    'ultimo_reporte',       ultimo_reporte,
    'version_puente',       version_puente,
    'alertas',              alertas,
    'minutos_sin_reporte',  minutos_sin_reporte,
    'dias_aviso',           dias_aviso,
    'alertar_sin_ztna',     alertar_sin_ztna,
    'alertar_vuln_critica', alertar_vuln_critica,
    'alertar_desconexion',  alertar_desconexion
  ) from ems_config;
$$;

-- ── Admin: registrar nuevo token del puente ───────────────────
create or replace function ems_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer as $$
begin
  if not (select coalesce((auth.jwt()->'app_metadata'->>'is_admin')::boolean, false)) then
    raise exception 'Solo administradores pueden configurar el puente.';
  end if;
  update ems_config set token_hash = p_token_hash where id = 1;
end;
$$;

-- ── Admin: guardar config de alertas ─────────────────────────
create or replace function ems_config_guardar(p jsonb)
returns void language plpgsql security definer as $$
begin
  if not (select coalesce((auth.jwt()->'app_metadata'->>'is_admin')::boolean, false)) then
    raise exception 'Solo administradores pueden cambiar la configuración.';
  end if;
  update ems_config set
    alertas              = coalesce((p->>'alertas')::boolean,              alertas),
    minutos_sin_reporte  = coalesce((p->>'minutos_sin_reporte')::int,      minutos_sin_reporte),
    dias_aviso           = coalesce((p->>'dias_aviso')::int,               dias_aviso),
    alertar_sin_ztna     = coalesce((p->>'alertar_sin_ztna')::boolean,     alertar_sin_ztna),
    alertar_vuln_critica = coalesce((p->>'alertar_vuln_critica')::boolean, alertar_vuln_critica),
    alertar_desconexion  = coalesce((p->>'alertar_desconexion')::boolean,  alertar_desconexion)
  where id = 1;
end;
$$;

-- ── Puente: reportar datos desde el Windows service ──────────
-- p_token : token en texto plano (se verifica su SHA-256)
-- p_datos : jsonb con claves:
--   version, endpoints[], cumplimiento[], vpn[], vpn_historial[],
--   vulnerabilidades[], accesos[], licencias[], politicas[]
create or replace function ems_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_hash   text;
  v_stored text;
  v_ts     timestamptz := now();
begin
  -- Verificar token
  select encode(digest(p_token, 'sha256'), 'hex') into v_hash;
  select token_hash into v_stored from ems_config where id = 1;
  if v_stored is null or v_hash <> v_stored then
    raise exception 'Token inválido.';
  end if;

  -- ── Endpoints ──
  if jsonb_typeof(p_datos->'endpoints') = 'array' then
    insert into ems_endpoints (uid, hostname, usuario, ip, version_cliente, estado, os, so_version,
      dominio, sitio, grupo, politica, score_postura, ultimo_visto, actualizado)
    select
      e->>'uid', e->>'hostname', e->>'usuario', e->>'ip', e->>'version_cliente',
      coalesce(e->>'estado', 'offline'), e->>'os', e->>'so_version',
      e->>'dominio', e->>'sitio', e->>'grupo', e->>'politica',
      (e->>'score_postura')::int, (e->>'ultimo_visto')::timestamptz, v_ts
    from jsonb_array_elements(p_datos->'endpoints') e
    on conflict (uid) do update set
      hostname        = excluded.hostname,
      usuario         = excluded.usuario,
      ip              = excluded.ip,
      version_cliente = excluded.version_cliente,
      estado          = excluded.estado,
      os              = excluded.os,
      so_version      = excluded.so_version,
      dominio         = excluded.dominio,
      sitio           = excluded.sitio,
      grupo           = excluded.grupo,
      politica        = excluded.politica,
      score_postura   = excluded.score_postura,
      ultimo_visto    = excluded.ultimo_visto,
      actualizado     = excluded.actualizado;
  end if;

  -- ── Cumplimiento (reemplazar por endpoint) ──
  if jsonb_typeof(p_datos->'cumplimiento') = 'array' then
    -- borrar los que mandó el puente y reinsertar
    delete from ems_cumplimiento
    where endpoint_uid in (
      select distinct e->>'endpoint_uid' from jsonb_array_elements(p_datos->'cumplimiento') e
    );
    insert into ems_cumplimiento (endpoint_uid, regla, estado, severidad, detalle, actualizado)
    select e->>'endpoint_uid', e->>'regla', e->>'estado',
      coalesce(e->>'severidad','info'), e->>'detalle', v_ts
    from jsonb_array_elements(p_datos->'cumplimiento') e;
  end if;

  -- ── VPN activa (snapshot completo) ──
  if jsonb_typeof(p_datos->'vpn') = 'array' then
    delete from ems_vpn;
    insert into ems_vpn (endpoint_uid, usuario, ip_publica, ip_tunel, desde,
      pais_codigo, pais, ciudad, isp, actualizado)
    select
      e->>'endpoint_uid', e->>'usuario', e->>'ip_publica', e->>'ip_tunel',
      (e->>'desde')::timestamptz,
      e->>'pais_codigo', e->>'pais', e->>'ciudad', e->>'isp', v_ts
    from jsonb_array_elements(p_datos->'vpn') e;
  end if;

  -- ── Historial VPN (insertar novedades por evento) ──
  if jsonb_typeof(p_datos->'vpn_historial') = 'array' then
    insert into ems_vpn_historial (fecha, usuario, endpoint_uid, hostname,
      ip_publica, accion, duracion_seg, pais_codigo, pais)
    select
      (e->>'fecha')::timestamptz, e->>'usuario', e->>'endpoint_uid', e->>'hostname',
      e->>'ip_publica', e->>'accion', (e->>'duracion_seg')::int,
      e->>'pais_codigo', e->>'pais'
    from jsonb_array_elements(p_datos->'vpn_historial') e
    on conflict do nothing;
    -- Limpiar historial > 90 días
    delete from ems_vpn_historial where fecha < now() - interval '90 days';
  end if;

  -- ── Vulnerabilidades (reemplazar por endpoint) ──
  if jsonb_typeof(p_datos->'vulnerabilidades') = 'array' then
    delete from ems_vulnerabilidades
    where endpoint_uid in (
      select distinct e->>'endpoint_uid' from jsonb_array_elements(p_datos->'vulnerabilidades') e
    );
    insert into ems_vulnerabilidades (endpoint_uid, cve_id, severidad, producto, version, descripcion, actualizado)
    select e->>'endpoint_uid', e->>'cve_id', coalesce(e->>'severidad','medium'),
      e->>'producto', e->>'version', e->>'descripcion', v_ts
    from jsonb_array_elements(p_datos->'vulnerabilidades') e;
  end if;

  -- ── Accesos a la consola EMS ──
  if jsonb_typeof(p_datos->'accesos') = 'array' then
    insert into ems_accesos (fecha, usuario, ip, accion, resultado, detalle)
    select (e->>'fecha')::timestamptz, e->>'usuario', e->>'ip',
      e->>'accion', e->>'resultado', e->>'detalle'
    from jsonb_array_elements(p_datos->'accesos') e
    on conflict do nothing;
    delete from ems_accesos where fecha < now() - interval '90 days';
  end if;

  -- ── Licencias (reemplazar completamente) ──
  if jsonb_typeof(p_datos->'licencias') = 'array' then
    delete from ems_licencias;
    insert into ems_licencias (tipo, total, usadas, disponibles, vence, estado, actualizado)
    select e->>'tipo', (e->>'total')::int, (e->>'usadas')::int, (e->>'disponibles')::int,
      (e->>'vence')::date, coalesce(e->>'estado','ok'), v_ts
    from jsonb_array_elements(p_datos->'licencias') e;
  end if;

  -- ── Políticas ──
  if jsonb_typeof(p_datos->'politicas') = 'array' then
    delete from ems_politicas;
    insert into ems_politicas (nombre, tipo, endpoints_asignados, endpoints_activos, actualizado)
    select e->>'nombre', e->>'tipo',
      coalesce((e->>'endpoints_asignados')::int, 0),
      coalesce((e->>'endpoints_activos')::int, 0), v_ts
    from jsonb_array_elements(p_datos->'politicas') e;
  end if;

  -- ── Actualizar timestamp del reporte ──
  update ems_config set
    ultimo_reporte = v_ts,
    version_puente = coalesce(p_datos->>'version', version_puente)
  where id = 1;

  return jsonb_build_object('ok', true, 'ts', v_ts);
end;
$$;

-- ── Condiciones de alertas (hook en alertas_condiciones_extra) ──
create or replace function ems_condiciones_alertas()
returns table (
  modulo      text,
  clave       text,
  descripcion text,
  prioridad   text,
  condicion   boolean,
  detalle     text
) language plpgsql security definer as $$
declare
  v_cfg record;
  v_ts  timestamptz := now();
begin
  select * into v_cfg from ems_config where id = 1;
  if not found or not v_cfg.alertas then return; end if;

  -- 1. Puente sin reportar
  if v_cfg.ultimo_reporte is not null
     and v_cfg.ultimo_reporte < v_ts - (v_cfg.minutos_sin_reporte || ' minutes')::interval then
    return query select
      'red'::text, 'ems_sin_reporte'::text,
      'FortiClient EMS: puente sin reportar'::text, 'alta'::text,
      true,
      format('Último reporte: %s (hace %s min)',
        to_char(v_cfg.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'),
        extract(epoch from (v_ts - v_cfg.ultimo_reporte))/60)::text;
  end if;

  -- 2. Endpoints offline por más de 2 horas (desconexión de agente)
  if v_cfg.alertar_desconexion then
    return query
    select 'red'::text, 'ems_endpoint_offline'::text,
      format('%s endpoint/s desconectado/s de FortiClient EMS', count(*))::text,
      'media'::text, true,
      string_agg(hostname || ' (' || coalesce(usuario,'?') || ')', ', ' order by hostname)
    from ems_endpoints
    where estado = 'offline'
      and ultimo_visto < v_ts - interval '2 hours'
    having count(*) > 0;
  end if;

  -- 3. Endpoints sin política ZTNA
  if v_cfg.alertar_sin_ztna then
    return query
    select 'red'::text, 'ems_sin_politica'::text,
      format('%s endpoint/s sin política ZTNA asignada', count(*))::text,
      'media'::text, true,
      string_agg(hostname, ', ' order by hostname)
    from ems_endpoints
    where (politica is null or politica = '')
      and estado <> 'offline'
    having count(*) > 0;
  end if;

  -- 4. Vulnerabilidades críticas nuevas
  if v_cfg.alertar_vuln_critica then
    return query
    select 'red'::text, 'ems_vuln_critica'::text,
      format('%s vulnerabilidad/es crítica/s detectada/s por EMS', count(*))::text,
      'alta'::text, true,
      string_agg(distinct coalesce(v.cve_id, v.producto), ', ' order by coalesce(v.cve_id, v.producto))
    from ems_vulnerabilidades v
    where v.severidad = 'critical'
      and v.actualizado > v_ts - interval '24 hours'
    having count(*) > 0;
  end if;

  -- 5. Licencias por vencer o vencidas
  return query
  select 'red'::text,
    case when vence < current_date then 'ems_lic_vencida' else 'ems_lic_por_vencer' end,
    case when vence < current_date
      then format('Licencia %s de EMS vencida', tipo)
      else format('Licencia %s de EMS vence en %s días', tipo, (vence - current_date))
    end,
    case when vence < current_date then 'alta' else 'media' end,
    true,
    format('%s/%s usadas, vence %s', usadas, total, to_char(vence,'DD/MM/YYYY'))
  from ems_licencias
  where vence is not null
    and vence <= current_date + v_cfg.dias_aviso;
end;
$$;

-- ── Enganchar en alertas_condiciones_extra ───────────────────
-- DROP explícito necesario: CREATE OR REPLACE no puede cambiar columnas de retorno.
drop function if exists alertas_condiciones_extra();

create or replace function alertas_condiciones_extra()
returns table (modulo text, clave text, descripcion text, prioridad text, condicion boolean, detalle text)
language plpgsql security definer as $$
begin
  -- FortiGate
  if exists (select from pg_proc where proname = 'fg_condiciones_alertas') then
    return query select * from fg_condiciones_alertas();
  end if;
  -- FortiClient EMS
  if exists (select from pg_proc where proname = 'ems_condiciones_alertas') then
    return query select * from ems_condiciones_alertas();
  end if;
end;
$$;
