-- ==========================================================
-- MIGRACIÓN A WINDOWS 11 desde Accusys Cyber
--   * La aptitud de cada equipo se calcula con lo que YA reporta el agente
--     (build, TPM, Secure Boot, procesador, RAM, discos y cifrado): no hace falta tocar las PCs para verla.
--   * Un administrador ordena la actualización desde Endpoints → Migración a Windows 11.
--   * El agente (versión 2.0 o superior) toma la orden en su próximo reporte y lanza el upgrade en una tarea aparte.
--     Modo mixto: si llega a la carpeta compartida, instala desde la red local (con el escaneo oficial de Microsoft);
--     si no llega (home office) y está permitido, usa el Asistente de instalación de Windows 11 desde internet.
--   * Al reiniciar en Windows 11 queda "Migrado".
--   * Las órdenes, cancelaciones y cambios de configuración quedan en Logs (auditoría).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de auditoria.sql e instalacion-segura.sql. Se puede repetir.
-- ==========================================================

-- Origen del instalador: carpeta compartida con el contenido del ISO (opcional) y/o descarga desde Microsoft
alter table public.inv_agente_config
  add column if not exists w11_internet boolean not null default true,  -- si no llega a la carpeta, bajar de Microsoft
  add column if not exists w11_origen text,                         -- ej: \\SERVIDOR\W11$\26H2 (opcional)
  add column if not exists w11_sha256 text,                         -- huella de sources\install.wim (o .esd), opcional
  add column if not exists w11_reiniciar boolean not null default false;  -- true: el upgrade reinicia solo al terminar

create table if not exists public.inv_w11 (
  dispositivo_id uuid primary key references public.inv_dispositivos(id) on delete cascade,
  hostname text,
  oleada text,
  estado text not null default 'sin_orden' check (estado in
    ('sin_orden', 'ordenado', 'entregado', 'en_curso', 'pendiente_reinicio', 'pospuesto', 'bloqueado', 'error', 'migrado')),
  orden_pendiente boolean not null default false,
  orden_por text,
  orden_fecha timestamptz,
  detalle text,
  compat text,                     -- resultado del escaneo de compatibilidad de Microsoft
  estado_fecha timestamptz,
  build_origen text,
  migrado_fecha timestamptz
);
create index if not exists idx_inv_w11_estado on public.inv_w11(estado);
-- Avance general 0-100 (agente 2.3): copia 0-15, escaneo 15-20, instalación 20-100
alter table public.inv_w11 add column if not exists progreso int;

alter table public.inv_w11 enable row level security;
drop policy if exists inv_w11_select on public.inv_w11;
create policy inv_w11_select on public.inv_w11 for select to authenticated using (mi_rol() is not null);
-- Sin políticas de escritura: solo se modifica con las funciones de abajo

-- Logs: las órdenes de las personas quedan registradas (los reportes del agente no, porque no tienen usuario)
drop trigger if exists trg_auditoria on public.inv_w11;
create trigger trg_auditoria after insert or update or delete on public.inv_w11
  for each row execute function public.auditar();

-- ---------- Configuración (solo administrador) ----------
drop function if exists public.inv_w11_config(text, text, boolean);
create or replace function public.inv_w11_config(p_origen text, p_sha256 text, p_reiniciar boolean, p_internet boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if nullif(trim(p_origen), '') is not null and trim(p_origen) !~ '^\\\\[A-Za-z0-9._-]+\\[^\\/:*?"<>|]+' then
    raise exception 'La carpeta tiene que ser un recurso compartido de la red, por ejemplo \\SERVIDOR\W11$\26H2';
  end if;
  if nullif(trim(p_sha256), '') is not null and trim(p_sha256) !~ '^[0-9A-Fa-f]{64}$' then
    raise exception 'La huella SHA-256 tiene que tener 64 caracteres hexadecimales';
  end if;
  if nullif(trim(p_origen), '') is null and not coalesce(p_internet, false) then
    raise exception 'Configurá la carpeta compartida o permití la descarga desde internet (o las dos)';
  end if;
  update inv_agente_config set
    w11_origen = nullif(rtrim(trim(p_origen), '\'), ''),
    w11_sha256 = upper(nullif(trim(p_sha256), '')),
    w11_reiniciar = coalesce(p_reiniciar, false),
    w11_internet = coalesce(p_internet, false)
  where id = 1;
end $$;
revoke all on function public.inv_w11_config(text, text, boolean, boolean) from public, anon;
grant execute on function public.inv_w11_config(text, text, boolean, boolean) to authenticated;

-- ---------- Ordenar la actualización (solo administrador) ----------
-- Solo equipos Windows de escritorio aprobados, en Windows 10, con TPM 2.0 y Secure Boot.
-- El resto de los requisitos los verifica el escaneo de Microsoft en el propio equipo antes de instalar.
create or replace function public.inv_w11_ordenar(p_ids uuid[], p_oleada text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ok uuid[];
  v_email text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if not exists (select 1 from inv_agente_config where id = 1 and (coalesce(w11_origen, '') <> '' or w11_internet)) then
    raise exception 'Primero configurá de dónde se instala Windows 11 (carpeta compartida o descarga desde internet)';
  end if;
  select email into v_email from perfiles where id = auth.uid();

  with cand as (
    select d.id, d.hostname, d.so_build
      from inv_dispositivos d
     where d.id = any(p_ids)
       and d.estado_registro = 'aprobado'
       and d.so_nombre ilike '%windows%' and d.so_nombre not ilike '%server%'
       and coalesce(nullif(regexp_replace(split_part(coalesce(d.so_build, ''), '.', 1), '\D', '', 'g'), '')::int, 0) between 1 and 21999
       and coalesce(d.tpm_version, '') like '2.0%'
       and coalesce(d.secure_boot, false)
       and not exists (select 1 from inv_w11 w where w.dispositivo_id = d.id
                        and w.estado in ('entregado', 'en_curso', 'pendiente_reinicio', 'migrado'))
  ), ins as (
    insert into inv_w11 as w (dispositivo_id, hostname, oleada, estado, orden_pendiente, orden_por, orden_fecha,
                              detalle, compat, estado_fecha, build_origen)
    select id, hostname, nullif(trim(p_oleada), ''), 'ordenado', true, v_email, now(), null, null, now(), so_build from cand
    on conflict (dispositivo_id) do update set
      hostname = excluded.hostname, oleada = excluded.oleada, estado = 'ordenado', orden_pendiente = true,
      orden_por = excluded.orden_por, orden_fecha = now(), detalle = null, compat = null, progreso = null,
      estado_fecha = now(), build_origen = excluded.build_origen
    returning w.dispositivo_id
  )
  select coalesce(array_agg(dispositivo_id), '{}') into v_ok from ins;

  return jsonb_build_object(
    'ordenados', cardinality(v_ok),
    'omitidos', (select coalesce(jsonb_agg(hostname order by hostname), '[]'::jsonb)
                   from inv_dispositivos where id = any(p_ids) and not (id = any(v_ok)))
  );
end $$;
revoke all on function public.inv_w11_ordenar(uuid[], text) from public, anon;
grant execute on function public.inv_w11_ordenar(uuid[], text) to authenticated;

-- ---------- Cancelar órdenes que el agente todavía no tomó (solo administrador) ----------
create or replace function public.inv_w11_cancelar(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  update inv_w11 set orden_pendiente = false, estado = 'sin_orden', estado_fecha = now(),
         detalle = 'Orden cancelada por ' || coalesce((select email from perfiles where id = auth.uid()), 'un administrador')
   where dispositivo_id = any(p_ids) and orden_pendiente;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.inv_w11_cancelar(uuid[]) from public, anon;
grant execute on function public.inv_w11_cancelar(uuid[]) to authenticated;

-- ---------- Agente: informa build y estado del upgrade; recibe la orden ----------
-- Se autentica con la clave propia del equipo (igual que aplicaciones, seguridad y ubicación).
-- La única orden posible es "actualizar". El agente además exige que el instalador esté firmado por Microsoft.
create or replace function public.inv_w11_agente(p_token text, p_uuid text, p_hostname text, p_secreto text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_build int;
  v_estado text;
  w record;
  c record;
  nada constant jsonb := jsonb_build_object('orden', null);
begin
  v_id := inv_verificar_equipo(p_token, p_uuid, p_hostname, p_secreto);
  if v_id is null then return nada; end if;

  select * into w from inv_w11 where dispositivo_id = v_id for update;
  if not found then return nada; end if;

  v_build := coalesce(nullif(regexp_replace(split_part(coalesce(p_datos->>'build', ''), '.', 1), '\D', '', 'g'), '')::int, 0);

  -- Estado informado por la tarea de actualización
  v_estado := p_datos->>'estado';
  if v_estado in ('en_curso', 'pendiente_reinicio', 'pospuesto', 'bloqueado', 'error') then
    update inv_w11 set
      estado = v_estado,
      detalle = left(p_datos->>'detalle', 1000),
      compat = coalesce(left(nullif(p_datos->>'compat', ''), 120), compat),
      progreso = case
        when v_estado = 'pendiente_reinicio' then 100
        when v_estado = 'en_curso' and (p_datos->>'progreso') ~ '^\d{1,3}$' then least((p_datos->>'progreso')::int, 100)
        when v_estado = 'en_curso' then progreso
        else null end,
      estado_fecha = now(),
      orden_pendiente = (v_estado = 'pospuesto')      -- pospuesto (a batería, sin espacio, fuera de la red): se reintenta solo
    where dispositivo_id = v_id;
    w.estado := v_estado;
    w.orden_pendiente := (v_estado = 'pospuesto');
    w.estado_fecha := now();
  end if;

  -- Ya reinició en Windows 11
  if v_build >= 22000 and w.estado in ('ordenado', 'entregado', 'en_curso', 'pendiente_reinicio', 'pospuesto', 'error') then
    update inv_w11 set estado = 'migrado', migrado_fecha = now(), estado_fecha = now(), orden_pendiente = false,
                       detalle = 'Windows 11 build ' || v_build
     where dispositivo_id = v_id;
    return nada;
  end if;

  -- Orden pendiente (los pospuestos se reintentan cada 30 minutos)
  if w.orden_pendiente and v_build between 1 and 21999
     and not (w.estado = 'pospuesto' and w.estado_fecha > now() - interval '30 minutes') then
    select w11_origen, w11_sha256, w11_reiniciar, w11_internet into c from inv_agente_config where id = 1;
    if coalesce(c.w11_origen, '') = '' and not c.w11_internet then return nada; end if;
    update inv_w11 set orden_pendiente = false, estado = 'entregado', estado_fecha = now(),
                       detalle = 'El agente recibió la orden'
     where dispositivo_id = v_id;
    return jsonb_build_object('orden', 'actualizar', 'origen', c.w11_origen, 'sha256', c.w11_sha256,
                              'reiniciar', c.w11_reiniciar, 'internet', c.w11_internet);
  end if;

  return nada;
end $$;
revoke all on function public.inv_w11_agente(text, text, text, text, jsonb) from public;
grant execute on function public.inv_w11_agente(text, text, text, text, jsonb) to anon, authenticated;
