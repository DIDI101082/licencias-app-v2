// Colores de los niveles de los indicadores (acá y no en lib/ para que Tailwind genere las clases)
import type { Nivel } from "@/lib/indicadores";

export const COLOR: Record<Nivel, { borde: string; texto: string; punto: string; etiqueta: string }> = {
  ok: { borde: "border-l-emerald-500", texto: "text-emerald-700", punto: "bg-emerald-500", etiqueta: "Cumple" },
  aviso: { borde: "border-l-amber-400", texto: "text-amber-700", punto: "bg-amber-400", etiqueta: "Cerca" },
  mal: { borde: "border-l-red-500", texto: "text-red-600", punto: "bg-red-500", etiqueta: "No cumple" },
  nd: { borde: "border-l-line/20", texto: "text-ink/40", punto: "bg-line/30", etiqueta: "Sin datos" },
};
