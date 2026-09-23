-- ==========================================================
-- Códigos de inventario según el tipo de equipo
--   Computadoras y servidores → el hostname (ej: NWKS045)
--   Notebooks y PCs sin hostname todavía → NWKS-00001… (provisorio,
--     cambia solo al hostname real cuando reporta el agente)
--   Periféricos               → P-00001, P-00002…
--   Todo lo demás             → IT-00001, IT-00002…
-- Se puede ejecutar más de una vez sin problema.
-- ==========================================================

create sequence if not exists public.inv_equipos_codigo_p_seq;
create sequence if not exists public.inv_equipos_codigo_nwks_seq;

-- El código lo decide el trigger (antes lo ponía un valor por defecto)
alter table public.inv_equipos alter column codigo drop default;

create or replace function public.inv_asignar_codigo()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_grupo text;
  v_categoria text;
  v_host text;
begin
  select grupo, nombre into v_grupo, v_categoria from inv_categorias where id = new.categoria_id;
  v_host := upper(nullif(trim(new.hostname), ''));

  -- Computadoras y servidores: el código es el hostname (si no lo usa otro equipo)
  if (v_grupo = 'Puesto de trabajo' or v_categoria in ('Servidor rack', 'Servidor torre'))
     and v_host is not null
     and not exists (select 1 from inv_equipos where codigo = v_host and id <> new.id) then
    new.codigo := v_host;
    return new;
  end if;

  if v_grupo = 'Puesto de trabajo' then
    -- notebook o PC sin hostname todavía: código provisorio NWKS-
    if new.codigo is null or new.codigo ~ '^(IT|P)-\d+$' then
      new.codigo := 'NWKS-' || lpad(nextval('public.inv_equipos_codigo_nwks_seq')::text, 5, '0');
    end if;
  elsif v_grupo = 'Periféricos' then
    if new.codigo is null or new.codigo !~ '^P-\d+$' then
      new.codigo := 'P-' || lpad(nextval('public.inv_equipos_codigo_p_seq')::text, 5, '0');
    end if;
  elsif new.codigo is null or new.codigo ~ '^(P|NWKS)-\d+$' then
    -- equipo nuevo sin hostname, o uno que cambió de categoría
    new.codigo := 'IT-' || lpad(nextval('public.inv_equipos_codigo_seq')::text, 5, '0');
  end if;
  return new;
end $$;

-- El nombre empieza con "a" para que corra antes que el trigger de auditoría
drop trigger if exists trg_inv_a_codigo on public.inv_equipos;
create trigger trg_inv_a_codigo
  before insert or update of hostname, categoria_id on public.inv_equipos
  for each row execute function public.inv_asignar_codigo();

-- ---------- Migración de lo que ya está cargado ----------

-- Periféricos existentes: IT-xxxxx → P-xxxxx (en orden de carga)
do $$
declare r record;
begin
  for r in
    select e.id from inv_equipos e join inv_categorias c on c.id = e.categoria_id
     where c.grupo = 'Periféricos' and e.codigo !~ '^P-\d+$'
     order by e.created_at
  loop
    update inv_equipos set codigo = 'P-' || lpad(nextval('public.inv_equipos_codigo_p_seq')::text, 5, '0')
     where id = r.id;
  end loop;
end $$;

-- Computadoras y servidores con hostname conocido: el código pasa a ser el hostname
update inv_equipos set hostname = hostname where hostname is not null;

-- Notebooks y PCs sin hostname todavía: IT-xxxxx → NWKS-xxxxx (en orden de carga)
do $$
declare r record;
begin
  for r in
    select e.id from inv_equipos e join inv_categorias c on c.id = e.categoria_id
     where c.grupo = 'Puesto de trabajo' and e.codigo ~ '^IT-\d+$'
     order by e.created_at
  loop
    update inv_equipos set codigo = 'NWKS-' || lpad(nextval('public.inv_equipos_codigo_nwks_seq')::text, 5, '0')
     where id = r.id;
  end loop;
end $$;
