-- ==========================================================
-- Instalación del agente desde ESET PROTECT (o cualquier herramienta que ejecute un comando)
--   * La app entrega el instalador en /api/agente/instalar?codigo=... SOLO si el código de instalación
--     es válido (no vencido, no revocado, con usos disponibles). No consume usos: el uso se cuenta
--     cuando el equipo se registra, igual que con el instalador descargado.
--   * No acepta el token general, solo códigos de instalación.
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de instalacion-segura.sql. Se puede repetir.
-- ==========================================================
create or replace function public.inv_instalador_intervalo(p_codigo text)
returns int language plpgsql stable security definer set search_path = public as $$
declare v_id int;
begin
  if coalesce(p_codigo, '') !~ '^[0-9a-f]{40}$' then return null; end if;
  select id into v_id from inv_codigos_instalacion
   where codigo_hash = inv_hash(p_codigo) and not revocado and vence > now() and usos < usos_max;
  if v_id is null then return null; end if;
  return (select intervalo_min from inv_agente_config where id = 1);
end $$;
revoke all on function public.inv_instalador_intervalo(text) from public;
grant execute on function public.inv_instalador_intervalo(text) to anon, authenticated;
