-- ==========================================================
-- VULNERABILIDADES DEL SOFTWARE INSTALADO
--   * Cruza las aplicaciones que informa el agente con la base oficial de
--     vulnerabilidades de EE.UU. (NVD, del NIST), por producto y VERSIÓN exacta.
--   * Marca las que están siendo explotadas activamente (catálogo KEV de CISA,
--     que NVD informa en cada vulnerabilidad).
--   * La base consulta sola en segundo plano (cada 10 minutos, de a pocos para
--     respetar el límite de NVD) y guarda cada resultado 7 días.
--   * Qué aplicaciones se controlan se define en una lista editable desde la app.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de vencimientos.sql.
-- ==========================================================

create extension if not exists http with schema extensions;

create table if not exists public.vuln_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default true,
  nvd_api_key text,               -- opcional: con clave, NVD permite 10 veces más consultas
  dias_cache int not null default 7 check (dias_cache between 1 and 60),
  ultima_corrida timestamptz,
  ultimo_error text
);
insert into public.vuln_config (id) values (1) on conflict (id) do nothing;

-- Qué aplicación corresponde a qué producto de la base oficial (CPE "fabricante:producto")
create table if not exists public.vuln_productos (
  id serial primary key,
  patron text not null,                 -- nombre de la app como aparece en Aplicaciones (admite % como comodín)
  excluir text,                         -- opcional: patrón a excluir
  cpe text not null check (cpe ~ '^[a-z0-9._\\+-]+:[a-z0-9._\\+-]+$'),
  version_regex text not null default '^[0-9]+(\.[0-9]+)*',   -- qué parte de la versión usar
  activo boolean not null default true,
  unique (patron, cpe)
);

insert into public.vuln_productos (patron, excluir, cpe, version_regex)
select * from (values
  ('Google Chrome', null, 'google:chrome', '^[0-9]+(\.[0-9]+)*'),
  ('Microsoft Edge', null, 'microsoft:edge_chromium', '^[0-9]+(\.[0-9]+)*'),
  ('Mozilla Firefox%', '%ESR%', 'mozilla:firefox', '^[0-9]+(\.[0-9]+)*'),
  ('Mozilla Firefox%ESR%', null, 'mozilla:firefox_esr', '^[0-9]+(\.[0-9]+)*'),
  ('Adobe Acrobat%', null, 'adobe:acrobat_reader_dc', '^[0-9]+(\.[0-9]+)*'),
  ('7-Zip%', null, '7-zip:7-zip', '^[0-9]+\.[0-9]+'),
  ('WinRAR%', null, 'rarlab:winrar', '^[0-9]+\.[0-9]+'),
  ('VLC media player', null, 'videolan:vlc_media_player', '^[0-9]+(\.[0-9]+)*'),
  ('Notepad++%', null, 'notepad-plus-plus:notepad\+\+', '^[0-9]+(\.[0-9]+)*'),
  ('PuTTY%', null, 'putty:putty', '^[0-9]+\.[0-9]+'),
  ('WinSCP%', null, 'winscp:winscp', '^[0-9]+(\.[0-9]+)*'),
  ('FileZilla%', null, 'filezilla-project:filezilla_client', '^[0-9]+(\.[0-9]+)*'),
  ('TeamViewer%', null, 'teamviewer:teamviewer', '^[0-9]+(\.[0-9]+)*'),
  ('AnyDesk', null, 'anydesk:anydesk', '^[0-9]+(\.[0-9]+)*'),
  ('Wireshark%', null, 'wireshark:wireshark', '^[0-9]+(\.[0-9]+)*'),
  ('Git', null, 'git-scm:git', '^[0-9]+(\.[0-9]+)*'),
  ('Node.js', null, 'nodejs:node.js', '^[0-9]+(\.[0-9]+)*'),
  ('Microsoft Visual Studio Code%', null, 'microsoft:visual_studio_code', '^[0-9]+(\.[0-9]+)*'),
  ('VMware Workstation', null, 'vmware:workstation', '^[0-9]+(\.[0-9]+)*'),
  ('Oracle VM VirtualBox%', null, 'oracle:vm_virtualbox', '^[0-9]+(\.[0-9]+)*'),
  ('KeePass%', null, 'keepass:keepass', '^[0-9]+(\.[0-9]+)*'),
  ('FortiClient%', null, 'fortinet:forticlient', '^[0-9]+\.[0-9]+\.[0-9]+'),
  ('Docker Desktop', null, 'docker:desktop', '^[0-9]+(\.[0-9]+)*'),
  ('Foxit PDF Reader%', null, 'foxit:pdf_reader', '^[0-9]+(\.[0-9]+)*')
) v(patron, excluir, cpe, version_regex)
where not exists (select 1 from public.vuln_productos);

-- Resultado por producto y versión
create table if not exists public.vuln_consultas (
  cpe text not null,
  version text not null,
  consultado timestamptz not null default now(),
  estado text not null check (estado in ('ok', 'sin_datos', 'error')),
  error text,
  total int not null default 0,
  criticas int not null default 0,
  altas int not null default 0,
  kev int not null default 0,          -- explotadas activamente
  max_cvss numeric(3,1),
  cves jsonb not null default '[]',    -- las 50 más importantes: [{id, cvss, severidad, kev, descripcion, accion}]
  primary key (cpe, version)
);

-- Qué equipo tiene qué aplicación controlada, con su resultado
create or replace view public.vuln_v_equipos with (security_invoker = true) as
select d.id as dispositivo_id, d.hostname, d.usuario, d.equipo_id,
       a.nombre as aplicacion, a.version as version_instalada,
       p.cpe, substring(a.version from '(' || p.version_regex || ')') as version,
       c.estado, c.consultado, c.total, c.criticas, c.altas, c.kev, c.max_cvss
  from inv_dispositivo_apps a
  join inv_dispositivos d on d.id = a.dispositivo_id
  join vuln_productos p on p.activo and a.nombre ilike p.patron and (p.excluir is null or a.nombre not ilike p.excluir)
  left join vuln_consultas c on c.cpe = p.cpe and c.version = substring(a.version from '(' || p.version_regex || ')')
 where substring(a.version from '(' || p.version_regex || ')') is not null;

-- Resumen por aplicación y versión (lo que muestra la pantalla)
create or replace view public.vuln_v_resumen with (security_invoker = true) as
select cpe, version, min(aplicacion) as aplicacion, count(distinct dispositivo_id)::int as equipos,
       max(estado) as estado, max(consultado) as consultado,
       max(total) as total, max(criticas) as criticas, max(altas) as altas, max(kev) as kev, max(max_cvss) as max_cvss
  from vuln_v_equipos
 group by cpe, version;

-- ----------------------------------------------------------
-- Consulta a NVD (la corre la base sola, de a pocos)
-- ----------------------------------------------------------
create or replace function public.vuln_consultar(p_cpe text, p_version text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_clave text;
  v_cpe text;
  v_url text;
  r record;
  j jsonb;
  v_items jsonb;
begin
  select nullif(trim(nvd_api_key), '') into v_clave from vuln_config where id = 1;
  -- En CPE, los caracteres especiales de la versión van con barra invertida
  v_cpe := 'cpe:2.3:a:' || p_cpe || ':' || regexp_replace(p_version, '([^A-Za-z0-9._-])', '\\\1', 'g') || ':*:*:*:*:*:*:*';
  v_url := 'https://services.nvd.nist.gov/rest/json/cves/2.0?noRejected&isVulnerable&resultsPerPage=500&cpeName=' || urlencode(v_cpe);

  begin
    begin
      perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000');
    exception when others then null;
    end;
    if v_clave is not null then
      select * into r from http(('GET', v_url, array[http_header('apiKey', v_clave)], null, null)::http_request);
    else
      select * into r from http_get(v_url);
    end if;
  exception when others then
    insert into vuln_consultas (cpe, version, estado, error) values (p_cpe, p_version, 'error', left(sqlerrm, 300))
    on conflict (cpe, version) do update set consultado = now(), estado = 'error', error = excluded.error;
    return 'error';
  end;

  if r.status = 404 then
    insert into vuln_consultas (cpe, version, estado) values (p_cpe, p_version, 'sin_datos')
    on conflict (cpe, version) do update set consultado = now(), estado = 'sin_datos', error = null,
      total = 0, criticas = 0, altas = 0, kev = 0, max_cvss = null, cves = '[]';
    return 'sin_datos';
  elsif r.status <> 200 then
    insert into vuln_consultas (cpe, version, estado, error) values (p_cpe, p_version, 'error', 'NVD respondió ' || r.status)
    on conflict (cpe, version) do update set consultado = now(), estado = 'error', error = excluded.error;
    return 'error';
  end if;

  j := r.content::jsonb;

  -- Una fila por vulnerabilidad: puntaje (CVSS 4.0, 3.1, 3.0 o 2), si está en KEV y descripción
  with v as (
    select x->'cve' as c from jsonb_array_elements(coalesce(j->'vulnerabilities', '[]')) x
  ), m as (
    select c->>'id' as id,
           coalesce(c#>'{metrics,cvssMetricV40,0,cvssData}', c#>'{metrics,cvssMetricV31,0,cvssData}',
                    c#>'{metrics,cvssMetricV30,0,cvssData}', c#>'{metrics,cvssMetricV2,0,cvssData}') as cvss,
           c#>>'{metrics,cvssMetricV2,0,baseSeverity}' as sev_v2,
           c ? 'cisaExploitAdd' as kev,
           c->>'cisaRequiredAction' as accion,
           (select d->>'value' from jsonb_array_elements(coalesce(c->'descriptions', '[]')) d
             order by (d->>'lang' = 'es') desc, (d->>'lang' = 'en') desc limit 1) as descripcion
      from v
  ), f as (
    select id, (cvss->>'baseScore')::numeric as puntaje,
           upper(coalesce(cvss->>'baseSeverity', sev_v2, '')) as severidad, kev, accion, descripcion
      from m
  )
  select jsonb_build_object(
           'total', count(*),
           'criticas', count(*) filter (where severidad = 'CRITICAL'),
           'altas', count(*) filter (where severidad = 'HIGH'),
           'kev', count(*) filter (where kev),
           'max', max(puntaje),
           'cves', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'cvss', puntaje, 'severidad', severidad, 'kev', kev,
                                                                'descripcion', left(descripcion, 300), 'accion', accion))
                               from (select * from f order by kev desc, puntaje desc nulls last, id desc limit 50) t), '[]'))
    into v_items
    from f;

  insert into vuln_consultas (cpe, version, estado, total, criticas, altas, kev, max_cvss, cves)
  values (p_cpe, p_version, case when (v_items->>'total')::int = 0 then 'sin_datos' else 'ok' end,
          (v_items->>'total')::int, (v_items->>'criticas')::int, (v_items->>'altas')::int, (v_items->>'kev')::int,
          (v_items->>'max')::numeric, v_items->'cves')
  on conflict (cpe, version) do update set
    consultado = now(), estado = excluded.estado, error = null, total = excluded.total, criticas = excluded.criticas,
    altas = excluded.altas, kev = excluded.kev, max_cvss = excluded.max_cvss, cves = excluded.cves;
  return 'ok';
end $$;
revoke all on function public.vuln_consultar(text, text) from public, anon, authenticated;

-- Procesa las versiones pendientes (nunca consultadas o vencidas), las más usadas primero
create or replace function public.vuln_procesar(p_max int default 5)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c vuln_config;
  r record;
  n int := 0;
  errores int := 0;
  v_pausa numeric;
begin
  select * into c from vuln_config where id = 1;
  if not c.activo then
    return jsonb_build_object('procesadas', 0, 'motivo', 'desactivado');
  end if;
  -- NVD pide 6 segundos entre consultas sin clave (menos de 1 con clave)
  v_pausa := case when nullif(trim(c.nvd_api_key), '') is null then 6.5 else 0.8 end;

  for r in
    select e.cpe, e.version, count(distinct e.dispositivo_id) as equipos
      from vuln_v_equipos e
      left join vuln_consultas q on q.cpe = e.cpe and q.version = e.version
     where q.cpe is null
        or q.consultado < now() - make_interval(days => c.dias_cache)
        or (q.estado = 'error' and q.consultado < now() - interval '1 hour')
     group by e.cpe, e.version, q.consultado
     order by q.consultado nulls first, count(distinct e.dispositivo_id) desc
     limit greatest(1, least(p_max, 60))
  loop
    if n > 0 then perform pg_sleep(v_pausa); end if;
    if vuln_consultar(r.cpe, r.version) = 'error' then errores := errores + 1; end if;
    n := n + 1;
  end loop;

  update vuln_config set ultima_corrida = now(),
    ultimo_error = case when errores > 0 then errores || ' consultas con error en la última corrida' end
  where id = 1;
  return jsonb_build_object('procesadas', n, 'errores', errores);
end $$;
revoke all on function public.vuln_procesar(int) from public, anon, authenticated;

-- Para la pantalla: estado general (sin mostrar la clave) y acciones del admin
create or replace function public.vuln_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'activo', c.activo, 'con_clave', nullif(trim(c.nvd_api_key), '') is not null, 'dias_cache', c.dias_cache,
    'ultima_corrida', c.ultima_corrida, 'ultimo_error', c.ultimo_error,
    'pendientes', (select count(*) from (select distinct e.cpe, e.version from vuln_v_equipos e
                     left join vuln_consultas q on q.cpe = e.cpe and q.version = e.version
                    where q.cpe is null or q.consultado < now() - make_interval(days => c.dias_cache)) x))
  from vuln_config c where c.id = 1 and puede_ver('seguridad')
$$;
grant execute on function public.vuln_estado() to authenticated;

create or replace function public.vuln_guardar_clave(p_clave text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if nullif(trim(p_clave), '') is not null and trim(p_clave) !~ '^[A-Za-z0-9-]{20,64}$' then
    raise exception 'La clave de NVD tiene un formato inválido';
  end if;
  update vuln_config set nvd_api_key = nullif(trim(p_clave), '') where id = 1;
end $$;
grant execute on function public.vuln_guardar_clave(text) to authenticated;

create or replace function public.vuln_reanalizar()
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update vuln_consultas set consultado = now() - interval '365 days';
end $$;
grant execute on function public.vuln_reanalizar() to authenticated;

-- ----------------------------------------------------------
-- Permisos: lo ve quien tiene Seguridad; la lista de productos la edita el admin
-- ----------------------------------------------------------
alter table public.vuln_config enable row level security;
alter table public.vuln_productos enable row level security;
alter table public.vuln_consultas enable row level security;
revoke all on public.vuln_config from anon, authenticated;

drop policy if exists vuln_productos_select on public.vuln_productos;
create policy vuln_productos_select on public.vuln_productos for select to authenticated using (puede_ver('seguridad'));
drop policy if exists vuln_productos_admin on public.vuln_productos;
create policy vuln_productos_admin on public.vuln_productos for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

drop policy if exists vuln_consultas_select on public.vuln_consultas;
create policy vuln_consultas_select on public.vuln_consultas for select to authenticated using (puede_ver('seguridad'));
revoke insert, update, delete on public.vuln_consultas from anon, authenticated;

drop trigger if exists trg_auditoria on public.vuln_productos;
create trigger trg_auditoria after insert or update or delete on public.vuln_productos
  for each row execute function public.auditar();

-- Consulta automática cada 10 minutos (requiere pg_cron, ver alertas.sql)
do $$ begin
  begin perform cron.unschedule('accusys-vulnerabilidades'); exception when others then null; end;
  perform cron.schedule('accusys-vulnerabilidades', '*/10 * * * *', 'select public.vuln_procesar(5)');
exception when others then
  raise notice 'La consulta automática no quedó programada (falta pg_cron): %', sqlerrm;
end $$;
