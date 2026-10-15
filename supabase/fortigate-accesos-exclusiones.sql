-- ==========================================================
-- Red → FortiGate → Inicios de sesión → Exclusiones
--   * Permite excluir un usuario (opcionalmente solo desde una IP) del listado de inicios de sesión
--     de administración y de las alertas a Teams. Pensado para ruido conocido, por ejemplo una
--     integración con un token viejo que falla cada pocos minutos.
--   * Los registros se siguen guardando: solo se ocultan (casilla «Mostrar excluidos») y no alertan.
--   * Solo un administrador crea o quita exclusiones; queda registrado quién y cuándo.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de fortigate-accesos.sql. Se puede repetir.
-- ==========================================================

create table if not exists public.fg_logins_exclusiones (
  id bigserial primary key,
  usuario text not null,                 -- tal cual llega del FortiGate (incluidos los asteriscos)
  ip text not null default '',           -- vacío = desde cualquier origen
  motivo text,
  creado_por uuid references public.perfiles(id) on delete set null default auth.uid(),
  creado_por_nombre text,
  creado timestamptz not null default now(),
  unique (usuario, ip)
);

alter table public.fg_logins_exclusiones enable row level security;
drop policy if exists fg_logins_exclusiones_select on public.fg_logins_exclusiones;
create policy fg_logins_exclusiones_select on public.fg_logins_exclusiones for select to authenticated using (puede_ver('red'));
revoke insert, update, delete on public.fg_logins_exclusiones from anon, authenticated;

-- ¿Este registro está excluido?
create or replace function public.fg_login_excluido(p_usuario text, p_ip text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from fg_logins_exclusiones x
     where x.usuario = coalesce(p_usuario, '') and (x.ip = '' or x.ip = coalesce(p_ip, ''))
  )
$$;
revoke all on function public.fg_login_excluido(text, text) from public, anon;
grant execute on function public.fg_login_excluido(text, text) to authenticated;

create or replace function public.fg_logins_excluir(p_usuario text, p_ip text, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v_nombre text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  if coalesce(p_usuario, '') = '' then raise exception 'Falta el usuario'; end if;
  select coalesce(nullif(nombre, ''), email) into v_nombre from perfiles where id = auth.uid();
  insert into fg_logins_exclusiones (usuario, ip, motivo, creado_por_nombre)
  values (left(p_usuario, 100), left(coalesce(p_ip, ''), 60), left(nullif(trim(p_motivo), ''), 200), v_nombre)
  on conflict (usuario, ip) do update set motivo = excluded.motivo, creado_por = auth.uid(),
    creado_por_nombre = excluded.creado_por_nombre, creado = now();
end $$;
revoke all on function public.fg_logins_excluir(text, text, text) from public, anon;
grant execute on function public.fg_logins_excluir(text, text, text) to authenticated;

create or replace function public.fg_logins_quitar_exclusion(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  delete from fg_logins_exclusiones where id = p_id;
end $$;
revoke all on function public.fg_logins_quitar_exclusion(bigint) from public, anon;
grant execute on function public.fg_logins_quitar_exclusion(bigint) to authenticated;

-- ----------------------------------------------------------
-- Alertas: misma lógica que fortigate-accesos.sql, salteando lo excluido
-- ----------------------------------------------------------
create or replace function public.fg_logins_condiciones_alertas()
returns void language plpgsql security definer set search_path = public as $$
declare c fg_config;
begin
  select * into c from fg_config where id = 1;
  if not coalesce(c.alertas, false) or c.token_hash is null then return; end if;

  -- Cada inicio de sesión de administración (queda abierta 2 horas)
  if c.alertar_logins then
    insert into _cond select 'fg:login:' || l.id, 'fortigate', 'media', 'Inicio de sesión en el FortiGate ' || l.equipo || ': ' || coalesce(nullif(l.usuario, ''), '(sin usuario)'),
           to_char(l.fecha at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') || coalesce(' · desde ' || nullif(l.ip, ''), '') || coalesce(' · por ' || nullif(l.via, ''), ''),
           '/red/fortigate?vista=accesos'
      from fg_admin_logins l
     where l.tipo = 'inicio' and l.fecha > now() - interval '2 hours'
       and not exists (select 1 from fg_logins_exclusiones x where x.usuario = l.usuario and (x.ip = '' or x.ip = l.ip))
    on conflict do nothing;
  end if;

  -- Intentos fallidos repetidos de entrar a la administración (última hora, por IP)
  insert into _cond select 'fg:loginfallo:' || l.equipo || ':' || l.ip, 'fortigate', 'alta', 'Intentos fallidos de administración en el FortiGate ' || l.equipo,
         count(*) || ' intentos en la última hora desde ' || coalesce(nullif(l.ip, ''), 'origen desconocido')
           || coalesce(' · usuarios: ' || left(string_agg(distinct nullif(l.usuario, ''), ', '), 120), ''), '/red/fortigate?vista=accesos'
    from fg_admin_logins l
   where l.tipo = 'fallo' and l.fecha > now() - interval '1 hour'
     and not exists (select 1 from fg_logins_exclusiones x where x.usuario = l.usuario and (x.ip = '' or x.ip = l.ip))
   group by l.equipo, l.ip having count(*) >= least(c.umbral_fallos, 5)
  on conflict do nothing;
end $$;
revoke all on function public.fg_logins_condiciones_alertas() from public, anon, authenticated;
