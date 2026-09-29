// Tipos y utilidades compartidas por Servidores → Virtualización y Storage
export type Hallazgo = { ambito: string; clave: string; tipo: string; severidad: string; titulo: string; detalle: string };
export type Proyeccion = { tipo: string; nombre: string; capacidad_gb: number | null; libre_gb: number | null; crecimiento_gb_dia: number | null; dias_para_llenarse: number | null };

export const SEV: Record<string, { t: string; c: string; o: number }> = {
  critica: { t: "Crítica", c: "bg-red-600 text-white", o: 0 },
  alta: { t: "Alta", c: "bg-orange-500/15 text-orange-700", o: 1 },
  media: { t: "Media", c: "bg-amber-500/15 text-amber-700", o: 2 },
  baja: { t: "Baja", c: "bg-line/[0.05] text-ink/60", o: 3 },
};

export function tamano(gb: number | null | undefined) {
  if (gb == null) return "—";
  if (gb >= 1024) return `${(gb / 1024).toFixed(gb >= 10240 ? 0 : 1).replace(".", ",")} TB`;
  return `${Math.round(gb)} GB`;
}

export const pctUsado = (capacidad: number | null, libre: number | null) =>
  capacidad && capacidad > 0 && libre != null ? Math.round(100 - (100 * libre) / capacidad) : null;

export const colorUso = (p: number | null, limite: number) =>
  p == null ? "bg-line/20" : p >= Math.max(limite, 95) ? "bg-red-500" : p >= limite ? "bg-amber-500" : "bg-emerald-500";

export const fechaCorta = (f: string | null) => (f ? new Date(f).toLocaleDateString("es-AR") : "—");
export const diasDesde = (f: string | null, ahora = Date.now()) => (f ? Math.floor((ahora - Date.parse(f)) / 86400000) : null);
