export const ESTADOS: Record<string, string> = {
  en_stock: "En stock",
  asignado: "Asignado",
  prestado: "Prestado",
  en_reparacion: "En reparación",
  dado_de_baja: "Dado de baja",
  perdido: "Perdido / robado",
};

export const CONDICIONES: Record<string, string> = {
  nuevo: "Nuevo",
  bueno: "Bueno",
  regular: "Regular",
  malo: "Malo",
};

export function dinero(v: number | null | undefined, moneda = "ARS") {
  if (v == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: moneda, maximumFractionDigits: 0 }).format(v);
}

export function fecha(v: string | null | undefined) {
  if (!v) return "—";
  return new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleDateString("es-AR");
}

export function diasHasta(v: string | null | undefined) {
  if (!v) return null;
  return Math.ceil((new Date(v + "T12:00:00").getTime() - Date.now()) / 86400000);
}
