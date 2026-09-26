-- ==========================================================
-- Registro propio de ingresos y salidas de la app (no depende de la configuración
-- del registro de autenticación de Supabase). La IP es la real del navegador.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de auditoria.sql.
-- ==========================================================

create table if not exists public.auditoria_ingresos (
  id bigserial primary key,
  fecha timestamptz not null default now(),
  usuario_id uuid,
  email text,
  nombre text,
  accion text not null check (accion in ('login', 'logout')),
  metodo text,
  ip text,
  navegador text
);
create index if not exists idx_auditoria_ingresos_fecha on public.auditoria_ingresos(fecha desc);

-- La llama la app al entrar y al salir. Toma el usuario de la sesión: no se puede registrar a otro.
create or replace function public.registrar_ingreso(p_accion text, p_metodo text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  p record;
  v_headers json;
begin
  if v_uid is null or p_accion not in ('login', 'logout') then
    return;
  end if;
  -- evitar duplicados si se recarga la página
  if exists (select 1 from auditoria_ingresos where usuario_id = v_uid and accion = p_accion and fecha > now() - interval '1 minute') then
    return;
  end if;
  select nombre, email into p from perfiles where id = v_uid;
  begin
    v_headers := current_setting('request.headers', true)::json;
  exception when others then v_headers := null;
  end;
  insert into auditoria_ingresos (usuario_id, email, nombre, accion, metodo, ip, navegador)
  values (v_uid, p.email, p.nombre, p_accion,
          case when p_metodo in ('azure', 'email') then p_metodo end,
          (select inv_ip_cliente()),
          left(v_headers ->> 'user-agent', 300));
end $$;
revoke all on function public.registrar_ingreso(text, text) from public, anon;
grant execute on function public.registrar_ingreso(text, text) to authenticated;

-- La pantalla "Inicios de sesión": ingresos y salidas propios + otros eventos de Supabase si los hubiera
drop function if exists public.auditoria_sesiones(timestamptz, int);
create function public.auditoria_sesiones(p_desde timestamptz, p_limite int default 500)
returns table (fecha timestamptz, email text, accion text, ip text, proveedor text, navegador text)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not puede_ver('auditoria') then
    return;
  end if;
  return query
    select i.fecha, i.email, i.accion, i.ip, i.metodo, i.navegador
      from auditoria_ingresos i
     where i.fecha >= p_desde
     order by i.fecha desc
     limit least(greatest(p_limite, 1), 2000);
  begin
    return query
      select e.created_at,
             coalesce(e.payload ->> 'actor_username', e.payload -> 'traits' ->> 'user_email', e.payload -> 'traits' ->> 'email'),
             e.payload ->> 'action', nullif(e.ip_address::text, ''), e.payload -> 'traits' ->> 'provider', null::text
        from auth.audit_log_entries e
       where e.created_at >= p_desde
         and e.payload ->> 'action' in ('user_signedup', 'user_deleted', 'user_invited', 'user_updated_password', 'user_recovery_requested')
       limit 500;
  exception when others then null;
  end;
end $$;
revoke all on function public.auditoria_sesiones(timestamptz, int) from public, anon;
grant execute on function public.auditoria_sesiones(timestamptz, int) to authenticated;

alter table public.auditoria_ingresos enable row level security;
revoke insert, update, delete, truncate on public.auditoria_ingresos from anon, authenticated;
drop policy if exists auditoria_ingresos_select on public.auditoria_ingresos;
create policy auditoria_ingresos_select on public.auditoria_ingresos for select to authenticated using (puede_ver('auditoria'));
