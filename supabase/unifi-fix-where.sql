-- ==========================================================
-- Corrección: el puente UniFi recibía "UPDATE requires a WHERE clause".
-- Supabase bloquea (extensión safeupdate) todo UPDATE sin WHERE que llega por la API,
-- aunque esté dentro de una función. Se agrega el WHERE a unifi_reportar sin tocar nada más.
-- Ejecutar UNA VEZ en el SQL Editor. Se puede repetir sin problema.
-- ==========================================================
do $$
declare v text;
begin
  v := pg_get_functiondef('public.unifi_reportar(text, jsonb)'::regprocedure);
  if position('where v.bssid is not null' in v) > 0 then
    raise notice 'Ya estaba corregido';
    return;
  end if;
  if position('or q.mac = v.bssid));' in v) = 0 then
    raise exception 'No se encontró el texto a corregir: pasale este mensaje a quien mantiene la app';
  end if;
  v := replace(v, 'or q.mac = v.bssid));', 'or q.mac = v.bssid))' || chr(10) || '   where v.bssid is not null;');
  execute v;
  raise notice 'unifi_reportar corregida';
end $$;
