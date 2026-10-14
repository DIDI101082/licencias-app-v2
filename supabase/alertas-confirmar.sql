-- ============================================================
-- Confirmar alertas: marcar una alerta abierta como "vista y atendida" con una nota de lo que se hizo.
-- La alerta sigue abierta (y se cierra sola cuando el problema desaparece), pero deja de contar
-- en el indicador "Alertas críticas o altas sin atender" del nivel de cumplimiento.
-- Si el problema se resuelve y vuelve a aparecer, entra como alerta nueva sin confirmar.
-- Ejecutar en Supabase (Accusys Cyber) > SQL Editor. Se puede correr más de una vez.
-- ============================================================
alter table public.alertas add column if not exists confirmada timestamptz;
alter table public.alertas add column if not exists confirmada_por uuid;
alter table public.alertas add column if not exists confirmada_por_nombre text;
alter table public.alertas add column if not exists confirmada_nota text;

create or replace function public.alertas_confirmar(p_ids bigint[], p_nota text, p_quitar boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare
  n int;
  v_nombre text;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 500), '');
begin
  if not (puede_ver('auditoria') and coalesce(mi_rol(), '') in ('administrador', 'lectura_escritura')) then
    raise exception 'Sin permiso para confirmar alertas';
  end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;

  if p_quitar then
    update alertas set confirmada = null, confirmada_por = null, confirmada_por_nombre = null, confirmada_nota = null
     where id = any(p_ids) and resuelta is null and confirmada is not null;
    get diagnostics n = row_count;
  else
    if v_nota is null or length(v_nota) < 3 then raise exception 'Escribí qué se hizo o por qué se confirma'; end if;
    select coalesce(nullif(nombre, ''), email) into v_nombre from perfiles where id = auth.uid();
    update alertas set confirmada = now(), confirmada_por = auth.uid(), confirmada_por_nombre = v_nombre, confirmada_nota = v_nota
     where id = any(p_ids) and resuelta is null;
    get diagnostics n = row_count;
  end if;

  perform alertas_registrar_cambio(
    case when p_quitar then 'Quitó la confirmación de ' else 'Confirmó ' end || n || ' alerta(s)',
    jsonb_build_object('ids', to_jsonb(p_ids), 'nota', v_nota));
  return n;
end $$;
revoke all on function public.alertas_confirmar(bigint[], text, boolean) from public, anon;
grant execute on function public.alertas_confirmar(bigint[], text, boolean) to authenticated;
