// ---------- Ciclo de vida de Windows ----------
// Fechas oficiales de Microsoft (learn.microsoft.com/lifecycle). Actualizá esta tabla
// cuando salgan versiones nuevas.
const WIN11_HOME_PRO: Record<string, string> = {
  "21H2": "2023-10-10", "22H2": "2024-10-08", "23H2": "2025-11-11",
  "24H2": "2026-10-13", "25H2": "2027-10-12", "26H1": "2028-03-14",
};
const WIN11_ENTERPRISE: Record<string, string> = {
  "21H2": "2024-10-08", "22H2": "2025-10-14", "23H2": "2026-11-10",
  "24H2": "2027-10-12", "25H2": "2028-10-10",
};
const BUILD_A_VERSION: Record<string, string> = {
  "22000": "21H2", "22621": "22H2", "22631": "23H2", "26100": "24H2", "26200": "25H2", "28000": "26H1",
};
const OTROS: [RegExp, string, string][] = [
  // [patrón sobre el nombre del sistema, fin de soporte, nombre corto]
  [/server 2012/i, "2023-10-10", "Windows Server 2012"],
  [/server 2016/i, "2027-01-12", "Windows Server 2016"],
  [/server 2019/i, "2029-01-09", "Windows Server 2019"],
  [/server 2022/i, "2031-10-14", "Windows Server 2022"],
  [/server 2025/i, "2034-10-10", "Windows Server 2025"],
  [/windows 11 .*ltsc/i, "2029-10-09", "Windows 11 LTSC 2024"],
  [/windows 10 .*ltsc 2021/i, "2027-01-12", "Windows 10 LTSC 2021"],
  [/windows 10 .*ltsc 2019|windows 10 .*ltsc$/i, "2029-01-09", "Windows 10 LTSC 2019"],
  [/windows 10 .*ltsb 2016|windows 10 .*ltsb$/i, "2026-10-13", "Windows 10 LTSB 2016"],
  [/windows 10/i, "2025-10-14", "Windows 10"],
  [/windows (7|8)/i, "2023-01-10", "Windows 7/8"],
];

export const DIAS_AVISO_SOPORTE = 90;

export type Soporte = { nivel: "ok" | "aviso" | "problema" | "sin_datos"; texto: string; fin: string | null; accion: string };

export function soporteWindows(nombre: string | null, version: string | null, build: string | null): Soporte {
  if (!nombre) return { nivel: "sin_datos", texto: "Sin datos", fin: null, accion: "" };
  let fin: string | null = null;
  let accion = "";

  if (/windows 11/i.test(nombre) && !/ltsc/i.test(nombre)) {
    const v = (version || BUILD_A_VERSION[String(build ?? "")] || "").toUpperCase();
    const enterprise = /enterprise|education/i.test(nombre) && !/pro education/i.test(nombre);
    fin = (enterprise ? WIN11_ENTERPRISE : WIN11_HOME_PRO)[v] ?? null;
    accion = "Actualizar a Windows 11 25H2 desde Windows Update";
    if (!fin) return { nivel: "sin_datos", texto: `Versión ${v || "desconocida"}`, fin: null, accion: "" };
  } else {
    const regla = OTROS.find(([re]) => re.test(nombre));
    if (!regla && /ubuntu|debian|red hat|rhel|rocky|alma|centos|suse|fedora|linux/i.test(nombre)) {
      return { nivel: "sin_datos", texto: "Linux: revisar a mano", fin: null, accion: "Verificar el fin de soporte de la versión en el sitio de la distribución" };
    }
    if (!regla) return { nivel: "sin_datos", texto: "Sistema no reconocido", fin: null, accion: "" };
    fin = regla[1];
    accion = /server/i.test(nombre) ? "Planificar migración a una versión de Server soportada"
      : /windows 10/i.test(nombre) ? "Actualizar a Windows 11 o reemplazar el equipo si no es compatible (salvo que tenga ESU contratado)"
      : "Reemplazar o actualizar el sistema";
  }

  const dias = Math.ceil((new Date(fin + "T12:00:00").getTime() - Date.now()) / 86400000);
  if (dias < 0) return { nivel: "problema", texto: "Sin soporte", fin, accion };
  if (dias <= DIAS_AVISO_SOPORTE) return { nivel: "aviso", texto: `Vence en ${dias} días`, fin, accion };
  return { nivel: "ok", texto: "Con soporte", fin, accion: "" };
}

// ---------- Amenazas de Defender ----------
export const SEVERIDAD: Record<number, { texto: string; clase: string }> = {
  5: { texto: "Grave", clase: "bg-red-600 text-white" },
  4: { texto: "Alta", clase: "bg-red-50 text-red-700" },
  2: { texto: "Moderada", clase: "bg-amber-500/10 text-amber-700" },
  1: { texto: "Baja", clase: "bg-black/[0.05] text-ink/70" },
  0: { texto: "Desconocida", clase: "bg-black/[0.05] text-ink/60" },
};

const ESTADOS_AMENAZA: Record<number, string> = {
  0: "Estado desconocido", 1: "Detectada, sin acción", 2: "Limpiada", 3: "En cuarentena", 4: "Eliminada",
  5: "Permitida por un usuario", 6: "Bloqueada", 102: "Falló la cuarentena", 103: "Falló la eliminación",
  104: "Falló al permitir", 105: "Abandonada", 107: "Falló el bloqueo",
};
const RESUELTAS = [2, 3, 4, 6];
const PERMITIDAS = [5, 104];

export function estadoAmenaza(id: number | null) {
  const n = id ?? 0;
  const texto = ESTADOS_AMENAZA[n] ?? `Estado ${n}`;
  if (RESUELTAS.includes(n)) return { tipo: "resuelta" as const, texto, clase: "bg-emerald-50 text-emerald-700" };
  if (PERMITIDAS.includes(n)) return { tipo: "permitida" as const, texto, clase: "bg-amber-500/10 text-amber-700" };
  return { tipo: "pendiente" as const, texto, clase: "bg-red-50 text-red-600" };
}

export function archivoAmenaza(recursos: string[] | null) {
  const r = (recursos ?? [])[0];
  if (!r) return "";
  return r.replace(/^[a-z]+:_/i, "");
}

// ---------- Software prohibido: lista sugerida para empezar ----------
export const SUGERIDOS: [string, string][] = [
  ["AnyDesk", "Acceso remoto no autorizado"],
  ["TeamViewer", "Acceso remoto no autorizado (quitalo de la lista si es la herramienta corporativa)"],
  ["RustDesk", "Acceso remoto no autorizado"],
  ["UltraViewer", "Acceso remoto no autorizado"],
  ["Ammyy", "Acceso remoto usado frecuentemente en estafas"],
  ["Radmin", "Acceso remoto no autorizado"],
  ["Supremo", "Acceso remoto no autorizado"],
  ["torrent", "Descargas P2P: riesgo de malware y de problemas legales"],
  ["Tor Browser", "Navegación anónima que evade los controles de la red"],
  ["Hotspot Shield", "VPN gratuita que evade los controles de la red"],
  ["Psiphon", "Evasión de controles de la red"],
  ["Urban VPN", "VPN gratuita que evade los controles de la red"],
  ["KMSpico", "Activador pirata de Windows/Office, suele traer malware"],
  ["KMSAuto", "Activador pirata de Windows/Office, suele traer malware"],
];
