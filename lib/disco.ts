// Diagnóstico del disco C (agente 2.1): qué ocupa el espacio, salud física y recomendación.
// Las reglas viven acá (no en el agente) para poder ajustarlas sin reinstalar nada.

export type ItemRuta = { ruta: string; gb: number };
export type DiscoDatos = {
  estado: "ok" | "error";
  detalle?: string;
  fecha?: string;
  duracion_seg?: number;
  volumen?: { total_gb: number; libre_gb: number };
  fisico?: {
    modelo?: string; tipo?: string; bus?: string; tamano_gb?: number; salud?: string; estado?: string;
    desgaste_pct?: number | null; temperatura?: number | null; horas_uso?: number | null;
    errores_lectura?: number | null; errores_escritura?: number | null; smart_falla?: boolean; error?: string;
  };
  sistema?: Record<string, number>;
  raiz?: ItemRuta[];
  rutas?: ItemRuta[];
  grandes?: (ItemRuta & { fecha?: string })[];
  archivos?: number;
  sin_acceso?: number;
};

export type DiscoDiag = {
  dispositivo_id: string;
  hostname: string | null;
  datos: DiscoDatos | null;
  analizado: string | null;
  pedido: boolean;
  pedido_por: string | null;
  pedido_fecha: string | null;
  lanzado: string | null;
  en_curso: boolean;
};

export type Clase = "limpiable" | "usuario" | "sistema";
export type Ocupante = { nombre: string; ruta: string; gb: number; clase: Clase; accion: string };

// Qué es cada ruta conocida y qué se puede hacer. Se compara contra el final de la ruta (en minúsculas).
const CONOCIDAS: { patron: RegExp; nombre: string; clase: Clase; accion: string }[] = [
  { patron: /^c:\\windows\.old$/, nombre: "Windows anterior (Windows.old)", clase: "limpiable", accion: "Liberador de espacio en disco → Limpiar archivos del sistema → Instalaciones anteriores de Windows" },
  { patron: /^c:\\windows\\softwaredistribution\\download$/, nombre: "Actualizaciones descargadas", clase: "limpiable", accion: "Liberador de espacio → Limpieza de Windows Update (o detener wuauserv y vaciar la carpeta)" },
  { patron: /^c:\\windows\\temp$/, nombre: "Temporales de Windows", clase: "limpiable", accion: "Borrar el contenido" },
  { patron: /^c:\\\$windows\.~bt$/, nombre: "Restos de una actualización de Windows", clase: "limpiable", accion: "Liberador de espacio → Archivos temporales de instalación" },
  { patron: /^c:\\w11setup$/, nombre: "Instalador de Windows 11 copiado por Cyber", clase: "limpiable", accion: "Borrar si el equipo ya migró o no tiene la migración en curso" },
  { patron: /^c:\\\$recycle\.bin$/, nombre: "Papelera de reciclaje", clase: "limpiable", accion: "Vaciar la papelera (consultar al usuario si hay algo para recuperar)" },
  { patron: /^c:\\windows\\(minidump|livekernelreports)$/, nombre: "Volcados de errores de Windows", clase: "limpiable", accion: "Borrar (si no se está investigando un error)" },
  { patron: /^c:\\programdata\\microsoft\\windows\\wer$/, nombre: "Informes de errores", clase: "limpiable", accion: "Liberador de espacio → Informes de errores de Windows" },
  { patron: /\\appdata\\local\\temp$/, nombre: "Temporales del usuario", clase: "limpiable", accion: "Borrar el contenido con la sesión cerrada" },
  { patron: /\\appdata\\local\\crashdumps$/, nombre: "Volcados de aplicaciones", clase: "limpiable", accion: "Borrar" },
  { patron: /\\appdata\\(roaming|local)\\microsoft\\teams$/, nombre: "Caché de Teams clásico", clase: "limpiable", accion: "Cerrar Teams y borrar la caché (o desinstalar Teams clásico si ya usa el nuevo)" },
  { patron: /\\appdata\\local\\packages\\msteams_8wekyb3d8bbwe$/, nombre: "Datos de Teams (nuevo)", clase: "limpiable", accion: "Configuración de Windows → Apps → Teams → Opciones avanzadas → Restablecer" },
  { patron: /\\appdata\\local\\microsoft\\outlook$/, nombre: "Buzón local de Outlook (OST)", clase: "usuario", accion: "Reducir la sincronización sin conexión (p. ej. 6 o 12 meses) y regenerar el OST" },
  { patron: /\\onedrive[^\\]*$/, nombre: "OneDrive (copia local)", clase: "usuario", accion: "Clic derecho en la carpeta → Liberar espacio (Archivos a petición)" },
  { patron: /\\downloads$/, nombre: "Descargas", clase: "usuario", accion: "Revisar con el usuario: instaladores, ISOs y archivos viejos" },
  { patron: /\\desktop$/, nombre: "Escritorio", clase: "usuario", accion: "Mover a OneDrive o a un recurso de red" },
  { patron: /\\documents$/, nombre: "Documentos", clase: "usuario", accion: "Mover a OneDrive o a un recurso de red" },
  { patron: /\\(pictures|videos)$/, nombre: "Imágenes y videos", clase: "usuario", accion: "Mover a OneDrive o a un recurso de red" },
  { patron: /\\appdata\\local\\(google\\chrome|microsoft\\edge)\\user data$/, nombre: "Datos del navegador", clase: "usuario", accion: "Borrar caché del navegador / perfiles que no use" },
  { patron: /^c:\\windows\\installer$/, nombre: "Instaladores de Windows (Installer)", clase: "sistema", accion: "No borrar a mano: se rompen reparaciones y desinstalaciones" },
  { patron: /^c:\\windows\\winsxs$/, nombre: "Almacén de componentes (WinSxS)", clase: "sistema", accion: "Tamaño aparente. Reducir con: DISM /Online /Cleanup-Image /StartComponentCleanup" },
];

// Cuánto de lo "limpiable" se puede recuperar de verdad (los temporales en uso, por ejemplo, no se borran todos)
const RECUPERA = 0.9;

function perfil(ruta: string) {
  const m = /^c:\\users\\([^\\]+)/i.exec(ruta);
  return m ? m[1] : null;
}

export function ocupantes(d: DiscoDatos): Ocupante[] {
  const lista: Ocupante[] = [];
  for (const r of d.rutas ?? []) {
    const k = CONOCIDAS.find((c) => c.patron.test(r.ruta.toLowerCase()));
    if (!k || r.gb < 0.2) continue;
    const u = perfil(r.ruta);
    lista.push({ nombre: u ? `${k.nombre} · ${u}` : k.nombre, ruta: r.ruta, gb: r.gb, clase: k.clase, accion: k.accion });
  }
  const s = d.sistema ?? {};
  if (s["hiberfil.sys"] >= 1) lista.push({ nombre: "Archivo de hibernación", ruta: "C:\\hiberfil.sys", gb: s["hiberfil.sys"], clase: "sistema", accion: "En PCs de escritorio se puede desactivar: powercfg /h off (en notebooks, mejor dejarlo)" });
  if (s["pagefile.sys"] >= 1) lista.push({ nombre: "Archivo de paginación", ruta: "C:\\pagefile.sys", gb: s["pagefile.sys"], clase: "sistema", accion: "Lo administra Windows: no tocar salvo que sea desproporcionado" });
  if (s["MEMORY.DMP"] >= 0.2) lista.push({ nombre: "Volcado de memoria (MEMORY.DMP)", ruta: "C:\\Windows\\MEMORY.DMP", gb: s["MEMORY.DMP"], clase: "limpiable", accion: "Borrar (si no se está investigando una pantalla azul)" });
  if (s.puntos_restauracion >= 1) lista.push({ nombre: "Puntos de restauración", ruta: "Instantáneas de volumen", gb: s.puntos_restauracion, clase: "sistema", accion: "Reducir el espacio reservado: vssadmin resize shadowstorage /for=C: /on=C: /maxsize=5%" });
  return lista.sort((a, b) => b.gb - a.gb);
}

export type Nivel = "urgente" | "cambiar" | "ampliar" | "limpiar" | "ok";
export type Veredicto = {
  nivel: Nivel;
  titulo: string;
  motivos: string[];
  usoPct: number | null;
  libreGb: number | null;
  recuperableGb: number;      // limpieza segura, sin tocar datos del usuario
  conUsuarioGb: number;       // lo que se libera además revisando con el usuario
  objetivoGb: number;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

export function diagnosticar(d: DiscoDatos): Veredicto {
  const total = d.volumen?.total_gb ?? 0;
  const libre = d.volumen?.libre_gb ?? 0;
  const ocup = ocupantes(d);
  const recuperable = r1(ocup.filter((o) => o.clase === "limpiable").reduce((s, o) => s + o.gb, 0) * RECUPERA);
  const conUsuario = r1(ocup.filter((o) => o.clase === "usuario").reduce((s, o) => s + o.gb, 0) * 0.5);
  // Libre que conviene tener: 15 % del disco y nunca menos de 25 GB (lo que pide el upgrade a Windows 11)
  const objetivo = Math.max(25, Math.round(total * 0.15));
  const f = d.fisico ?? {};
  const motivos: string[] = [];

  // 1. Salud física: esto manda sobre todo lo demás
  const falla: string[] = [];
  if (f.salud && !/healthy/i.test(f.salud)) falla.push(`Windows informa el disco como "${f.salud}"${f.estado ? ` (${f.estado})` : ""}`);
  if (f.smart_falla) falla.push("El disco emitió una alerta SMART de falla inminente");
  if ((f.errores_lectura ?? 0) > 0) falla.push(`${f.errores_lectura} errores de lectura sin corregir`);
  if ((f.errores_escritura ?? 0) > 0) falla.push(`${f.errores_escritura} errores de escritura sin corregir`);
  if ((f.desgaste_pct ?? 0) >= 80) falla.push(`Desgaste del SSD: ${f.desgaste_pct} % de su vida útil consumida`);
  const hdd = /hdd/i.test(f.tipo ?? "");

  const base = { usoPct: total ? Math.round(((total - libre) / total) * 100) : null, libreGb: total ? libre : null, recuperableGb: recuperable, conUsuarioGb: conUsuario, objetivoGb: objetivo };

  if (falla.length) {
    return { ...base, nivel: "urgente", titulo: "Cambiar el disco: tiene signos de falla", motivos: [...falla, "Hacer backup de los datos del usuario cuanto antes"] };
  }

  // 2. Espacio: ¿alcanza con limpiar?
  const alcanzaLimpiando = libre + recuperable >= objetivo;
  const alcanzaConUsuario = libre + recuperable + conUsuario >= objetivo;
  if (libre < objetivo) {
    motivos.push(`Quedan ${r1(libre)} GB libres de ${r1(total)} GB; conviene tener al menos ${objetivo} GB`);
    if (recuperable >= 1) motivos.push(`Limpiando lo de sistema y temporales se recuperan unos ${recuperable} GB`);
  }

  if (libre < objetivo && !alcanzaConUsuario) {
    motivos.push(total < 240
      ? `Aun limpiando no alcanza: el disco de ${Math.round(total)} GB queda chico. Reemplazar por uno de 512 GB (SSD)`
      : "Aun limpiando no alcanza: el contenido del equipo supera la capacidad del disco. Reemplazar por uno de mayor capacidad o mover datos a la red/OneDrive");
    if (hdd) motivos.push("Además es un disco mecánico (HDD): el reemplazo por SSD mejora mucho el rendimiento");
    return { ...base, nivel: "ampliar", titulo: "Cambiar por un disco más grande", motivos };
  }

  if (hdd) {
    motivos.push("Es un disco mecánico (HDD): está sano, pero es lento para Windows 11 y Office. Recomendado pasar a SSD");
    if (libre < objetivo) motivos.push(alcanzaLimpiando ? "Mientras tanto, la limpieza alcanza para recuperar espacio" : "Mientras tanto, hace falta limpiar revisando con el usuario sus archivos");
    return { ...base, nivel: "cambiar", titulo: "Recomendado cambiar a SSD (rendimiento)", motivos };
  }

  if (libre < objetivo) {
    if (!alcanzaLimpiando) motivos.push("Con la limpieza de sistema no alcanza: hay que revisar con el usuario sus archivos (Descargas, OneDrive, Outlook)");
    motivos.push("El disco está sano: no hace falta cambiarlo");
    return { ...base, nivel: "limpiar", titulo: alcanzaLimpiando ? "No hace falta cambiar el disco: alcanza con limpiar" : "No hace falta cambiar el disco: limpiar con el usuario", motivos };
  }

  motivos.push(`Tiene ${r1(libre)} GB libres y el disco está sano`);
  return { ...base, nivel: "ok", titulo: "Disco en buen estado", motivos };
}

export const ESTILO_NIVEL: Record<Nivel, string> = {
  urgente: "bg-red-50 text-red-700 border-red-200",
  ampliar: "bg-red-50 text-red-700 border-red-200",
  cambiar: "bg-amber-50 text-amber-800 border-amber-200",
  limpiar: "bg-amber-50 text-amber-800 border-amber-200",
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export const VERSION_AGENTE_DISCO = 2.1;
export const agenteSoportaDisco = (v: string | null) => (parseFloat(v ?? "0") || 0) >= VERSION_AGENTE_DISCO;
