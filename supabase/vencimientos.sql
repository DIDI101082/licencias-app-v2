-- ==========================================================
-- VENCIMIENTOS CENTRALIZADOS
--   * Junta en una sola lista: licencias de software, garantías de equipos y
--     vencimientos cargados a mano (certificados SSL, dominios, secretos de Entra ID,
--     contratos de soporte, etc.).
--   * Los certificados SSL y los dominios se pueden verificar solos desde la app.
--   * Avisa por Teams antes de vencer (regla "Vencimientos" de Alertas).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de altas-bajas.sql.
-- ==========================================================

create table if not exists public.vencimientos (
  id serial primary key,
  tipo text not null check (tipo in ('certificado', 'dominio', 'secreto', 'contrato', 'otro')),
  descripcion text not null,
  host text,                         -- certificado: host a verificar; dominio: el dominio
  fecha_vencimiento date,
  aviso_dias int not null default 30 check (aviso_dias between 1 and 365),
  responsable text,
  notas text,
  activo boolean not null default true,
  creado_por uuid references public.perfiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

-- Resultado de la última verificación automática (aparte, para no llenar Logs con cada chequeo)
create table if not exists public.vencimientos_verificacion (
  vencimiento_id int primary key references public.vencimientos(id) on delete cascade,
  verificado timestamptz not null default now(),
  error text,
  emisor text
);

-- Lista unificada (respeta los permisos de quien consulta: cada uno ve lo de sus solapas)
create or replace view public.vencimientos_v with (security_invoker = true) as
select 'licencia'::text as origen, l.id::text as ref, 'licencia'::text as tipo,
       l.nombre || coalesce(' · ' || l.proveedor, '') as descripcion,
       l.fecha_vencimiento, 30 as aviso_dias, null::text as responsable, '/licencias'::text as enlace,
       null::timestamptz as verificado, null::text as verificacion_error, null::text as emisor, null::text as host
  from licencias l
 where l.fecha_vencimiento is not null
union all
select 'garantia', e.id::text, 'garantia',
       e.codigo || ' · ' || coalesce(nullif(trim(concat_ws(' ', e.marca, e.modelo)), ''), 'equipo'),
       e.garantia_hasta, 30, null, '/inventario/equipos/' || e.id, null, null, null, null
  from inv_equipos e
 where e.garantia_hasta is not null and e.estado not in ('dado_de_baja', 'perdido')
union all
select 'manual', v.id::text, v.tipo, v.descripcion, v.fecha_vencimiento, v.aviso_dias, v.responsable, '/vencimientos',
       vv.verificado, vv.error, vv.emisor, v.host
  from vencimientos v
  left join vencimientos_verificacion vv on vv.vencimiento_id = v.id
 where v.activo;

-- La verificación automática (desde la app) guarda la fecha real del certificado o del dominio
create or replace function public.vencimientos_guardar_verificacion(p_id int, p_fecha date, p_emisor text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (puede_ver('licencias') and mi_rol() in ('administrador', 'lectura_escritura')) then
    raise exception 'Sin permiso';
  end if;
  if not exists (select 1 from vencimientos where id = p_id and tipo in ('certificado', 'dominio')) then
    return;
  end if;
  -- la fecha solo se toca si cambió (así en Logs queda cada renovación, no cada chequeo)
  update vencimientos set fecha_vencimiento = p_fecha
   where id = p_id and p_fecha is not null and fecha_vencimiento is distinct from p_fecha;
  insert into vencimientos_verificacion (vencimiento_id, verificado, error, emisor)
  values (p_id, now(), nullif(trim(p_error), ''), nullif(trim(p_emisor), ''))
  on conflict (vencimiento_id) do update set verificado = now(), error = excluded.error,
    emisor = coalesce(excluded.emisor, vencimientos_verificacion.emisor);
end $$;
grant execute on function public.vencimientos_guardar_verificacion(int, date, text, text) to authenticated;

insert into public.vencimientos (tipo, descripcion, notas, creado_por)
select 'secreto', 'Secreto de la app de Entra ID (inicio de sesión con Microsoft)',
       'Entra ID → Registros de aplicaciones → Accusys Cyber → Certificados y secretos. Al renovarlo, actualizarlo en Supabase (Authentication → Providers → Azure).',
       null
 where not exists (select 1 from public.vencimientos);

alter table public.vencimientos enable row level security;
alter table public.vencimientos_verificacion enable row level security;
drop policy if exists vencimientos_verificacion_select on public.vencimientos_verificacion;
create policy vencimientos_verificacion_select on public.vencimientos_verificacion for select to authenticated using (puede_ver('licencias'));
revoke insert, update, delete on public.vencimientos_verificacion from anon, authenticated;
drop policy if exists vencimientos_select on public.vencimientos;
create policy vencimientos_select on public.vencimientos for select to authenticated using (puede_ver('licencias'));
drop policy if exists vencimientos_editar on public.vencimientos;
create policy vencimientos_editar on public.vencimientos for all to authenticated
  using (puede_ver('licencias') and mi_rol() in ('administrador', 'lectura_escritura'))
  with check (puede_ver('licencias') and mi_rol() in ('administrador', 'lectura_escritura'));

drop trigger if exists trg_auditoria on public.vencimientos;
create trigger trg_auditoria after insert or update or delete on public.vencimientos
  for each row execute function public.auditar();
