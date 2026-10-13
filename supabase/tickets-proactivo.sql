-- ==========================================================
-- Soporte proactivo para la ticketera (Accusys Desk)
--   Lista los problemas que el agente y ESET detectan en los equipos ASIGNADOS a cada persona,
--   para que la ticketera le avise o abra el ticket antes de que la persona llame.
--   Usa la misma clave que tickets-contexto.sql (ejecutar ese antes). Solo lectura.
-- Ejecutar UNA VEZ en el SQL Editor (se puede repetir).
-- ==========================================================

create or replace function public.tickets_problemas(p_token text, p_dias_sin_reporte int default 7, p_disco_pct int default 10)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  r jsonb := '[]'::jsonb;
  q record;
  d jsonb;
  disco jsonb;
  v_dias int := greatest(2, least(coalesce(p_dias_sin_reporte, 7), 60));
  v_pct int := greatest(1, least(coalesce(p_disco_pct, 10), 50));
  v_cifrado text;
  v_libre numeric;
  v_total numeric;
  v_eset jsonb;
begin
  select token_hash into v_hash from tickets_integracion where id = 1;
  if v_hash is null or coalesce(p_token, '') = '' or v_hash <> inv_hash(p_token) then
    raise exception 'No autorizado' using errcode = '28000';
  end if;

  -- Equipos entregados y no devueltos, con el último reporte de su agente
  for q in
    select e.id as empleado_id, lower(e.email) as email, trim(coalesce(e.nombre, '') || ' ' || coalesce(e.apellido, '')) as nombre,
           eq.id as equipo_id, to_jsonb(eq) ->> 'codigo' as codigo,
           (select to_jsonb(x) from inv_dispositivos x where x.equipo_id = eq.id order by x.ultimo_reporte desc nulls last limit 1) as disp
      from inv_asignaciones a
      join inv_equipos eq on eq.id = a.equipo_id
      join empleados e on e.id = a.empleado_id
     where a.fecha_devolucion is null and coalesce(e.activo, true) and coalesce(e.email, '') like '%@%'
  loop
    d := q.disp;
    continue when d is null;
    -- Equipos pendientes de aprobación en el registro del agente: se ignoran
    continue when coalesce(d ->> 'estado_registro', 'aprobado') <> 'aprobado';

    -- 1. Sin reportar (entre los días configurados y 60: más viejo suele ser un equipo guardado o dado de baja)
    if (d ->> 'ultimo_reporte')::timestamptz < now() - make_interval(days => v_dias)
       and (d ->> 'ultimo_reporte')::timestamptz > now() - interval '60 days' then
      r := r || jsonb_build_array(jsonb_build_object('tipo', 'sin_reporte', 'clave', 'sin_reporte:' || q.equipo_id,
        'detalle', 'El equipo no se conecta desde el ' || to_char((d ->> 'ultimo_reporte')::timestamptz at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'),
        'email', q.email, 'nombre', q.nombre, 'equipo', coalesce(q.codigo, d ->> 'hostname'), 'hostname', d ->> 'hostname', 'equipo_id', q.equipo_id));
      continue;   -- con el equipo sin reportar, el resto de los datos está desactualizado
    end if;

    -- 2. Disco casi lleno
    for disco in select * from jsonb_array_elements(case when jsonb_typeof(d -> 'discos') = 'array' then d -> 'discos' else '[]'::jsonb end) loop
      v_total := nullif(disco ->> 'total_gb', '')::numeric;
      v_libre := nullif(disco ->> 'libre_gb', '')::numeric;
      if v_total >= 20 and v_libre is not null and v_libre * 100 < v_total * v_pct then
        r := r || jsonb_build_array(jsonb_build_object('tipo', 'disco', 'clave', 'disco:' || q.equipo_id || ':' || coalesce(disco ->> 'unidad', ''),
          'detalle', 'La unidad ' || coalesce(disco ->> 'unidad', '') || ' tiene ' || round(v_libre, 1) || ' GB libres de ' || round(v_total) || ' GB',
          'email', q.email, 'nombre', q.nombre, 'equipo', coalesce(q.codigo, d ->> 'hostname'), 'hostname', d ->> 'hostname', 'equipo_id', q.equipo_id));
      end if;
    end loop;

    -- 3. Antivirus apagado
    if (d ->> 'antivirus_activo')::boolean is false then
      r := r || jsonb_build_array(jsonb_build_object('tipo', 'antivirus', 'clave', 'antivirus:' || q.equipo_id,
        'detalle', 'El antivirus del equipo figura apagado',
        'email', q.email, 'nombre', q.nombre, 'equipo', coalesce(q.codigo, d ->> 'hostname'), 'hostname', d ->> 'hostname', 'equipo_id', q.equipo_id));
    end if;

    -- 4. Reinicio pendiente (para instalar actualizaciones) con el equipo prendido hace más de 7 días
    if (d ->> 'reinicio_pendiente')::boolean is true
       and coalesce((d ->> 'arranque')::timestamptz, now() - interval '30 days') < now() - interval '7 days' then
      r := r || jsonb_build_array(jsonb_build_object('tipo', 'reinicio', 'clave', 'reinicio:' || q.equipo_id,
        'detalle', 'Hay actualizaciones esperando un reinicio' || coalesce(' (encendido desde el ' || to_char((d ->> 'arranque')::timestamptz at time zone 'America/Argentina/Buenos_Aires', 'DD/MM') || ')', ''),
        'email', q.email, 'nombre', q.nombre, 'equipo', coalesce(q.codigo, d ->> 'hostname'), 'hostname', d ->> 'hostname', 'equipo_id', q.equipo_id));
    end if;

    -- 5. Disco sin cifrar o con el cifrado suspendido (solo notebooks, si el tipo está cargado)
    v_cifrado := lower(coalesce(d ->> 'cifrado_estado', d ->> 'bitlocker_estado', ''));
    if v_cifrado in ('sin_cifrar', 'suspendido', 'error') and coalesce(d ->> 'tipo', 'notebook') = 'notebook' then
      r := r || jsonb_build_array(jsonb_build_object('tipo', 'cifrado', 'clave', 'cifrado:' || q.equipo_id,
        'detalle', 'El disco del equipo figura ' || replace(v_cifrado, '_', ' '),
        'email', q.email, 'nombre', q.nombre, 'equipo', coalesce(q.codigo, d ->> 'hostname'), 'hostname', d ->> 'hostname', 'equipo_id', q.equipo_id));
    end if;

    -- 6. Detecciones graves de ESET sin resolver en la última semana
    v_eset := null;
    begin
      select jsonb_build_object('n', count(*), 'ultima', max(s.nombre)) into v_eset
        from eset_detecciones s
       where s.dispositivo_id = (d ->> 'id')::uuid and not s.resuelta and s.fecha > now() - interval '7 days'
         and upper(coalesce(s.severidad, '')) in ('HIGH', 'CRITICAL');
    exception when others then v_eset := null;
    end;
    if coalesce((v_eset ->> 'n')::int, 0) > 0 then
      r := r || jsonb_build_array(jsonb_build_object('tipo', 'eset', 'clave', 'eset:' || q.equipo_id,
        'detalle', 'ESET detectó ' || (v_eset ->> 'n') || ' amenaza(s) grave(s) sin resolver' || coalesce(': ' || (v_eset ->> 'ultima'), ''),
        'email', q.email, 'nombre', q.nombre, 'equipo', coalesce(q.codigo, d ->> 'hostname'), 'hostname', d ->> 'hostname', 'equipo_id', q.equipo_id));
    end if;
  end loop;

  insert into tickets_contexto_consultas (email, ticket, encontrado) values ('(soporte proactivo)', jsonb_array_length(r) || ' problemas', true);
  return r;
end $$;
revoke all on function public.tickets_problemas(text, int, int) from public;
grant execute on function public.tickets_problemas(text, int, int) to anon, authenticated;
