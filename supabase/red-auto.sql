-- ==========================================================
-- Mapa automático de red: puente con PRTG
--   Un script en el servidor de PRTG consulta la API local (solo lectura)
--   y envía el estado a esta base cada pocos minutos. PRTG no queda expuesto.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de red.sql.
-- ==========================================================

-- Configuración del puente: se guarda solo la huella del token, nunca el token
create table if not exists public.red_puente_config (
  id int primary key default 1 check (id = 1),
  token_hash text,
  prtg_url text,
  creado_en timestamptz
);
insert into public.red_puente_config (id) values (1) on conflict (id) do nothing;

-- Última foto del estado de PRTG (grupos, equipos y sensores con problemas)
create table if not exists public.red_prtg_estado (
  id int primary key default 1 check (id = 1),
  datos jsonb not null default '{}'::jsonb,
  prtg_url text,
  equipos int not null default 0,
  version_puente text,
  actualizado timestamptz
);
insert into public.red_prtg_estado (id) values (1) on conflict (id) do nothing;

-- Historial de cambios de estado de los equipos (caídas, advertencias, recuperaciones)
create table if not exists public.red_prtg_eventos (
  id bigserial primary key,
  objid int not null,
  equipo text not null,
  grupo text,
  estado_anterior text,
  estado_nuevo text not null,
  fecha timestamptz not null default now()
);
create index if not exists idx_red_prtg_eventos_fecha on public.red_prtg_eventos(fecha desc);

-- La llama el puente con su token. Guarda la foto y registra los cambios de estado.
create or replace function public.red_reportar_prtg(p_token text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  v_anterior jsonb;
  d jsonb;
  v_estado_ant text;
  v_n int;
begin
  select token_hash into v_hash from red_puente_config where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'Token del puente inválido';
  end if;
  if coalesce(jsonb_typeof(p_datos->'dispositivos'), '') <> 'array' then
    raise exception 'Datos inválidos';
  end if;

  select datos into v_anterior from red_prtg_estado where id = 1;

  -- Cambios de estado respecto de la foto anterior (solo si había una)
  if v_anterior ? 'dispositivos' then
    for d in select * from jsonb_array_elements(p_datos->'dispositivos') loop
      select e->>'estado' into v_estado_ant
        from jsonb_array_elements(v_anterior->'dispositivos') e
       where (e->>'objid')::int = (d->>'objid')::int;
      if v_estado_ant is distinct from d->>'estado' and (v_estado_ant is not null or d->>'estado' in ('caido', 'advertencia')) then
        insert into red_prtg_eventos (objid, equipo, grupo, estado_anterior, estado_nuevo)
        values ((d->>'objid')::int, coalesce(d->>'nombre', '?'), d->>'grupo', v_estado_ant, d->>'estado');
      end if;
    end loop;
  end if;

  v_n := jsonb_array_length(p_datos->'dispositivos');
  update red_prtg_estado set
    datos = p_datos,
    prtg_url = (select prtg_url from red_puente_config where id = 1),
    equipos = v_n,
    version_puente = p_datos->>'version',
    actualizado = now()
  where id = 1;

  -- Historial acotado a 90 días
  delete from red_prtg_eventos where fecha < now() - interval '90 days';
  return jsonb_build_object('ok', true, 'equipos', v_n);
end $$;

revoke all on function public.red_reportar_prtg(text, jsonb) from public;
grant execute on function public.red_reportar_prtg(text, jsonb) to anon, authenticated;

-- Permisos: el estado y el historial los ve quien tiene la solapa Red; el puente lo configura el admin
alter table public.red_puente_config enable row level security;
alter table public.red_prtg_estado enable row level security;
alter table public.red_prtg_eventos enable row level security;

drop policy if exists red_puente_config_admin on public.red_puente_config;
create policy red_puente_config_admin on public.red_puente_config for all to authenticated
  using (mi_rol() = 'administrador' and puede_ver('red'))
  with check (mi_rol() = 'administrador' and puede_ver('red'));

drop policy if exists red_prtg_estado_select on public.red_prtg_estado;
create policy red_prtg_estado_select on public.red_prtg_estado for select to authenticated
  using (puede_ver('red'));

drop policy if exists red_prtg_eventos_select on public.red_prtg_eventos;
create policy red_prtg_eventos_select on public.red_prtg_eventos for select to authenticated
  using (puede_ver('red'));

-- Actualización en vivo de la pantalla
do $$ begin
  alter publication supabase_realtime add table public.red_prtg_estado;
exception when duplicate_object then null;
end $$;
