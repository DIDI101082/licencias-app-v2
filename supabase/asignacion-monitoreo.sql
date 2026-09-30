-- ==========================================================
-- Monitoreo → "Equipos para asignar"
--   * La lista muestra las notebooks y PCs aprobadas que no tienen a nadie
--     asignado en el inventario (sin cargar, o cargadas pero "En stock").
--   * Esta columna permite sacar de la lista los equipos que no se entregan
--     a una persona (sala de reuniones, recepción, pruebas), con el botón
--     "No se asigna". Para volver a mostrarlo, ponerla en false.
--   * La asignación en sí usa la función existente inv_asignar_equipo,
--     así que queda en el historial de asignaciones del equipo.
-- Ejecutar UNA VEZ en el SQL Editor.
-- ==========================================================

alter table public.inv_dispositivos
  add column if not exists asignacion_omitida boolean not null default false;

comment on column public.inv_dispositivos.asignacion_omitida is
  'true = el equipo no se entrega a una persona y no aparece en "Equipos para asignar" de Monitoreo.';
