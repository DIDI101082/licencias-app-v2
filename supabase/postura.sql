-- ==========================================================
-- POSTURA DE SEGURIDAD: Secure Score de Microsoft 365, correo y dominio (SPF/DKIM/DMARC),
-- superficie expuesta a Internet, vencimientos automáticos, normativa (BCRA "A" 7724 e
-- ISO/IEC 27001:2022) e informe mensual.
--
--   * Las verificaciones diarias las hace la app (tarea programada de Vercel, una vez por día).
--     La tarea se identifica con una clave: en la base se guarda solo su huella (sha256).
--   * Los certificados internos los verifica el puente de Virtualización (red interna).
--   * Todo se ve con la solapa Seguridad (vencimientos, con Licencias).
--   * Alertas: apagadas hasta que las actives en cada pantalla.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de virtualizacion.sql (se puede volver a ejecutar).
-- ==========================================================

-- ----------------------------------------------------------
-- Tareas programadas (clave de la tarea diaria + opciones de alertas)
-- ----------------------------------------------------------
create table if not exists public.prog_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  ultima_ejecucion timestamptz,
  resultado jsonb not null default '{}',
  alertas_securescore boolean not null default false,
  securescore_min int not null default 60 check (securescore_min between 1 and 100),
  securescore_caida int not null default 5 check (securescore_caida between 1 and 50),
  alertas_correo boolean not null default false,
  alertas_superficie boolean not null default false,
  alertas_normativa boolean not null default false,
  informe_mensual boolean not null default true
);
insert into public.prog_config (id) values (1) on conflict (id) do nothing;

create or replace function public.prog_token_ok(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select token_hash from prog_config where id = 1) = inv_hash(p_token), false) and coalesce(p_token, '') <> ''
$$;
revoke all on function public.prog_token_ok(text) from public, anon, authenticated;

-- Registro en Logs de acciones que no pasan por el disparador general (con o sin usuario)
create or replace function public.postura_auditar(p_tabla text, p_registro text, p_desc text, p_cambios jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select nombre, email into p from perfiles where id = auth.uid();
  insert into auditoria (usuario_id, usuario_email, usuario_nombre, ip, tabla, accion, registro_id, descripcion, cambios)
  values (auth.uid(), p.email, coalesce(p.nombre, case when auth.uid() is null then 'Verificación automática' end),
          case when auth.uid() is null then null else inv_ip_cliente() end, p_tabla, 'modificacion', p_registro, left(p_desc, 300), p_cambios);
exception when others then null;   -- Logs no debe frenar la acción
end $$;
revoke all on function public.postura_auditar(text, text, text, jsonb) from public, anon, authenticated;

-- Nueva clave (la genera el navegador del administrador; acá llega solo la huella)
create or replace function public.prog_nuevo_token(p_token_hash text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede generar la clave'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update prog_config set token_hash = p_token_hash where id = 1;   -- queda en Logs (con la huella oculta)
end $$;
grant execute on function public.prog_nuevo_token(text) to authenticated;

create or replace function public.prog_estado() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when puede_ver('seguridad') or puede_ver('licencias') then
    jsonb_build_object('configurado', token_hash is not null, 'ultima_ejecucion', ultima_ejecucion, 'resultado', resultado,
      'alertas_securescore', alertas_securescore, 'securescore_min', securescore_min, 'securescore_caida', securescore_caida,
      'alertas_correo', alertas_correo, 'alertas_superficie', alertas_superficie, 'alertas_normativa', alertas_normativa,
      'informe_mensual', informe_mensual)
  end from prog_config where id = 1
$$;
grant execute on function public.prog_estado() to authenticated;

create or replace function public.prog_config_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then raise exception 'Solo un administrador puede cambiar la configuración'; end if;
  update prog_config set
    alertas_securescore = coalesce((p ->> 'alertas_securescore')::boolean, alertas_securescore),
    securescore_min = coalesce((p ->> 'securescore_min')::int, securescore_min),
    securescore_caida = coalesce((p ->> 'securescore_caida')::int, securescore_caida),
    alertas_correo = coalesce((p ->> 'alertas_correo')::boolean, alertas_correo),
    alertas_superficie = coalesce((p ->> 'alertas_superficie')::boolean, alertas_superficie),
    alertas_normativa = coalesce((p ->> 'alertas_normativa')::boolean, alertas_normativa),
    informe_mensual = coalesce((p ->> 'informe_mensual')::boolean, informe_mensual)
  where id = 1;
end $$;
grant execute on function public.prog_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Secure Score de Microsoft 365
-- ----------------------------------------------------------
create table if not exists public.ss_historial (
  fecha date primary key, actual numeric, maximo numeric, promedio_similares numeric, actualizado timestamptz not null default now()
);
create table if not exists public.ss_categorias (
  categoria text primary key, actual numeric, maximo numeric, actualizado timestamptz not null default now()
);
create table if not exists public.ss_acciones (
  control text primary key, titulo text, categoria text, servicio text, puntaje numeric, maximo numeric,
  estado text, costo text, impacto text, rango int, enlace text, actualizado timestamptz not null default now()
);

-- ----------------------------------------------------------
-- Correo y dominio
-- ----------------------------------------------------------
create table if not exists public.correo_dominios (
  dominio text primary key check (dominio ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  selectores text[] not null default array['selector1', 'selector2'],
  activo boolean not null default true,
  creado timestamptz not null default now()
);
create table if not exists public.correo_estado (
  dominio text primary key references public.correo_dominios(dominio) on delete cascade,
  mx text[], spf text, dmarc text, dmarc_politica text, dkim jsonb not null default '[]', mta_sts text, tls_rpt text,
  puntaje int, hallazgos jsonb not null default '[]', error text, verificado timestamptz not null default now()
);
create table if not exists public.correo_cambios (
  id bigserial primary key,
  dominio text not null references public.correo_dominios(dominio) on delete cascade,
  fecha timestamptz not null default now(),
  registro text not null, antes text, despues text,
  revisado timestamptz, revisado_por uuid references public.perfiles(id) on delete set null
);
create index if not exists idx_correo_cambios on public.correo_cambios(dominio, fecha desc);

-- ----------------------------------------------------------
-- Superficie expuesta
-- ----------------------------------------------------------
create table if not exists public.sup_objetivos (
  id serial primary key,
  direccion text not null unique check (length(direccion) between 4 and 253),
  descripcion text,
  activo boolean not null default true,
  ip text, hostnames text[], verificado timestamptz, error text,
  creado timestamptz not null default now()
);
create table if not exists public.sup_puertos (
  objetivo_id int not null references public.sup_objetivos(id) on delete cascade,
  puerto int not null check (puerto between 1 and 65535),
  servicio text, fuente text,
  abierto boolean not null default true,
  esperado boolean not null default false,
  nota text,
  primera_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now(),
  primary key (objetivo_id, puerto)
);
create table if not exists public.sup_vulns (
  objetivo_id int not null references public.sup_objetivos(id) on delete cascade,
  cve text not null, primera_vez timestamptz not null default now(), ultima_vez timestamptz not null default now(),
  primary key (objetivo_id, cve)
);

-- Puertos que no deberían estar publicados en Internet (administración, bases de datos, compartidos)
create or replace function public.sup_puerto_riesgoso(p int) returns boolean language sql immutable as $$
  select p = any(array[21, 23, 69, 135, 137, 139, 161, 389, 445, 636, 873, 1433, 1521, 2049, 2375, 2376, 3306, 3389,
                       5432, 5900, 5985, 5986, 6379, 9200, 9300, 11211, 27017])
$$;

-- ----------------------------------------------------------
-- Vencimientos: certificados internos (los verifica el puente de Virtualización)
-- ----------------------------------------------------------
alter table public.vencimientos add column if not exists interno boolean not null default false;

create or replace function public.venc_aplicar(p_id int, p_fecha date, p_emisor text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if not exists (select 1 from vencimientos where id = p_id and tipo in ('certificado', 'dominio')) then return; end if;
  select descripcion, fecha_vencimiento into v from vencimientos where id = p_id;
  update vencimientos set fecha_vencimiento = p_fecha
   where id = p_id and p_fecha is not null and fecha_vencimiento is distinct from p_fecha;
  if found and auth.uid() is null then
    perform postura_auditar('vencimientos', p_id::text, v.descripcion,
      jsonb_build_object('fecha_vencimiento', jsonb_build_object('antes', v.fecha_vencimiento, 'despues', p_fecha)));
  end if;
  insert into vencimientos_verificacion (vencimiento_id, verificado, error, emisor)
  values (p_id, now(), nullif(trim(left(p_error, 300)), ''), nullif(trim(left(p_emisor, 200)), ''))
  on conflict (vencimiento_id) do update set verificado = now(), error = excluded.error,
    emisor = coalesce(excluded.emisor, vencimientos_verificacion.emisor);
end $$;
revoke all on function public.venc_aplicar(int, date, text, text) from public, anon, authenticated;

-- El puente de Virtualización pide la lista de certificados internos y devuelve lo que leyó
create or replace function public.venc_internos_pendientes(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_hash text;
begin
  select token_hash into v_hash from virt_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then raise exception 'Token del puente inválido'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'host', host) order by id)
                     from vencimientos where activo and interno and tipo = 'certificado' and coalesce(host, '') <> ''), '[]'::jsonb);
end $$;
grant execute on function public.venc_internos_pendientes(text) to anon;

create or replace function public.venc_internos_reportar(p_token text, p_datos jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_hash text; vr record; n int := 0;
begin
  select token_hash into v_hash from virt_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then raise exception 'Token del puente inválido'; end if;
  for vr in select * from jsonb_to_recordset(case when jsonb_typeof(p_datos) = 'array' then p_datos else '[]' end)
                  as r(id int, vence timestamptz, emisor text, error text) loop
    if exists (select 1 from vencimientos where id = vr.id and interno) then
      perform venc_aplicar(vr.id, (vr.vence at time zone 'America/Argentina/Buenos_Aires')::date, vr.emisor, vr.error);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
grant execute on function public.venc_internos_reportar(text, jsonb) to anon;

-- Contratos típicos para completar (sin fecha: aparecen como "Sin fecha" hasta que se carguen)
create or replace function public.vencimientos_agregar_tipicos() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (puede_ver('licencias') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then raise exception 'Sin permiso'; end if;
  insert into vencimientos (tipo, descripcion, notas, aviso_dias)
  select 'contrato', d, nt, 60
    from (values
      ('Soporte VMware vSphere (Broadcom)', 'Portal de Broadcom → Licencias y contratos de soporte'),
      ('Mantenimiento / garantía storage IBM V5000', 'IBM Support → Entitlement del número de serie'),
      ('Garantía de los hosts ESXi', 'Sitio del fabricante con el número de serie de cada servidor'),
      ('Licencia ESET PROTECT', 'ESET PROTECT → Administración de licencias'),
      ('Soporte y licencia Veeam Backup', 'my.veeam.com → Licencias'),
      ('Suscripción Microsoft 365', 'Centro de administración de Microsoft 365 → Facturación → Sus productos'),
      ('Contrato de enlaces de Internet', 'Proveedores de los enlaces del SD-WAN')
    ) as t(d, nt)
   where not exists (select 1 from vencimientos v where lower(v.descripcion) = lower(t.d));
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.vencimientos_agregar_tipicos() to authenticated;

-- Todo lo que vence, incluidos los datos que traen otros módulos (cada uno visible con su solapa)
do $$
declare v text;
begin
  v := 'create or replace view public.vencimientos_todos with (security_invoker = true) as
    select origen, ref, tipo, descripcion, fecha_vencimiento, aviso_dias, responsable, enlace, verificado, verificacion_error, emisor, host,
           case when origen = ''manual'' then (select interno from vencimientos where id::text = vv.ref) else false end as interno
      from vencimientos_v vv';
  if to_regclass('public.fg_licencias') is not null then
    v := v || ' union all
    select ''fortigate'', l.equipo || '':'' || l.servicio, ''contrato'', l.servicio || '' · '' || l.equipo,
           (l.vence at time zone ''America/Argentina/Buenos_Aires'')::date, 60, null, ''/red/fortigate?vista=licencias'', null, null, ''Fortinet'', null, false
      from fg_licencias l where l.vence is not null
    union all
    select ''fortigate'', c.equipo || '':cert:'' || c.nombre, ''certificado'', ''Certificado '' || c.nombre || '' · '' || c.equipo,
           (c.vence at time zone ''America/Argentina/Buenos_Aires'')::date, 30, null, ''/red/fortigate?vista=licencias'', null, null, null, null, false
      from fg_certificados c where c.vence is not null and c.nombre !~* ''^fortinet_''';
  end if;
  if to_regclass('public.virt_licencias') is not null then
    v := v || ' union all
    select ''vmware'', l.producto || '':'' || l.edicion, ''licencia'', l.producto || coalesce('' · '' || nullif(l.edicion, ''''), ''''),
           (l.vence at time zone ''America/Argentina/Buenos_Aires'')::date, 60, null, ''/servidores/virtualizacion?vista=alarmas'', null, null, ''VMware'', null, false
      from virt_licencias l where l.vence is not null
    union all
    select ''vmware'', ''cert:'' || h.nombre, ''certificado'', ''Certificado del host '' || h.nombre,
           (h.cert_vence at time zone ''America/Argentina/Buenos_Aires'')::date, 30, null, ''/servidores/virtualizacion'', null, null, null, null, false
      from virt_hosts h where h.cert_vence is not null';
  end if;
  execute v;
end $$;
grant select on public.vencimientos_todos to authenticated;

-- ----------------------------------------------------------
-- La tarea diaria: pide qué revisar y después guarda los resultados
-- ----------------------------------------------------------
create or replace function public.prog_inicio(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;
  return jsonb_build_object(
    'correo', coalesce((select jsonb_agg(jsonb_build_object('dominio', dominio, 'selectores', selectores) order by dominio)
                          from correo_dominios where activo), '[]'::jsonb),
    'superficie', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'direccion', direccion) order by id)
                              from sup_objetivos where activo), '[]'::jsonb),
    'vencimientos', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'tipo', tipo, 'host', host) order by id)
                                from vencimientos where activo and not interno and tipo in ('certificado', 'dominio') and coalesce(host, '') <> ''), '[]'::jsonb));
end $$;
grant execute on function public.prog_inicio(text) to anon;

create or replace function public.prog_reportar(p_token text, p_datos jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ahora timestamptz := now();
  s jsonb := p_datos -> 'securescore';
  d jsonb; o jsonb; ant correo_estado; vr record;
  v_res jsonb := '{}'::jsonb;
  v_ids int[];
begin
  if not prog_token_ok(p_token) then raise exception 'Clave de tareas programadas inválida'; end if;

  -- Secure Score (Microsoft da el historial diario: se guarda tal cual)
  if jsonb_typeof(s) = 'object' then
    insert into ss_historial (fecha, actual, maximo, promedio_similares, actualizado)
    select x.fecha, x.actual, x.maximo, x.promedio, v_ahora
      from jsonb_to_recordset(coalesce(s -> 'historial', '[]')) as x(fecha date, actual numeric, maximo numeric, promedio numeric)
     where x.fecha is not null
    on conflict (fecha) do update set actual = excluded.actual, maximo = excluded.maximo, promedio_similares = excluded.promedio_similares, actualizado = v_ahora;
    delete from ss_historial where fecha < current_date - 400;

    if jsonb_array_length(coalesce(s -> 'categorias', '[]')) > 0 then
      insert into ss_categorias (categoria, actual, maximo, actualizado)
      select left(x.categoria, 80), x.actual, x.maximo, v_ahora
        from jsonb_to_recordset(s -> 'categorias') as x(categoria text, actual numeric, maximo numeric) where coalesce(x.categoria, '') <> ''
      on conflict (categoria) do update set actual = excluded.actual, maximo = excluded.maximo, actualizado = v_ahora;
      delete from ss_categorias where actualizado < v_ahora;
    end if;
    if jsonb_array_length(coalesce(s -> 'acciones', '[]')) > 0 then
      insert into ss_acciones (control, titulo, categoria, servicio, puntaje, maximo, estado, costo, impacto, rango, enlace, actualizado)
      select distinct on (left(x.control, 200)) left(x.control, 200), left(x.titulo, 300), left(x.categoria, 80), left(x.servicio, 80), x.puntaje, x.maximo,
             left(x.estado, 40), left(x.costo, 40), left(x.impacto, 40), x.rango,
             case when x.enlace ~ '^https://' then left(x.enlace, 500) end, v_ahora
        from jsonb_to_recordset(s -> 'acciones') as x(control text, titulo text, categoria text, servicio text, puntaje numeric, maximo numeric,
                                                      estado text, costo text, impacto text, rango int, enlace text)
       where coalesce(x.control, '') <> ''
      on conflict (control) do update set titulo = excluded.titulo, categoria = excluded.categoria, servicio = excluded.servicio,
        puntaje = excluded.puntaje, maximo = excluded.maximo, estado = excluded.estado, costo = excluded.costo, impacto = excluded.impacto,
        rango = excluded.rango, enlace = excluded.enlace, actualizado = v_ahora;
      delete from ss_acciones where actualizado < v_ahora;
    end if;
  end if;

  -- Correo: estado actual y registro de cada cambio en el DNS
  for d in select * from jsonb_array_elements(case when jsonb_typeof(p_datos -> 'correo') = 'array' then p_datos -> 'correo' else '[]' end) loop
    if not exists (select 1 from correo_dominios where dominio = d ->> 'dominio') then continue; end if;
    select * into ant from correo_estado where dominio = d ->> 'dominio';
    if coalesce(d ->> 'error', '') <> '' then
      insert into correo_estado (dominio, error, verificado) values (d ->> 'dominio', left(d ->> 'error', 300), v_ahora)
      on conflict (dominio) do update set error = excluded.error, verificado = v_ahora;
      continue;
    end if;
    if ant.dominio is not null and ant.error is null then
      insert into correo_cambios (dominio, registro, antes, despues)
      select d ->> 'dominio', r.reg, r.antes, r.despues
        from (values
          ('MX', array_to_string(ant.mx, ', '), (select string_agg(v, ', ' order by v) from jsonb_array_elements_text(coalesce(d -> 'mx', '[]')) v)),
          ('SPF', ant.spf, d ->> 'spf'),
          ('DMARC', ant.dmarc, d ->> 'dmarc'),
          ('MTA-STS', ant.mta_sts, d ->> 'mta_sts'),
          ('DKIM', (select string_agg((e ->> 'selector') || '=' || coalesce(e ->> 'valor', '(no existe)'), ' | ' order by e ->> 'selector') from jsonb_array_elements(ant.dkim) e),
                   (select string_agg((e ->> 'selector') || '=' || coalesce(e ->> 'valor', '(no existe)'), ' | ' order by e ->> 'selector') from jsonb_array_elements(coalesce(d -> 'dkim', '[]')) e))
        ) as r(reg, antes, despues)
       where coalesce(r.antes, '') is distinct from coalesce(r.despues, '');
    end if;
    insert into correo_estado (dominio, mx, spf, dmarc, dmarc_politica, dkim, mta_sts, tls_rpt, puntaje, hallazgos, error, verificado)
    values (d ->> 'dominio',
            (select array_agg(v order by v) from jsonb_array_elements_text(coalesce(d -> 'mx', '[]')) v),
            left(d ->> 'spf', 2000), left(d ->> 'dmarc', 2000), left(d ->> 'dmarc_politica', 20), coalesce(d -> 'dkim', '[]'),
            left(d ->> 'mta_sts', 500), left(d ->> 'tls_rpt', 500), (d ->> 'puntaje')::int, coalesce(d -> 'hallazgos', '[]'), null, v_ahora)
    on conflict (dominio) do update set mx = excluded.mx, spf = excluded.spf, dmarc = excluded.dmarc, dmarc_politica = excluded.dmarc_politica,
      dkim = excluded.dkim, mta_sts = excluded.mta_sts, tls_rpt = excluded.tls_rpt, puntaje = excluded.puntaje, hallazgos = excluded.hallazgos,
      error = null, verificado = v_ahora;
  end loop;
  delete from correo_cambios where fecha < now() - interval '2 years';

  -- Superficie: puertos vistos hoy; los que no aparecen quedan como cerrados (se conserva el historial)
  for o in select * from jsonb_array_elements(case when jsonb_typeof(p_datos -> 'superficie') = 'array' then p_datos -> 'superficie' else '[]' end) loop
    if not exists (select 1 from sup_objetivos where id = (o ->> 'id')::int) then continue; end if;
    update sup_objetivos set ip = left(o ->> 'ip', 60), verificado = v_ahora, error = nullif(left(o ->> 'error', 300), ''),
           hostnames = (select array_agg(left(h, 200)) from jsonb_array_elements_text(coalesce(o -> 'hostnames', '[]')) h)
     where id = (o ->> 'id')::int;
    if coalesce(o ->> 'error', '') <> '' then continue; end if;
    insert into sup_puertos (objetivo_id, puerto, servicio, fuente, abierto, primera_vez, ultima_vez)
    select distinct on (x.puerto) (o ->> 'id')::int, x.puerto, left(x.servicio, 60), left(x.fuente, 30), true, v_ahora, v_ahora
      from jsonb_to_recordset(coalesce(o -> 'puertos', '[]')) as x(puerto int, servicio text, fuente text)
     where x.puerto between 1 and 65535
    on conflict (objetivo_id, puerto) do update set abierto = true, ultima_vez = v_ahora,
      servicio = coalesce(excluded.servicio, sup_puertos.servicio), fuente = excluded.fuente,
      primera_vez = case when sup_puertos.abierto then sup_puertos.primera_vez else v_ahora end;
    update sup_puertos set abierto = false where objetivo_id = (o ->> 'id')::int and ultima_vez < v_ahora and abierto;
    insert into sup_vulns (objetivo_id, cve, primera_vez, ultima_vez)
    select (o ->> 'id')::int, left(c, 30), v_ahora, v_ahora from jsonb_array_elements_text(coalesce(o -> 'vulns', '[]')) c where c ~ '^CVE-\d{4}-\d+$'
    on conflict (objetivo_id, cve) do update set ultima_vez = v_ahora;
    delete from sup_vulns where objetivo_id = (o ->> 'id')::int and ultima_vez < v_ahora;
  end loop;

  -- Certificados y dominios públicos
  for vr in select * from jsonb_to_recordset(case when jsonb_typeof(p_datos -> 'vencimientos') = 'array' then p_datos -> 'vencimientos' else '[]' end)
                  as r(id int, fecha date, emisor text, error text) loop
    if exists (select 1 from vencimientos where id = vr.id and not interno) then
      perform venc_aplicar(vr.id, vr.fecha, vr.emisor, vr.error);
    end if;
  end loop;

  -- Resultado de cada parte (se muestra en pantalla y alerta si la tarea deja de correr)
  update prog_config set ultima_ejecucion = v_ahora,
         resultado = jsonb_build_object(
           'securescore', coalesce(p_datos ->> 'error_securescore', case when jsonb_typeof(s) = 'object' then 'ok' else 'sin datos' end),
           'correo', coalesce(p_datos ->> 'error_correo', 'ok'),
           'superficie', coalesce(p_datos ->> 'error_superficie', 'ok'),
           'vencimientos', coalesce(p_datos ->> 'error_vencimientos', 'ok'),
           'duracion_s', p_datos -> 'duracion_s')
   where id = 1;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.prog_reportar(text, jsonb) to anon;

-- ----------------------------------------------------------
-- Normativa: BCRA "A" 7724 (texto ordenado "Requisitos mínimos para la gestión y control de los riesgos
-- de tecnología y seguridad de la información") e ISO/IEC 27001:2022 Anexo A.
-- Cada control tiene su evaluación (estado, responsable, evidencia, próxima revisión) y los
-- indicadores automáticos de la app que sirven como evidencia.
-- ----------------------------------------------------------
create table if not exists public.norma_controles (
  id text primary key,
  marco text not null check (marco in ('BCRA', 'ISO27001')),
  codigo text not null,
  dominio text not null,
  titulo text not null,
  indicadores text[] not null default '{}',
  orden int not null
);
create table if not exists public.norma_evaluacion (
  control_id text primary key references public.norma_controles(id) on delete cascade,
  estado text not null default 'sin_evaluar' check (estado in ('sin_evaluar', 'cumple', 'parcial', 'no_cumple', 'no_aplica')),
  responsable text, evidencia text, notas text,
  revisado date, proxima date,
  actualizado timestamptz not null default now(),
  actualizado_por uuid references public.perfiles(id) on delete set null default auth.uid()
);

insert into public.norma_controles (id, marco, codigo, dominio, titulo, indicadores, orden)
select m || '-' || c, m, c, dom, t, coalesce(ind, '{}'), row_number() over ()
  from (values
  -- BCRA
  ('BCRA','2.1.1','Gobierno de TI y SI','Rol del Directorio',null::text[]),
  ('BCRA','2.1.2','Gobierno de TI y SI','Rol de la Alta Gerencia',null),
  ('BCRA','2.1.3','Gobierno de TI y SI','Áreas de tecnología y seguridad de la información',null),
  ('BCRA','2.1.4','Gobierno de TI y SI','Comité de gobierno de tecnología y seguridad de la información',null),
  ('BCRA','2.2','Gobierno de TI y SI','Segregación de funciones',array['admins_locales']),
  ('BCRA','2.3','Gobierno de TI y SI','Marco normativo',null),
  ('BCRA','3','Gestión de riesgos de TI y SI','Gestión de riesgos de tecnología y seguridad de la información',array['kev','superficie','securescore']),
  ('BCRA','4.1','Gestión de TI','Estrategia de tecnología de la información',null),
  ('BCRA','4.2','Gestión de TI','Arquitectura empresarial',null),
  ('BCRA','4.3','Gestión de TI','Presupuesto, inversiones y gestión de portafolio',null),
  ('BCRA','4.3.1','Gestión de TI','Gestión de proyectos',null),
  ('BCRA','4.4','Gestión de TI','Gestión de datos',null),
  ('BCRA','4.5','Gestión de TI','Gestión de activos de información',array['so_soporte']),
  ('BCRA','4.6','Gestión de TI','Inteligencia artificial o aprendizaje automático',null),
  ('BCRA','4.7','Gestión de TI','Control y reportes de gestión',null),
  ('BCRA','5.1','Gestión de seguridad de la información','Marco de gestión de seguridad de la información',null),
  ('BCRA','5.2','Gestión de seguridad de la información','Estrategia de seguridad de la información',null),
  ('BCRA','5.3','Gestión de seguridad de la información','Normas y procedimientos',null),
  ('BCRA','5.4','Gestión de seguridad de la información','Presupuesto, inversiones y gestión de proyectos',null),
  ('BCRA','5.5','Gestión de seguridad de la información','Programas de capacitación y concientización',array['capacitacion']),
  ('BCRA','5.6','Gestión de seguridad de la información','Control y reportes de gestión',null),
  ('BCRA','5.7.1','Control de accesos','Seguridad física y medioambiental',null),
  ('BCRA','5.7.2.1','Control de accesos','Medidas de control de acceso',array['cuentas_inactivas','bajas_pendientes','admins_locales']),
  ('BCRA','5.7.2.2','Control de accesos','Métodos de autenticación',array['mfa']),
  ('BCRA','5.7.2.3','Control de accesos','Requisitos generales para los factores de autenticación',array['mfa']),
  ('BCRA','5.7.2.4','Control de accesos','Requisitos generales para la autenticación multifactor',array['mfa','admins_sin_mfa']),
  ('BCRA','5.7.3','Control de accesos','Seguridad de los dispositivos portátiles',array['cifrado','antivirus','firewall']),
  ('BCRA','5.7.4','Control de accesos','Controles sobre la información',array['cifrado','correo']),
  ('BCRA','5.8.1','Operaciones de seguridad','Detección, monitoreo y análisis de eventos',array['alertas_graves']),
  ('BCRA','5.8.2','Operaciones de seguridad','Gestión de amenazas y vulnerabilidades',array['kev','parches','superficie','securescore']),
  ('BCRA','6.1','Continuidad del negocio','Marco de gestión de la continuidad',null),
  ('BCRA','6.2','Continuidad del negocio','Ciberresiliencia en la continuidad del negocio',array['backups']),
  ('BCRA','6.3.1','Continuidad del negocio','Análisis de impacto del negocio',null),
  ('BCRA','6.3.2','Continuidad del negocio','Evaluación de riesgos y escenarios',null),
  ('BCRA','6.4.1','Continuidad del negocio','Planes de continuidad del negocio',null),
  ('BCRA','6.4.2','Continuidad del negocio','Gestión de crisis y estrategias de comunicación',null),
  ('BCRA','6.5','Continuidad del negocio','Programa de capacitación y concientización',null),
  ('BCRA','6.6','Continuidad del negocio','Ejercicios y pruebas de los planes de continuidad',null),
  ('BCRA','6.7','Continuidad del negocio','Mantenimiento de los planes de continuidad',null),
  ('BCRA','6.8','Continuidad del negocio','Control y reportes de gestión',null),
  ('BCRA','7.1','Infraestructura y procesamiento','Gestión de la infraestructura tecnológica',null),
  ('BCRA','7.2','Infraestructura y procesamiento','Gestión de cambios',null),
  ('BCRA','7.3','Infraestructura y procesamiento','Actualización de la infraestructura tecnológica',array['so_soporte','parches']),
  ('BCRA','7.4','Infraestructura y procesamiento','Gestión de las comunicaciones',array['superficie','correo']),
  ('BCRA','7.5','Infraestructura y procesamiento','Procesamiento de datos',null),
  ('BCRA','7.6','Infraestructura y procesamiento','Gestión de copias de respaldo de datos',array['backups']),
  ('BCRA','7.7','Infraestructura y procesamiento','Monitoreo de la infraestructura tecnológica y procesamiento',array['alertas_graves']),
  ('BCRA','8.1.1','Gestión de ciberincidentes','Registro y repositorio de ciberincidentes',array['incidentes_abiertos']),
  ('BCRA','8.1.2','Gestión de ciberincidentes','Investigación de ciberincidentes',array['incidentes_abiertos']),
  ('BCRA','8.1.3','Gestión de ciberincidentes','Comunicación y notificación de los ciberincidentes',null),
  ('BCRA','8.2','Gestión de ciberincidentes','Ejercicios y pruebas de la respuesta ante ciberincidentes',null),
  ('BCRA','8.3','Gestión de ciberincidentes','Control y reportes de gestión',null),
  ('BCRA','9.1','Desarrollo y mantenimiento de software','Requisitos para los sistemas y aplicaciones',null),
  ('BCRA','9.1.1','Desarrollo y mantenimiento de software','Requisitos para la generación de los regímenes informativos',null),
  ('BCRA','9.2','Desarrollo y mantenimiento de software','Gestión del ciclo de vida de software',null),
  ('BCRA','10.1','Relación con terceras partes','Exigencia de notificación previa',null),
  ('BCRA','10.2','Relación con terceras partes','Marco de gestión de la relación con terceras partes',null),
  ('BCRA','10.3','Relación con terceras partes','Formalización de la relación',array['vencimientos']),
  ('BCRA','10.4','Relación con terceras partes','Control y monitoreo',array['vencimientos']),
  ('BCRA','10.5','Relación con terceras partes','Informes de auditoría interna y externa',null),
  ('BCRA','10.6','Relación con terceras partes','Consideraciones adicionales',null),
  -- ISO/IEC 27001:2022 Anexo A
  ('ISO27001','5.1','Organizacionales','Políticas de seguridad de la información',null),
  ('ISO27001','5.2','Organizacionales','Roles y responsabilidades de seguridad de la información',null),
  ('ISO27001','5.3','Organizacionales','Segregación de funciones',array['admins_locales']),
  ('ISO27001','5.4','Organizacionales','Responsabilidades de la dirección',null),
  ('ISO27001','5.5','Organizacionales','Contacto con autoridades',null),
  ('ISO27001','5.6','Organizacionales','Contacto con grupos de interés especial',null),
  ('ISO27001','5.7','Organizacionales','Inteligencia de amenazas',array['kev']),
  ('ISO27001','5.8','Organizacionales','Seguridad de la información en la gestión de proyectos',null),
  ('ISO27001','5.9','Organizacionales','Inventario de información y otros activos asociados',array['so_soporte']),
  ('ISO27001','5.10','Organizacionales','Uso aceptable de la información y activos asociados',null),
  ('ISO27001','5.11','Organizacionales','Devolución de activos',array['bajas_pendientes']),
  ('ISO27001','5.12','Organizacionales','Clasificación de la información',null),
  ('ISO27001','5.13','Organizacionales','Etiquetado de la información',null),
  ('ISO27001','5.14','Organizacionales','Transferencia de información',array['correo']),
  ('ISO27001','5.15','Organizacionales','Control de acceso',array['cuentas_inactivas','admins_sin_mfa']),
  ('ISO27001','5.16','Organizacionales','Gestión de identidades',array['cuentas_inactivas','bajas_pendientes']),
  ('ISO27001','5.17','Organizacionales','Información de autenticación',array['mfa']),
  ('ISO27001','5.18','Organizacionales','Derechos de acceso',array['cuentas_inactivas','bajas_pendientes']),
  ('ISO27001','5.19','Organizacionales','Seguridad de la información en la relación con proveedores',null),
  ('ISO27001','5.20','Organizacionales','Seguridad de la información en los acuerdos con proveedores',array['vencimientos']),
  ('ISO27001','5.21','Organizacionales','Seguridad de la información en la cadena de suministro TIC',null),
  ('ISO27001','5.22','Organizacionales','Seguimiento, revisión y cambios de los servicios de proveedores',array['vencimientos']),
  ('ISO27001','5.23','Organizacionales','Seguridad de la información en servicios en la nube',array['securescore']),
  ('ISO27001','5.24','Organizacionales','Planificación y preparación de la gestión de incidentes',array['incidentes_abiertos']),
  ('ISO27001','5.25','Organizacionales','Evaluación y decisión sobre eventos de seguridad',array['alertas_graves']),
  ('ISO27001','5.26','Organizacionales','Respuesta a incidentes de seguridad de la información',array['incidentes_abiertos']),
  ('ISO27001','5.27','Organizacionales','Aprendizaje de los incidentes de seguridad',null),
  ('ISO27001','5.28','Organizacionales','Recolección de evidencia',null),
  ('ISO27001','5.29','Organizacionales','Seguridad de la información durante una interrupción',null),
  ('ISO27001','5.30','Organizacionales','Preparación de las TIC para la continuidad del negocio',array['backups']),
  ('ISO27001','5.31','Organizacionales','Requisitos legales, reglamentarios y contractuales',null),
  ('ISO27001','5.32','Organizacionales','Derechos de propiedad intelectual',null),
  ('ISO27001','5.33','Organizacionales','Protección de los registros',null),
  ('ISO27001','5.34','Organizacionales','Privacidad y protección de datos personales',null),
  ('ISO27001','5.35','Organizacionales','Revisión independiente de la seguridad de la información',null),
  ('ISO27001','5.36','Organizacionales','Cumplimiento de políticas, reglas y normas de seguridad',null),
  ('ISO27001','5.37','Organizacionales','Procedimientos operativos documentados',null),
  ('ISO27001','6.1','Personas','Verificación de antecedentes',null),
  ('ISO27001','6.2','Personas','Términos y condiciones de empleo',null),
  ('ISO27001','6.3','Personas','Concientización, educación y capacitación en seguridad',array['capacitacion']),
  ('ISO27001','6.4','Personas','Proceso disciplinario',null),
  ('ISO27001','6.5','Personas','Responsabilidades después de la desvinculación o cambio de puesto',array['bajas_pendientes']),
  ('ISO27001','6.6','Personas','Acuerdos de confidencialidad',null),
  ('ISO27001','6.7','Personas','Trabajo remoto',array['cifrado','antivirus']),
  ('ISO27001','6.8','Personas','Reporte de eventos de seguridad de la información',null),
  ('ISO27001','7.1','Físicos','Perímetros de seguridad física',null),
  ('ISO27001','7.2','Físicos','Controles de ingreso físico',null),
  ('ISO27001','7.3','Físicos','Seguridad de oficinas, salas e instalaciones',null),
  ('ISO27001','7.4','Físicos','Monitoreo de la seguridad física',null),
  ('ISO27001','7.5','Físicos','Protección contra amenazas físicas y ambientales',null),
  ('ISO27001','7.6','Físicos','Trabajo en áreas seguras',null),
  ('ISO27001','7.7','Físicos','Escritorio y pantalla limpios',null),
  ('ISO27001','7.8','Físicos','Ubicación y protección del equipamiento',null),
  ('ISO27001','7.9','Físicos','Seguridad de los activos fuera de las instalaciones',array['cifrado']),
  ('ISO27001','7.10','Físicos','Medios de almacenamiento',array['cifrado']),
  ('ISO27001','7.11','Físicos','Servicios de suministro',null),
  ('ISO27001','7.12','Físicos','Seguridad del cableado',null),
  ('ISO27001','7.13','Físicos','Mantenimiento del equipamiento',null),
  ('ISO27001','7.14','Físicos','Eliminación o reutilización segura del equipamiento',null),
  ('ISO27001','8.1','Tecnológicos','Dispositivos de usuario final',array['cifrado','antivirus','firewall','parches']),
  ('ISO27001','8.2','Tecnológicos','Derechos de acceso privilegiado',array['admins_locales','admins_sin_mfa']),
  ('ISO27001','8.3','Tecnológicos','Restricción del acceso a la información',null),
  ('ISO27001','8.4','Tecnológicos','Acceso al código fuente',null),
  ('ISO27001','8.5','Tecnológicos','Autenticación segura',array['mfa']),
  ('ISO27001','8.6','Tecnológicos','Gestión de la capacidad',null),
  ('ISO27001','8.7','Tecnológicos','Protección contra malware',array['antivirus']),
  ('ISO27001','8.8','Tecnológicos','Gestión de vulnerabilidades técnicas',array['parches','kev','so_soporte','superficie']),
  ('ISO27001','8.9','Tecnológicos','Gestión de la configuración',array['securescore']),
  ('ISO27001','8.10','Tecnológicos','Eliminación de información',null),
  ('ISO27001','8.11','Tecnológicos','Enmascaramiento de datos',null),
  ('ISO27001','8.12','Tecnológicos','Prevención de fuga de datos',null),
  ('ISO27001','8.13','Tecnológicos','Copias de respaldo de la información',array['backups']),
  ('ISO27001','8.14','Tecnológicos','Redundancia de las instalaciones de procesamiento',null),
  ('ISO27001','8.15','Tecnológicos','Registro de eventos (logs)',null),
  ('ISO27001','8.16','Tecnológicos','Actividades de monitoreo',array['alertas_graves']),
  ('ISO27001','8.17','Tecnológicos','Sincronización de relojes',null),
  ('ISO27001','8.18','Tecnológicos','Uso de programas utilitarios privilegiados',null),
  ('ISO27001','8.19','Tecnológicos','Instalación de software en sistemas operativos',null),
  ('ISO27001','8.20','Tecnológicos','Seguridad de las redes',array['superficie','firewall']),
  ('ISO27001','8.21','Tecnológicos','Seguridad de los servicios de red',array['superficie']),
  ('ISO27001','8.22','Tecnológicos','Segregación de redes',null),
  ('ISO27001','8.23','Tecnológicos','Filtrado web',null),
  ('ISO27001','8.24','Tecnológicos','Uso de criptografía',array['cifrado','vencimientos']),
  ('ISO27001','8.25','Tecnológicos','Ciclo de vida de desarrollo seguro',null),
  ('ISO27001','8.26','Tecnológicos','Requisitos de seguridad de las aplicaciones',null),
  ('ISO27001','8.27','Tecnológicos','Principios de arquitectura e ingeniería de sistemas seguros',null),
  ('ISO27001','8.28','Tecnológicos','Codificación segura',null),
  ('ISO27001','8.29','Tecnológicos','Pruebas de seguridad en desarrollo y aceptación',null),
  ('ISO27001','8.30','Tecnológicos','Desarrollo tercerizado',null),
  ('ISO27001','8.31','Tecnológicos','Separación de los entornos de desarrollo, prueba y producción',null),
  ('ISO27001','8.32','Tecnológicos','Gestión de cambios',null),
  ('ISO27001','8.33','Tecnológicos','Información de prueba',null),
  ('ISO27001','8.34','Tecnológicos','Protección de los sistemas durante las pruebas de auditoría',null)
  ) as t(m, c, dom, t, ind)
on conflict (id) do update set dominio = excluded.dominio, titulo = excluded.titulo, indicadores = excluded.indicadores, orden = excluded.orden;

create or replace function public.norma_guardar(p_control text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then raise exception 'Sin permiso para evaluar controles'; end if;
  if not exists (select 1 from norma_controles where id = p_control) then raise exception 'Control inexistente'; end if;
  insert into norma_evaluacion (control_id, estado, responsable, evidencia, notas, revisado, proxima, actualizado, actualizado_por)
  values (p_control, coalesce(p ->> 'estado', 'sin_evaluar'), nullif(left(trim(p ->> 'responsable'), 120), ''),
          nullif(left(trim(p ->> 'evidencia'), 4000), ''), nullif(left(trim(p ->> 'notas'), 4000), ''),
          nullif(p ->> 'revisado', '')::date, nullif(p ->> 'proxima', '')::date, now(), auth.uid())
  on conflict (control_id) do update set estado = excluded.estado, responsable = excluded.responsable, evidencia = excluded.evidencia,
    notas = excluded.notas, revisado = excluded.revisado, proxima = excluded.proxima, actualizado = now(), actualizado_por = auth.uid();
end $$;
grant execute on function public.norma_guardar(text, jsonb) to authenticated;

-- ----------------------------------------------------------
-- Informe mensual: se arma el día 1 con lo del mes anterior y avisa por Teams
-- ----------------------------------------------------------
create table if not exists public.informe_mensual (
  mes date primary key check (extract(day from mes) = 1),
  datos jsonb not null,
  kpis jsonb,
  generado timestamptz not null default now()
);

create or replace function public.informe_calcular(p_mes date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ini timestamptz := (date_trunc('month', p_mes)::date)::timestamp at time zone 'America/Argentina/Buenos_Aires';
  v_fin timestamptz := ((date_trunc('month', p_mes) + interval '1 month')::date)::timestamp at time zone 'America/Argentina/Buenos_Aires';
  r jsonb := jsonb_build_object('mes', to_char(p_mes, 'YYYY-MM'), 'calculado', now());
begin
  begin
    r := r || jsonb_build_object('alertas', jsonb_build_object(
      'nuevas', (select count(*) from alertas where abierta >= v_ini and abierta < v_fin),
      'resueltas', (select count(*) from alertas where resuelta >= v_ini and resuelta < v_fin),
      'abiertas_hoy', (select count(*) from alertas where resuelta is null),
      'por_severidad', (select coalesce(jsonb_object_agg(severidad, n), '{}') from (select severidad, count(*) n from alertas where abierta >= v_ini and abierta < v_fin group by 1) z),
      'por_regla', (select coalesce(jsonb_agg(jsonb_build_object('regla', regla, 'n', n) order by n desc), '[]') from
                     (select regla, count(*) n from alertas where abierta >= v_ini and abierta < v_fin group by 1 order by 2 desc limit 8) z)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('incidentes', jsonb_build_object(
      'registrados', (select count(*) from incidentes where detectado >= v_ini and detectado < v_fin),
      'cerrados', (select count(*) from incidentes where cerrado >= v_ini and cerrado < v_fin),
      'abiertos', (select count(*) from incidentes where cerrado is null and detectado < v_fin),
      'por_severidad', (select coalesce(jsonb_object_agg(severidad, n), '{}') from (select severidad, count(*) n from incidentes where detectado >= v_ini and detectado < v_fin group by 1) z)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('eset', jsonb_build_object(
      'detecciones', (select count(*) from eset_detecciones where fecha >= v_ini and fecha < v_fin),
      'altas', (select count(*) from eset_detecciones where fecha >= v_ini and fecha < v_fin and severidad = 'HIGH'),
      'sin_resolver', (select count(*) from eset_detecciones where fecha >= v_ini and fecha < v_fin and not resuelta)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('personas', jsonb_build_object(
      'altas', (select count(*) from empleados_movimientos where tipo = 'alta' and fecha >= v_ini::date and fecha < v_fin::date),
      'bajas', (select count(*) from empleados_movimientos where tipo = 'baja' and fecha >= v_ini::date and fecha < v_fin::date),
      'bajas_abiertas', (select count(*) from empleados_movimientos where tipo = 'baja' and estado = 'abierto')));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('accesos', jsonb_build_object(
      'inicios', (select count(*) from srv_sesiones where fecha >= v_ini and fecha < v_fin),
      'no_autorizados', (select count(*) from srv_sesiones where fecha >= v_ini and fecha < v_fin and autorizado = false),
      'fuera_horario', (select count(*) from srv_sesiones where fecha >= v_ini and fecha < v_fin and fuera_horario),
      'cuentas_locales', (select count(*) from srv_sesiones where fecha >= v_ini and fecha < v_fin and cuenta_local),
      'fallos', (select count(*) from srv_accesos where tipo = 'fallo' and fecha >= v_ini and fecha < v_fin)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('identidad', (select to_jsonb(i) - 'actualizado' from identidad_resumen i where fecha < v_fin::date order by fecha desc limit 1));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('securescore', jsonb_build_object(
      'inicio', (select jsonb_build_object('actual', actual, 'maximo', maximo) from ss_historial where fecha >= v_ini::date and fecha < v_fin::date order by fecha limit 1),
      'fin', (select jsonb_build_object('actual', actual, 'maximo', maximo, 'promedio', promedio_similares) from ss_historial where fecha >= v_ini::date and fecha < v_fin::date order by fecha desc limit 1)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('superficie', jsonb_build_object(
      'direcciones', (select count(*) from sup_objetivos where activo),
      'abiertos', (select count(*) from sup_puertos where abierto),
      'inesperados', (select count(*) from sup_puertos where abierto and not esperado),
      'nuevos_mes', (select count(*) from sup_puertos where primera_vez >= v_ini and primera_vez < v_fin),
      'cves', (select count(distinct cve) from sup_vulns)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('correo', jsonb_build_object(
      'dominios', (select count(*) from correo_dominios where activo),
      'con_problemas', (select count(*) from correo_estado e where exists (select 1 from jsonb_array_elements(e.hallazgos) h where h ->> 'severidad' in ('alta', 'critica'))),
      'cambios_mes', (select count(*) from correo_cambios where fecha >= v_ini and fecha < v_fin)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('vencimientos', jsonb_build_object(
      'vencidos', (select count(*) from vencimientos_v where fecha_vencimiento < current_date),
      'proximos', (select coalesce(jsonb_agg(jsonb_build_object('descripcion', descripcion, 'fecha', fecha_vencimiento) order by fecha_vencimiento), '[]')
                     from (select descripcion, fecha_vencimiento from vencimientos_v
                            where fecha_vencimiento between current_date and current_date + 60 order by fecha_vencimiento limit 12) z)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('vulnerabilidades', jsonb_build_object(
      'versiones_kev', (select count(*) from vuln_v_resumen where coalesce(kev, 0) > 0),
      'versiones_criticas', (select count(*) from vuln_v_resumen where coalesce(criticas, 0) > 0)));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('backups', jsonb_build_object(
      'trabajos', (select count(*) from backups_trabajos where habilitado and not ignorar),
      'fallidos', (select count(*) from backups_trabajos where habilitado and not ignorar and ultimo_resultado = 'Failed')));
  exception when others then null; end;
  begin
    r := r || jsonb_build_object('normativa', (select coalesce(jsonb_agg(z order by z.marco), '[]') from (
      select c.marco, count(*) total,
             count(*) filter (where e.estado = 'cumple') cumple, count(*) filter (where e.estado = 'parcial') parcial,
             count(*) filter (where e.estado = 'no_cumple') no_cumple, count(*) filter (where e.estado = 'no_aplica') no_aplica,
             count(*) filter (where coalesce(e.estado, 'sin_evaluar') = 'sin_evaluar') sin_evaluar
        from norma_controles c left join norma_evaluacion e on e.control_id = c.id group by c.marco) z));
  exception when others then null; end;
  return r;
end $$;
revoke all on function public.informe_calcular(date) from public, anon, authenticated;

-- Para la pantalla: el guardado si existe; si no (mes en curso), calculado en el momento
create or replace function public.informe_ver(p_mes date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v informe_mensual;
begin
  if not puede_ver('seguridad') then raise exception 'Sin acceso a Seguridad'; end if;
  select * into v from informe_mensual where mes = date_trunc('month', p_mes)::date;
  if v.mes is not null then
    return jsonb_build_object('guardado', true, 'generado', v.generado, 'datos', v.datos, 'kpis', v.kpis);
  end if;
  return jsonb_build_object('guardado', false, 'datos', informe_calcular(date_trunc('month', p_mes)::date), 'kpis', null);
end $$;
grant execute on function public.informe_ver(date) to authenticated;

create or replace function public.informe_meses() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when puede_ver('seguridad') then coalesce((select jsonb_agg(to_char(mes, 'YYYY-MM') order by mes desc) from informe_mensual), '[]') end
$$;
grant execute on function public.informe_meses() to authenticated;

-- Cerrar el informe de un mes a mano (o volver a generarlo) y guardar los indicadores de Cumplimiento
create or replace function public.informe_guardar(p_mes date, p_kpis jsonb default null, p_recalcular boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare v_mes date := date_trunc('month', p_mes)::date;
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then raise exception 'Sin permiso'; end if;
  if v_mes > date_trunc('month', current_date)::date then raise exception 'Mes futuro'; end if;
  insert into informe_mensual (mes, datos, kpis, generado) values (v_mes, informe_calcular(v_mes), p_kpis, now())
  on conflict (mes) do update set
    datos = case when p_recalcular then excluded.datos else informe_mensual.datos end,
    kpis = coalesce(p_kpis, informe_mensual.kpis),
    generado = case when p_recalcular then now() else informe_mensual.generado end;
end $$;
grant execute on function public.informe_guardar(date, jsonb, boolean) to authenticated;

create or replace function public.informe_mensual_cron() returns text
language plpgsql security definer set search_path = public as $$
declare v_mes date := (date_trunc('month', current_date) - interval '1 month')::date; d jsonb; l text[] := '{}';
begin
  if not coalesce((select informe_mensual from prog_config where id = 1), true) then return 'Informe mensual desactivado'; end if;
  insert into informe_mensual (mes, datos) values (v_mes, informe_calcular(v_mes)) on conflict (mes) do nothing;
  select datos into d from informe_mensual where mes = v_mes;
  l := l || ('**Alertas:** ' || coalesce(d #>> '{alertas,nuevas}', '0') || ' nuevas · ' || coalesce(d #>> '{alertas,resueltas}', '0') || ' resueltas');
  if d ? 'incidentes' then l := l || ('**Incidentes:** ' || (d #>> '{incidentes,registrados}') || ' registrados · ' || (d #>> '{incidentes,abiertos}') || ' abiertos'); end if;
  if d #> '{securescore,fin}' is not null and jsonb_typeof(d #> '{securescore,fin}') = 'object' then
    l := l || ('**Secure Score:** ' || round((d #>> '{securescore,fin,actual}')::numeric) || ' de ' || round((d #>> '{securescore,fin,maximo}')::numeric)); end if;
  if d ? 'superficie' then l := l || ('**Superficie expuesta:** ' || (d #>> '{superficie,inesperados}') || ' puertos abiertos sin justificar'); end if;
  if d ? 'vencimientos' then l := l || ('**Vencimientos:** ' || (d #>> '{vencimientos,vencidos}') || ' vencidos · ' || jsonb_array_length(d #> '{vencimientos,proximos}') || ' en los próximos 60 días'); end if;
  begin
    return coalesce(alertas_teams('Accusys Cyber · Informe de ' || to_char(v_mes, 'MM/YYYY') || ' listo', l, '/inventario/informe?mes=' || to_char(v_mes, 'YYYY-MM')), 'Enviado');
  exception when others then return 'Guardado; no se pudo avisar a Teams: ' || sqlerrm;
  end;
end $$;
revoke all on function public.informe_mensual_cron() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('accusys-informe-mensual'); exception when others then null; end;
    perform cron.schedule('accusys-informe-mensual', '10 12 1 * *', 'select public.informe_mensual_cron()');
  end if;
end $$;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.postura_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c prog_config; v_act numeric; v_max numeric; v_ant numeric; n int;
begin
  select * into c from prog_config where id = 1;
  if c.id is null then return; end if;

  -- La tarea diaria dejó de correr (solo si ya se configuró)
  if c.token_hash is not null and coalesce(c.ultima_ejecucion, '-infinity') < now() - interval '36 hours'
     and (c.alertas_securescore or c.alertas_correo or c.alertas_superficie) then
    insert into _cond values ('prog:sin_correr', 'programadas', 'media', 'Las verificaciones diarias no se ejecutan',
      coalesce('Última: ' || to_char(c.ultima_ejecucion at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI'), 'Nunca se ejecutaron') ||
      '. Revisá la variable CRON_SECRET en Vercel.', '/inventario/securescore') on conflict do nothing;
  end if;

  if c.alertas_securescore then
    select actual, maximo into v_act, v_max from ss_historial order by fecha desc limit 1;
    select actual into v_ant from ss_historial where fecha <= current_date - 7 order by fecha desc limit 1;
    if v_max > 0 and 100 * v_act / v_max < c.securescore_min then
      insert into _cond values ('ss:bajo', 'securescore', 'media', 'Secure Score de Microsoft 365 por debajo de la meta',
        round(100 * v_act / v_max) || '% (meta ' || c.securescore_min || '%)', '/inventario/securescore') on conflict do nothing;
    end if;
    if v_max > 0 and v_ant is not null and 100 * (v_ant - v_act) / v_max >= c.securescore_caida then
      insert into _cond values ('ss:caida:' || current_date, 'securescore', 'alta', 'Bajó el Secure Score de Microsoft 365',
        'De ' || round(v_ant) || ' a ' || round(v_act) || ' puntos en la última semana: puede haber cambiado una configuración', '/inventario/securescore') on conflict do nothing;
    end if;
  end if;

  if c.alertas_correo then
    insert into _cond
    select 'correo:' || e.dominio || ':' || md5(h ->> 'titulo'), 'correo',
           case when h ->> 'severidad' in ('critica', 'alta') then 'alta' else 'media' end,
           e.dominio || ': ' || (h ->> 'titulo'), h ->> 'detalle', '/inventario/correo'
      from correo_estado e cross join jsonb_array_elements(e.hallazgos) h
     where h ->> 'severidad' in ('critica', 'alta', 'media') and e.error is null
    on conflict do nothing;
    insert into _cond
    select 'correo:cambio:' || k.id, 'correo', 'alta', 'Cambió el registro ' || k.registro || ' de ' || k.dominio,
           left('Antes: ' || coalesce(k.antes, '(no existía)') || ' · Ahora: ' || coalesce(k.despues, '(no existe)'), 400), '/inventario/correo'
      from correo_cambios k where k.revisado is null and k.fecha > now() - interval '14 days'
    on conflict do nothing;
  end if;

  if c.alertas_superficie then
    insert into _cond
    select 'sup:' || p.objetivo_id || ':' || p.puerto, 'superficie', case when sup_puerto_riesgoso(p.puerto) then 'alta' else 'media' end,
           'Puerto ' || p.puerto || coalesce(' (' || p.servicio || ')', '') || ' abierto a Internet en ' || o.direccion,
           coalesce(o.descripcion || ' · ', '') || 'visto desde ' || to_char(p.primera_vez at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') ||
           '. Si corresponde, marcalo como esperado.', '/inventario/superficie'
      from sup_puertos p join sup_objetivos o on o.id = p.objetivo_id
     where p.abierto and not p.esperado and o.activo
    on conflict do nothing;
    insert into _cond
    select 'sup:cve:' || o.id, 'superficie', 'media', 'Vulnerabilidades publicadas para ' || o.direccion,
           count(*) || ' CVE según Shodan: ' || string_agg(v.cve, ', ' order by v.cve desc), '/inventario/superficie'
      from sup_vulns v join sup_objetivos o on o.id = v.objetivo_id where o.activo group by o.id, o.direccion
    on conflict do nothing;
  end if;

  if c.alertas_normativa then
    select count(*) into n from norma_evaluacion where proxima < current_date and estado <> 'no_aplica';
    if n > 0 then
      insert into _cond values ('norma:revision', 'normativa', 'info', n || ' control(es) de normativa con la revisión vencida',
        'BCRA "A" 7724 / ISO 27001', '/inventario/normativa') on conflict do nothing;
    end if;
    select count(*) into n from norma_evaluacion where estado = 'no_cumple';
    if n > 0 then
      insert into _cond values ('norma:no_cumple', 'normativa', 'media', n || ' control(es) de normativa que no se cumplen',
        'BCRA "A" 7724 / ISO 27001', '/inventario/normativa?estado=no_cumple') on conflict do nothing;
    end if;
  end if;
end $$;
revoke all on function public.postura_condiciones_alertas() from public, anon, authenticated;

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
  if to_regprocedure('public.postura_condiciones_alertas()') is not null then perform postura_condiciones_alertas(); end if;
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
-- Permisos: se ve con la solapa Seguridad; los datos los escribe la tarea diaria o las funciones de arriba
-- ----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ss_historial', 'ss_categorias', 'ss_acciones', 'correo_dominios', 'correo_estado', 'correo_cambios',
                           'sup_objetivos', 'sup_puertos', 'sup_vulns', 'norma_controles', 'norma_evaluacion', 'informe_mensual'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''seguridad''))', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
  alter table public.prog_config enable row level security;
  revoke all on public.prog_config from anon, authenticated;
end $$;

-- Los administradores cargan dominios y direcciones a revisar (queda en Logs)
drop policy if exists correo_dominios_admin on public.correo_dominios;
create policy correo_dominios_admin on public.correo_dominios for all to authenticated
  using (coalesce(mi_rol(), '') = 'administrador' and puede_ver('seguridad')) with check (coalesce(mi_rol(), '') = 'administrador' and puede_ver('seguridad'));
grant insert, update, delete on public.correo_dominios to authenticated;
drop policy if exists sup_objetivos_admin on public.sup_objetivos;
create policy sup_objetivos_admin on public.sup_objetivos for all to authenticated
  using (coalesce(mi_rol(), '') = 'administrador' and puede_ver('seguridad')) with check (coalesce(mi_rol(), '') = 'administrador' and puede_ver('seguridad'));
grant insert, update, delete on public.sup_objetivos to authenticated;

create or replace function public.sup_marcar(p_objetivo int, p_puerto int, p_esperado boolean, p_nota text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') = 'administrador') then raise exception 'Solo un administrador puede justificar puertos'; end if;
  select p.esperado, p.nota, o.direccion into r from sup_puertos p join sup_objetivos o on o.id = p.objetivo_id
   where p.objetivo_id = p_objetivo and p.puerto = p_puerto;
  if not found then raise exception 'Puerto inexistente'; end if;
  update sup_puertos set esperado = p_esperado, nota = nullif(left(trim(p_nota), 300), '') where objetivo_id = p_objetivo and puerto = p_puerto;
  perform postura_auditar('sup_puertos', p_objetivo || ':' || p_puerto,
    'Puerto ' || p_puerto || ' en ' || r.direccion || case when p_esperado then ' marcado como esperado' else ' vuelve a alertar' end,
    jsonb_build_object('esperado', jsonb_build_object('antes', r.esperado, 'despues', p_esperado),
                       'nota', jsonb_build_object('antes', r.nota, 'despues', nullif(left(trim(p_nota), 300), ''))));
end $$;
grant execute on function public.sup_marcar(int, int, boolean, text) to authenticated;

create or replace function public.correo_cambio_revisado(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then raise exception 'Sin permiso'; end if;
  update correo_cambios set revisado = now(), revisado_por = auth.uid() where id = p_id and revisado is null
  returning dominio, registro, antes, despues into r;
  if found then
    perform postura_auditar('correo_cambios', p_id::text, 'Cambio de ' || r.registro || ' en ' || r.dominio || ' marcado como autorizado',
      jsonb_build_object('antes', r.antes, 'despues', r.despues));
  end if;
end $$;
grant execute on function public.correo_cambio_revisado(bigint) to authenticated;

do $$
declare t text;
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  -- el disparador general ignora lo que no hace una persona, así que la tarea diaria no llena Logs
  foreach t in array array['correo_dominios', 'sup_objetivos', 'norma_evaluacion', 'prog_config'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
