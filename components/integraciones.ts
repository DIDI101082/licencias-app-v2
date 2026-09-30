// Estado de las integraciones (lo devuelve integraciones_estado() en la base). Acá y no en lib/ para que Tailwind genere los colores.
export type Integracion = {
  clave: string; nombre: string; area: string; ultimo: string | null; version: string | null;
  detalle: string | null; error: string | null; enlace: string; estado: "ok" | "aviso" | "mal" | "sin_configurar";
};

export const ESTADO_INT: Record<Integracion["estado"], { t: string; pill: string; punto: string; orden: number }> = {
  mal: { t: "No reporta", pill: "bg-red-600 text-white", punto: "bg-red-500", orden: 0 },
  aviso: { t: "Con demora o avisos", pill: "bg-amber-500/15 text-amber-700", punto: "bg-amber-500", orden: 1 },
  ok: { t: "Reporta bien", pill: "bg-emerald-50 text-emerald-700", punto: "bg-emerald-500", orden: 2 },
  sin_configurar: { t: "Sin configurar", pill: "bg-line/[0.05] text-ink/50", punto: "bg-line/30", orden: 3 },
};
