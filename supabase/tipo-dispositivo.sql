-- ==========================================================
-- Tipo de equipo en Monitoreo: notebook, PC de escritorio, servidor u otro
--   * Si "tipo" queda vacío, la app lo deduce sola:
--       sistema operativo de servidor o Linux → servidor; con batería → notebook; si no → PC de escritorio.
--   * Un administrador puede fijarlo a mano desde el detalle del equipo en Monitoreo
--     (por ejemplo, una notebook sin batería, una PC usada como servidor o un equipo de sala).
--   * El agente nunca modifica este dato. Los cambios quedan en Logs.
-- Ejecutar UNA VEZ en el SQL Editor.
-- ==========================================================

alter table public.inv_dispositivos
  add column if not exists tipo text check (tipo in ('notebook', 'pc', 'servidor', 'otro'));

comment on column public.inv_dispositivos.tipo is
  'Tipo fijado a mano (notebook, pc, servidor, otro). Vacío = la app lo deduce del sistema operativo y la batería.';
