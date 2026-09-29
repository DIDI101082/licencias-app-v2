-- ==========================================================
-- Servidores → Virtualización (VMware vCenter) y Storage (IBM V5000 / FlashSystem)
--   * Un puente de solo lectura en un servidor interno lee vCenter con PowerCLI y el storage con su API REST.
--   * vCenter: hosts ESXi (versión, SSH, lockdown, salud del hardware, certificado), VMs, snapshots, datastores,
--     alarmas y licencias. La versión de ESXi y vCenter se cruza con la base NVD (vulnerabilidades explotadas).
--   * Storage: sistema, pools, discos, nodos, fuentes, baterías, arreglos, volúmenes y eventos abiertos.
--   * Proyección de llenado de datastores y pools (historial diario).
--   * Alertas (arrancan apagadas).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de servidores.sql y vulnerabilidades.sql. Se puede repetir.
-- ==========================================================

create table if not exists public.virt_config (
  id int primary key default 1 check (id = 1),
  token_hash text, creado_en timestamptz, ultimo_reporte timestamptz, version_puente text,
  error_vcenter text, error_storage text, avisos jsonb not null default '[]',
  alertas boolean not null default false,
  pct_lleno int not null default 85 check (pct_lleno between 50 and 99),        -- datastore o pool
  dias_snapshot int not null default 7 check (dias_snapshot between 1 and 90),
  dias_aviso int not null default 30 check (dias_aviso between 1 and 180),       -- licencias y certificados
  minutos_sin_reporte int not null default 45 check (minutos_sin_reporte between 10 and 720)
);
insert into public.virt_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.virt_vcenter (
  id int primary key default 1 check (id = 1), nombre text, version text, build text, actualizado timestamptz
);
insert into public.virt_vcenter (id) values (1) on conflict (id) do nothing;

create table if not exists public.virt_hosts (
  nombre text primary key, version text, build text, estado text, energia text, fabricante text, modelo text, cluster text,
  salud text, cpu_pct numeric, mem_pct numeric, mem_gb numeric, arranque timestamptz, lockdown text,
  ssh_activo boolean, ssh_politica text, shell_activo boolean, shell_politica text, cert_vence timestamptz,
  sensores jsonb not null default '[]', actualizado timestamptz not null default now()
);
create table if not exists public.virt_vms (
  nombre text primary key, host text, estado text, so text, cpus int, mem_gb numeric, disco_gb numeric, usado_gb numeric,
  tools text, tools_estado text, ip text, actualizado timestamptz not null default now()
);
create table if not exists public.virt_snapshots (
  vm text not null, nombre text not null, creado timestamptz not null, tamano_gb numeric, actualizado timestamptz not null default now(),
  primary key (vm, nombre, creado)
);
create table if not exists public.virt_datastores (
  nombre text primary key, tipo text, capacidad_gb numeric, libre_gb numeric, estado text, hosts int, actualizado timestamptz not null default now()
);
create table if not exists public.virt_alarmas (
  id bigserial primary key, alarma text, entidad text, tipo text, estado text, fecha timestamptz, reconocida boolean, actualizado timestamptz not null default now()
);
create table if not exists public.virt_licencias (
  producto text not null, edicion text not null default '', usado numeric, total numeric, vence timestamptz, actualizado timestamptz not null default now(),
  primary key (producto, edicion)
);
-- Historial diario de ocupación (para proyectar cuándo se llena)
create table if not exists public.virt_capacidad (
  fecha date not null, tipo text not null check (tipo in ('datastore', 'pool')), nombre text not null,
  capacidad_gb numeric, libre_gb numeric, primary key (fecha, tipo, nombre)
);

create table if not exists public.sto_sistema (
  id int primary key default 1 check (id = 1), nombre text, producto text, version text, capacidad_gb numeric, libre_gb numeric, actualizado timestamptz
);
insert into public.sto_sistema (id) values (1) on conflict (id) do nothing;
create table if not exists public.sto_pools (
  nombre text primary key, estado text, capacidad_gb numeric, libre_gb numeric, usado_gb numeric, asignado_gb numeric, actualizado timestamptz not null default now()
);
create table if not exists public.sto_discos (
  id text primary key, estado text, uso text, capacidad_gb numeric, tecnologia text, gabinete text, bahia text, arreglo text, actualizado timestamptz not null default now()
);
create table if not exists public.sto_componentes (
  tipo text not null, id text not null, estado text, detalle text, actualizado timestamptz not null default now(), primary key (tipo, id)
);
create table if not exists public.sto_volumenes (
  nombre text primary key, estado text, capacidad_gb numeric, pool text, actualizado timestamptz not null default now()
);
create table if not exists public.sto_eventos (
  secuencia text primary key, fecha timestamptz, objeto text, codigo text, evento text, descripcion text, actualizado timestamptz not null default now()
);

-- ----------------------------------------------------------
-- Lo llama el puente
-- ----------------------------------------------------------
create or replace function public.virt_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_hash text; v_ahora timestamptz := now(); s jsonb := p_datos -> 'storage';
begin
  select token_hash into v_hash from virt_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de virtualización inválido';
  end if;

  -- vCenter (si hubo error de conexión se conserva lo último conocido)
  if jsonb_typeof(p_datos -> 'hosts') = 'array' then
    update virt_vcenter v set nombre = x.nombre, version = x.version, build = x.build, actualizado = v_ahora
      from jsonb_to_record(coalesce(p_datos -> 'vcenter', '{}')) as x(nombre text, version text, build text) where v.id = 1;

    insert into virt_hosts as h (nombre, version, build, estado, energia, fabricante, modelo, cluster, salud, cpu_pct, mem_pct, mem_gb, arranque,
                                 lockdown, ssh_activo, ssh_politica, shell_activo, shell_politica, cert_vence, sensores, actualizado)
    select left(x.nombre, 200), x.version, x.build, x.estado, x.energia, x.fabricante, x.modelo, nullif(x.cluster, ''), x.salud, x.cpu_pct, x.mem_pct,
           x.mem_gb, x.arranque, nullif(x.lockdown, ''), (x.ssh ->> 'activo')::boolean, x.ssh ->> 'politica', (x.shell ->> 'activo')::boolean,
           x.shell ->> 'politica', x.cert_vence, coalesce(x.sensores, '[]'), v_ahora
      from jsonb_to_recordset(p_datos -> 'hosts') as x(nombre text, version text, build text, estado text, energia text, fabricante text, modelo text,
             cluster text, salud text, cpu_pct numeric, mem_pct numeric, mem_gb numeric, arranque timestamptz, lockdown text, ssh jsonb, shell jsonb,
             cert_vence timestamptz, sensores jsonb)
     where coalesce(x.nombre, '') <> ''
    on conflict (nombre) do update set version = excluded.version, build = excluded.build, estado = excluded.estado, energia = excluded.energia,
      fabricante = excluded.fabricante, modelo = excluded.modelo, cluster = excluded.cluster, salud = excluded.salud, cpu_pct = excluded.cpu_pct,
      mem_pct = excluded.mem_pct, mem_gb = excluded.mem_gb, arranque = excluded.arranque, lockdown = excluded.lockdown, ssh_activo = excluded.ssh_activo,
      ssh_politica = excluded.ssh_politica, shell_activo = excluded.shell_activo, shell_politica = excluded.shell_politica,
      cert_vence = coalesce(excluded.cert_vence, h.cert_vence), sensores = excluded.sensores, actualizado = v_ahora;
    delete from virt_hosts where actualizado < v_ahora;

    if jsonb_typeof(p_datos -> 'vms') = 'array' then
      insert into virt_vms (nombre, host, estado, so, cpus, mem_gb, disco_gb, usado_gb, tools, tools_estado, ip, actualizado)
      select distinct on (left(x.nombre, 200)) left(x.nombre, 200), x.host, x.estado, nullif(x.so, ''), x.cpus, x.mem_gb, x.disco_gb, x.usado_gb,
             nullif(x.tools, ''), nullif(x.tools_estado, ''), nullif(x.ip, ''), v_ahora
        from jsonb_to_recordset(p_datos -> 'vms') as x(nombre text, host text, estado text, so text, cpus int, mem_gb numeric, disco_gb numeric,
                                                       usado_gb numeric, tools text, tools_estado text, ip text)
       where coalesce(x.nombre, '') <> ''
      on conflict (nombre) do update set host = excluded.host, estado = excluded.estado, so = excluded.so, cpus = excluded.cpus, mem_gb = excluded.mem_gb,
        disco_gb = excluded.disco_gb, usado_gb = excluded.usado_gb, tools = excluded.tools, tools_estado = excluded.tools_estado, ip = excluded.ip, actualizado = v_ahora;
      delete from virt_vms where actualizado < v_ahora;
    end if;
    if jsonb_typeof(p_datos -> 'snapshots') = 'array' then
      insert into virt_snapshots (vm, nombre, creado, tamano_gb, actualizado)
      select left(x.vm, 200), left(coalesce(nullif(x.nombre, ''), '(sin nombre)'), 200), x.creado, x.tamano_gb, v_ahora
        from jsonb_to_recordset(p_datos -> 'snapshots') as x(vm text, nombre text, creado timestamptz, tamano_gb numeric)
       where coalesce(x.vm, '') <> '' and x.creado is not null
      on conflict (vm, nombre, creado) do update set tamano_gb = excluded.tamano_gb, actualizado = v_ahora;
      delete from virt_snapshots where actualizado < v_ahora;
    end if;
    if jsonb_typeof(p_datos -> 'datastores') = 'array' then
      insert into virt_datastores (nombre, tipo, capacidad_gb, libre_gb, estado, hosts, actualizado)
      select left(x.nombre, 200), x.tipo, x.capacidad_gb, x.libre_gb, x.estado, x.hosts, v_ahora
        from jsonb_to_recordset(p_datos -> 'datastores') as x(nombre text, tipo text, capacidad_gb numeric, libre_gb numeric, estado text, hosts int)
       where coalesce(x.nombre, '') <> ''
      on conflict (nombre) do update set tipo = excluded.tipo, capacidad_gb = excluded.capacidad_gb, libre_gb = excluded.libre_gb, estado = excluded.estado,
        hosts = excluded.hosts, actualizado = v_ahora;
      delete from virt_datastores where actualizado < v_ahora;
      insert into virt_capacidad (fecha, tipo, nombre, capacidad_gb, libre_gb)
      select (v_ahora at time zone 'America/Argentina/Buenos_Aires')::date, 'datastore', nombre, capacidad_gb, libre_gb from virt_datastores
      on conflict (fecha, tipo, nombre) do update set capacidad_gb = excluded.capacidad_gb, libre_gb = excluded.libre_gb;
    end if;
    if jsonb_typeof(p_datos -> 'alarmas') = 'array' then
      delete from virt_alarmas where actualizado <= v_ahora;
      insert into virt_alarmas (alarma, entidad, tipo, estado, fecha, reconocida, actualizado)
      select left(x.alarma, 200), left(x.entidad, 200), x.tipo, x.estado, x.fecha, x.reconocida, v_ahora
        from jsonb_to_recordset(p_datos -> 'alarmas') as x(alarma text, entidad text, tipo text, estado text, fecha timestamptz, reconocida boolean);
    end if;
    if jsonb_typeof(p_datos -> 'licencias') = 'array' then
      insert into virt_licencias (producto, edicion, usado, total, vence, actualizado)
      select distinct on (left(x.producto, 200), coalesce(x.edicion, '')) left(x.producto, 200), coalesce(x.edicion, ''), x.usado, x.total, x.vence, v_ahora
        from jsonb_to_recordset(p_datos -> 'licencias') as x(producto text, edicion text, usado numeric, total numeric, vence timestamptz)
       where coalesce(x.producto, '') <> ''
      on conflict (producto, edicion) do update set usado = excluded.usado, total = excluded.total, vence = excluded.vence, actualizado = v_ahora;
      delete from virt_licencias where actualizado < v_ahora;
    end if;
  end if;

  -- Storage
  if jsonb_typeof(s) = 'object' then
    update sto_sistema t set nombre = x.nombre, producto = x.producto, version = x.version, capacidad_gb = x.capacidad_gb, libre_gb = x.libre_gb, actualizado = v_ahora
      from jsonb_to_record(coalesce(s -> 'sistema', '{}')) as x(nombre text, producto text, version text, capacidad_gb numeric, libre_gb numeric) where t.id = 1;
    if jsonb_typeof(s -> 'pools') = 'array' then
      insert into sto_pools (nombre, estado, capacidad_gb, libre_gb, usado_gb, asignado_gb, actualizado)
      select left(x.nombre, 200), x.estado, x.capacidad_gb, x.libre_gb, x.usado_gb, x.asignado_gb, v_ahora
        from jsonb_to_recordset(s -> 'pools') as x(nombre text, estado text, capacidad_gb numeric, libre_gb numeric, usado_gb numeric, asignado_gb numeric)
       where coalesce(x.nombre, '') <> ''
      on conflict (nombre) do update set estado = excluded.estado, capacidad_gb = excluded.capacidad_gb, libre_gb = excluded.libre_gb,
        usado_gb = excluded.usado_gb, asignado_gb = excluded.asignado_gb, actualizado = v_ahora;
      delete from sto_pools where actualizado < v_ahora;
      insert into virt_capacidad (fecha, tipo, nombre, capacidad_gb, libre_gb)
      select (v_ahora at time zone 'America/Argentina/Buenos_Aires')::date, 'pool', nombre, capacidad_gb, libre_gb from sto_pools
      on conflict (fecha, tipo, nombre) do update set capacidad_gb = excluded.capacidad_gb, libre_gb = excluded.libre_gb;
    end if;
    if jsonb_typeof(s -> 'discos') = 'array' then
      insert into sto_discos (id, estado, uso, capacidad_gb, tecnologia, gabinete, bahia, arreglo, actualizado)
      select left(x.id, 40), x.estado, x.uso, x.capacidad_gb, x.tecnologia, x.gabinete, x.bahia, nullif(x.arreglo, ''), v_ahora
        from jsonb_to_recordset(s -> 'discos') as x(id text, estado text, uso text, capacidad_gb numeric, tecnologia text, gabinete text, bahia text, arreglo text)
       where coalesce(x.id, '') <> ''
      on conflict (id) do update set estado = excluded.estado, uso = excluded.uso, capacidad_gb = excluded.capacidad_gb, tecnologia = excluded.tecnologia,
        gabinete = excluded.gabinete, bahia = excluded.bahia, arreglo = excluded.arreglo, actualizado = v_ahora;
      delete from sto_discos where actualizado < v_ahora;
    end if;
    if jsonb_typeof(s -> 'componentes') = 'array' then
      insert into sto_componentes (tipo, id, estado, detalle, actualizado)
      select distinct on (x.tipo, left(x.id, 60)) x.tipo, left(x.id, 60), x.estado, nullif(x.detalle, ''), v_ahora
        from jsonb_to_recordset(s -> 'componentes') as x(tipo text, id text, estado text, detalle text)
       where coalesce(x.tipo, '') <> '' and coalesce(x.id, '') <> ''
      on conflict (tipo, id) do update set estado = excluded.estado, detalle = excluded.detalle, actualizado = v_ahora;
      delete from sto_componentes where actualizado < v_ahora;
    end if;
    if jsonb_typeof(s -> 'volumenes') = 'array' then
      insert into sto_volumenes (nombre, estado, capacidad_gb, pool, actualizado)
      select distinct on (left(x.nombre, 200)) left(x.nombre, 200), x.estado, x.capacidad_gb, nullif(x.pool, ''), v_ahora
        from jsonb_to_recordset(s -> 'volumenes') as x(nombre text, estado text, capacidad_gb numeric, pool text)
       where coalesce(x.nombre, '') <> ''
      on conflict (nombre) do update set estado = excluded.estado, capacidad_gb = excluded.capacidad_gb, pool = excluded.pool, actualizado = v_ahora;
      delete from sto_volumenes where actualizado < v_ahora;
    end if;
    if jsonb_typeof(s -> 'eventos') = 'array' then
      insert into sto_eventos (secuencia, fecha, objeto, codigo, evento, descripcion, actualizado)
      -- el storage informa la hora local sin zona
      select distinct on (left(x.secuencia, 40)) left(x.secuencia, 40), (nullif(x.fecha, '')::timestamp at time zone 'America/Argentina/Buenos_Aires'),
             x.objeto, nullif(x.codigo, ''), x.evento, left(x.descripcion, 300), v_ahora
        from jsonb_to_recordset(s -> 'eventos') as x(secuencia text, fecha text, objeto text, codigo text, evento text, descripcion text)
       where coalesce(x.secuencia, '') <> ''
      on conflict (secuencia) do update set fecha = excluded.fecha, objeto = excluded.objeto, codigo = excluded.codigo, evento = excluded.evento,
        descripcion = excluded.descripcion, actualizado = v_ahora;
      delete from sto_eventos where actualizado < v_ahora;
    end if;
  end if;

  delete from virt_capacidad where fecha < current_date - 400;
  update virt_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20),
         error_vcenter = left(p_datos ->> 'error_vcenter', 400), error_storage = left(p_datos ->> 'error_storage', 400),
         avisos = coalesce(p_datos -> 'avisos', '[]')
   where id = 1;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.virt_reportar(text, jsonb) from public;
grant execute on function public.virt_reportar(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Vulnerabilidades de ESXi y vCenter (NVD, por versión y update: 8.0.2 = 8.0 Update 2)
-- ----------------------------------------------------------
create or replace function public.virt_version_nvd(p_version text) returns text language sql immutable as $$
  select case when p_version ~ '^\d+\.\d+\.\d+' then
    substring(p_version from '^(\d+\.\d+)') || ':' ||
    case when split_part(p_version, '.', 3) = '0' then '-' else 'update' || split_part(p_version, '.', 3) end end
$$;

create or replace function public.virt_consultar_vulns(p_producto text, p_version text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_clave text; v_url text; r record; j jsonb; v_items jsonb; v_cpe text; v_nvd text := virt_version_nvd(p_version);
begin
  if to_regclass('public.vuln_consultas') is null or v_nvd is null then return 'sin_modulo'; end if;
  v_cpe := case p_producto when 'esxi' then 'vmware:esxi' else 'vmware:vcenter_server' end;
  select nullif(trim(nvd_api_key), '') into v_clave from vuln_config where id = 1;
  -- virtualMatchString: todas las variantes de esa versión y update (8.0 Update 2, 2a, 2b…)
  v_url := 'https://services.nvd.nist.gov/rest/json/cves/2.0?noRejected&resultsPerPage=500&virtualMatchString='
           || urlencode('cpe:2.3:' || case p_producto when 'esxi' then 'o' else 'a' end || ':' || v_cpe || ':' || v_nvd);
  begin
    begin perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000'); exception when others then null; end;
    if v_clave is not null then
      select * into r from http(('GET', v_url, array[http_header('apiKey', v_clave)], null, null)::http_request);
    else
      select * into r from http_get(v_url);
    end if;
  exception when others then
    insert into vuln_consultas (cpe, version, estado, error) values (v_cpe, p_version, 'error', left(sqlerrm, 300))
    on conflict (cpe, version) do update set consultado = now(), estado = 'error', error = excluded.error;
    return 'error';
  end;
  if r.status <> 200 then
    insert into vuln_consultas (cpe, version, estado, error) values (v_cpe, p_version, 'error', 'NVD respondió ' || r.status)
    on conflict (cpe, version) do update set consultado = now(), estado = 'error', error = excluded.error;
    return 'error';
  end if;
  j := r.content::jsonb;
  with v as (select x -> 'cve' as c from jsonb_array_elements(coalesce(j -> 'vulnerabilities', '[]')) x),
  m as (
    select c ->> 'id' as id,
           coalesce(c #> '{metrics,cvssMetricV40,0,cvssData}', c #> '{metrics,cvssMetricV31,0,cvssData}',
                    c #> '{metrics,cvssMetricV30,0,cvssData}', c #> '{metrics,cvssMetricV2,0,cvssData}') as cvss,
           c #>> '{metrics,cvssMetricV2,0,baseSeverity}' as sev_v2, c ? 'cisaExploitAdd' as kev, c ->> 'cisaRequiredAction' as accion,
           (select d ->> 'value' from jsonb_array_elements(coalesce(c -> 'descriptions', '[]')) d
             order by (d ->> 'lang' = 'es') desc, (d ->> 'lang' = 'en') desc limit 1) as descripcion
      from v),
  f as (select id, (cvss ->> 'baseScore')::numeric as puntaje, upper(coalesce(cvss ->> 'baseSeverity', sev_v2, '')) as severidad, kev, accion, descripcion from m)
  select jsonb_build_object('total', count(*), 'criticas', count(*) filter (where severidad = 'CRITICAL'),
           'altas', count(*) filter (where severidad = 'HIGH'), 'kev', count(*) filter (where kev), 'max', max(puntaje),
           'cves', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'cvss', puntaje, 'severidad', severidad, 'kev', kev,
                                                                'descripcion', left(descripcion, 300), 'accion', accion))
                               from (select * from f order by kev desc, puntaje desc nulls last, id desc limit 50) t), '[]'))
    into v_items from f;
  insert into vuln_consultas (cpe, version, estado, total, criticas, altas, kev, max_cvss, cves)
  values (v_cpe, p_version, case when (v_items ->> 'total')::int = 0 then 'sin_datos' else 'ok' end,
          (v_items ->> 'total')::int, (v_items ->> 'criticas')::int, (v_items ->> 'altas')::int, (v_items ->> 'kev')::int,
          (v_items ->> 'max')::numeric, v_items -> 'cves')
  on conflict (cpe, version) do update set consultado = now(), estado = excluded.estado, error = null, total = excluded.total,
    criticas = excluded.criticas, altas = excluded.altas, kev = excluded.kev, max_cvss = excluded.max_cvss, cves = excluded.cves;
  return 'ok';
end $$;
revoke all on function public.virt_consultar_vulns(text, text) from public, anon, authenticated;

create or replace function public.virt_vulns_procesar()
returns void language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if to_regclass('public.vuln_consultas') is null then return; end if;
  for r in
    select p, v from (select distinct 'esxi' as p, version as v from virt_hosts where version is not null
                      union select 'vcenter', version from virt_vcenter where version is not null) x
      left join vuln_consultas q on q.cpe = case x.p when 'esxi' then 'vmware:esxi' else 'vmware:vcenter_server' end and q.version = x.v
     where q.cpe is null or q.consultado < now() - interval '1 day' or (q.estado = 'error' and q.consultado < now() - interval '1 hour')
  loop
    if n > 0 then perform pg_sleep(6.5); end if;
    perform virt_consultar_vulns(r.p, r.v);
    n := n + 1;
  end loop;
end $$;
revoke all on function public.virt_vulns_procesar() from public, anon, authenticated;

do $$ begin
  begin perform cron.unschedule('accusys-virtualizacion-vulns'); exception when others then null; end;
  perform cron.schedule('accusys-virtualizacion-vulns', '27 * * * *', 'select public.virt_vulns_procesar()');
exception when others then
  raise notice 'La consulta de vulnerabilidades de VMware no quedó programada (falta pg_cron): %', sqlerrm;
end $$;

-- Quien ve Servidores también ve las vulnerabilidades de VMware (el resto sigue siendo de Seguridad)
do $$
begin
  if to_regclass('public.vuln_consultas') is null then return; end if;
  drop policy if exists vuln_consultas_vmware on public.vuln_consultas;
  create policy vuln_consultas_vmware on public.vuln_consultas for select to authenticated
    using (cpe in ('vmware:esxi', 'vmware:vcenter_server') and puede_ver('servidores'));
end $$;

-- ----------------------------------------------------------
-- Vistas
-- ----------------------------------------------------------
-- Cuándo se llena cada datastore / pool (tendencia de los últimos 30 días)
create or replace view public.virt_proyeccion with (security_invoker = true) as
select tipo, nombre, max(capacidad_gb) filter (where fecha = ult) as capacidad_gb, max(libre_gb) filter (where fecha = ult) as libre_gb,
       round(regr_slope(capacidad_gb - libre_gb, fecha - date '2000-01-01')::numeric, 2) as crecimiento_gb_dia,
       case when regr_slope(capacidad_gb - libre_gb, fecha - date '2000-01-01') > 0.5 and count(*) >= 7
            then floor(max(libre_gb) filter (where fecha = ult) / regr_slope(capacidad_gb - libre_gb, fecha - date '2000-01-01'))::int end as dias_para_llenarse
  from (select *, max(fecha) over (partition by tipo, nombre) as ult from virt_capacidad where fecha > current_date - 30) x
 group by tipo, nombre;

create or replace view public.virt_hallazgos with (security_invoker = true) as
with c as (select * from virt_config where id = 1)
-- Hosts
select 'host'::text as ambito, nombre as clave, 'host_caido'::text as tipo, 'critica'::text as severidad,
       'Host sin conexión: ' || nombre as titulo, 'Estado en vCenter: ' || coalesce(estado, '—') || '. Las VMs que no se reiniciaron en otro host están caídas.' as detalle
  from virt_hosts where estado in ('Disconnected', 'NotResponding')
union all
select 'host', nombre, 'host_mantenimiento', 'media', 'Host en modo mantenimiento: ' || nombre, 'Si terminó el trabajo, sacalo de mantenimiento para recuperar capacidad del cluster.'
  from virt_hosts where estado = 'Maintenance'
union all
select 'host', nombre, 'host_salud', case when salud = 'red' or exists (select 1 from jsonb_array_elements(sensores) s where s ->> 'estado' = 'red') then 'alta' else 'media' end, 'Problema de hardware en ' || nombre,
       coalesce((select string_agg((s ->> 'nombre') || ' (' || (s ->> 'estado') || ')', ', ') from jsonb_array_elements(sensores) s), 'Estado general ' || salud)
  from virt_hosts where salud in ('red', 'yellow') or jsonb_array_length(sensores) > 0
union all
select 'host', nombre, 'ssh', 'alta', 'SSH habilitado en ' || nombre,
       'El servicio SSH está ' || case when ssh_activo then 'corriendo' else 'configurado para arrancar' end || '. Es la puerta de entrada típica del ransomware para ESXi: dejalo apagado y encendelo solo para soporte.'
  from virt_hosts where ssh_activo or ssh_politica = 'on'
union all
select 'host', nombre, 'shell', 'alta', 'ESXi Shell habilitada en ' || nombre, 'Apagala: permite ejecutar comandos en el host.'
  from virt_hosts where shell_activo or shell_politica = 'on'
union all
select 'host', nombre, 'lockdown', 'media', 'Modo lockdown desactivado en ' || nombre,
       'Con lockdown activo el host solo se administra desde vCenter: nadie puede entrar directo aunque tenga una contraseña.'
  from virt_hosts where lockdown = 'lockdownDisabled'
union all
select 'host', nombre, 'cert', case when cert_vence < now() then 'alta' else 'media' end,
       case when cert_vence < now() then 'Certificado vencido en ' else 'Certificado por vencer en ' end || nombre,
       'Vence el ' || to_char(cert_vence at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') || '.'
  from virt_hosts where cert_vence < now() + make_interval(days => (select dias_aviso from c))
union all
select 'host', 'versiones', 'versiones_mezcladas', 'media', 'Los hosts tienen versiones distintas de ESXi',
       string_agg(distinct version || ' build ' || build, ', ') || '. Conviene que todo el cluster esté en el mismo parche.'
  from virt_hosts having count(distinct version || build) > 1
union all
-- Vulnerabilidades
select 'host', 'vuln:' || x.p || ':' || x.v, 'vulnerable', case when q.kev > 0 then 'critica' else 'alta' end,
       case x.p when 'esxi' then 'ESXi ' else 'vCenter ' end || x.v || ' con vulnerabilidades ' || case when q.kev > 0 then 'explotadas' else 'críticas' end,
       q.total || ' vulnerabilidades publicadas para esta versión' ||
       case when q.kev > 0 then ', ' || q.kev || ' explotadas activamente (CISA KEV)' else ', ' || q.criticas || ' críticas' end ||
       '. Revisá el build contra el aviso de Broadcom (VMSA): si ya tenés el parche, no aplica.'
  from (select distinct 'esxi' as p, version as v from virt_hosts where version is not null
        union select 'vcenter', version from virt_vcenter where version is not null) x
  join vuln_consultas q on q.cpe = case x.p when 'esxi' then 'vmware:esxi' else 'vmware:vcenter_server' end and q.version = x.v
 where q.kev > 0 or q.criticas > 0
union all
-- Datastores
select 'datastore', nombre, 'lleno', case when libre_gb < capacidad_gb * 0.05 then 'critica' else 'alta' end, 'Datastore casi lleno: ' || nombre,
       round(100 - 100 * libre_gb / nullif(capacidad_gb, 0)) || '% usado · quedan ' || round(libre_gb) || ' GB. Si se llena, las VMs con discos que crecen se detienen.'
  from virt_datastores where capacidad_gb > 0 and 100 - 100 * libre_gb / capacidad_gb >= (select pct_lleno from c)
union all
select 'datastore', nombre, 'ds_estado', 'alta', 'Datastore no disponible: ' || nombre, 'Estado: ' || coalesce(estado, '—')
  from virt_datastores where estado is distinct from 'Available'
union all
select p.tipo, p.nombre, 'se_llena', case when p.dias_para_llenarse < 15 then 'alta' else 'media' end,
       case p.tipo when 'pool' then 'Pool del storage' else 'Datastore' end || ' ' || p.nombre || ' se llena en ~' || p.dias_para_llenarse || ' días',
       'Crece ' || p.crecimiento_gb_dia || ' GB por día (últimos 30 días) y quedan ' || round(p.libre_gb) || ' GB.'
  from virt_proyeccion p where p.dias_para_llenarse < 45
union all
-- VMs
select 'vm', vm || ':' || nombre, 'snapshot', case when creado < now() - interval '30 days' or tamano_gb > 100 then 'alta' else 'media' end,
       'Snapshot viejo en ' || vm || ': ' || nombre,
       'Creado hace ' || (now()::date - creado::date) || ' días · ' || coalesce(round(tamano_gb) || ' GB', '—') ||
       '. Los snapshots no son backup: crecen, ocupan el datastore y degradan el rendimiento. Consolidalo o borralo.'
  from virt_snapshots where creado < now() - make_interval(days => (select dias_snapshot from c))
union all
select 'vm', nombre, 'tools', 'baja', 'VMware Tools ' || case tools when 'guestToolsNotInstalled' then 'no instaladas' else 'desactualizadas' end || ' en ' || nombre,
       coalesce(so, '') || '. Las Tools traen drivers y correcciones de seguridad.'
  from virt_vms where estado = 'PoweredOn' and tools in ('guestToolsNeedUpgrade', 'guestToolsNotInstalled', 'guestToolsSupportedOld', 'guestToolsTooOld', 'guestToolsBlacklisted')
union all
-- Alarmas y licencias
select 'alarma', coalesce(entidad, '') || ':' || coalesce(alarma, ''), 'alarma', case when estado = 'red' then 'alta' else 'media' end,
       'Alarma de vCenter en ' || coalesce(entidad, '—') || ': ' || coalesce(alarma, '—'),
       'Desde ' || to_char(fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') || case when reconocida then ' · reconocida' else '' end
  from virt_alarmas where estado in ('red', 'yellow')
union all
select 'licencia', producto || ':' || edicion, 'licencia', case when vence < now() then 'alta' else 'media' end,
       case when vence < now() then 'Licencia vencida: ' else 'Licencia por vencer: ' end || producto,
       'Vence el ' || to_char(vence at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') || '.'
  from virt_licencias where vence < now() + make_interval(days => (select dias_aviso from c))
union all
-- Storage
select 'storage', id, 'disco', 'critica', 'Disco con falla en el storage: ' || id,
       'Estado ' || coalesce(estado, '—') || ' · uso ' || coalesce(uso, '—') || ' · gabinete ' || coalesce(gabinete, '—') || ', bahía ' || coalesce(bahia, '—') ||
       '. Reemplazalo cuanto antes: el arreglo queda sin protección ante otra falla.'
  from sto_discos where estado is distinct from 'online' or uso = 'failed'
union all
select 'storage', 'repuesto', 'sin_repuesto', 'media', 'El storage no tiene discos de repuesto (spare)',
       'Si falla un disco, la reconstrucción no arranca sola.'
  from sto_sistema where exists (select 1 from sto_discos) and not exists (select 1 from sto_discos where uso = 'spare')
union all
select 'storage', tipo || ':' || id, 'componente', case when tipo in ('nodo', 'arreglo') then 'critica' else 'alta' end,
       case tipo when 'nodo' then 'Nodo del storage' when 'fuente' then 'Fuente del storage' when 'bateria' then 'Batería del storage'
                 when 'arreglo' then 'Arreglo (RAID)' else 'Gabinete' end || ' con problema: ' || id,
       'Estado ' || coalesce(estado, '—') || coalesce(' · ' || detalle, '')
  from sto_componentes where estado is distinct from 'online'
union all
select 'storage', nombre, 'pool_lleno', case when libre_gb < capacidad_gb * 0.05 then 'critica' else 'alta' end, 'Pool del storage casi lleno: ' || nombre,
       round(100 - 100 * libre_gb / nullif(capacidad_gb, 0)) || '% usado · quedan ' || round(libre_gb) || ' GB' ||
       case when asignado_gb > capacidad_gb then ' · sobreasignado: se prometieron ' || round(asignado_gb) || ' GB' else '' end || '.'
  from sto_pools where capacidad_gb > 0 and 100 - 100 * libre_gb / capacidad_gb >= (select pct_lleno from c)
union all
select 'storage', nombre, 'pool_estado', 'critica', 'Pool del storage con problema: ' || nombre, 'Estado ' || coalesce(estado, '—')
  from sto_pools where estado is distinct from 'online'
union all
select 'storage', nombre, 'volumen', 'alta', 'Volumen del storage con problema: ' || nombre, 'Estado ' || coalesce(estado, '—') || coalesce(' · pool ' || pool, '')
  from sto_volumenes where estado is distinct from 'online'
union all
select 'storage', 'evento:' || secuencia, 'evento', 'alta', 'Evento abierto en el storage: ' || coalesce(descripcion, '—'),
       concat_ws(' · ', objeto, 'código ' || codigo, to_char(fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'))
  from sto_eventos;

create or replace view public.virt_hosts_vista with (security_invoker = true) as
select h.*, q.estado as vuln_estado, q.total as vuln_total, q.criticas as vuln_criticas, q.kev as vuln_kev, q.cves as vuln_cves,
       (select count(*) from virt_vms v where v.host = h.nombre) as vms, (select count(*) from virt_vms v where v.host = h.nombre and v.estado = 'PoweredOn') as vms_encendidas
  from virt_hosts h left join vuln_consultas q on q.cpe = 'vmware:esxi' and q.version = h.version;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.virt_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('servidores') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'version_puente', version_puente,
    'error_vcenter', error_vcenter, 'error_storage', error_storage, 'avisos', avisos,
    'alertas', alertas, 'pct_lleno', pct_lleno, 'dias_snapshot', dias_snapshot, 'dias_aviso', dias_aviso, 'minutos_sin_reporte', minutos_sin_reporte)
  end from virt_config where id = 1
$$;
revoke execute on function public.virt_estado() from public, anon;
grant execute on function public.virt_estado() to authenticated;

create or replace function public.virt_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update virt_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.virt_nuevo_puente(text) from public, anon;
grant execute on function public.virt_nuevo_puente(text) to authenticated;

create or replace function public.virt_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update virt_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    pct_lleno = coalesce((p ->> 'pct_lleno')::int, pct_lleno),
    dias_snapshot = coalesce((p ->> 'dias_snapshot')::int, dias_snapshot),
    dias_aviso = coalesce((p ->> 'dias_aviso')::int, dias_aviso),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte)
  where id = 1;
end $$;
revoke execute on function public.virt_config_guardar(jsonb) from public, anon;
grant execute on function public.virt_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.virt_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c virt_config;
begin
  select * into c from virt_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  if c.ultimo_reporte is null or c.ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte) then
    insert into _cond values ('virt:puente', 'virtualizacion', 'alta', 'El puente de virtualización y storage dejó de reportar',
      coalesce('Último reporte ' || to_char(c.ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'), '/servidores/virtualizacion')
    on conflict do nothing;
    return;
  end if;
  if c.error_vcenter is not null then
    insert into _cond values ('virt:err:vcenter', 'virtualizacion', 'alta', 'No se pudo leer vCenter', left(c.error_vcenter, 250), '/servidores/virtualizacion')
    on conflict do nothing;
  end if;
  if c.error_storage is not null then
    insert into _cond values ('virt:err:storage', 'virtualizacion', 'alta', 'No se pudo leer el storage', left(c.error_storage, 250), '/servidores/storage')
    on conflict do nothing;
  end if;

  insert into _cond select 'virt:' || ambito || ':' || tipo || ':' || clave, 'virtualizacion', severidad, titulo, left(detalle, 250),
         case when ambito = 'storage' or (ambito = 'pool') then '/servidores/storage' else '/servidores/virtualizacion' end
    from virt_hallazgos where severidad in ('critica', 'alta')
  on conflict do nothing;
end $$;
revoke all on function public.virt_condiciones_alertas() from public, anon, authenticated;

-- Gancho común (los demás módulos sin cambios)
create or replace function public.alertas_condiciones_extra()
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.backups_condiciones_alertas()') is not null then perform backups_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_condiciones_alertas()') is not null then perform srv_condiciones_alertas(); end if;
  if to_regprocedure('public.unifi_condiciones_alertas()') is not null then perform unifi_condiciones_alertas(); end if;
  if to_regprocedure('public.sw_condiciones_alertas()') is not null then perform sw_condiciones_alertas(); end if;
  if to_regprocedure('public.fg_condiciones_alertas()') is not null then perform fg_condiciones_alertas(); end if;
  if to_regprocedure('public.ad_condiciones_alertas()') is not null then perform ad_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_accesos_condiciones_alertas()') is not null then perform srv_accesos_condiciones_alertas(); end if;
  if to_regprocedure('public.virt_condiciones_alertas()') is not null then perform virt_condiciones_alertas(); end if;
end $$;
revoke all on function public.alertas_condiciones_extra() from public, anon, authenticated;

do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_evaluar(boolean)') is null then return; end if;
  v_def := pg_get_functiondef('public.alertas_evaluar(boolean)'::regprocedure);
  if position('alertas_condiciones_extra' in v_def) > 0 then return; end if;
  if position('-- Abrir las nuevas' in v_def) = 0 then return; end if;
  v_def := replace(v_def, '-- Abrir las nuevas',
    E'-- Condiciones de otros módulos\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
  execute v_def;
end $$;

-- ----------------------------------------------------------
-- Permisos: se ve con la solapa Servidores; los datos los escribe solo el puente
-- ----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['virt_vcenter', 'virt_hosts', 'virt_vms', 'virt_snapshots', 'virt_datastores', 'virt_alarmas', 'virt_licencias', 'virt_capacidad',
                           'sto_sistema', 'sto_pools', 'sto_discos', 'sto_componentes', 'sto_volumenes', 'sto_eventos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''servidores''))', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter table public.virt_config enable row level security;
revoke all on public.virt_config from anon, authenticated;
grant select on public.virt_hallazgos, public.virt_proyeccion, public.virt_hosts_vista to authenticated;

do $$
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  drop trigger if exists trg_auditoria on public.virt_config;
  create trigger trg_auditoria after insert or update or delete on public.virt_config for each row execute function public.auditar();
end $$;
