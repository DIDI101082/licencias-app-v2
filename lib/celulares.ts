// Tipos y utilidades para el módulo Celulares corporativos

export const ESTADOS_CEL: Record<string, string> = {
  en_deposito:   "En depósito",
  asignado:      "Asignado",
  en_reparacion: "En reparación",
  dado_de_baja:  "Dado de baja",
};

export const COLOR_ESTADO_CEL: Record<string, string> = {
  en_deposito:   "est-en_stock",
  asignado:      "est-asignado",
  en_reparacion: "est-en_reparacion",
  dado_de_baja:  "est-dado_de_baja",
};

export const LABELS_MOV_CEL: Record<string, string> = {
  alta:          "Alta",
  asignacion:    "Asignación",
  desasignacion: "Desasignación",
  traslado:      "Traslado",
  baja:          "Baja",
};

export type CelularItem = {
  id: number;
  codigo: string;
  marca: string;
  modelo: string;
  imei: string | null;
  imei2: string | null;
  numero_linea: string | null;
  operadora: string | null;
  numero_sim: string | null;
  plan: string | null;
  color: string | null;
  almacenamiento: string | null;
  numero_inventario: string | null;
  estado: string;
  piso: string | null;
  sector: string | null;
  empleado_id: string | null;
  empleado: string | null;
  responsable: string | null;
  fecha_ingreso: string | null;
  fecha_baja: string | null;
  motivo_baja: string | null;
  notas: string | null;
  creado: string;
  actualizado: string;
};

export type MovimientoCel = {
  id: number;
  celular_id: number;
  codigo: string;
  tipo_movimiento: "alta" | "asignacion" | "desasignacion" | "traslado" | "baja";
  empleado_origen_id: string | null;
  empleado_origen: string | null;
  empleado_destino_id: string | null;
  empleado_destino: string | null;
  fecha: string;
  usuario: string | null;
  notas: string | null;
};

export function codigoCel(id: number) {
  return `CEL-${String(id).padStart(5, "0")}`;
}

export function exportarCelCSV(filas: CelularItem[]) {
  const cols: [keyof CelularItem, string][] = [
    ["codigo",           "Código"],
    ["marca",            "Marca"],
    ["modelo",           "Modelo"],
    ["imei",             "IMEI"],
    ["imei2",            "IMEI 2"],
    ["numero_linea",     "N° de línea"],
    ["operadora",        "Operadora"],
    ["numero_sim",       "N° SIM"],
    ["plan",             "Plan"],
    ["color",            "Color"],
    ["almacenamiento",   "Almacenamiento"],
    ["numero_inventario","N° inventario"],
    ["estado",           "Estado"],
    ["piso",             "Piso"],
    ["sector",           "Sector"],
    ["empleado",         "Asignado a"],
    ["responsable",      "Responsable"],
    ["fecha_ingreso",    "Fecha ingreso"],
    ["fecha_baja",       "Fecha baja"],
    ["motivo_baja",      "Motivo baja"],
    ["notas",            "Notas"],
  ];
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cab = cols.map(([, t]) => t).join(";");
  const cuerpo = filas.map((f) =>
    cols.map(([k]) => {
      const v = f[k];
      if (k === "estado") return esc(ESTADOS_CEL[v as string] ?? v);
      return esc(v);
    }).join(";")
  );
  const blob = new Blob(["﻿" + [cab, ...cuerpo].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `celulares-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
