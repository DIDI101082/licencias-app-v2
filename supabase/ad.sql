-- ==========================================================
-- Seguridad → Active Directory
--   * Un puente de solo lectura en cada controlador de dominio envía:
--     - cada hora: dominio, controladores, política de contraseñas, usuarios, equipos y grupos privilegiados;
--     - cada ejecución: eventos de seguridad del DC (altas, bajas, cambios de grupos, bloqueos, intentos fallidos,
--       borrado del log, cambios de política).
--   * Hallazgos: ex empleados con la cuenta habilitada (cruce con Empleados), cuentas inactivas, contraseñas que no
--     vencen, cuentas atacables (Kerberoasting, AS-REP), delegación sin restricciones, krbtgt vieja, política débil…
--   * Alertas (arrancan apagadas).
-- Ejecutar UNA VEZ en el SQL Editor (se puede repetir sin problema).
-- ==========================================================

create table if not exists public.ad_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  creado_en timestamptz,
  ultimo_reporte timestamptz,
  ultimo_inventario timestamptz,
  version_puente text,
  alertas boolean not null default false,
  alertar_altas boolean not null default true,        -- usuarios creados o habilitados
  dias_inactivo int not null default 90 check (dias_inactivo between 30 and 365),
  umbral_fallos int not null default 20 check (umbral_fallos between 5 and 1000),
  minutos_sin_reporte int not null default 30 check (minutos_sin_reporte between 10 and 720)
);
insert into public.ad_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.ad_dominio (
  id int primary key default 1 check (id = 1),
  dns text, netbios text, nivel_dominio text, nivel_bosque text, pdc text, papelera boolean, krbtgt_pwd timestamptz,
  pwd_min int, pwd_max_dias int, pwd_historial int, pwd_complejidad boolean, bloqueo_umbral int,
  actualizado timestamptz
);
insert into public.ad_dominio (id) values (1) on conflict (id) do nothing;

create table if not exists public.ad_dcs (
  nombre text primary key, host text, so text, sitio text, gc boolean, ip text, roles text,
  ultimo_reporte timestamptz,                 -- último envío del puente instalado en ese DC
  version_puente text, avisos jsonb not null default '[]',
  actualizado timestamptz
);

create table if not exists public.ad_usuarios (
  sam text primary key, upn text, nombre text, mail text, habilitado boolean, ultimo_logon timestamptz, pwd_cambiada timestamptz,
  creado timestamptz, pwd_no_vence boolean, pwd_no_requerida boolean, reversible boolean, sin_preauth boolean, delegacion boolean,
  spn boolean, admin_count boolean, bloqueado boolean, departamento text, cargo text, rid500 boolean,
  actualizado timestamptz not null default now()
);
create index if not exists idx_ad_usuarios_mail on public.ad_usuarios (lower(mail));
create index if not exists idx_ad_usuarios_upn on public.ad_usuarios (lower(upn));

create table if not exists public.ad_equipos (
  nombre text primary key, so text, version text, habilitado boolean, ultimo_logon timestamptz, creado timestamptz,
  delegacion boolean, es_dc boolean, laps boolean,
  actualizado timestamptz not null default now()
);

create table if not exists public.ad_grupos (
  clave text primary key,                     -- domain_admins, administrators, … (no depende del idioma del dominio)
  nombre text not null,                       -- nombre real en el dominio (ej. "Admins. del dominio")
  actualizado timestamptz not null default now()
);
create table if not exists public.ad_miembros (
  grupo text not null references public.ad_grupos(clave) on delete cascade,
  sam text not null, nombre text, tipo text,
  desde timestamptz not null default now(),   -- primera vez que lo vimos en el grupo
  primary key (grupo, sam)
);

create table if not exists public.ad_eventos (
  id bigserial primary key,
  dc text not null default '',
  record_id bigint,                           -- null = detectado comparando el inventario (no por un evento del DC)
  fecha timestamptz not null,
  evento int, tipo text not null,
  usuario text, actor text, grupo text, ip text, equipo text, motivo text
);
create unique index if not exists idx_ad_eventos_rec on public.ad_eventos (dc, record_id) where record_id is not null;
create index if not exists idx_ad_eventos_fecha on public.ad_eventos (fecha desc);
create index if not exists idx_ad_eventos_tipo on public.ad_eventos (tipo, fecha desc);

-- Grupos que se consideran privilegiados (Protected Users se informa, pero no da privilegios)
create or replace function public.ad_es_privilegiado(p_clave text) returns boolean language sql immutable as $$
  select p_clave in ('domain_admins', 'enterprise_admins', 'schema_admins', 'administrators', 'account_operators', 'server_operators',
                     'backup_operators', 'print_operators', 'gpo_creators', 'key_admins', 'enterprise_key_admins', 'dnsadmins')
$$;

-- ----------------------------------------------------------
-- Lo llama el puente (una vez por ejecución en cada DC)
-- ----------------------------------------------------------
create or replace function public.ad_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text; v_ahora timestamptz := now(); v_dc text := left(coalesce(nullif(p_datos ->> 'dc', ''), 'DC'), 60);
  n_ev int := 0; v_primer_inv boolean;
begin
  select token_hash into v_hash from ad_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente de Active Directory inválido';
  end if;

  -- Eventos del DC (no se repiten: dc + número de registro)
  if jsonb_typeof(p_datos -> 'eventos') = 'array' then
    insert into ad_eventos (dc, record_id, fecha, evento, tipo, usuario, actor, grupo, ip, equipo, motivo)
    select v_dc, x.record_id, coalesce(x.fecha, v_ahora), x.evento, left(x.tipo, 40), nullif(left(x.usuario, 200), ''), nullif(left(x.actor, 200), ''),
           nullif(left(x.grupo, 200), ''), nullif(left(x.ip, 60), ''), nullif(left(x.equipo, 100), ''), nullif(left(x.motivo, 40), '')
      from jsonb_to_recordset(p_datos -> 'eventos') as x(record_id bigint, fecha timestamptz, evento int, tipo text, usuario text, actor text,
                                                           grupo text, ip text, equipo text, motivo text)
     where coalesce(x.tipo, '') <> ''
    on conflict (dc, record_id) where record_id is not null do nothing;
    get diagnostics n_ev = row_count;
  end if;

  -- Inventario (llega cada hora; cualquiera de los DC lo puede mandar)
  if jsonb_typeof(p_datos -> 'dominio') = 'object' then
    update ad_dominio d set dns = x.dns, netbios = x.netbios, nivel_dominio = x.nivel_dominio, nivel_bosque = x.nivel_bosque, pdc = x.pdc,
           papelera = x.papelera, krbtgt_pwd = x.krbtgt_pwd, pwd_min = x.pwd_min, pwd_max_dias = x.pwd_max_dias, pwd_historial = x.pwd_historial,
           pwd_complejidad = x.pwd_complejidad, bloqueo_umbral = x.bloqueo_umbral, actualizado = v_ahora
      from jsonb_to_record(p_datos -> 'dominio') as x(dns text, netbios text, nivel_dominio text, nivel_bosque text, pdc text, papelera boolean,
                                                      krbtgt_pwd timestamptz, pwd_min int, pwd_max_dias int, pwd_historial int,
                                                      pwd_complejidad boolean, bloqueo_umbral int)
     where d.id = 1;
  end if;

  if jsonb_typeof(p_datos -> 'dcs') = 'array' then
    insert into ad_dcs as t (nombre, host, so, sitio, gc, ip, roles, actualizado)
    select left(x.nombre, 60), x.host, x.so, x.sitio, x.gc, x.ip, x.roles, v_ahora
      from jsonb_to_recordset(p_datos -> 'dcs') as x(nombre text, host text, so text, sitio text, gc boolean, ip text, roles text)
     where coalesce(x.nombre, '') <> ''
    on conflict (nombre) do update set host = excluded.host, so = excluded.so, sitio = excluded.sitio, gc = excluded.gc, ip = excluded.ip,
      roles = excluded.roles, actualizado = v_ahora;
    delete from ad_dcs where actualizado < v_ahora - interval '1 day' and (ultimo_reporte is null or ultimo_reporte < v_ahora - interval '7 days');
  end if;

  if jsonb_typeof(p_datos -> 'usuarios') = 'array' then
    insert into ad_usuarios as u (sam, upn, nombre, mail, habilitado, ultimo_logon, pwd_cambiada, creado, pwd_no_vence, pwd_no_requerida, reversible,
                                  sin_preauth, delegacion, spn, admin_count, bloqueado, departamento, cargo, rid500, actualizado)
    select left(x.sam, 100), nullif(x.upn, ''), nullif(x.nombre, ''), nullif(x.mail, ''), x.habilitado, x.ultimo_logon, x.pwd_cambiada, x.creado,
           x.pwd_no_vence, x.pwd_no_requerida, x.reversible, x.sin_preauth, x.delegacion, x.spn, x.admin_count, x.bloqueado,
           nullif(x.departamento, ''), nullif(x.cargo, ''), coalesce(x.rid500, false), v_ahora
      from jsonb_to_recordset(p_datos -> 'usuarios') as x(sam text, upn text, nombre text, mail text, habilitado boolean, ultimo_logon timestamptz,
             pwd_cambiada timestamptz, creado timestamptz, pwd_no_vence boolean, pwd_no_requerida boolean, reversible boolean, sin_preauth boolean,
             delegacion boolean, spn boolean, admin_count boolean, bloqueado boolean, departamento text, cargo text, rid500 boolean)
     where coalesce(x.sam, '') <> ''
    on conflict (sam) do update set upn = excluded.upn, nombre = excluded.nombre, mail = excluded.mail, habilitado = excluded.habilitado,
      ultimo_logon = greatest(u.ultimo_logon, excluded.ultimo_logon), pwd_cambiada = excluded.pwd_cambiada, creado = excluded.creado,
      pwd_no_vence = excluded.pwd_no_vence, pwd_no_requerida = excluded.pwd_no_requerida, reversible = excluded.reversible,
      sin_preauth = excluded.sin_preauth, delegacion = excluded.delegacion, spn = excluded.spn, admin_count = excluded.admin_count,
      bloqueado = excluded.bloqueado, departamento = excluded.departamento, cargo = excluded.cargo, rid500 = excluded.rid500, actualizado = v_ahora;
    delete from ad_usuarios where actualizado < v_ahora;      -- borrados del dominio
  end if;

  if jsonb_typeof(p_datos -> 'equipos') = 'array' then
    insert into ad_equipos as q (nombre, so, version, habilitado, ultimo_logon, creado, delegacion, es_dc, laps, actualizado)
    select left(x.nombre, 100), nullif(x.so, ''), nullif(x.version, ''), x.habilitado, x.ultimo_logon, x.creado, x.delegacion, x.es_dc, x.laps, v_ahora
      from jsonb_to_recordset(p_datos -> 'equipos') as x(nombre text, so text, version text, habilitado boolean, ultimo_logon timestamptz,
                                                         creado timestamptz, delegacion boolean, es_dc boolean, laps boolean)
     where coalesce(x.nombre, '') <> ''
    on conflict (nombre) do update set so = excluded.so, version = excluded.version, habilitado = excluded.habilitado,
      ultimo_logon = greatest(q.ultimo_logon, excluded.ultimo_logon), creado = excluded.creado, delegacion = excluded.delegacion,
      es_dc = excluded.es_dc, laps = excluded.laps, actualizado = v_ahora;
    delete from ad_equipos where actualizado < v_ahora;
  end if;

  -- Grupos privilegiados: se comparan con lo anterior para registrar altas y bajas aunque falte el evento del DC
  if jsonb_typeof(p_datos -> 'grupos') = 'array' then
    create temp table if not exists _ad_m (grupo text, sam text, nombre text, tipo text) on commit drop;
    delete from _ad_m where true;
    insert into _ad_m select g ->> 'clave', left(m ->> 'sam', 200), left(m ->> 'nombre', 200), left(m ->> 'tipo', 30)
      from jsonb_array_elements(p_datos -> 'grupos') g
      cross join lateral jsonb_array_elements(case when jsonb_typeof(g -> 'miembros') = 'array' then g -> 'miembros' else '[]' end) m
     where coalesce(g ->> 'clave', '') <> '' and coalesce(m ->> 'sam', '') <> '';

    insert into ad_grupos as g (clave, nombre, actualizado)
    select x ->> 'clave', left(coalesce(nullif(x ->> 'nombre', ''), x ->> 'clave'), 200), v_ahora
      from jsonb_array_elements(p_datos -> 'grupos') x where coalesce(x ->> 'clave', '') <> ''
    on conflict (clave) do update set nombre = excluded.nombre, actualizado = v_ahora;

    select not exists (select 1 from ad_miembros) into v_primer_inv;
    if not v_primer_inv then
      insert into ad_eventos (dc, fecha, tipo, usuario, grupo, motivo)
      select v_dc, v_ahora, 'miembro_agregado', coalesce(n.nombre, n.sam), g.nombre, 'inventario'
        from _ad_m n join ad_grupos g on g.clave = n.grupo
       where not exists (select 1 from ad_miembros a where a.grupo = n.grupo and a.sam = n.sam)
         -- si el DC ya informó el evento en la última hora, no se duplica
         and not exists (select 1 from ad_eventos e where e.tipo = 'miembro_agregado' and e.fecha > v_ahora - interval '2 hours'
                          and lower(e.grupo) = lower(g.nombre) and lower(e.usuario) in (lower(n.nombre), lower(n.sam)));
      insert into ad_eventos (dc, fecha, tipo, usuario, grupo, motivo)
      select v_dc, v_ahora, 'miembro_quitado', coalesce(a.nombre, a.sam), g.nombre, 'inventario'
        from ad_miembros a join ad_grupos g on g.clave = a.grupo
       where g.clave in (select distinct grupo from _ad_m union select x ->> 'clave' from jsonb_array_elements(p_datos -> 'grupos') x)
         and not exists (select 1 from _ad_m n where n.grupo = a.grupo and n.sam = a.sam)
         and not exists (select 1 from ad_eventos e where e.tipo = 'miembro_quitado' and e.fecha > v_ahora - interval '2 hours'
                          and lower(e.grupo) = lower(g.nombre) and lower(e.usuario) in (lower(a.nombre), lower(a.sam)));
    end if;
    delete from ad_miembros a
     where a.grupo in (select x ->> 'clave' from jsonb_array_elements(p_datos -> 'grupos') x)
       and not exists (select 1 from _ad_m n where n.grupo = a.grupo and n.sam = a.sam);
    insert into ad_miembros (grupo, sam, nombre, tipo, desde)
    select distinct on (grupo, sam) grupo, sam, nombre, tipo, v_ahora from _ad_m
    on conflict (grupo, sam) do update set nombre = excluded.nombre, tipo = excluded.tipo;
    update ad_config set ultimo_inventario = v_ahora where id = 1;
  end if;

  -- Estado de este DC
  insert into ad_dcs as t (nombre, ultimo_reporte, version_puente, avisos)
  values (v_dc, v_ahora, left(p_datos ->> 'version', 20), coalesce(p_datos -> 'avisos', '[]'))
  on conflict (nombre) do update set ultimo_reporte = v_ahora, version_puente = excluded.version_puente, avisos = excluded.avisos;

  delete from ad_eventos where fecha < v_ahora - interval '180 days';
  update ad_config set ultimo_reporte = v_ahora, version_puente = left(p_datos ->> 'version', 20) where id = 1;
  return jsonb_build_object('ok', true, 'eventos', n_ev);
end $$;
revoke all on function public.ad_reportar(text, jsonb) from public;
grant execute on function public.ad_reportar(text, jsonb) to anon, authenticated;

-- ----------------------------------------------------------
-- Hallazgos (se recalculan solos con cada inventario)
-- ----------------------------------------------------------
create or replace view public.ad_hallazgos with (security_invoker = true) as
with c as (select * from ad_config where id = 1),
priv as (select distinct m.sam from ad_miembros m where ad_es_privilegiado(m.grupo) and coalesce(m.tipo, 'user') = 'user'),
u as (select x.*, x.sam in (select sam from priv) as privilegiado,
             coalesce(x.ultimo_logon, x.creado) < now() - make_interval(days => (select dias_inactivo from c)) as inactivo
        from ad_usuarios x
       where x.sam not in ('krbtgt', 'Guest', 'Invitado', 'DefaultAccount') and x.sam not like '%$')
-- Ex empleados (cruce con la solapa Empleados)
select 'usuario'::text as ambito, u.sam as clave, 'ex_empleado'::text as tipo, 'critica'::text as severidad,
       'Ex empleado con la cuenta habilitada: ' || coalesce(u.nombre, u.sam) as titulo,
       'Figura inactivo en Empleados (' || e.email || ') pero su cuenta de Active Directory sigue habilitada' ||
         coalesce('; último inicio de sesión ' || to_char(u.ultimo_logon at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), '') || '. Deshabilitala.' as detalle
  from u join empleados e on e.activo = false and (lower(e.email) = lower(u.mail) or lower(e.email) = lower(u.upn))
 where u.habilitado
   and not exists (select 1 from empleados e2 where e2.activo and (lower(e2.email) = lower(u.mail) or lower(e2.email) = lower(u.upn)))
union all
select 'usuario', sam, 'priv_spn', 'critica', 'Cuenta privilegiada atacable por Kerberoasting: ' || coalesce(nombre, sam),
       'Tiene un SPN y está en un grupo privilegiado: cualquier usuario del dominio puede pedir su ticket e intentar descifrar la contraseña fuera de línea. Sacala del grupo o usá una cuenta de servicio administrada (gMSA).'
  from u where habilitado and spn and privilegiado
union all
select 'usuario', sam, 'sin_preauth', case when privilegiado then 'critica' else 'alta' end, 'Cuenta sin preautenticación Kerberos: ' || coalesce(nombre, sam),
       'Permite el ataque AS-REP roasting (obtener un hash para descifrar la contraseña sin conocerla). Activá la preautenticación.'
  from u where habilitado and sin_preauth
union all
select 'usuario', sam, 'pwd_no_requerida', 'alta', 'Cuenta que puede no tener contraseña: ' || coalesce(nombre, sam),
       'Tiene marcado "contraseña no requerida" (PASSWD_NOTREQD). Quitá la marca y asigná una contraseña.'
  from u where habilitado and pwd_no_requerida
union all
select 'usuario', sam, 'reversible', 'alta', 'Contraseña guardada con cifrado reversible: ' || coalesce(nombre, sam),
       'La contraseña se puede recuperar en texto plano desde el dominio. Desactivá la opción y cambiá la contraseña.'
  from u where habilitado and reversible
union all
select 'usuario', sam, 'delegacion', 'alta', 'Usuario con delegación sin restricciones: ' || coalesce(nombre, sam),
       'Puede suplantar a cualquier usuario ante cualquier servicio. Usá delegación restringida o quitala.'
  from u where habilitado and delegacion
union all
select 'usuario', sam, 'priv_inactivo', 'alta', 'Cuenta privilegiada sin uso: ' || coalesce(nombre, sam),
       coalesce('Último inicio de sesión ' || to_char(ultimo_logon at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), 'Nunca inició sesión') ||
       '. Si no se usa, deshabilitala o sacala de los grupos de administración.'
  from u where habilitado and privilegiado and inactivo
union all
select 'usuario', sam, 'priv_pwd_no_vence', 'alta', 'Cuenta privilegiada con contraseña que nunca vence: ' || coalesce(nombre, sam),
       'Última contraseña: ' || coalesce(to_char(pwd_cambiada at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), '—') || '.'
  from u where habilitado and privilegiado and pwd_no_vence
union all
select 'usuario', sam, 'admin_integrado', 'media', 'Cuenta Administrador integrada en uso: ' || sam,
       'Conviene usar cuentas nominales para administrar, dejar la integrada deshabilitada o con una contraseña larga guardada en sobre, y vigilar su uso.'
  from u where habilitado and rid500 and ultimo_logon > now() - interval '30 days'
union all
select 'usuario', sam, 'spn', 'media', 'Cuenta de servicio atacable por Kerberoasting: ' || coalesce(nombre, sam),
       'Tiene un SPN: su contraseña se puede atacar fuera de línea. Usá una contraseña de 25 caracteres o más, o una cuenta gMSA.'
  from u where habilitado and spn and not privilegiado
union all
select 'usuario', sam, 'inactivo', 'media', 'Cuenta habilitada sin uso: ' || coalesce(nombre, sam),
       coalesce('Último inicio de sesión ' || to_char(ultimo_logon at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), 'Nunca inició sesión') ||
       coalesce(' · ' || departamento, '') || '. Si ya no se usa, deshabilitala.'
  from u where habilitado and inactivo and not privilegiado
union all
select 'usuario', sam, 'pwd_no_vence', 'baja', 'Contraseña que nunca vence: ' || coalesce(nombre, sam),
       'Última contraseña: ' || coalesce(to_char(pwd_cambiada at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), '—') || '.'
  from u where habilitado and pwd_no_vence and not privilegiado and not spn
union all
-- Equipos
select 'equipo', nombre, 'delegacion', 'alta', 'Equipo con delegación sin restricciones: ' || nombre,
       'Si alguien lo compromete, puede robar las credenciales de quien se conecte (incluidos administradores). Usá delegación restringida.'
  from ad_equipos where habilitado and delegacion and not coalesce(es_dc, false)
union all
select 'equipo', nombre, 'so_sin_soporte', case when so ~* 'server' then 'alta' else 'media' end, 'Sistema operativo sin soporte: ' || nombre,
       so || '. Ya no recibe parches de seguridad de Microsoft.'
  from ad_equipos where habilitado and so ~* '(windows (xp|vista|7|8)\M|server (2003|2008|2012))'
   and coalesce(ultimo_logon, creado) > now() - make_interval(days => (select dias_inactivo from c))
union all
select 'equipo', nombre, 'inactivo', 'baja', 'Equipo del dominio sin uso: ' || nombre,
       coalesce(so || ' · ', '') || coalesce('último contacto ' || to_char(ultimo_logon at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'), 'nunca se conectó') || '. Si ya no existe, deshabilitalo o borralo.'
  from ad_equipos where habilitado and not coalesce(es_dc, false)
   and coalesce(ultimo_logon, creado) < now() - make_interval(days => (select dias_inactivo from c))
union all
select 'equipo', nombre, 'sin_laps', 'media', 'Equipo sin LAPS: ' || nombre,
       'La contraseña del administrador local no se rota con LAPS: si es la misma en varios equipos, comprometer uno da acceso a todos.'
  from ad_equipos where habilitado and laps = false and not coalesce(es_dc, false)
   and exists (select 1 from ad_equipos where laps)       -- solo si LAPS se usa en el dominio
   and coalesce(ultimo_logon, creado) > now() - make_interval(days => (select dias_inactivo from c))
union all
-- Dominio
select 'dominio', 'krbtgt', 'krbtgt', case when krbtgt_pwd < now() - interval '365 days' then 'alta' else 'media' end,
       'La contraseña de krbtgt no se cambia hace ' || (now()::date - krbtgt_pwd::date) || ' días',
       'Si alguna vez se comprometió el dominio, un atacante podría seguir creando "golden tickets". Cambiala dos veces (con 10 horas entre cada cambio) al menos una vez al año.'
  from ad_dominio where krbtgt_pwd < now() - interval '180 days'
union all
select 'dominio', 'politica', 'sin_bloqueo', 'alta', 'Las cuentas no se bloquean por intentos fallidos',
       'La política de contraseñas del dominio no tiene umbral de bloqueo: permite probar contraseñas sin límite. Configurá, por ejemplo, 10 intentos.'
  from ad_dominio where bloqueo_umbral = 0
union all
select 'dominio', 'politica', 'pwd_corta', 'media', 'Largo mínimo de contraseña: ' || pwd_min || ' caracteres',
       'Se recomiendan 12 o más (o 14 para cuentas administrativas, con una política específica).'
  from ad_dominio where pwd_min < 12
union all
select 'dominio', 'politica', 'sin_complejidad', 'media', 'La política no exige contraseñas complejas', 'Activá los requisitos de complejidad o una política de frases de contraseña largas.'
  from ad_dominio where pwd_complejidad = false
union all
select 'dominio', 'papelera', 'papelera', 'baja', 'La papelera de reciclaje de Active Directory está desactivada',
       'Sin ella, un usuario o grupo borrado por error se recupera solo desde un backup. Se activa con Enable-ADOptionalFeature.'
  from ad_dominio where papelera = false
union all
select 'dominio', 'domain_admins', 'muchos_admins', 'media', 'Hay ' || count(*) || ' cuentas en ' || max(g.nombre),
       'Conviene que sean muy pocas (2 a 4) y que se usen solo para administrar el dominio.'
  from ad_miembros m join ad_grupos g on g.clave = m.grupo
 where m.grupo = 'domain_admins' and coalesce(m.tipo, 'user') = 'user' group by m.grupo having count(*) > 5
union all
select 'dominio', 'dc:' || nombre, 'dc_sin_reporte', 'media', 'El controlador ' || nombre || ' no tiene el puente instalado o dejó de reportar',
       'Los eventos de seguridad se leen en cada DC: sin el puente en ' || nombre || ' se pierden los inicios de sesión fallidos y bloqueos que resuelva ese DC.'
  from ad_dcs where host is not null and (ultimo_reporte is null or ultimo_reporte < now() - interval '1 day');

-- Grupos privilegiados con sus miembros y el detalle de cada cuenta
create or replace view public.ad_privilegiados with (security_invoker = true) as
select g.clave, g.nombre as grupo, ad_es_privilegiado(g.clave) as privilegiado, m.sam, m.nombre, m.tipo, m.desde,
       u.habilitado, u.ultimo_logon, u.pwd_cambiada, u.pwd_no_vence, u.spn
  from ad_grupos g join ad_miembros m on m.grupo = g.clave
  left join ad_usuarios u on u.sam = m.sam;

-- ----------------------------------------------------------
-- Configuración
-- ----------------------------------------------------------
create or replace function public.ad_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when puede_ver('seguridad') then jsonb_build_object(
    'configurado', token_hash is not null, 'ultimo_reporte', ultimo_reporte, 'ultimo_inventario', ultimo_inventario,
    'version_puente', version_puente, 'alertas', alertas, 'alertar_altas', alertar_altas, 'dias_inactivo', dias_inactivo,
    'umbral_fallos', umbral_fallos, 'minutos_sin_reporte', minutos_sin_reporte)
  end from ad_config where id = 1
$$;
revoke execute on function public.ad_estado() from public, anon;
grant execute on function public.ad_estado() to authenticated;

create or replace function public.ad_nuevo_puente(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;
  update ad_config set token_hash = p_token_hash, creado_en = now() where id = 1;
end $$;
revoke execute on function public.ad_nuevo_puente(text) from public, anon;
grant execute on function public.ad_nuevo_puente(text) to authenticated;

create or replace function public.ad_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update ad_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    alertar_altas = coalesce((p ->> 'alertar_altas')::boolean, alertar_altas),
    dias_inactivo = coalesce((p ->> 'dias_inactivo')::int, dias_inactivo),
    umbral_fallos = coalesce((p ->> 'umbral_fallos')::int, umbral_fallos),
    minutos_sin_reporte = coalesce((p ->> 'minutos_sin_reporte')::int, minutos_sin_reporte)
  where id = 1;
end $$;
revoke execute on function public.ad_config_guardar(jsonb) from public, anon;
grant execute on function public.ad_config_guardar(jsonb) to authenticated;

-- Quitar un DC que ya no existe
create or replace function public.ad_quitar_dc(p_nombre text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  delete from ad_dcs where nombre = p_nombre;
end $$;
revoke execute on function public.ad_quitar_dc(text) from public, anon;
grant execute on function public.ad_quitar_dc(text) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------
create or replace function public.ad_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c ad_config;
begin
  select * into c from ad_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  -- Puente sin reportar (por DC)
  insert into _cond select 'ad:puente:' || nombre, 'ad', 'alta', 'El puente de Active Directory dejó de reportar en ' || nombre,
         coalesce('Último reporte ' || to_char(ultimo_reporte at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'Nunca reportó'), '/inventario/ad'
    from ad_dcs where ultimo_reporte is not null and ultimo_reporte < now() - make_interval(mins => c.minutos_sin_reporte)
  on conflict do nothing;

  -- Alguien entró a un grupo privilegiado (últimas 24 horas)
  insert into _cond select 'ad:grupo:' || e.id, 'ad', 'critica', 'Nuevo miembro en ' || e.grupo || ': ' || coalesce(e.usuario, '—'),
         concat_ws(' · ', 'Agregado por ' || e.actor, 'en ' || nullif(e.dc, ''), to_char(e.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'),
                   case when e.motivo = 'inventario' then 'detectado en el inventario' end), '/inventario/ad?vista=eventos'
    from ad_eventos e
   where e.tipo = 'miembro_agregado' and e.fecha > now() - interval '24 hours'
     and exists (select 1 from ad_grupos g where ad_es_privilegiado(g.clave) and lower(g.nombre) = lower(e.grupo))
  on conflict do nothing;

  -- Log de seguridad borrado, contraseña DSRM o política del dominio cambiada
  insert into _cond select 'ad:ev:' || e.id, 'ad', case when e.tipo = 'log_borrado' then 'critica' else 'alta' end,
         case e.tipo when 'log_borrado' then 'Se borró el log de seguridad de ' || e.dc
                     when 'dsrm' then 'Se cambió la contraseña de restauración (DSRM) de ' || e.dc
                     else 'Se cambió la política del dominio' end,
         concat_ws(' · ', 'Por ' || e.actor, to_char(e.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')), '/inventario/ad?vista=eventos'
    from ad_eventos e where e.tipo in ('log_borrado', 'dsrm', 'politica_dominio') and e.fecha > now() - interval '24 hours'
  on conflict do nothing;

  -- Intentos fallidos: por usuario, por IP y password spraying (una IP probando muchos usuarios)
  insert into _cond select 'ad:bf:usr:' || lower(usuario), 'ad', 'alta', 'Intentos fallidos de inicio de sesión para ' || usuario,
         count(*) || ' en la última hora' || coalesce(' · desde ' || left(string_agg(distinct coalesce(ip, equipo), ', '), 120), ''), '/inventario/ad?vista=eventos'
    from ad_eventos where tipo in ('fallo_inicio', 'fallo_kerberos', 'fallo_ntlm') and fecha > now() - interval '1 hour' and usuario is not null
   group by lower(usuario), usuario having count(*) >= c.umbral_fallos
  on conflict do nothing;
  insert into _cond select 'ad:spray:' || coalesce(ip, equipo), 'ad', 'critica', 'Posible password spraying desde ' || coalesce(ip, equipo),
         count(distinct lower(usuario)) || ' usuarios distintos con contraseña incorrecta en la última hora', '/inventario/ad?vista=eventos'
    from ad_eventos where tipo in ('fallo_inicio', 'fallo_kerberos', 'fallo_ntlm') and fecha > now() - interval '1 hour' and coalesce(ip, equipo) is not null
   group by coalesce(ip, equipo) having count(distinct lower(usuario)) >= 10
  on conflict do nothing;

  -- Bloqueos: cuenta privilegiada bloqueada, o muchos bloqueos juntos
  insert into _cond select 'ad:bloqueo:' || e.id, 'ad', 'alta', 'Cuenta privilegiada bloqueada: ' || e.usuario,
         concat_ws(' · ', 'Origen ' || e.equipo, to_char(e.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')), '/inventario/ad?vista=eventos'
    from ad_eventos e where e.tipo = 'bloqueo' and e.fecha > now() - interval '24 hours'
     and exists (select 1 from ad_miembros m where ad_es_privilegiado(m.grupo) and lower(m.sam) = lower(e.usuario))
  on conflict do nothing;
  insert into _cond select 'ad:bloqueos', 'ad', 'alta', count(*) || ' cuentas bloqueadas en la última hora',
         left(string_agg(distinct usuario, ', '), 200), '/inventario/ad?vista=eventos'
    from ad_eventos where tipo = 'bloqueo' and fecha > now() - interval '1 hour' having count(distinct usuario) >= 5
  on conflict do nothing;

  -- Usuarios creados o habilitados (últimas 24 horas)
  if c.alertar_altas then
    insert into _cond select 'ad:alta:' || e.id, 'ad', 'media',
           case e.tipo when 'usuario_creado' then 'Usuario creado en el dominio: ' else 'Usuario habilitado: ' end || coalesce(e.usuario, '—'),
           concat_ws(' · ', 'Por ' || e.actor, to_char(e.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')), '/inventario/ad?vista=eventos'
      from ad_eventos e where e.tipo in ('usuario_creado', 'usuario_habilitado') and e.fecha > now() - interval '24 hours'
    on conflict do nothing;
  end if;

  -- Hallazgos graves
  insert into _cond select 'ad:h:' || tipo || ':' || clave, 'ad', severidad, titulo, left(detalle, 250), '/inventario/ad?vista=hallazgos'
    from ad_hallazgos where severidad in ('critica', 'alta')
  on conflict do nothing;
end $$;
revoke all on function public.ad_condiciones_alertas() from public, anon, authenticated;

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
-- Permisos: se ve con la solapa Seguridad; los datos los escribe solo el puente
-- ----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ad_dominio', 'ad_dcs', 'ad_usuarios', 'ad_equipos', 'ad_grupos', 'ad_miembros', 'ad_eventos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''seguridad''))', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter table public.ad_config enable row level security;
revoke all on public.ad_config from anon, authenticated;
grant select on public.ad_hallazgos, public.ad_privilegiados to authenticated;
revoke execute on function public.ad_es_privilegiado(text) from anon;

do $$
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  drop trigger if exists trg_auditoria on public.ad_config;
  create trigger trg_auditoria after insert or update or delete on public.ad_config for each row execute function public.auditar();
end $$;
