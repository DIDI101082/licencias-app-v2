-- ==========================================================
-- INCIDENTES DE SEGURIDAD con playbooks
--   * Cada incidente tiene tipo, severidad, estado y un checklist que sale del playbook de su tipo.
--   * Línea de tiempo con notas y cambios de estado (quién y cuándo).
--   * "Equipo perdido o robado" vincula el equipo y muestra su último rastro (agente, IP, Wi-Fi).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de altas-bajas.sql.
-- ==========================================================

create table if not exists public.incidentes_tipos (
  id text primary key,
  nombre text not null,
  orden int not null default 0
);
insert into public.incidentes_tipos (id, nombre, orden) values
  ('equipo_perdido', 'Equipo perdido o robado', 10),
  ('phishing', 'Phishing reportado', 20),
  ('malware', 'Malware detectado', 30),
  ('cuenta_comprometida', 'Cuenta comprometida', 40),
  ('fuga_datos', 'Fuga o exposición de datos', 50),
  ('otro', 'Otro', 90)
on conflict (id) do nothing;

-- Playbooks: tareas modelo por tipo (se pueden editar desde el SQL Editor o la app a futuro)
create table if not exists public.incidentes_plantilla (
  id serial primary key,
  tipo text not null references public.incidentes_tipos(id),
  fase text not null default 'Contención' check (fase in ('Contención', 'Investigación', 'Recuperación', 'Cierre')),
  orden int not null default 0,
  descripcion text not null,
  activo boolean not null default true
);

insert into public.incidentes_plantilla (tipo, fase, orden, descripcion)
select * from (values
  -- Equipo perdido o robado
  ('equipo_perdido', 'Contención', 10, 'Revocar todas las sesiones del usuario en Entra ID y resetear su contraseña'),
  ('equipo_perdido', 'Contención', 20, 'Deshabilitar el dispositivo en Entra ID (si figura registrado)'),
  ('equipo_perdido', 'Contención', 30, 'Bloquear el usuario o su certificado de VPN FortiClient en el FortiGate'),
  ('equipo_perdido', 'Contención', 40, 'Verificar en ESET PROTECT que el disco esté cifrado y aplicar las acciones remotas disponibles'),
  ('equipo_perdido', 'Investigación', 50, 'Revisar el último reporte del agente (IP, ciudad, red Wi-Fi) y registrarlo en las notas'),
  ('equipo_perdido', 'Investigación', 60, 'Relevar qué datos sensibles había en el equipo y si había credenciales guardadas'),
  ('equipo_perdido', 'Recuperación', 70, 'Rotar credenciales que pudieran estar guardadas (navegador, SSH, sistemas críticos)'),
  ('equipo_perdido', 'Recuperación', 80, 'Hacer la denuncia policial y adjuntar el número en las notas'),
  ('equipo_perdido', 'Recuperación', 90, 'Entregar equipo de reemplazo con acta'),
  ('equipo_perdido', 'Cierre', 100, 'Dar aviso al seguro y actualizar el estado del equipo en Inventario IT'),
  -- Phishing
  ('phishing', 'Contención', 10, 'Identificar a todos los destinatarios del correo'),
  ('phishing', 'Contención', 20, 'Eliminar el correo de todos los buzones (búsqueda de contenido en Microsoft 365)'),
  ('phishing', 'Contención', 30, 'Bloquear remitente, dominio y enlaces en el filtro de correo y en el FortiGate'),
  ('phishing', 'Investigación', 40, 'Confirmar si alguien hizo clic o ingresó credenciales (logs de inicio de sesión)'),
  ('phishing', 'Recuperación', 50, 'A quien ingresó credenciales: revocar sesiones, resetear contraseña y revisar MFA'),
  ('phishing', 'Cierre', 60, 'Avisar a la empresa con un ejemplo del correo para que lo reconozcan'),
  -- Malware
  ('malware', 'Contención', 10, 'Aislar el equipo de la red (ESET o desconectarlo físicamente)'),
  ('malware', 'Investigación', 20, 'Revisar la detección en ESET PROTECT: archivo, origen y si fue bloqueado'),
  ('malware', 'Investigación', 30, 'Buscar el mismo indicador en otros equipos'),
  ('malware', 'Recuperación', 40, 'Analizar el equipo completo; si hay dudas, reinstalar'),
  ('malware', 'Recuperación', 50, 'Resetear las credenciales usadas en ese equipo'),
  ('malware', 'Cierre', 60, 'Documentar la causa (adjunto, descarga, USB) y cómo evitarla'),
  -- Cuenta comprometida
  ('cuenta_comprometida', 'Contención', 10, 'Revocar sesiones y resetear la contraseña en Entra ID'),
  ('cuenta_comprometida', 'Contención', 20, 'Revisar y quitar métodos de MFA desconocidos'),
  ('cuenta_comprometida', 'Investigación', 30, 'Revisar reglas de reenvío y bandeja de entrada del buzón'),
  ('cuenta_comprometida', 'Investigación', 40, 'Revisar inicios de sesión: IPs, países y aplicaciones'),
  ('cuenta_comprometida', 'Investigación', 50, 'Revisar correos enviados y archivos compartidos por la cuenta'),
  ('cuenta_comprometida', 'Recuperación', 60, 'Avisar a los contactos afectados si se enviaron correos maliciosos'),
  ('cuenta_comprometida', 'Cierre', 70, 'Documentar cómo se comprometió la cuenta'),
  -- Fuga de datos
  ('fuga_datos', 'Contención', 10, 'Cortar el acceso a la información expuesta (permisos, enlaces públicos)'),
  ('fuga_datos', 'Investigación', 20, 'Determinar qué datos, de quiénes y desde cuándo estuvieron expuestos'),
  ('fuga_datos', 'Investigación', 30, 'Evaluar con Legales la obligación de notificar a clientes o a la autoridad'),
  ('fuga_datos', 'Recuperación', 40, 'Ejecutar las notificaciones que correspondan'),
  ('fuga_datos', 'Cierre', 50, 'Documentar causa raíz y medidas correctivas'),
  -- Otro
  ('otro', 'Contención', 10, 'Contener el impacto'),
  ('otro', 'Investigación', 20, 'Investigar la causa'),
  ('otro', 'Cierre', 30, 'Documentar y cerrar')
) v(tipo, fase, orden, descripcion)
where not exists (select 1 from public.incidentes_plantilla);

create sequence if not exists public.incidentes_numero_seq;

create table if not exists public.incidentes (
  id bigserial primary key,
  numero int not null unique default nextval('public.incidentes_numero_seq'),
  tipo text not null references public.incidentes_tipos(id),
  titulo text not null,
  descripcion text,
  severidad text not null default 'media' check (severidad in ('baja', 'media', 'alta', 'critica')),
  estado text not null default 'abierto' check (estado in ('abierto', 'contenido', 'cerrado')),
  empleado_id uuid references public.empleados(id) on delete set null,
  equipo_id uuid references public.inv_equipos(id) on delete set null,
  detectado timestamptz not null default now(),
  contenido timestamptz,
  cerrado timestamptz,
  conclusion text,
  creado_por uuid references public.perfiles(id) on delete set null default auth.uid(),
  creado_por_nombre text,
  creado timestamptz not null default now()
);
create index if not exists idx_incidentes_estado on public.incidentes(estado);

create table if not exists public.incidentes_tareas (
  id bigserial primary key,
  incidente_id bigint not null references public.incidentes(id) on delete cascade,
  fase text not null,
  orden int not null default 0,
  descripcion text not null,
  hecha boolean not null default false,
  hecha_en timestamptz,
  hecha_por_nombre text
);
create index if not exists idx_incidentes_tareas on public.incidentes_tareas(incidente_id);

create table if not exists public.incidentes_eventos (
  id bigserial primary key,
  incidente_id bigint not null references public.incidentes(id) on delete cascade,
  tipo text not null default 'nota' check (tipo in ('nota', 'estado', 'tarea', 'creado')),
  texto text not null,
  autor_nombre text,
  fecha timestamptz not null default now()
);
create index if not exists idx_incidentes_eventos on public.incidentes_eventos(incidente_id);

-- ----------------------------------------------------------
-- Funciones (toda escritura pasa por acá)
-- ----------------------------------------------------------
create or replace function public.incidentes_puede_gestionar() returns boolean
language sql stable security definer set search_path = public as $$
  select puede_ver('seguridad') and coalesce(mi_rol() in ('administrador', 'lectura_escritura'), false)
$$;
grant execute on function public.incidentes_puede_gestionar() to authenticated;

create or replace function public.incidentes_mi_nombre() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nombre, email) from perfiles where id = auth.uid()
$$;

create or replace function public.incidentes_crear(
  p_tipo text, p_titulo text, p_descripcion text default null, p_severidad text default 'media',
  p_empleado uuid default null, p_equipo uuid default null, p_detectado timestamptz default now()
) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_nombre text := incidentes_mi_nombre();
begin
  if not incidentes_puede_gestionar() then raise exception 'No tenés permiso para registrar incidentes'; end if;
  if coalesce(trim(p_titulo), '') = '' then raise exception 'Falta el título'; end if;
  insert into incidentes (tipo, titulo, descripcion, severidad, empleado_id, equipo_id, detectado, creado_por_nombre)
  values (p_tipo, trim(p_titulo), nullif(trim(p_descripcion), ''), p_severidad, p_empleado, p_equipo, coalesce(p_detectado, now()), v_nombre)
  returning id into v_id;
  insert into incidentes_tareas (incidente_id, fase, orden, descripcion)
  select v_id, fase, orden, descripcion from incidentes_plantilla where tipo = p_tipo and activo order by orden, id;
  insert into incidentes_eventos (incidente_id, tipo, texto, autor_nombre) values (v_id, 'creado', 'Incidente registrado', v_nombre);
  return v_id;
end $$;
grant execute on function public.incidentes_crear(text, text, text, text, uuid, uuid, timestamptz) to authenticated;

create or replace function public.incidentes_tarea_marcar(p_tarea bigint, p_hecha boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_inc bigint; v_desc text; v_nombre text := incidentes_mi_nombre();
begin
  if not incidentes_puede_gestionar() then raise exception 'No tenés permiso'; end if;
  update incidentes_tareas set hecha = p_hecha,
         hecha_en = case when p_hecha then now() end,
         hecha_por_nombre = case when p_hecha then v_nombre end
   where id = p_tarea returning incidente_id, descripcion into v_inc, v_desc;
  if v_inc is null then raise exception 'Tarea inexistente'; end if;
  insert into incidentes_eventos (incidente_id, tipo, texto, autor_nombre)
  values (v_inc, 'tarea', case when p_hecha then 'Hecho: ' else 'Desmarcado: ' end || v_desc, v_nombre);
end $$;
grant execute on function public.incidentes_tarea_marcar(bigint, boolean) to authenticated;

create or replace function public.incidentes_nota(p_incidente bigint, p_texto text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not incidentes_puede_gestionar() then raise exception 'No tenés permiso'; end if;
  if coalesce(trim(p_texto), '') = '' then raise exception 'La nota está vacía'; end if;
  insert into incidentes_eventos (incidente_id, tipo, texto, autor_nombre) values (p_incidente, 'nota', trim(p_texto), incidentes_mi_nombre());
end $$;
grant execute on function public.incidentes_nota(bigint, text) to authenticated;

create or replace function public.incidentes_estado(p_incidente bigint, p_estado text, p_conclusion text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_nombre text := incidentes_mi_nombre();
begin
  if not incidentes_puede_gestionar() then raise exception 'No tenés permiso'; end if;
  if p_estado not in ('abierto', 'contenido', 'cerrado') then raise exception 'Estado inválido'; end if;
  if p_estado = 'cerrado' and coalesce(trim(p_conclusion), '') = '' then raise exception 'Para cerrar, escribí la conclusión (causa y qué se hizo)'; end if;
  update incidentes set estado = p_estado,
         contenido = case when p_estado in ('contenido', 'cerrado') then coalesce(contenido, now()) else null end,
         cerrado = case when p_estado = 'cerrado' then now() end,
         conclusion = case when p_estado = 'cerrado' then trim(p_conclusion) else conclusion end
   where id = p_incidente;
  insert into incidentes_eventos (incidente_id, tipo, texto, autor_nombre)
  values (p_incidente, 'estado',
          case p_estado when 'abierto' then 'Reabierto' when 'contenido' then 'Marcado como contenido' else 'Cerrado: ' || trim(p_conclusion) end,
          v_nombre);
end $$;
grant execute on function public.incidentes_estado(bigint, text, text) to authenticated;

-- Lista con avance
create or replace view public.incidentes_v as
select i.*, t.nombre as tipo_nombre,
       trim(concat_ws(' ', e.nombre, e.apellido)) as empleado,
       (select count(*) from incidentes_tareas x where x.incidente_id = i.id)::int as tareas,
       (select count(*) from incidentes_tareas x where x.incidente_id = i.id and x.hecha)::int as hechas
  from incidentes i
  join incidentes_tipos t on t.id = i.tipo
  left join empleados e on e.id = i.empleado_id;
alter view public.incidentes_v set (security_invoker = on);

-- ----------------------------------------------------------
-- Seguridad: se leen con la solapa Seguridad; se escriben solo por las funciones
-- ----------------------------------------------------------
alter table public.incidentes_tipos enable row level security;
alter table public.incidentes_plantilla enable row level security;
alter table public.incidentes enable row level security;
alter table public.incidentes_tareas enable row level security;
alter table public.incidentes_eventos enable row level security;

do $$
declare t text;
begin
  foreach t in array array['incidentes_tipos', 'incidentes_plantilla', 'incidentes', 'incidentes_tareas', 'incidentes_eventos'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (puede_ver(''seguridad''))', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I for each row execute function public.auditar()', t);
  end loop;
end $$;
