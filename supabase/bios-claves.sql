-- ==========================================================
-- Claves de BIOS por equipo (una distinta por notebook, asociada al número de serie / service tag)
--   * La app genera una clave aleatoria por equipo y la guarda CIFRADA: la llave de cifrado vive en
--     Vercel (BIOS_CLAVE_MAESTRA), no en la base. Con la base sola no se puede leer ninguna clave.
--   * El equipo pide SU clave con la clave propia del agente (equipo.key): no puede pedir la de otro.
--   * Solo se entrega mientras el despliegue está habilitado y hasta que el equipo confirma que la aplicó.
--   * Cada vez que un administrador ve una clave queda registrado quién, cuándo y por qué.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de bios.sql e instalacion-segura.sql. Se puede repetir.
-- ==========================================================

create table if not exists public.bios_claves_config (
  id int primary key default 1 check (id = 1),
  habilitado_hasta timestamptz,          -- ventana en la que los equipos pueden pedir su clave
  habilitado_por text
);
insert into public.bios_claves_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.bios_claves (
  numero_serie text primary key,         -- service tag (en mayúsculas)
  dispositivo_id uuid references public.inv_dispositivos(id) on delete set null,
  hostname text,
  clave_cifrada text not null,           -- AES-256-GCM, cifrada por la app
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aplicada', 'error')),
  generada timestamptz not null default now(),
  aplicada timestamptz,
  intentos int not null default 1,
  usb_bloqueado boolean,                 -- si además se pudo deshabilitar el arranque por USB
  ultimo_error text
);

create table if not exists public.bios_claves_consultas (
  id bigint generated always as identity primary key,
  numero_serie text not null,
  hostname text,
  usuario uuid,
  email text,
  motivo text not null,
  fecha timestamptz not null default now()
);
create index if not exists idx_bios_claves_consultas_fecha on public.bios_claves_consultas(fecha desc);

-- Sin políticas: nadie lee ni escribe estas tablas directamente, solo a través de las funciones de abajo.
alter table public.bios_claves_config enable row level security;
alter table public.bios_claves enable row level security;
alter table public.bios_claves_consultas enable row level security;

-- ----------------------------------------------------------
-- El equipo pide su clave. Devuelve la clave cifrada que quedó guardada:
-- la nueva (p_cifrada) si no tenía, o la que ya tenía si el intento anterior no se confirmó.
-- ----------------------------------------------------------
create or replace function public.bios_reservar(p_uuid text, p_hostname text, p_secreto text, p_cifrada text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_disp uuid;
  v_serie text;
  v_host text;
  r record;
begin
  v_disp := inv_verificar_equipo('', p_uuid, p_hostname, p_secreto);
  if v_disp is null then
    raise exception 'El equipo todavía no está aprobado en Monitoreo';
  end if;
  if not exists (select 1 from bios_claves_config where id = 1 and habilitado_hasta > now()) then
    raise exception 'El despliegue de claves de BIOS no está habilitado';
  end if;

  select upper(trim(numero_serie)), hostname into v_serie, v_host from inv_dispositivos where id = v_disp;
  if v_serie is null or v_serie !~ '^[A-Z0-9]{5,20}$' then
    raise exception 'El equipo no informa un número de serie válido';
  end if;

  select * into r from bios_claves where numero_serie = v_serie for update;
  if found then
    if r.estado = 'aplicada' then
      raise exception 'Este equipo ya tiene su clave de BIOS aplicada';
    end if;
    update bios_claves set intentos = intentos + 1, dispositivo_id = v_disp, hostname = v_host where numero_serie = v_serie;
    return r.clave_cifrada;
  end if;

  if coalesce(p_cifrada, '') !~ '^v1:' then
    raise exception 'Clave cifrada inválida';
  end if;
  insert into bios_claves (numero_serie, dispositivo_id, hostname, clave_cifrada)
  values (v_serie, v_disp, v_host, p_cifrada);
  return p_cifrada;
end $$;
revoke all on function public.bios_reservar(text, text, text, text) from public;
grant execute on function public.bios_reservar(text, text, text, text) to anon, authenticated;

-- El equipo avisa cómo le fue al aplicar la clave
create or replace function public.bios_confirmar(p_uuid text, p_hostname text, p_secreto text, p_ok boolean, p_usb boolean, p_detalle text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_disp uuid;
  v_serie text;
begin
  v_disp := inv_verificar_equipo('', p_uuid, p_hostname, p_secreto);
  if v_disp is null then
    raise exception 'El equipo todavía no está aprobado en Monitoreo';
  end if;
  select upper(trim(numero_serie)) into v_serie from inv_dispositivos where id = v_disp;
  update bios_claves set
    estado = case when p_ok then 'aplicada' else 'error' end,
    aplicada = case when p_ok then now() else aplicada end,
    usb_bloqueado = case when p_ok then p_usb else usb_bloqueado end,
    ultimo_error = case when p_ok then null else left(coalesce(p_detalle, 'Error sin detalle'), 300) end
  where numero_serie = v_serie and estado <> 'aplicada';
end $$;
revoke all on function public.bios_confirmar(text, text, text, boolean, boolean, text) from public;
grant execute on function public.bios_confirmar(text, text, text, boolean, boolean, text) to anon, authenticated;

-- ----------------------------------------------------------
-- Administradores
-- ----------------------------------------------------------
-- Habilita el despliegue por N horas (0 = deshabilitar)
create or replace function public.bios_habilitar(p_horas int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v timestamptz;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  if p_horas is null or p_horas < 0 or p_horas > 72 then raise exception 'La ventana va de 0 a 72 horas'; end if;
  v := case when p_horas = 0 then null else now() + make_interval(hours => p_horas) end;
  update bios_claves_config set habilitado_hasta = v, habilitado_por = auth.jwt()->>'email' where id = 1;
  return v;
end $$;
revoke all on function public.bios_habilitar(int) from public, anon;
grant execute on function public.bios_habilitar(int) to authenticated;

-- Devuelve la clave CIFRADA de un equipo (la app la descifra) y deja registrada la consulta
create or replace function public.bios_ver(p_serie text, p_motivo text)
returns text language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Indicá el motivo de la consulta'; end if;
  select numero_serie, hostname, clave_cifrada into r from bios_claves where numero_serie = upper(trim(p_serie));
  if not found then raise exception 'Ese equipo no tiene una clave de BIOS guardada'; end if;
  insert into bios_claves_consultas (numero_serie, hostname, usuario, email, motivo)
  values (r.numero_serie, r.hostname, auth.uid(), auth.jwt()->>'email', left(trim(p_motivo), 300));
  return r.clave_cifrada;
end $$;
revoke all on function public.bios_ver(text, text) from public, anon;
grant execute on function public.bios_ver(text, text) to authenticated;

-- Estado del despliegue, sin las claves
create or replace function public.bios_resumen()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo administradores'; end if;
  return jsonb_build_object(
    'habilitado_hasta', (select habilitado_hasta from bios_claves_config where id = 1),
    'habilitado_por', (select habilitado_por from bios_claves_config where id = 1),
    'claves', coalesce((select jsonb_agg(jsonb_build_object(
        'numero_serie', numero_serie, 'hostname', hostname, 'estado', estado, 'generada', generada,
        'aplicada', aplicada, 'intentos', intentos, 'usb_bloqueado', usb_bloqueado, 'ultimo_error', ultimo_error)
        order by generada desc) from bios_claves), '[]'::jsonb),
    'consultas', coalesce((select jsonb_agg(c order by c.fecha desc) from (
        select numero_serie, hostname, email, motivo, fecha from bios_claves_consultas order by fecha desc limit 50) c), '[]'::jsonb)
  );
end $$;
revoke all on function public.bios_resumen() from public, anon;
grant execute on function public.bios_resumen() to authenticated;
