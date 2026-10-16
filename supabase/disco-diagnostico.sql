-- ==========================================================
-- DIAGNÓSTICO DEL DISCO C desde Accusys Cyber (agente 2.1)
--   * Qué ocupa el disco C (carpetas de la raíz, perfiles, Descargas, OST de Outlook, caché de Teams,
--     Windows.old, actualizaciones descargadas, temporales, papelera, puntos de restauración, archivos de más de 1 GB).
--   * Salud física del disco (tipo SSD/HDD, estado, desgaste, errores, temperatura, alerta SMART).
--   * El agente analiza en una tarea aparte, solo lee (no borra nada) y manda el resultado en su próximo reporte.
--   * Cuándo analizar lo decide esta función (se puede cambiar acá sin reinstalar el agente):
--       - si un administrador lo pide desde Monitoreo ("Analizar disco"),
--       - si C tiene menos del 15 % libre y el último análisis tiene más de 12 horas,
--       - y si no, una vez por semana.
--   * La recomendación (limpiar / cambiar disco) la calcula la app con estos datos (lib/disco.ts).
-- Ejecutar UNA VEZ en el SQL Editor, DESPUÉS de instalacion-segura.sql. Se puede repetir.
-- ==========================================================

create table if not exists public.inv_disco_diag (
  dispositivo_id uuid primary key references public.inv_dispositivos(id) on delete cascade,
  hostname text,
  datos jsonb,                    -- último resultado del agente
  analizado timestamptz,          -- fecha del último resultado
  pedido boolean not null default false,
  pedido_por text,
  pedido_fecha timestamptz,
  lanzado timestamptz,            -- última vez que se le dijo al agente que analice
  en_curso boolean not null default false
);

alter table public.inv_disco_diag enable row level security;
drop policy if exists inv_disco_diag_select on public.inv_disco_diag;
create policy inv_disco_diag_select on public.inv_disco_diag for select to authenticated using (mi_rol() is not null);
-- Sin políticas de escritura: solo se modifica con las funciones de abajo

-- ---------- Pedir un análisis ya (administrador) ----------
create or replace function public.inv_disco_pedir(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare v_n int; v_email text;
begin
  if mi_rol() is distinct from 'administrador' then raise exception 'Solo un administrador'; end if;
  select email into v_email from perfiles where id = auth.uid();
  insert into inv_disco_diag as x (dispositivo_id, hostname, pedido, pedido_por, pedido_fecha)
  select id, hostname, true, v_email, now() from inv_dispositivos where id = any(p_ids) and estado_registro = 'aprobado'
  on conflict (dispositivo_id) do update set pedido = true, pedido_por = excluded.pedido_por, pedido_fecha = now(), hostname = excluded.hostname;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.inv_disco_pedir(uuid[]) from public, anon;
grant execute on function public.inv_disco_pedir(uuid[]) to authenticated;

-- ---------- Agente: manda el resultado y pregunta si tiene que analizar ----------
-- Se autentica con la clave propia del equipo (igual que seguridad, aplicaciones y Windows 11).
create or replace function public.inv_disco_agente(p_token text, p_uuid text, p_hostname text, p_secreto text, p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  r record;
  v_libre numeric; v_total numeric;
  v_analizar boolean := false;
begin
  v_id := inv_verificar_equipo(p_token, p_uuid, p_hostname, p_secreto);
  if v_id is null then return jsonb_build_object('analizar', false); end if;

  insert into inv_disco_diag (dispositivo_id, hostname) values (v_id, left(p_hostname, 200))
  on conflict (dispositivo_id) do nothing;
  select * into r from inv_disco_diag where dispositivo_id = v_id for update;

  -- Llegó un resultado (máximo 200 KB, para que un equipo no pueda llenar la base)
  if jsonb_typeof(p_datos -> 'resultado') = 'object' and length((p_datos -> 'resultado')::text) <= 200000 then
    update inv_disco_diag set datos = (p_datos -> 'resultado') - 'reportado', analizado = now(), en_curso = false,
                              pedido = false, hostname = left(p_hostname, 200)
     where dispositivo_id = v_id;
    return jsonb_build_object('analizar', false);
  end if;

  if coalesce((p_datos ->> 'en_curso')::boolean, false) then
    update inv_disco_diag set en_curso = true where dispositivo_id = v_id;
    return jsonb_build_object('analizar', false);
  end if;
  if r.en_curso then update inv_disco_diag set en_curso = false where dispositivo_id = v_id; end if;

  -- Libre en C: según el último reporte del agente
  select nullif(x ->> 'libre_gb', '')::numeric, nullif(x ->> 'total_gb', '')::numeric into v_libre, v_total
    from inv_dispositivos d, jsonb_array_elements(case when jsonb_typeof(d.discos) = 'array' then d.discos else '[]'::jsonb end) x
   where d.id = v_id and upper(x ->> 'unidad') = 'C:' limit 1;

  v_analizar := r.pedido
    or r.analizado is null
    or r.analizado < now() - interval '7 days'
    or (v_total > 0 and v_libre / v_total < 0.15 and r.analizado < now() - interval '12 hours');

  -- No relanzar mientras uno anterior puede seguir corriendo (la tarea tiene un límite de 45 minutos)
  if v_analizar and r.lanzado is not null and r.lanzado > now() - interval '1 hour'
     and (r.analizado is null or r.analizado < r.lanzado) then
    v_analizar := false;
  end if;

  if v_analizar then
    update inv_disco_diag set lanzado = now() where dispositivo_id = v_id;
  end if;
  return jsonb_build_object('analizar', v_analizar);
end $$;
revoke all on function public.inv_disco_agente(text, text, text, text, jsonb) from public;
grant execute on function public.inv_disco_agente(text, text, text, text, jsonb) to anon, authenticated;
