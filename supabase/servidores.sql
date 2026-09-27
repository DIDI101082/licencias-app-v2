-- ==========================================================
-- Solapa SERVIDORES
--   * Registro de servidores (rol, entorno, criticidad, responsable, RPO) vinculado con:
--       - el agente de Accusys Cyber (sistema operativo, parches, discos, RAM, último reporte),
--       - PRTG (estado en vivo y sensores con problemas),
--       - Veeam (trabajos de backup que lo incluyen: automático por nombre o asignado a mano).
--   * Fin de soporte del sistema operativo (tabla editable, precargada con Windows Server y Linux).
--   * Pruebas de restauración registradas por servidor.
--   * Alertas propias (Teams / tickets) mediante el gancho de alertas de otros módulos.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de backups.sql y auditoria.sql.
-- ==========================================================

-- ----------------------------------------------------------
-- Nueva solapa "Servidores" en los grupos de acceso
-- ----------------------------------------------------------
alter table public.grupos_acceso drop constraint if exists grupos_acceso_modulos_check;
alter table public.grupos_acceso add constraint grupos_acceso_modulos_check
  check (modulos <@ array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red', 'auditoria', 'servidores']);

create or replace function public.mis_modulos() returns text[]
language sql stable security definer set search_path = public as $$
  select case
           when p.rol = 'administrador'
             then array['empleados', 'licencias', 'inventario', 'seguridad', 'ubicacion', 'red', 'auditoria', 'servidores']
           else coalesce(g.modulos, '{}')      -- sin grupo: ninguna solapa
         end
    from perfiles p
    left join grupos_acceso g on g.id = p.grupo_id
   where p.id = auth.uid()
$$;

update public.grupos_acceso
   set modulos = modulos || array['servidores']
 where nombre = 'Ciberseguridad' and not ('servidores' = any(modulos));

-- ----------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------
create table if not exists public.srv_config (
  id int primary key default 1 check (id = 1),
  alertas boolean not null default true,
  reglas text[] not null default array['reporte', 'fin_soporte', 'backup', 'restauracion'],
  horas_sin_reporte int not null default 2 check (horas_sin_reporte between 1 and 168),
  dias_sin_parche int not null default 35 check (dias_sin_parche between 7 and 365),
  dias_aviso_fin_soporte int not null default 180 check (dias_aviso_fin_soporte between 0 and 730),
  dias_prueba_restore int not null default 180 check (dias_prueba_restore between 30 and 730)
);
insert into public.srv_config (id) values (1) on conflict (id) do nothing;

-- Fin de soporte por sistema operativo. "patron" se compara con ILIKE contra el nombre que informa el agente
-- (% = cualquier texto). Si coinciden varios, gana el patrón más largo (el más específico).
create table if not exists public.srv_fin_soporte (
  id serial primary key,
  patron text not null unique,
  nombre text not null,
  fin_estandar date,                  -- fin del soporte general (solo informativo)
  fin_extendido date not null,        -- fin de parches de seguridad: después de esta fecha, "sin soporte"
  notas text
);

insert into public.srv_fin_soporte (patron, nombre, fin_estandar, fin_extendido, notas) values
  ('%Windows Server 2008%',            'Windows Server 2008 / 2008 R2', '2015-01-13', '2020-01-14', 'Sin soporte (ESU pago hasta 2023)'),
  ('%Windows Server 2012%',            'Windows Server 2012',           '2018-10-09', '2023-10-10', 'Sin soporte (ESU pago hasta 13/10/2026)'),
  ('%Windows Server 2012 R2%',         'Windows Server 2012 R2',        '2018-10-09', '2023-10-10', 'Sin soporte (ESU pago hasta 13/10/2026)'),
  ('%Windows Server 2016%',            'Windows Server 2016',           '2022-01-11', '2027-01-12', null),
  ('%Windows Server 2019%',            'Windows Server 2019',           '2024-01-09', '2029-01-09', null),
  ('%Windows Server 2022%',            'Windows Server 2022',           '2026-10-13', '2031-10-14', null),
  ('%Windows Server 2025%',            'Windows Server 2025',           '2029-11-13', '2034-11-14', null),
  ('%Ubuntu 18.04%',                   'Ubuntu 18.04 LTS',              null,         '2023-05-31', 'Después, solo con Ubuntu Pro (ESM)'),
  ('%Ubuntu 20.04%',                   'Ubuntu 20.04 LTS',              null,         '2025-05-31', 'Después, solo con Ubuntu Pro (ESM)'),
  ('%Ubuntu 22.04%',                   'Ubuntu 22.04 LTS',              null,         '2027-06-01', 'Después, solo con Ubuntu Pro (ESM)'),
  ('%Ubuntu 24.04%',                   'Ubuntu 24.04 LTS',              null,         '2029-05-31', 'Después, solo con Ubuntu Pro (ESM)'),
  ('%Debian GNU/Linux 10%',            'Debian 10',                     '2022-09-10', '2024-06-30', 'Fecha de fin de LTS'),
  ('%Debian GNU/Linux 11%',            'Debian 11',                     '2024-08-14', '2026-08-31', 'Fecha de fin de LTS'),
  ('%Debian GNU/Linux 12%',            'Debian 12',                     '2026-07-11', '2028-06-30', 'Fecha de fin de LTS'),
  ('%Debian GNU/Linux 13%',            'Debian 13',                     '2028-08-09', '2030-06-30', 'Fecha de fin de LTS'),
  ('%CentOS Linux 7%',                 'CentOS 7',                      null,         '2024-06-30', null),
  ('%CentOS Stream 8%',                'CentOS Stream 8',               null,         '2024-05-31', null),
  ('%CentOS Stream 9%',                'CentOS Stream 9',               null,         '2027-05-31', null),
  ('%Red Hat Enterprise Linux%7.%',    'RHEL 7',                        null,         '2024-06-30', 'Después, solo con ELS pago'),
  ('%Red Hat Enterprise Linux%8.%',    'RHEL 8',                        '2024-05-31', '2029-05-31', null),
  ('%Red Hat Enterprise Linux%9.%',    'RHEL 9',                        '2027-05-31', '2032-05-31', null),
  ('%Rocky Linux 8%',                  'Rocky Linux 8',                 '2024-05-31', '2029-05-31', null),
  ('%Rocky Linux 9%',                  'Rocky Linux 9',                 '2027-05-31', '2032-05-31', null),
  ('%AlmaLinux 8%',                    'AlmaLinux 8',                   '2024-05-31', '2029-05-31', null),
  ('%AlmaLinux 9%',                    'AlmaLinux 9',                   '2027-05-31', '2032-05-31', null)
on conflict (patron) do nothing;

create table if not exists public.srv_servidores (
  id serial primary key,
  nombre text not null,
  rol text,                                     -- DC, archivos, SQL, aplicación, etc.
  entorno text not null default 'produccion'
    check (entorno in ('produccion', 'pruebas', 'desarrollo', 'contingencia')),
  criticidad text not null default 'media'
    check (criticidad in ('critica', 'alta', 'media', 'baja')),
  sede text,
  responsable text,
  notas text,
  activo boolean not null default true,         -- desactivado: se ve atenuado y no genera alertas
  dispositivo_id uuid unique references public.inv_dispositivos(id) on delete set null,   -- agente
  so_manual text,                               -- sistema operativo, si no tiene agente (appliance, Linux sin agente)
  prtg_objid int,                               -- equipo en PRTG
  requiere_backup boolean not null default true,
  backup_auto boolean not null default true,    -- sumar los trabajos de Veeam que lo incluyen por nombre
  backup_trabajos text[] not null default '{}', -- trabajos asignados a mano
  rpo_horas int not null default 26 check (rpo_horas between 1 and 2160),
  creado_en timestamptz not null default now()
);

create table if not exists public.srv_pruebas_restore (
  id bigserial primary key,
  servidor_id int not null references public.srv_servidores(id) on delete cascade,
  fecha date not null default current_date,
  resultado text not null check (resultado in ('exitosa', 'parcial', 'fallida')),
  duracion_min int check (duracion_min between 0 and 100000),
  notas text,
  registrado_por uuid default auth.uid(),
  registrado_email text,
  creado_en timestamptz not null default now()
);
create index if not exists idx_srv_pruebas_servidor on public.srv_pruebas_restore(servidor_id, fecha desc);

create or replace function public.srv_pruebas_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.registrado_por := auth.uid();
  new.registrado_email := (select email from perfiles where id = auth.uid());
  return new;
end $$;
drop trigger if exists trg_srv_pruebas_email on public.srv_pruebas_restore;
create trigger trg_srv_pruebas_email before insert on public.srv_pruebas_restore
  for each row execute function public.srv_pruebas_email();

-- ----------------------------------------------------------
-- Veeam: el script (versión 1.1) también informa qué VMs / equipos incluye cada trabajo.
-- Así un servidor se vincula solo con sus backups cuando el nombre coincide.
-- ----------------------------------------------------------
alter table public.backups_trabajos add column if not exists objetos text[];

create or replace function public.backups_reportar(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_hash text; t jsonb; n int := 0; v_obj text[];
begin
  select token_hash into v_hash from backups_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos -> 'trabajos'), '') <> 'array' then raise exception 'Datos inválidos'; end if;

  for t in select * from jsonb_array_elements(p_datos -> 'trabajos') loop
    continue when coalesce(t ->> 'nombre', '') = '';
    v_obj := null;
    if jsonb_typeof(t -> 'objetos') = 'array' then
      select array_agg(distinct left(x, 200)) into v_obj
        from jsonb_array_elements_text(t -> 'objetos') x where coalesce(x, '') <> '';
      v_obj := coalesce(v_obj, '{}');
    end if;
    insert into backups_trabajos as b (nombre, tipo, habilitado, ultimo_resultado, ultimo_inicio, ultimo_fin, ultimo_exito, tamano_gb, detalle, objetos, actualizado)
    values (left(t ->> 'nombre', 200), left(t ->> 'tipo', 60), coalesce((t ->> 'habilitado')::boolean, true), left(t ->> 'resultado', 20),
            (t ->> 'inicio')::timestamptz, (t ->> 'fin')::timestamptz, (t ->> 'ultimo_exito')::timestamptz,
            (t ->> 'tamano_gb')::numeric, left(t ->> 'detalle', 500), v_obj, now())
    on conflict (nombre) do update set
      tipo = excluded.tipo, habilitado = excluded.habilitado, ultimo_resultado = excluded.ultimo_resultado,
      ultimo_inicio = excluded.ultimo_inicio, ultimo_fin = excluded.ultimo_fin,
      ultimo_exito = coalesce(excluded.ultimo_exito, b.ultimo_exito),
      tamano_gb = excluded.tamano_gb, detalle = excluded.detalle,
      objetos = coalesce(excluded.objetos, b.objetos),   -- un script 1.0 no borra lo que ya se sabía
      actualizado = now();
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

-- ----------------------------------------------------------
-- Funciones de cálculo
-- ----------------------------------------------------------

-- Fin de soporte que corresponde a un sistema operativo (el patrón más específico)
create or replace function public.srv_fin_soporte_de(p_so text)
returns public.srv_fin_soporte language sql stable security definer set search_path = public as $$
  select f.* from srv_fin_soporte f
   where p_so is not null and p_so ilike f.patron
   order by length(f.patron) desc
   limit 1
$$;

-- Trabajos de Veeam de un servidor: los asignados a mano + (si está activado) los que lo incluyen por nombre
create or replace function public.srv_trabajos_de(p_id int)
returns table (nombre text, automatico boolean) language sql stable security definer set search_path = public as $$
  with s as (
    select sv.backup_trabajos, sv.backup_auto,
           array_remove(array[lower(split_part(sv.nombre, '.', 1)), lower(split_part(d.hostname, '.', 1))], null) as nombres
      from srv_servidores sv
      left join inv_dispositivos d on d.id = sv.dispositivo_id
     where sv.id = p_id
  )
  select b.nombre, not (b.nombre = any(s.backup_trabajos))
    from backups_trabajos b, s
   where b.nombre = any(s.backup_trabajos)
      or (s.backup_auto and exists (
            select 1 from unnest(coalesce(b.objetos, '{}')) o
             where lower(split_part(o, '.', 1)) = any(s.nombres)))
$$;

-- Todo lo que necesita la solapa, de otros módulos (agente, PRTG, Veeam), en una sola llamada.
-- Así quien tiene solo la solapa Servidores ve el estado sin necesitar acceso a Inventario, Red o Seguridad.
create or replace function public.srv_datos()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not puede_ver('servidores') then raise exception 'Sin acceso a la solapa Servidores'; end if;

  select jsonb_build_object(
    'dispositivos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'hostname', d.hostname, 'so_nombre', d.so_nombre, 'so_version', d.so_version, 'so_build', d.so_build,
               'ip', d.ip, 'dominio', d.dominio, 'fabricante', d.fabricante, 'modelo', d.modelo,
               'procesador', d.procesador, 'nucleos', d.nucleos, 'ram_total_gb', d.ram_total_gb, 'ram_libre_gb', d.ram_libre_gb,
               'discos', d.discos, 'arranque', d.arranque, 'ultimo_reporte', d.ultimo_reporte, 'agente_version', d.agente_version,
               'ultimo_parche', d.ultimo_parche, 'ultimo_parche_titulo', d.ultimo_parche_titulo,
               'reinicio_pendiente', d.reinicio_pendiente, 'antivirus_activo', d.antivirus_activo, 'equipo_id', d.equipo_id)
             order by d.hostname)
        from inv_dispositivos d where d.estado_registro = 'aprobado'), '[]'::jsonb),
    'prtg', (
      select jsonb_build_object(
               'actualizado', e.actualizado,
               'dispositivos', coalesce((
                 select jsonb_agg(jsonb_build_object('objid', x->'objid', 'nombre', x->'nombre', 'host', x->'host', 'grupo', x->'grupo',
                                                     'estado', x->'estado', 'ok', x->'ok', 'advertencia', x->'advertencia',
                                                     'caido', x->'caido', 'total', x->'total'))
                   from jsonb_array_elements(coalesce(e.datos->'dispositivos', '[]')) x), '[]'::jsonb),
               'sensores', coalesce((
                 select jsonb_agg(x) from jsonb_array_elements(coalesce(e.datos->'sensores', '[]')) x
                  where (x->>'dispositivo')::int in (select prtg_objid from srv_servidores where prtg_objid is not null)), '[]'::jsonb))
        from red_prtg_estado e where e.id = 1),
    'veeam', jsonb_build_object(
      'configurado', (select token_hash is not null from backups_config where id = 1),
      'ultimo_reporte', (select ultimo_reporte from backups_config where id = 1),
      'horas_max_sin_reporte', (select horas_max_sin_reporte from backups_config where id = 1),
      'trabajos', coalesce((
        select jsonb_agg(jsonb_build_object('nombre', b.nombre, 'tipo', b.tipo, 'habilitado', b.habilitado,
                 'ultimo_resultado', b.ultimo_resultado, 'ultimo_fin', b.ultimo_fin, 'ultimo_exito', b.ultimo_exito,
                 'tamano_gb', b.tamano_gb, 'detalle', b.detalle, 'ignorar', b.ignorar, 'objetos', coalesce(to_jsonb(b.objetos), 'null'))
               order by b.nombre)
          from backups_trabajos b), '[]'::jsonb),
      'historial', coalesce((
        select jsonb_agg(jsonb_build_object('nombre', h.nombre, 'fecha', h.fecha, 'resultado', h.resultado))
          from backups_historial h where h.fecha >= current_date - 13), '[]'::jsonb)),
    'calculado', coalesce((
      select jsonb_object_agg(s.id::text, jsonb_build_object(
               'trabajos', coalesce((select jsonb_agg(jsonb_build_object('nombre', t.nombre, 'automatico', t.automatico) order by t.nombre)
                                       from srv_trabajos_de(s.id) t), '[]'::jsonb),
               'fin_soporte', (select case when f.id is null then null
                                           else jsonb_build_object('nombre', f.nombre, 'fin_estandar', f.fin_estandar,
                                                                   'fin_extendido', f.fin_extendido, 'notas', f.notas) end
                                 from srv_fin_soporte_de(coalesce(d.so_nombre, s.so_manual)) f),
               'ultima_prueba', (select jsonb_build_object('fecha', p.fecha, 'resultado', p.resultado)
                                   from srv_pruebas_restore p where p.servidor_id = s.id
                                  order by p.fecha desc, p.id desc limit 1)))
        from srv_servidores s left join inv_dispositivos d on d.id = s.dispositivo_id), '{}'::jsonb)
  ) into v;
  return v;
end $$;
revoke all on function public.srv_datos() from public, anon;
grant execute on function public.srv_datos() to authenticated;

create or replace function public.srv_config_guardar(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  update srv_config set
    alertas = coalesce((p ->> 'alertas')::boolean, alertas),
    reglas = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'reglas') x
                        where x in ('reporte', 'fin_soporte', 'backup', 'restauracion')), case when p ? 'reglas' then '{}'::text[] end, reglas),
    horas_sin_reporte = coalesce((p ->> 'horas_sin_reporte')::int, horas_sin_reporte),
    dias_sin_parche = coalesce((p ->> 'dias_sin_parche')::int, dias_sin_parche),
    dias_aviso_fin_soporte = coalesce((p ->> 'dias_aviso_fin_soporte')::int, dias_aviso_fin_soporte),
    dias_prueba_restore = coalesce((p ->> 'dias_prueba_restore')::int, dias_prueba_restore)
  where id = 1;
end $$;
grant execute on function public.srv_config_guardar(jsonb) to authenticated;

-- ----------------------------------------------------------
-- Alertas
-- ----------------------------------------------------------

-- Las condiciones de Backups (antes dentro de alertas_condiciones_extra), sin cambios
create or replace function public.backups_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c backups_config;
begin
  select * into c from backups_config where id = 1;
  if c.alertas and c.token_hash is not null then
    if c.ultimo_reporte is not null and c.ultimo_reporte < now() - make_interval(hours => c.horas_max_sin_reporte) then
      insert into _cond values ('backup:puente', 'backup', 'alta', 'El servidor de Veeam dejó de reportar',
        'Último reporte hace ' || floor(extract(epoch from now() - c.ultimo_reporte) / 3600) || ' horas' || coalesce(' · ' || c.servidor, ''),
        '/inventario/backups')
      on conflict do nothing;
    end if;
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
revoke all on function public.backups_condiciones_alertas() from public, anon, authenticated;

create or replace function public.srv_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare
  c srv_config;
  v_veeam_fresco boolean;
begin
  select * into c from srv_config where id = 1;
  if not coalesce(c.alertas, false) then return; end if;

  -- Servidor importante cuyo agente dejó de reportar
  if 'reporte' = any(c.reglas) then
    insert into _cond
    select 'srv:reporte:' || s.id, 'servidor',
           case when s.criticidad = 'critica' then 'critica' else 'alta' end,
           'Servidor sin reportar: ' || s.nombre,
           'El agente no reporta hace ' ||
             case when now() - d.ultimo_reporte < interval '48 hours'
                  then floor(extract(epoch from now() - d.ultimo_reporte) / 3600) || ' horas'
                  else floor(extract(epoch from now() - d.ultimo_reporte) / 86400) || ' días' end
             || coalesce(' · ' || d.hostname, ''),
           '/servidores'
      from srv_servidores s join inv_dispositivos d on d.id = s.dispositivo_id
     where s.activo and s.criticidad in ('critica', 'alta')
       and d.ultimo_reporte < now() - make_interval(hours => c.horas_sin_reporte)
    on conflict do nothing;
  end if;

  -- Sistema operativo sin soporte o por perderlo
  if 'fin_soporte' = any(c.reglas) then
    insert into _cond
    select 'srv:eol:' || s.id, 'servidor',
           case when f.fin_extendido < current_date then 'alta' else 'media' end,
           case when f.fin_extendido < current_date then 'Servidor sin soporte del fabricante: ' else 'Servidor por perder soporte: ' end || s.nombre,
           f.nombre || ' · ' ||
             case when f.fin_extendido < current_date then 'sin parches de seguridad desde el ' else 'deja de recibir parches el ' end
             || to_char(f.fin_extendido, 'DD/MM/YYYY'),
           '/servidores/parches'
      from srv_servidores s
      left join inv_dispositivos d on d.id = s.dispositivo_id
      cross join lateral srv_fin_soporte_de(coalesce(d.so_nombre, s.so_manual)) f
     where s.activo and f.id is not null
       and f.fin_extendido < current_date + c.dias_aviso_fin_soporte
    on conflict do nothing;
  end if;

  -- Backups: solo si Veeam está reportando al día (si no, ya avisa la alerta del servidor de Veeam)
  select coalesce(token_hash is not null and ultimo_reporte >= now() - make_interval(hours => horas_max_sin_reporte), false)
    into v_veeam_fresco from backups_config where id = 1;

  if 'backup' = any(c.reglas) and coalesce(v_veeam_fresco, false) then
    insert into _cond
    select 'srv:backup:' || x.id, 'servidor',
           case when x.n = 0 then 'media' when x.criticidad = 'critica' then 'critica' else 'alta' end,
           case when x.n = 0 then 'Servidor sin backup: ' else 'Servidor fuera de su RPO: ' end || x.nombre,
           case when x.n = 0 then 'Ningún trabajo de Veeam lo incluye'
                else 'último backup exitoso ' || coalesce(to_char(x.exito at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI'), 'nunca')
                     || ' · RPO ' || x.rpo_horas || ' h' end,
           '/servidores/backups'
      from (
        select s.id, s.nombre, s.criticidad, s.rpo_horas, count(t.nombre) as n, max(b.ultimo_exito) as exito
          from srv_servidores s
          left join lateral srv_trabajos_de(s.id) t on true
          left join backups_trabajos b on b.nombre = t.nombre
         where s.activo and s.requiere_backup and s.criticidad <> 'baja'
         group by s.id
      ) x
     where x.n = 0 or coalesce(x.exito, '-infinity') < now() - make_interval(hours => x.rpo_horas)
    on conflict do nothing;
  end if;

  -- Prueba de restauración vencida en servidores críticos y altos
  if 'restauracion' = any(c.reglas) then
    insert into _cond
    select 'srv:restore:' || s.id, 'servidor', 'media',
           'Prueba de restauración pendiente: ' || s.nombre,
           coalesce('última prueba exitosa el ' || to_char(p.ultima, 'DD/MM/YYYY'), 'nunca se registró una prueba exitosa'),
           '/servidores/backups'
      from srv_servidores s
      left join lateral (select max(r.fecha) as ultima from srv_pruebas_restore r
                          where r.servidor_id = s.id and r.resultado <> 'fallida') p on true
     where s.activo and s.requiere_backup and s.criticidad in ('critica', 'alta')
       and coalesce(p.ultima, '-infinity'::date) < current_date - c.dias_prueba_restore
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.srv_condiciones_alertas() from public, anon, authenticated;

-- Gancho común para las condiciones de otros módulos.
-- Si en el futuro otro módulo necesita alertas, se agrega una línea acá (no reemplazar esta función por otra).
create or replace function public.alertas_condiciones_extra()
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.backups_condiciones_alertas()') is not null then perform backups_condiciones_alertas(); end if;
  if to_regprocedure('public.srv_condiciones_alertas()') is not null then perform srv_condiciones_alertas(); end if;
end $$;
revoke all on function public.alertas_condiciones_extra() from public, anon, authenticated;

-- Asegura que el motor de alertas llame al gancho (si backups.sql ya lo agregó, no hace nada)
do $$
declare v_def text;
begin
  if to_regprocedure('public.alertas_evaluar(boolean)') is null then
    raise notice 'Falta alertas.sql: la solapa Servidores funciona, pero sin alertas';
    return;
  end if;
  v_def := pg_get_functiondef('public.alertas_evaluar(boolean)'::regprocedure);
  if position('alertas_condiciones_extra' in v_def) > 0 then return; end if;
  if position('-- Abrir las nuevas' in v_def) = 0 then
    raise notice 'No se encontró dónde agregar el gancho en alertas_evaluar; los servidores quedan sin alertas';
    return;
  end if;
  v_def := replace(v_def, '-- Abrir las nuevas',
    E'-- Condiciones de otros módulos (backups, servidores, etc.)\n  if to_regprocedure(''public.alertas_condiciones_extra()'') is not null then\n    perform alertas_condiciones_extra();\n  end if;\n\n  -- Abrir las nuevas');
  execute v_def;
end $$;

-- ----------------------------------------------------------
-- Permisos: se ve con la solapa Servidores; se modifica según el rol
-- ----------------------------------------------------------
alter table public.srv_config enable row level security;
alter table public.srv_fin_soporte enable row level security;
alter table public.srv_servidores enable row level security;
alter table public.srv_pruebas_restore enable row level security;

drop policy if exists srv_config_select on public.srv_config;
create policy srv_config_select on public.srv_config for select to authenticated using (puede_ver('servidores'));
revoke insert, update, delete on public.srv_config from anon, authenticated;

drop policy if exists srv_fin_soporte_select on public.srv_fin_soporte;
create policy srv_fin_soporte_select on public.srv_fin_soporte for select to authenticated using (puede_ver('servidores'));
drop policy if exists srv_fin_soporte_admin on public.srv_fin_soporte;
create policy srv_fin_soporte_admin on public.srv_fin_soporte for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

drop policy if exists srv_servidores_select on public.srv_servidores;
create policy srv_servidores_select on public.srv_servidores for select to authenticated using (puede_ver('servidores'));
drop policy if exists srv_servidores_admin on public.srv_servidores;
create policy srv_servidores_admin on public.srv_servidores for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');

-- Las pruebas de restauración las registra quien tiene lectura y escritura; borrar, solo un administrador
drop policy if exists srv_pruebas_select on public.srv_pruebas_restore;
create policy srv_pruebas_select on public.srv_pruebas_restore for select to authenticated using (puede_ver('servidores'));
drop policy if exists srv_pruebas_insert on public.srv_pruebas_restore;
create policy srv_pruebas_insert on public.srv_pruebas_restore for insert to authenticated
  with check (puede_ver('servidores') and mi_rol() in ('administrador', 'lectura_escritura'));
drop policy if exists srv_pruebas_delete on public.srv_pruebas_restore;
create policy srv_pruebas_delete on public.srv_pruebas_restore for delete to authenticated using (mi_rol() = 'administrador');

-- Registro en Logs
do $$
declare t text;
begin
  if to_regprocedure('public.auditar()') is null then return; end if;
  foreach t in array array['srv_config', 'srv_fin_soporte', 'srv_servidores', 'srv_pruebas_restore'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
