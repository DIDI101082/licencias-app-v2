-- ==========================================================
-- Normativa, segunda parte:
--   * Declaración de Aplicabilidad (SoA) de ISO/IEC 27001: justificación de cada control
--     y datos del documento (alcance, versión, aprobación).
--   * Registro de riesgos de seguridad de la información con su plan de tratamiento,
--     vinculado a los controles (ISO 27001 cláusulas 6.1.2, 6.1.3 y 8.2-8.3).
--   * Historial: foto diaria del nivel de cumplimiento y registro de cada cambio de estado.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de postura.sql. Se puede repetir.
-- ==========================================================

-- ---------- Declaración de Aplicabilidad ----------
alter table public.norma_evaluacion add column if not exists justificacion text;   -- por qué se incluye o se excluye

create table if not exists public.norma_soa (
  id int primary key default 1 check (id = 1),
  organizacion text not null default 'Accusys Technology',
  alcance text,
  version text not null default '1.0',
  aprobado_por text,
  aprobado_en date,
  actualizado timestamptz not null default now()
);
insert into public.norma_soa (id) values (1) on conflict (id) do nothing;

-- ---------- Registro de riesgos ----------
create table if not exists public.norma_riesgos (
  id bigserial primary key,
  codigo text unique,
  titulo text not null,
  descripcion text,
  activo text,                       -- qué se protege (sistema, información, proceso)
  amenaza text,
  vulnerabilidad text,
  probabilidad int not null check (probabilidad between 1 and 5),
  impacto int not null check (impacto between 1 and 5),
  nivel int generated always as (probabilidad * impacto) stored,
  tratamiento text not null default 'mitigar' check (tratamiento in ('mitigar', 'aceptar', 'transferir', 'evitar')),
  plan text,                         -- acciones del plan de tratamiento
  responsable text,
  fecha_objetivo date,
  estado text not null default 'identificado' check (estado in ('identificado', 'en_tratamiento', 'tratado', 'aceptado', 'cerrado')),
  prob_residual int check (prob_residual between 1 and 5),
  impacto_residual int check (impacto_residual between 1 and 5),
  nivel_residual int generated always as (prob_residual * impacto_residual) stored,
  aceptado_por text,                 -- dueño del riesgo que acepta el riesgo residual
  aceptado_en date,
  controles text[] not null default '{}',   -- ids de norma_controles (ej. ISO27001-8.7)
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  actualizado_por uuid references public.perfiles(id) on delete set null default auth.uid()
);
create index if not exists idx_norma_riesgos_controles on public.norma_riesgos using gin (controles);

-- ---------- Historial ----------
create table if not exists public.norma_cambios (
  id bigserial primary key,
  fecha timestamptz not null default now(),
  control_id text not null references public.norma_controles(id) on delete cascade,
  estado_anterior text,
  estado_nuevo text not null,
  usuario uuid,
  usuario_nombre text
);
create index if not exists idx_norma_cambios_control on public.norma_cambios (control_id, fecha desc);

create table if not exists public.norma_historial (
  fecha date not null,
  marco text not null,
  cumple int not null default 0,
  parcial int not null default 0,
  no_cumple int not null default 0,
  no_aplica int not null default 0,
  sin_evaluar int not null default 0,
  avance numeric,                    -- (cumple + parcial/2) / evaluados, en %; null si no hay evaluados
  primary key (fecha, marco)
);

-- Foto del día: se recalcula en cada cambio (queda la última del día)
create or replace function public.norma_foto() returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into norma_historial (fecha, marco, cumple, parcial, no_cumple, no_aplica, sin_evaluar, avance)
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date, c.marco,
         count(*) filter (where e.estado = 'cumple'),
         count(*) filter (where e.estado = 'parcial'),
         count(*) filter (where e.estado = 'no_cumple'),
         count(*) filter (where e.estado = 'no_aplica'),
         count(*) filter (where coalesce(e.estado, 'sin_evaluar') = 'sin_evaluar'),
         round(100.0 * (count(*) filter (where e.estado = 'cumple') + 0.5 * count(*) filter (where e.estado = 'parcial'))
               / nullif(count(*) filter (where e.estado in ('cumple', 'parcial', 'no_cumple')), 0), 1)
    from norma_controles c left join norma_evaluacion e on e.control_id = c.id
   group by c.marco
  on conflict (fecha, marco) do update set
    cumple = excluded.cumple, parcial = excluded.parcial, no_cumple = excluded.no_cumple,
    no_aplica = excluded.no_aplica, sin_evaluar = excluded.sin_evaluar, avance = excluded.avance;
end $$;
revoke all on function public.norma_foto() from public, anon, authenticated;

create or replace function public.norma_evaluacion_cambio() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.estado is distinct from old.estado then
    insert into norma_cambios (control_id, estado_anterior, estado_nuevo, usuario, usuario_nombre)
    values (new.control_id, case when tg_op = 'UPDATE' then old.estado end, new.estado, auth.uid(),
            (select nombre from perfiles where id = auth.uid()));
  end if;
  return new;
end $$;
drop trigger if exists trg_norma_evaluacion_cambio on public.norma_evaluacion;
create trigger trg_norma_evaluacion_cambio after insert or update on public.norma_evaluacion
  for each row execute function public.norma_evaluacion_cambio();

create or replace function public.norma_evaluacion_foto() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform norma_foto();
  return null;
end $$;
drop trigger if exists trg_norma_evaluacion_foto on public.norma_evaluacion;
create trigger trg_norma_evaluacion_foto after insert or update or delete on public.norma_evaluacion
  for each statement execute function public.norma_evaluacion_foto();

-- ---------- Funciones que usa la app ----------

-- Guardar la evaluación de un control (ahora con la justificación de la SoA)
create or replace function public.norma_guardar(p_control text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then raise exception 'Sin permiso para evaluar controles'; end if;
  if not exists (select 1 from norma_controles where id = p_control) then raise exception 'Control inexistente'; end if;
  insert into norma_evaluacion (control_id, estado, responsable, evidencia, notas, justificacion, revisado, proxima, actualizado, actualizado_por)
  values (p_control, coalesce(p ->> 'estado', 'sin_evaluar'), nullif(left(trim(p ->> 'responsable'), 120), ''),
          nullif(left(trim(p ->> 'evidencia'), 4000), ''), nullif(left(trim(p ->> 'notas'), 4000), ''),
          nullif(left(trim(p ->> 'justificacion'), 2000), ''),
          nullif(p ->> 'revisado', '')::date, nullif(p ->> 'proxima', '')::date, now(), auth.uid())
  on conflict (control_id) do update set estado = excluded.estado, responsable = excluded.responsable, evidencia = excluded.evidencia,
    notas = excluded.notas, justificacion = excluded.justificacion, revisado = excluded.revisado, proxima = excluded.proxima,
    actualizado = now(), actualizado_por = auth.uid();
end $$;
grant execute on function public.norma_guardar(text, jsonb) to authenticated;

-- Datos del documento SoA (solo administradores)
create or replace function public.norma_soa_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') = 'administrador') then raise exception 'Solo un administrador edita la Declaración de Aplicabilidad'; end if;
  update norma_soa set
    organizacion = coalesce(nullif(left(trim(p ->> 'organizacion'), 120), ''), organizacion),
    alcance = nullif(left(trim(p ->> 'alcance'), 4000), ''),
    version = coalesce(nullif(left(trim(p ->> 'version'), 20), ''), version),
    aprobado_por = nullif(left(trim(p ->> 'aprobado_por'), 120), ''),
    aprobado_en = nullif(p ->> 'aprobado_en', '')::date,
    actualizado = now()
  where id = 1;
end $$;
revoke execute on function public.norma_soa_guardar(jsonb) from public, anon;
grant execute on function public.norma_soa_guardar(jsonb) to authenticated;

-- Alta o modificación de un riesgo. Devuelve el id.
create or replace function public.norma_riesgo_guardar(p_id bigint, p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := p_id;
  v_controles text[];
  v_trat text := coalesce(p ->> 'tratamiento', 'mitigar');
  v_estado text := coalesce(p ->> 'estado', 'identificado');
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then raise exception 'Sin permiso para editar riesgos'; end if;
  if coalesce(trim(p ->> 'titulo'), '') = '' then raise exception 'Falta el título del riesgo'; end if;
  -- Solo se guardan controles que existen
  select coalesce(array_agg(distinct c.id), '{}') into v_controles
    from jsonb_array_elements_text(coalesce(p -> 'controles', '[]')) x join norma_controles c on c.id = x;

  if v_id is null then
    insert into norma_riesgos (titulo, probabilidad, impacto) values (left(trim(p ->> 'titulo'), 200), 1, 1) returning id into v_id;
    update norma_riesgos set codigo = 'R-' || lpad(v_id::text, 3, '0') where id = v_id;
  elsif not exists (select 1 from norma_riesgos where id = v_id) then
    raise exception 'Riesgo inexistente';
  end if;

  update norma_riesgos set
    titulo = left(trim(p ->> 'titulo'), 200),
    descripcion = nullif(left(trim(p ->> 'descripcion'), 4000), ''),
    activo = nullif(left(trim(p ->> 'activo'), 200), ''),
    amenaza = nullif(left(trim(p ->> 'amenaza'), 500), ''),
    vulnerabilidad = nullif(left(trim(p ->> 'vulnerabilidad'), 500), ''),
    probabilidad = least(5, greatest(1, coalesce((p ->> 'probabilidad')::int, 3))),
    impacto = least(5, greatest(1, coalesce((p ->> 'impacto')::int, 3))),
    tratamiento = case when v_trat in ('mitigar', 'aceptar', 'transferir', 'evitar') then v_trat else 'mitigar' end,
    plan = nullif(left(trim(p ->> 'plan'), 4000), ''),
    responsable = nullif(left(trim(p ->> 'responsable'), 120), ''),
    fecha_objetivo = nullif(p ->> 'fecha_objetivo', '')::date,
    estado = case when v_estado in ('identificado', 'en_tratamiento', 'tratado', 'aceptado', 'cerrado') then v_estado else 'identificado' end,
    prob_residual = case when nullif(p ->> 'prob_residual', '') is null then null else least(5, greatest(1, (p ->> 'prob_residual')::int)) end,
    impacto_residual = case when nullif(p ->> 'impacto_residual', '') is null then null else least(5, greatest(1, (p ->> 'impacto_residual')::int)) end,
    aceptado_por = nullif(left(trim(p ->> 'aceptado_por'), 120), ''),
    aceptado_en = nullif(p ->> 'aceptado_en', '')::date,
    controles = v_controles,
    actualizado = now(),
    actualizado_por = auth.uid()
  where id = v_id;
  return v_id;
end $$;
revoke execute on function public.norma_riesgo_guardar(bigint, jsonb) from public, anon;
grant execute on function public.norma_riesgo_guardar(bigint, jsonb) to authenticated;

create or replace function public.norma_riesgo_borrar(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (puede_ver('seguridad') and coalesce(mi_rol(), '') = 'administrador') then raise exception 'Solo un administrador borra riesgos'; end if;
  delete from norma_riesgos where id = p_id;
end $$;
revoke execute on function public.norma_riesgo_borrar(bigint) from public, anon;
grant execute on function public.norma_riesgo_borrar(bigint) to authenticated;

-- ---------- Seguridad: lectura para quien ve Seguridad; escritura solo por las funciones ----------
do $$
declare t text;
begin
  foreach t in array array['norma_soa', 'norma_riesgos', 'norma_cambios', 'norma_historial'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''seguridad''))', t || '_select', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
  -- Cambios del registro de riesgos y de la SoA en la auditoría general
  foreach t in array array['norma_soa', 'norma_riesgos'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;

-- Punto de partida del historial: la foto de hoy
select public.norma_foto();
