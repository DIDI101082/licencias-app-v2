-- ==========================================================
-- Auto-update del agente: el agente consulta al inicio de cada
-- ciclo si hay una versión nueva y se actualiza solo.
-- Ejecutar en Supabase > SQL Editor. Se puede correr más de una vez.
-- ==========================================================

alter table public.inv_agente_config
  add column if not exists script_version  text,      -- versión del script publicada (ej. "2.7")
  add column if not exists script_hash     text,       -- SHA-256 del script (para que el agente detecte cambios)
  add column if not exists script_contenido text;      -- contenido completo del agente.ps1

-- Función que la app llama para publicar una nueva versión del agente
create or replace function public.inv_agente_publicar(
  p_version text, p_hash text, p_contenido text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(mi_rol(), '') <> 'administrador' then
    raise exception 'Solo administradores pueden publicar el agente';
  end if;
  update inv_agente_config set
    script_version   = p_version,
    script_hash      = upper(p_hash),
    script_contenido = p_contenido
  where id = 1;
end $$;
revoke all on function public.inv_agente_publicar(text, text, text) from public, anon;
grant execute on function public.inv_agente_publicar(text, text, text) to authenticated;

-- Función que el agente llama para saber si hay update (devuelve hash y contenido solo si difiere)
create or replace function public.inv_agente_check_update(
  p_token text, p_hash_actual text
) returns table (hay_update boolean, script_version text, script_hash text, script_contenido text)
language plpgsql security definer set search_path = public as $$
declare
  v_cfg record;
begin
  if not exists (select 1 from inv_agente_config where token = p_token) then
    raise exception 'Token de agente inválido';
  end if;
  select c.script_version, c.script_hash, c.script_contenido
    into v_cfg from inv_agente_config c where c.id = 1;

  -- Si no hay script publicado, no hay update
  if v_cfg.script_hash is null or v_cfg.script_contenido is null then
    return query select false, null::text, null::text, null::text;
    return;
  end if;

  -- Si el hash coincide, no hay update
  if upper(p_hash_actual) = upper(v_cfg.script_hash) then
    return query select false, v_cfg.script_version, v_cfg.script_hash, null::text;
    return;
  end if;

  -- Hay update: devuelve el script nuevo
  return query select true, v_cfg.script_version, v_cfg.script_hash, v_cfg.script_contenido;
end $$;
revoke all on function public.inv_agente_check_update(text, text) from public;
grant execute on function public.inv_agente_check_update(text, text) to anon, authenticated;
