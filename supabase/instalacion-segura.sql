-- ==========================================================
-- Instalación segura del agente
--   * Códigos de instalación con vencimiento, límite de equipos y revocación
--     (reemplazan al token general dentro de los instaladores)
--   * Se guarda solo la huella (SHA-256) del código, nunca el código
--   * Los equipos ya registrados se autentican solo con su clave propia
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de registro.sql.
-- ==========================================================

create table if not exists public.inv_codigos_instalacion (
  id serial primary key,
  codigo_hash text not null unique,
  descripcion text not null,                 -- para quién o para qué es (ej: "Felipe Alborch")
  creado_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now(),
  vence timestamptz not null,
  usos_max int not null default 1 check (usos_max > 0),
  usos int not null default 0,
  revocado boolean not null default false,
  ultimo_uso timestamptz
);

alter table public.inv_dispositivos
  add column if not exists codigo_id int references public.inv_codigos_instalacion(id) on delete set null,
  add column if not exists clave_restablecida_hasta timestamptz;

-- El token general viejo deja de servir para registrar equipos nuevos (se puede reactivar desde la app)
alter table public.inv_agente_config
  add column if not exists permitir_token_general boolean not null default false;

-- Devuelve el id del código (0 = token general habilitado) o null si no es válido.
create or replace function public.inv_validar_codigo(p_token text, p_consumir boolean)
returns int language plpgsql security definer set search_path = public as $$
declare
  c record;
begin
  if coalesce(p_token, '') = '' then
    return null;
  end if;
  select * into c from inv_codigos_instalacion where codigo_hash = inv_hash(p_token) for update;
  if found then
    if c.revocado or c.vence < now() or c.usos >= c.usos_max then
      return null;
    end if;
    if p_consumir then
      update inv_codigos_instalacion set usos = usos + 1, ultimo_uso = now() where id = c.id;
    end if;
    return c.id;
  end if;
  if exists (select 1 from inv_agente_config where id = 1 and permitir_token_general and token = p_token) then
    return 0;
  end if;
  return null;
end $$;
revoke all on function public.inv_validar_codigo(text, boolean) from public, anon, authenticated;

-- Aplicaciones, seguridad y ubicación: se autentican solo con la clave del equipo
create or replace function public.inv_verificar_equipo(p_token text, p_uuid text, p_hostname text, p_secreto text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  r record;
begin
  v_uuid := nullif(trim(p_uuid), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then
    v_uuid := nullif(trim(p_hostname), '');
  end if;
  select id, estado_registro, secreto_hash into r from inv_dispositivos where uuid_equipo = v_uuid;
  if not found then
    raise exception 'El equipo todavía no está registrado';
  end if;
  if r.estado_registro = 'bloqueado' then
    raise exception 'Equipo bloqueado por el administrador';
  end if;
  if r.secreto_hash is null or coalesce(p_secreto, '') = '' or r.secreto_hash <> inv_hash(p_secreto) then
    raise exception 'Clave de equipo inválida';
  end if;
  if r.estado_registro <> 'aprobado' then
    return null;
  end if;
  return r.id;
end $$;
revoke all on function public.inv_verificar_equipo(text, text, text, text) from public, anon, authenticated;

create or replace function public.inv_reportar_dispositivo(p_token text, p_datos jsonb, p_secreto text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uuid text;
  v_serie text;
  v_equipo uuid;
  r record;
  v_estado text;
  v_nuevo text;
  v_dominios text[];
  v_usuario_dom text;
  v_codigo int;
begin

  v_uuid := nullif(trim(p_datos->>'uuid'), '');
  if v_uuid is null or v_uuid ~* '^(0|f|-)+$' then
    v_uuid := nullif(trim(p_datos->>'hostname'), '');
  end if;
  if v_uuid is null then
    raise exception 'El reporte no trae identificador';
  end if;

  -- ¿Equipo conocido? Verificar su clave propia. ¿Nuevo? Queda pendiente de aprobación.
  select id, estado_registro, secreto_hash, clave_confirmada, clave_restablecida_hasta into r
    from inv_dispositivos where uuid_equipo = v_uuid;
  if found then
    if r.estado_registro = 'bloqueado' then
      raise exception 'Equipo bloqueado por el administrador';
    end if;
    if r.secreto_hash is not null and coalesce(p_secreto, '') <> '' and r.secreto_hash = inv_hash(p_secreto) then
      -- equipo conocido con su clave correcta: no necesita código de instalación
      if not r.clave_confirmada then
        update inv_dispositivos set clave_confirmada = true where id = r.id;
      end if;
    elsif (r.secreto_hash is null or (not r.clave_confirmada and coalesce(p_secreto, '') = ''))
          and (coalesce(r.clave_restablecida_hasta, '-infinity') > now() or inv_validar_codigo(p_token, false) is not null) then
      -- sin clave (restablecida por un admin o nunca guardada): se entrega una nueva, solo con ventana o código válido
      v_nuevo := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
      update inv_dispositivos set secreto_hash = inv_hash(v_nuevo), clave_confirmada = false, clave_restablecida_hasta = null
       where id = r.id;
    else
      raise exception 'Clave de equipo inválida. Si reinstalaste el agente desde cero, restablecé la clave del equipo desde Monitoreo.';
    end if;
    v_estado := r.estado_registro;
  else
    -- equipo nuevo: necesita un código de instalación vigente (se consume un uso)
    v_codigo := inv_validar_codigo(p_token, true);
    if v_codigo is null then
      raise exception 'Código de instalación inválido, vencido, revocado o sin usos disponibles. Pedí un instalador nuevo.';
    end if;
    select dominios_autoaprobados into v_dominios from inv_agente_config where id = 1;
    v_usuario_dom := upper(split_part(coalesce(p_datos->>'usuario', ''), '\', 1));
    v_estado := case
      when exists (select 1 from unnest(v_dominios) x
                    where upper(trim(x)) in (upper(coalesce(p_datos->>'dominio', '')),
                                             upper(split_part(coalesce(p_datos->>'dominio', ''), '.', 1)),
                                             v_usuario_dom))
      then 'aprobado' else 'pendiente' end;
    v_nuevo := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  end if;

  v_serie := nullif(trim(p_datos->>'numero_serie'), '');
  if v_serie is not null and lower(v_serie) in
     ('to be filled by o.e.m.', 'default string', 'system serial number', 'none', '0', 'not specified') then
    v_serie := null;
  end if;
  -- Solo los equipos aprobados se vinculan con el inventario
  if v_serie is not null and v_estado = 'aprobado' then
    select id into v_equipo from inv_equipos where upper(numero_serie) = upper(v_serie) limit 1;
  end if;

  insert into inv_dispositivos as d (
    uuid_equipo, hostname, numero_serie, fabricante, modelo, so_nombre, so_version, so_build,
    so_arquitectura, procesador, nucleos, ram_total_gb, ram_libre_gb, discos, almacenamiento,
    ip, mac, usuario, dominio, arranque, bateria_pct, antivirus_activo, agente_version,
    equipo_id, ultimo_reporte, estado_registro, secreto_hash, ip_registro, ip_publica, codigo_id
  ) values (
    v_uuid,
    p_datos->>'hostname',
    v_serie,
    p_datos->>'fabricante',
    p_datos->>'modelo',
    p_datos->>'so_nombre',
    p_datos->>'so_version',
    p_datos->>'so_build',
    p_datos->>'so_arquitectura',
    p_datos->>'procesador',
    nullif(p_datos->>'nucleos', '')::int,
    nullif(p_datos->>'ram_total_gb', '')::numeric,
    nullif(p_datos->>'ram_libre_gb', '')::numeric,
    coalesce(p_datos->'discos', '[]'::jsonb),
    p_datos->>'almacenamiento',
    p_datos->>'ip',
    p_datos->>'mac',
    p_datos->>'usuario',
    p_datos->>'dominio',
    nullif(p_datos->>'arranque', '')::timestamptz,
    nullif(p_datos->>'bateria_pct', '')::int,
    nullif(p_datos->>'antivirus_activo', '')::boolean,
    p_datos->>'agente_version',
    v_equipo,
    now(),
    v_estado,
    inv_hash(v_nuevo),
    inv_ip_cliente(),
    inv_ip_cliente(),
    nullif(v_codigo, 0)
  )
  on conflict (uuid_equipo) do update set
    hostname = excluded.hostname,
    numero_serie = excluded.numero_serie,
    fabricante = excluded.fabricante,
    modelo = excluded.modelo,
    so_nombre = excluded.so_nombre,
    so_version = excluded.so_version,
    so_build = excluded.so_build,
    so_arquitectura = excluded.so_arquitectura,
    procesador = excluded.procesador,
    nucleos = excluded.nucleos,
    ram_total_gb = excluded.ram_total_gb,
    ram_libre_gb = excluded.ram_libre_gb,
    discos = excluded.discos,
    almacenamiento = excluded.almacenamiento,
    ip = excluded.ip,
    mac = excluded.mac,
    usuario = excluded.usuario,
    dominio = excluded.dominio,
    arranque = excluded.arranque,
    bateria_pct = excluded.bateria_pct,
    antivirus_activo = excluded.antivirus_activo,
    agente_version = excluded.agente_version,
    equipo_id = coalesce(excluded.equipo_id, d.equipo_id),
    ip_publica = excluded.ip_publica,
    ultimo_reporte = now();

  -- Mantener al día los datos técnicos del equipo vinculado en el inventario
  select equipo_id into v_equipo from inv_dispositivos where uuid_equipo = v_uuid;
  if v_equipo is not null and v_estado = 'aprobado' then
    update inv_equipos e set
      hostname = coalesce(p_datos->>'hostname', e.hostname),
      sistema_operativo = coalesce(p_datos->>'so_nombre', e.sistema_operativo),
      procesador = coalesce(p_datos->>'procesador', e.procesador),
      ram_gb = coalesce(round(nullif(p_datos->>'ram_total_gb', '')::numeric)::int, e.ram_gb),
      almacenamiento = coalesce(p_datos->>'almacenamiento', e.almacenamiento),
      mac = coalesce(p_datos->>'mac', e.mac)
    where e.id = v_equipo
      and (e.hostname, e.sistema_operativo, e.procesador, e.ram_gb, e.almacenamiento, e.mac)
          is distinct from
          (coalesce(p_datos->>'hostname', e.hostname),
           coalesce(p_datos->>'so_nombre', e.sistema_operativo),
           coalesce(p_datos->>'procesador', e.procesador),
           coalesce(round(nullif(p_datos->>'ram_total_gb', '')::numeric)::int, e.ram_gb),
           coalesce(p_datos->>'almacenamiento', e.almacenamiento),
           coalesce(p_datos->>'mac', e.mac));
  end if;

  -- La clave nueva se entrega una sola vez; el agente la guarda en una carpeta protegida
  return jsonb_build_object('estado', v_estado, 'secreto', v_nuevo);
end $$;

revoke all on function public.inv_reportar_dispositivo(text, jsonb, text) from public;
grant execute on function public.inv_reportar_dispositivo(text, jsonb, text) to anon, authenticated;

-- Solo administradores ven y gestionan los códigos
alter table public.inv_codigos_instalacion enable row level security;
drop policy if exists inv_codigos_admin on public.inv_codigos_instalacion;
create policy inv_codigos_admin on public.inv_codigos_instalacion for all to authenticated
  using (mi_rol() = 'administrador') with check (mi_rol() = 'administrador');
