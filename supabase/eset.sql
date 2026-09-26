-- ==========================================================
-- ESET PROTECT Cloud → Accusys Cyber (detecciones por API, ESET Connect)
--   * Cada 10 minutos la base trae las detecciones de ESET de los últimos 7 días
--     (antivirus, HIPS, firewall, red, web, EDR) y las guarda con su historial.
--   * Las detecciones se vinculan con los equipos del agente por nombre de equipo.
--   * La contraseña del usuario de API se guarda cifrada en Supabase Vault:
--     no se puede leer desde la app ni queda en Logs.
--   * Las detecciones sin resolver generan la alerta "Amenaza detectada" en Teams.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de revision-accesos.sql.
-- ==========================================================

create extension if not exists http with schema extensions;
create extension if not exists supabase_vault;

create table if not exists public.eset_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default false,
  region text not null default 'us' check (region in ('eu', 'de', 'us', 'ca', 'jpn')),
  usuario text,
  access_token text,
  token_vence timestamptz,
  ultima_sync timestamptz,
  ultimo_error text,
  detecciones_ultima_sync int
);
insert into public.eset_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.eset_detecciones (
  uuid text primary key,
  fecha timestamptz not null,
  nombre text,
  tipo text,
  categoria text,              -- ANTIVIRUS, HIPS, FIREWALL_RULE, NETWORK_INTRUSION, WEB_ACCESS, EDR_RULE, ...
  severidad text,              -- HIGH, MEDIUM, LOW, INFORMATIONAL, DIAGNOSTIC
  puntaje int,                 -- 1 a 100
  resuelta boolean not null default false,
  equipo_nombre text,
  equipo_uuid text,
  dispositivo_id uuid references public.inv_dispositivos(id) on delete set null,
  usuario text,
  objeto text,
  circunstancias text,
  proceso text,
  respuestas jsonb,
  revisada boolean not null default false,   -- la marca IT desde la app
  revisada_por text,
  revisada_en timestamptz,
  primera_vez timestamptz not null default now(),
  actualizada timestamptz not null default now()
);
create index if not exists idx_eset_detecciones_fecha on public.eset_detecciones(fecha desc);
create index if not exists idx_eset_detecciones_disp on public.eset_detecciones(dispositivo_id);

-- ----------------------------------------------------------
-- Token de acceso (se pide con el usuario de API y se reutiliza mientras sea válido)
-- ----------------------------------------------------------
create or replace function public.eset_token(p_forzar boolean default false)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  c eset_config;
  v_pass text;
  r record;
  j jsonb;
begin
  select * into c from eset_config where id = 1;
  if not p_forzar and c.access_token is not null and c.token_vence > now() + interval '2 minutes' then
    return c.access_token;
  end if;
  select decrypted_secret into v_pass from vault.decrypted_secrets where name = 'eset_connect_password';
  if c.usuario is null or v_pass is null then
    raise exception 'Faltan el usuario y la contraseña de la API de ESET';
  end if;
  begin
    perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '20000');
  exception when others then null;
  end;
  select * into r from http_post(
    'https://' || c.region || '.business-account.iam.eset.systems/oauth/token',
    'grant_type=password&username=' || urlencode(c.usuario) || '&password=' || urlencode(v_pass) || '&refresh_token=',
    'application/x-www-form-urlencoded');
  if r.status <> 200 then
    raise exception 'ESET rechazó el inicio de sesión (%). Revisá usuario, contraseña, región y que el usuario tenga el permiso Integrations y haya entrado una vez a ESET PROTECT Hub', r.status;
  end if;
  j := r.content::jsonb;
  update eset_config set access_token = j->>'access_token',
         token_vence = now() + make_interval(secs => coalesce((j->>'expires_in')::int, 3600))
   where id = 1;
  return j->>'access_token';
end $$;
revoke all on function public.eset_token(boolean) from public, anon, authenticated;

-- ----------------------------------------------------------
-- Sincronización: trae las detecciones de los últimos días (así también
-- se actualizan las que ESET marca como resueltas después)
-- ----------------------------------------------------------
create or replace function public.eset_sincronizar()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c eset_config;
  v_token text;
  v_desde timestamptz;
  v_pagina text := '';
  v_url text;
  r record;
  j jsonb;
  d jsonb;
  n int := 0;
  i int := 0;
  v_reintento boolean := false;
begin
  select * into c from eset_config where id = 1;
  if not c.activo then
    return jsonb_build_object('ok', false, 'motivo', 'desactivado');
  end if;
  -- primera vez: 30 días; después: 7 días hacia atrás en cada corrida
  v_desde := case when c.ultima_sync is null then now() - interval '30 days' else now() - interval '7 days' end;

  begin
    v_token := eset_token();
    loop
      i := i + 1;
      exit when i > 30;   -- tope de seguridad: 30 páginas de 500
      v_url := 'https://' || c.region || '.incident-management.eset.systems/v2/detections?pageSize=500'
               || '&startTime=' || urlencode(to_char(v_desde at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
               || case when v_pagina <> '' then '&pageToken=' || urlencode(v_pagina) else '' end;
      select * into r from http(('GET', v_url, array[http_header('Authorization', 'Bearer ' || v_token)], null, null)::http_request);

      if r.status = 401 and not v_reintento then
        v_reintento := true;
        v_token := eset_token(true);
        i := i - 1;
        continue;
      end if;
      if r.status not in (200, 202) then
        raise exception 'ESET respondió % al pedir las detecciones', r.status;
      end if;

      j := r.content::jsonb;
      for d in select * from jsonb_array_elements(coalesce(j->'detections', '[]')) loop
        insert into eset_detecciones as e (uuid, fecha, nombre, tipo, categoria, severidad, puntaje, resuelta,
                                           equipo_nombre, equipo_uuid, dispositivo_id, usuario, objeto, circunstancias, proceso, respuestas)
        values (
          d->>'uuid',
          coalesce((d->>'occurTime')::timestamptz, now()),
          d->>'displayName',
          d->>'typeName',
          replace(d->>'category', 'DETECTION_CATEGORY_', ''),
          replace(d->>'severityLevel', 'SEVERITY_LEVEL_', ''),
          nullif(d->>'severityScore', '')::int,
          coalesce((d->>'resolved')::boolean, false),
          d#>>'{device,displayName}',
          d#>>'{device,uuid}',
          (select x.id from inv_dispositivos x
            where lower(x.hostname) = lower(split_part(d#>>'{device,displayName}', '.', 1))
            order by x.ultimo_reporte desc limit 1),
          d->>'userName',
          left(d->>'objectName', 1000),
          left(d->>'circumstances', 1000),
          left(coalesce(d#>>'{process,path}', d#>>'{process,commandLine}'), 500),
          d->'responses')
        on conflict (uuid) do update set
          resuelta = excluded.resuelta,
          severidad = excluded.severidad,
          puntaje = excluded.puntaje,
          respuestas = excluded.respuestas,
          dispositivo_id = coalesce(excluded.dispositivo_id, e.dispositivo_id),
          actualizada = now();
        n := n + 1;
      end loop;

      v_pagina := coalesce(j->>'nextPageToken', '');
      exit when v_pagina = '';
    end loop;
  exception when others then
    update eset_config set ultimo_error = left(sqlerrm, 400) where id = 1;
    return jsonb_build_object('ok', false, 'error', left(sqlerrm, 400));
  end;

  update eset_config set ultima_sync = now(), ultimo_error = null, detecciones_ultima_sync = n where id = 1;
  -- historial de 1 año
  delete from eset_detecciones where fecha < now() - interval '365 days';
  return jsonb_build_object('ok', true, 'detecciones', n);
end $$;
revoke all on function public.eset_sincronizar() from public, anon, authenticated;

-- ----------------------------------------------------------
-- Funciones para la pantalla
-- ----------------------------------------------------------
create or replace function public.eset_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('activo', c.activo, 'region', c.region, 'usuario', c.usuario,
           'con_clave', exists (select 1 from vault.decrypted_secrets where name = 'eset_connect_password'),
           'ultima_sync', c.ultima_sync, 'ultimo_error', c.ultimo_error, 'detecciones_ultima_sync', c.detecciones_ultima_sync,
           'es_admin', mi_rol() = 'administrador')
    from eset_config c where c.id = 1 and puede_ver('seguridad')
$$;
grant execute on function public.eset_estado() to authenticated;

create or replace function public.eset_configurar(p_region text, p_usuario text, p_password text, p_activo boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid; p record;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if p_region not in ('eu', 'de', 'us', 'ca', 'jpn') then raise exception 'Región inválida'; end if;
  if nullif(trim(p_usuario), '') is not null and trim(p_usuario) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'El usuario de API es un email';
  end if;

  update eset_config set region = p_region, usuario = coalesce(nullif(trim(p_usuario), ''), usuario),
         activo = coalesce(p_activo, activo), access_token = null, token_vence = null
   where id = 1;

  if nullif(p_password, '') is not null then
    select id into v_id from vault.secrets where name = 'eset_connect_password';
    if v_id is null then
      perform vault.create_secret(p_password, 'eset_connect_password', 'Contraseña del usuario de API de ESET Connect (Accusys Cyber)');
    else
      perform vault.update_secret(v_id, p_password);
    end if;
  end if;

  -- queda en Logs quién cambió la configuración (nunca la contraseña)
  begin
    select nombre, email into p from perfiles where id = auth.uid();
    insert into auditoria (usuario_id, usuario_email, usuario_nombre, ip, tabla, accion, registro_id, descripcion, cambios)
    values (auth.uid(), p.email, p.nombre, inv_ip_cliente(), 'eset_config', 'modificacion', '1', 'Integración con ESET',
            jsonb_build_object('region', p_region, 'usuario', p_usuario, 'activo', p_activo,
                               'password', case when nullif(p_password, '') is null then '(sin cambios)' else '(cambiada)' end));
  exception when others then null;
  end;
end $$;
grant execute on function public.eset_configurar(text, text, text, boolean) to authenticated;

create or replace function public.eset_sincronizar_ahora()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  -- se sincroniza "como el sistema", igual que la tarea automática: así Logs no se llena
  -- con cada detección importada (solo quedan las acciones de las personas)
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return eset_sincronizar();
end $$;
grant execute on function public.eset_sincronizar_ahora() to authenticated;

create or replace function public.eset_marcar_revisada(p_uuid text, p_revisada boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (puede_ver('seguridad') and mi_rol() in ('administrador', 'lectura_escritura')) then
    raise exception 'Sin permiso';
  end if;
  update eset_detecciones set revisada = p_revisada,
         revisada_por = case when p_revisada then (select coalesce(nombre, email) from perfiles where id = auth.uid()) end,
         revisada_en = case when p_revisada then now() end
   where uuid = p_uuid;
end $$;
grant execute on function public.eset_marcar_revisada(text, boolean) to authenticated;

-- ----------------------------------------------------------
-- Permisos
-- ----------------------------------------------------------
alter table public.eset_config enable row level security;
alter table public.eset_detecciones enable row level security;
revoke all on public.eset_config from anon, authenticated;
drop policy if exists eset_detecciones_select on public.eset_detecciones;
create policy eset_detecciones_select on public.eset_detecciones for select to authenticated using (puede_ver('seguridad'));
revoke insert, update, delete on public.eset_detecciones from anon, authenticated;

drop trigger if exists trg_auditoria on public.eset_detecciones;
create trigger trg_auditoria after insert or update or delete on public.eset_detecciones
  for each row execute function public.auditar();

do $$ begin
  begin perform cron.unschedule('accusys-eset'); exception when others then null; end;
  perform cron.schedule('accusys-eset', '*/10 * * * *', 'select public.eset_sincronizar()');
exception when others then
  raise notice 'La sincronización automática no quedó programada (falta pg_cron): %', sqlerrm;
end $$;
