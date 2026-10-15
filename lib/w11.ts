// Migración a Windows 11: aptitud calculada con lo que ya reporta el agente y estados del upgrade.
import type { Disco } from "./monitoreo";

export type Aptitud = "apto" | "verificar" | "no_apto" | "win11";

export type EstadoW11 =
  | "sin_orden" | "ordenado" | "entregado" | "en_curso" | "pendiente_reinicio"
  | "pospuesto" | "bloqueado" | "error" | "migrado" | "revisar";

export type EquipoW11 = {
  id: string;
  hostname: string | null;
  usuario: string | null;
  fabricante: string | null;
  modelo: string | null;
  numero_serie: string | null;
  so_nombre: string | null;
  so_version: string | null;
  so_build: string | null;
  procesador: string | null;
  ram_total_gb: number | null;
  discos: Disco[] | null;
  tpm_version: string | null;
  secure_boot: boolean | null;
  cifrado_producto: string | null;
  ultimo_reporte: string;
  agente_version: string | null;
  inv_w11: {
    oleada: string | null; estado: Exclude<EstadoW11, "revisar">; orden_pendiente: boolean; orden_por: string | null;
    orden_fecha: string | null; detalle: string | null; compat: string | null; estado_fecha: string | null;
    build_origen: string | null; migrado_fecha: string | null;
  } | null;
};

export const VERSION_AGENTE_W11 = 2.0;

export const buildNum = (b: string | null) => parseInt(String(b ?? "").split(".")[0].replace(/\D/g, ""), 10) || 0;
export const esWin11 = (e: Pick<EquipoW11, "so_build">) => buildNum(e.so_build) >= 22000;
export const agenteSoportaW11 = (v: string | null) => (parseFloat(v ?? "0") || 0) >= VERSION_AGENTE_W11;

// Equipos que entran en la migración: Windows de escritorio (no servidores, no Linux)
export const esWindowsCliente = (e: Pick<EquipoW11, "so_nombre">) =>
  /windows/i.test(e.so_nombre ?? "") && !/server/i.test(e.so_nombre ?? "");

// Procesador: heurística sobre el nombre (la lista oficial de Microsoft es la referencia final;
// el escaneo de compatibilidad que corre el agente antes de instalar lo confirma).
function evaluarCpu(cpu: string | null): "ok" | "no" | "verificar" {
  const n = cpu ?? "";
  if (/Core\(TM\) Ultra|Core Ultra/i.test(n)) return "ok";
  let m = n.match(/Core\(TM\) i[3579]-(\d{4,5})/i) ?? n.match(/Core i[3579]-(\d{4,5})/i);
  if (m) {
    const gen = m[1].length === 5 ? parseInt(m[1].slice(0, 2), 10) : parseInt(m[1][0], 10);
    if (gen >= 8) return "ok";
    if (gen === 7) return "verificar"; // algunos modelos de 7.ª generación están soportados
    return "no";
  }
  m = n.match(/Ryzen \d+ (?:PRO )?(\d)\d{3}/i);
  if (m) return parseInt(m[1], 10) >= 2 ? "ok" : "no";
  return "verificar";
}

export function evaluar(e: EquipoW11): { aptitud: Aptitud; motivos: string[]; verificar: string[]; avisos: string[] } {
  const motivos: string[] = [];
  const verificar: string[] = [];
  const avisos: string[] = [];
  if (esWin11(e)) return { aptitud: "win11", motivos, verificar, avisos };

  if (e.tpm_version == null && e.secure_boot == null) {
    verificar.push("El agente todavía no reportó los datos de seguridad (TPM y Secure Boot)");
  } else {
    if (!e.tpm_version) motivos.push("Sin TPM detectado (puede estar deshabilitado en el BIOS)");
    else if (!e.tpm_version.startsWith("2.0")) motivos.push(`TPM ${e.tpm_version} (se requiere 2.0)`);
    if (e.secure_boot === false) motivos.push("Secure Boot desactivado o BIOS en modo Legacy (se requiere UEFI con Secure Boot)");
  }

  if (e.ram_total_gb != null && e.ram_total_gb < 3.8) motivos.push(`RAM insuficiente: ${e.ram_total_gb} GB (mínimo 4 GB)`);

  const c = (e.discos ?? []).find((d) => d.unidad?.toUpperCase() === "C:");
  if (c) {
    if (c.total_gb < 64) motivos.push(`Disco del sistema de ${c.total_gb} GB (mínimo 64 GB)`);
    else if (c.libre_gb < 25) verificar.push(`Solo ${c.libre_gb} GB libres en C: (se recomiendan 25 GB o más para el upgrade)`);
  }

  const cpu = evaluarCpu(e.procesador);
  if (cpu === "no") motivos.push(`Procesador no soportado: ${e.procesador}`);
  else if (cpu === "verificar") verificar.push(`Procesador a confirmar con la lista de Microsoft: ${e.procesador ?? "sin dato"}`);

  if (/ESET/i.test(e.cifrado_producto ?? "")) {
    avisos.push(`${e.cifrado_producto}: confirmar que la versión instalada soporta el upgrade y probarlo en la oleada piloto`);
  }
  if (!agenteSoportaW11(e.agente_version)) {
    avisos.push(`Agente ${e.agente_version ?? "?"}: para ejecutar el upgrade hace falta el agente ${VERSION_AGENTE_W11.toFixed(1)} o superior`);
  }

  const aptitud: Aptitud = motivos.length ? "no_apto" : verificar.length ? "verificar" : "apto";
  return { aptitud, motivos, verificar, avisos };
}

// Si lleva más de 24 h en curso sin pasar a Windows 11, algo falló en el equipo
export function estadoVisible(e: EquipoW11, ahora = Date.now()): EstadoW11 {
  const w = e.inv_w11;
  if (!w) return "sin_orden";
  if (["entregado", "en_curso"].includes(w.estado) && w.estado_fecha && ahora - new Date(w.estado_fecha).getTime() > 24 * 3600000) {
    return "revisar";
  }
  return w.estado;
}

export const APTITUD: Record<Aptitud, { txt: string; cls: string }> = {
  apto: { txt: "Apto", cls: "pill bg-emerald-50 text-emerald-700" },
  verificar: { txt: "A verificar", cls: "pill bg-amber-500/10 text-amber-700" },
  no_apto: { txt: "No apto", cls: "pill bg-red-50 text-red-700" },
  win11: { txt: "Windows 11", cls: "pill bg-brand-50 text-brand-700" },
};

export const ESTADO: Record<EstadoW11, { txt: string; cls: string; ayuda: string }> = {
  sin_orden: { txt: "Sin orden", cls: "pill bg-line/[0.05] text-ink/50", ayuda: "Todavía no se ordenó la actualización" },
  ordenado: { txt: "Ordenado", cls: "pill bg-violet-50 text-violet-700", ayuda: "Esperando el próximo reporte del agente" },
  entregado: { txt: "Orden recibida", cls: "pill bg-violet-50 text-violet-700", ayuda: "El agente tomó la orden y arranca la tarea de actualización" },
  en_curso: { txt: "En curso", cls: "pill bg-brand-50 text-brand-700", ayuda: "Descarga, copia o instalación en marcha" },
  pendiente_reinicio: { txt: "Falta reiniciar", cls: "pill bg-sky-50 text-sky-700", ayuda: "El upgrade quedó preparado; se completa cuando el equipo se reinicia" },
  pospuesto: { txt: "Pospuesto", cls: "pill bg-amber-500/10 text-amber-700", ayuda: "A batería, sin espacio, sin acceso a la carpeta o sin poder descargar: se reintenta solo" },
  bloqueado: { txt: "Bloqueado", cls: "pill bg-orange-500/10 text-orange-700", ayuda: "El escaneo de Microsoft encontró un impedimento" },
  error: { txt: "Error", cls: "pill bg-red-50 text-red-700", ayuda: "Ver el detalle" },
  migrado: { txt: "Migrado", cls: "pill bg-emerald-50 text-emerald-700", ayuda: "Ya reporta Windows 11" },
  revisar: { txt: "Revisar", cls: "pill bg-red-600 text-white", ayuda: "Más de 24 h en curso sin pasar a Windows 11" },
};

export const EN_PROCESO: EstadoW11[] = ["ordenado", "entregado", "en_curso", "pendiente_reinicio", "pospuesto"];
