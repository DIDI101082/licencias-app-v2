// Etiquetas y colores de incidentes (compartidas por la lista y el detalle)
export const SEVERIDAD: Record<string, { t: string; c: string }> = {
  critica: { t: "Crítica", c: "bg-red-600 text-white" },
  alta: { t: "Alta", c: "bg-orange-500/15 text-orange-700" },
  media: { t: "Media", c: "bg-amber-500/15 text-amber-700" },
  baja: { t: "Baja", c: "bg-line/[0.05] text-ink/60" },
};
export const ESTADO: Record<string, { t: string; c: string }> = {
  abierto: { t: "Abierto", c: "bg-red-50 text-red-600" },
  contenido: { t: "Contenido", c: "bg-amber-50 text-amber-700" },
  cerrado: { t: "Cerrado", c: "bg-emerald-50 text-emerald-700" },
};
