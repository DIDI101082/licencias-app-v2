// Solapa Servidores: tipos, carga de datos y reglas de estado (compartidas por las tres pantallas).
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { conectado, discoCritico, tipoDeducido, type Disco } from "@/lib/monitoreo";

export type Criticidad = "critica" | "alta" | "media" | "baja";
export type Entorno = "produccion" | "pruebas" | "desarrollo" | "contingencia";

export type Servidor = {
  id: number; nombre: string; rol: string | null; entorno: Entorno; criticidad: Criticidad; sede: string | null;
  responsable: string | null; notas: string | null; activo: boolean; dispositivo_id: string | null; so_manual: string | null;
  prtg_objid: number | null; requiere_backup: boolean; backup_auto: boolean; backup_trabajos: string[]; rpo_horas: number;
};

export type Dispositivo = {
  id: string; hostname: string | null; so_nombre: string | null; so_version: string | null; so_build: string | null;
  ip: string | null; dominio: string | null; fabricante: string | null; modelo: string | null; procesador: string | null;
  nucleos: number | null; ram_total_gb: number | null; ram_libre_gb: number | null; discos: Disco[] | null;
  arranque: string | null; ultimo_reporte: string; agente_version: string | null; ultimo_parche: string | null;
  ultimo_parche_titulo: string | null; reinicio_pendiente: boolean | null; antivirus_activo: boolean | null; equipo_id: string | null;
};

export type PrtgEquipo = {
  objid: number; nombre: string; host: string; grupo: string; estado: string;
  ok: number; advertencia: number; caido: number; total: number;
};
export type PrtgSensor = { objid: number; nombre: string; dispositivo: number; estado: string; mensaje: string; valor: string; desde: string };

export type TrabajoVeeam = {
  nombre: string; tipo: string | null; habilitado: boolean; ultimo_resultado: string | null; ultimo_fin: string | null;
  ultimo_exito: string | null; tamano_gb: number | null; detalle: string | null; ignorar: boolean; objetos: string[] | null;
};

export type FinSoporte = { nombre: string; fin_estandar: string | null; fin_extendido: string; notas: string | null };

type Calculado = {
  trabajos: { nombre: string; automatico: boolean }[];
  fin_soporte: FinSoporte | null;
  ultima_prueba: { fecha: string; resultado: "exitosa" | "parcial" | "fallida" } | null;
};

export type Datos = {
  dispositivos: Dispositivo[];
  prtg: { actualizado: string | null; dispositivos: PrtgEquipo[]; sensores: PrtgSensor[] } | null;
  veeam: {
    configurado: boolean | null; ultimo_reporte: string | null; horas_max_sin_reporte: number | null;
    trabajos: TrabajoVeeam[]; historial: { nombre: string; fecha: string; resultado: string }[];
  };
  calculado: Record<string, Calculado>;
};

export type Config = {
  alertas: boolean; reglas: string[]; horas_sin_reporte: number; dias_sin_parche: number;
  dias_aviso_fin_soporte: number; dias_prueba_restore: number;
};

export const CONFIG_INICIAL: Config = {
  alertas: true, reglas: ["reporte", "fin_soporte", "backup", "restauracion"], horas_sin_reporte: 2,
  dias_sin_parche: 35, dias_aviso_fin_soporte: 180, dias_prueba_restore: 180,
};

export const CRITICIDAD: Record<Criticidad, { t: string; c: string; orden: number }> = {
  critica: { t: "Crítica", c: "bg-red-600 text-white", orden: 0 },
  alta: { t: "Alta", c: "bg-red-50 text-red-600", orden: 1 },
  media: { t: "Media", c: "bg-amber-500/10 text-amber-700", orden: 2 },
  baja: { t: "Baja", c: "bg-line/[0.05] text-ink/60", orden: 3 },
};

export const ENTORNO: Record<Entorno, string> = {
  produccion: "Producción", pruebas: "Pruebas", desarrollo: "Desarrollo", contingencia: "Contingencia",
};

// ---------- Estado general ----------
export type EstadoGeneral = "caido" | "sin_reportar" | "advertencia" | "ok" | "pausado" | "sin_datos";

export const ESTADO: Record<EstadoGeneral, { t: string; c: string; orden: number }> = {
  caido: { t: "Caído", c: "bg-red-600 text-white", orden: 0 },
  sin_reportar: { t: "Sin reportar", c: "bg-red-50 text-red-600", orden: 1 },
  advertencia: { t: "Con alertas", c: "bg-amber-500/10 text-amber-700", orden: 2 },
  ok: { t: "OK", c: "bg-emerald-50 text-emerald-700", orden: 3 },
  pausado: { t: "Pausado en PRTG", c: "bg-line/[0.05] text-ink/60", orden: 4 },
  sin_datos: { t: "Sin vincular", c: "bg-line/[0.05] text-ink/50", orden: 5 },
};

// ---------- Soporte del sistema operativo ----------
export type EstadoSoporte = "sin_soporte" | "por_vencer" | "vigente" | "desconocido";
export const SOPORTE: Record<EstadoSoporte, { t: string; c: string; orden: number }> = {
  sin_soporte: { t: "Sin soporte", c: "bg-red-600 text-white", orden: 0 },
  por_vencer: { t: "Por vencer", c: "bg-amber-500/10 text-amber-700", orden: 1 },
  desconocido: { t: "Sin datos", c: "bg-line/[0.05] text-ink/50", orden: 2 },
  vigente: { t: "Con soporte", c: "bg-emerald-50 text-emerald-700", orden: 3 },
};

// ---------- Backups ----------
export type EstadoBackup = "sin_backup" | "fuera_rpo" | "fallo" | "ok" | "no_requiere" | "sin_veeam";
export const BACKUP: Record<EstadoBackup, { t: string; c: string; orden: number }> = {
  sin_backup: { t: "Sin backup", c: "bg-red-50 text-red-600", orden: 1 },
  fuera_rpo: { t: "Fuera de RPO", c: "bg-red-600 text-white", orden: 0 },
  fallo: { t: "Último falló", c: "bg-amber-500/10 text-amber-700", orden: 2 },
  ok: { t: "Al día", c: "bg-emerald-50 text-emerald-700", orden: 4 },
  no_requiere: { t: "No requiere", c: "bg-line/[0.05] text-ink/50", orden: 5 },
  sin_veeam: { t: "Sin datos de Veeam", c: "bg-line/[0.05] text-ink/50", orden: 3 },
};

export type Fila = Servidor & {
  disp: Dispositivo | null;
  prtg: PrtgEquipo | null;
  sensores: PrtgSensor[];
  so: string | null;
  estado: EstadoGeneral;
  motivo: string | null;
  soporte: EstadoSoporte;
  fin: FinSoporte | null;
  diasParche: number | null;
  trabajos: (TrabajoVeeam & { automatico: boolean })[];
  ultimoExito: string | null;
  backup: EstadoBackup;
  ultimaPrueba: Calculado["ultima_prueba"];
  pruebaVencida: boolean;
};

const DIA = 86400000;
export const diasDesde = (f: string | null, ahora = Date.now()) => (f ? Math.floor((ahora - Date.parse(f)) / DIA) : null);
export const diasHastaFecha = (f: string, ahora = Date.now()) => Math.ceil((Date.parse(f + "T12:00:00") - ahora) / DIA);
export const fechaCorta = (f: string | null) =>
  f ? new Date(f.length === 10 ? f + "T12:00:00" : f).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "—";
export const fechaHora = (f: string | null) =>
  f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—";

export function haceHoras(f: string | null, ahora = Date.now()) {
  if (!f) return "nunca";
  const h = (ahora - Date.parse(f)) / 3600000;
  return h < 1 ? "hace minutos" : h < 48 ? `hace ${Math.floor(h)} h` : `hace ${Math.floor(h / 24)} días`;
}

export function usoRam(d: Dispositivo | null) {
  if (!d?.ram_total_gb || d.ram_libre_gb == null) return null;
  return Math.round(((d.ram_total_gb - d.ram_libre_gb) / d.ram_total_gb) * 100);
}

// Equipos del agente que parecen servidores (Windows Server o Linux) y todavía no están en la lista
export function pareceServidor(d: Dispositivo) {
  return tipoDeducido(d) === "servidor";
}

export function armarFilas(servidores: Servidor[], datos: Datos | null, config: Config, ahora = Date.now()): Fila[] {
  const disp = new Map((datos?.dispositivos ?? []).map((d) => [d.id, d]));
  const prtg = new Map((datos?.prtg?.dispositivos ?? []).map((p) => [Number(p.objid), p]));
  const trabajos = new Map((datos?.veeam.trabajos ?? []).map((t) => [t.nombre, t]));
  const prtgFresco = !!datos?.prtg?.actualizado && ahora - Date.parse(datos.prtg.actualizado) < 30 * 60000;
  const veeamOk = !!datos?.veeam.configurado && !!datos.veeam.ultimo_reporte;

  return servidores.map((s) => {
    const d = s.dispositivo_id ? disp.get(s.dispositivo_id) ?? null : null;
    const p = s.prtg_objid != null ? prtg.get(s.prtg_objid) ?? null : null;
    const calc = datos?.calculado[String(s.id)];
    const sensores = (datos?.prtg?.sensores ?? []).filter((x) => Number(x.dispositivo) === s.prtg_objid);

    // Estado general: PRTG manda sobre la disponibilidad; el agente, sobre si reporta y los recursos
    let estado: EstadoGeneral = "sin_datos";
    let motivo: string | null = null;
    const agenteOk = d ? conectado(d.ultimo_reporte, ahora) : null;
    const pe = p && prtgFresco ? p.estado : null;
    if (pe === "caido" || pe === "caido_reconocido") {
      estado = "caido"; motivo = `${p!.caido} de ${p!.total} sensores caídos en PRTG`;
    } else if (d && !agenteOk) {
      estado = "sin_reportar"; motivo = `El agente no reporta ${haceHoras(d.ultimo_reporte, ahora)}`;
    } else if (pe === "advertencia" || pe === "inusual") {
      estado = "advertencia"; motivo = `${p!.advertencia} sensores con advertencia en PRTG`;
    } else if (d && discoCritico(d.discos)) {
      estado = "advertencia"; motivo = "Disco al 90% o más";
    } else if (pe === "pausado") {
      estado = "pausado";
    } else if (pe === "ok" || agenteOk) {
      estado = "ok";
    }

    // Soporte del sistema operativo
    const fin = calc?.fin_soporte ?? null;
    let soporte: EstadoSoporte = "desconocido";
    if (fin) {
      const dias = diasHastaFecha(fin.fin_extendido, ahora);
      soporte = dias < 0 ? "sin_soporte" : dias <= config.dias_aviso_fin_soporte ? "por_vencer" : "vigente";
    }

    // Backups
    const suyos = (calc?.trabajos ?? []).map((t) => ({ ...(trabajos.get(t.nombre) as TrabajoVeeam), automatico: t.automatico })).filter((t) => t.nombre);
    const exitos = suyos.map((t) => t.ultimo_exito).filter(Boolean) as string[];
    const ultimoExito = exitos.length ? exitos.sort()[exitos.length - 1] : null;
    let backup: EstadoBackup;
    if (!s.requiere_backup) backup = "no_requiere";
    else if (!veeamOk) backup = "sin_veeam";
    else if (!suyos.length) backup = "sin_backup";
    else if (!ultimoExito || ahora - Date.parse(ultimoExito) > s.rpo_horas * 3600000) backup = "fuera_rpo";
    else if (suyos.some((t) => t.ultimo_resultado === "Failed")) backup = "fallo";
    else backup = "ok";

    const ultimaPrueba = calc?.ultima_prueba ?? null;
    const pruebaVencida = s.requiere_backup && (s.criticidad === "critica" || s.criticidad === "alta") &&
      (!ultimaPrueba || ultimaPrueba.resultado === "fallida" || (diasDesde(ultimaPrueba.fecha, ahora) ?? 0) > config.dias_prueba_restore);

    return {
      ...s, disp: d, prtg: p, sensores, so: d?.so_nombre ?? s.so_manual, estado, motivo, soporte, fin,
      diasParche: d ? diasDesde(d.ultimo_parche, ahora) : null,
      trabajos: suyos, ultimoExito, backup, ultimaPrueba, pruebaVencida,
    };
  });
}

// Carga todo lo de la solapa. Se refresca solo cada minuto.
export function useServidores() {
  const [servidores, setServidores] = useState<Servidor[]>([]);
  const [datos, setDatos] = useState<Datos | null>(null);
  const [config, setConfig] = useState<Config>(CONFIG_INICIAL);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ahora, setAhora] = useState(Date.now());

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [s, d, c] = await Promise.all([
      sb.from("srv_servidores").select("*").order("nombre"),
      sb.rpc("srv_datos"),
      sb.from("srv_config").select("*").eq("id", 1).maybeSingle(),
    ]);
    const err = s.error ?? d.error;
    if (err) setError(/srv_/.test(err.message) ? "Falta ejecutar supabase/servidores.sql en Supabase." : err.message);
    else setError(null);
    setServidores((s.data ?? []) as Servidor[]);
    setDatos((d.data as Datos) ?? null);
    if (c.data) setConfig(c.data as Config);
    setAhora(Date.now());
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  const filas = useMemo(() => armarFilas(servidores, datos, config, ahora), [servidores, datos, config, ahora]);
  return { servidores, filas, datos, config, cargando, error, recargar: cargar, ahora };
}
