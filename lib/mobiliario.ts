// Tipos y utilidades para el módulo Mobiliario

export const ESTADOS_MOB: Record<string, string> = {
  en_deposito: "En depósito",
  asignado: "Asignado",
  en_reparacion: "En reparación",
  dado_de_baja: "Dado de baja",
};

export const TIPOS_MOB: string[] = [
  "Escritorio",
  "Silla ejecutiva",
  "Silla de visita",
  "Sillón",
  "Mesa de reunión",
  "Mesa auxiliar",
  "Armario",
  "Biblioteca",
  "Cajonera",
  "Pizarrón",
  "Locker",
  "Perchero",
  "Aire acondicionado",
  "Otro",
];

export type MobiliarioItem = {
  id: number;
  codigo: string;
  tipo: string;
  descripcion: string | null;
  marca: string | null;
  modelo: string | null;
  numero_serie: string | null;
  color: string | null;
  estado: string;
  piso: string | null;
  sector: string | null;
  detalle_ubicacion: string | null;
  empleado_id: string | null;
  empleado: string | null;
  responsable: string | null;
  fecha_ingreso: string | null;
  fecha_baja: string | null;
  motivo_baja: string | null;
  numero_inventario: string | null;
  notas: string | null;
  creado: string;
  actualizado: string;
};

export type MovimientoMob = {
  id: number;
  mobiliario_id: number;
  codigo: string;
  tipo_movimiento: "asignacion" | "desasignacion" | "traslado" | "baja" | "alta";
  piso_origen: string | null;
  sector_origen: string | null;
  piso_destino: string | null;
  sector_destino: string | null;
  empleado_origen_id: string | null;
  empleado_origen: string | null;
  empleado_destino_id: string | null;
  empleado_destino: string | null;
  fecha: string;
  usuario: string | null;
  notas: string | null;
};

export const LABELS_MOVIMIENTO: Record<string, string> = {
  alta: "Alta",
  asignacion: "Asignación",
  desasignacion: "Desasignación",
  traslado: "Traslado",
  baja: "Baja",
};

export const COLOR_ESTADO: Record<string, string> = {
  en_deposito: "est-en_stock",
  asignado: "est-asignado",
  en_reparacion: "est-en_reparacion",
  dado_de_baja: "est-dado_de_baja",
};

export function codigoMob(id: number) {
  return `MOB-${String(id).padStart(5, "0")}`;
}

export function exportarMobCSV(filas: MobiliarioItem[]) {
  const cols: [keyof MobiliarioItem, string][] = [
    ["codigo", "Código"],
    ["tipo", "Tipo"],
    ["descripcion", "Descripción"],
    ["marca", "Marca"],
    ["modelo", "Modelo"],
    ["numero_serie", "N° de serie"],
    ["color", "Color"],
    ["numero_inventario", "N° inventario"],
    ["estado", "Estado"],
    ["piso", "Piso"],
    ["sector", "Sector"],
    ["detalle_ubicacion", "Detalle ubicación"],
    ["empleado", "Asignado a"],
    ["responsable", "Responsable"],
    ["fecha_ingreso", "Fecha ingreso"],
    ["fecha_baja", "Fecha baja"],
    ["motivo_baja", "Motivo baja"],
    ["notas", "Notas"],
  ];
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cab = cols.map(([, t]) => t).join(";");
  const cuerpo = filas.map((f) =>
    cols.map(([k]) => {
      const v = f[k];
      if (k === "estado") return esc(ESTADOS_MOB[v as string] ?? v);
      return esc(v);
    }).join(";")
  );
  const blob = new Blob(["﻿" + [cab, ...cuerpo].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `mobiliario-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
