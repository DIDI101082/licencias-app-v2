"use client";

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { hace } from "@/lib/monitoreo";
import { exportarExcel } from "@/lib/excel";

// ---------------------------------------------------------------------------------------------
// Tipos (los devuelven qualys_estado() y qualys_detalle())
// ---------------------------------------------------------------------------------------------
type Vuln = {
  qid: number; severidad: number; qds: number | null; equipos: number; primera: string | null; vista: string;
  titulo: string | null; categoria: string | null; cves: string[] | null; cvss: number | null; amenazas: string[] | null;
  parcheable: boolean | null; explotada: boolean; ransomware: boolean;
};
type Equipo = {
  id: number; nombre: string; ip: string | null; dns: string | null; os: string | null; tracking: string | null;
  ultimo_escaneo: string | null; ultimo_escaneo_auth: string | null; inv_id: string | null; origen: "agente" | "servidor" | null;
  inv_nombre: string | null; inv_tipo: string | null; persona: string | null; area: string | null;
  s5: number; s4: number; s3: number; explotadas: number; qds_max: number | null; mas_vieja: string | null;
};
type SinEscaneo = { inv_id: string; nombre: string; ip: string | null; persona: string | null; tipo: string | null; host_id: number | null; ultimo_escaneo: string | null; ultimo_escaneo_auth: string | null };
type Estado = {
  activo: boolean; alertar_nuevas: boolean; alertar_cobertura: boolean; sev_alerta: number; dias_cobertura: number;
  carga_completa: boolean; cursor_id_min: number | null; ultimo_ciclo: string | null; ultima_ejecucion: string | null; ultimo_ok: string | null;
  ultimo_error: string | null; avisos: string[]; clave_configurada: boolean; sin_kb: number;
  vulns: Vuln[]; equipos: Equipo[]; cobertura: SinEscaneo[]; corregidas_30d: number; nuevas_30d: number;
};
type Det = {
  clave: string; host_id: number; equipo: string; ip: string | null; persona: string | null; qid: number; titulo: string | null; severidad: number;
  qds: number | null; puerto: number | null; protocolo: string | null; estado: string; primera: string | null; ultima: string | null; veces: number | null;
  cves: string[] | null; explotada: boolean; parcheable: boolean | null; solucion: string | null;
};
type Kb = { qid: number; titulo: string | null; categoria: string | null; cves: string[]; cvss: number | null; cvss3: number | null; amenazas: string[]; solucion: string | null; publicada: string | null; parcheable: boolean | null };

type Vista = "resumen" | "vulnerabilidades" | "equipos" | "cobertura";
const VISTAS: [Vista, string][] = [["resumen", "Resumen"], ["vulnerabilidades", "Vulnerabilidades"], ["equipos", "Equipos"], ["cobertura", "Cobertura de escaneo"]];

const SEV: Record<number, { t: string; c: string }> = {
  5: { t: "Urgente", c: "bg-red-600 text-white" },
  4: { t: "Crítica", c: "bg-red-50 text-red-700" },
  3: { t: "Grave", c: "bg-amber-500/15 text-amber-800" },
};
const AMENAZA: Record<string, string> = {
  Active_Attacks: "Ataques activos", Cisa_Known_Exploited_Vulns: "CISA KEV", Ransomware: "Ransomware", Exploit_Public: "Exploit público",
  Easy_Exploit: "Fácil de explotar", Remote_Code_Execution: "Ejecución remota", Unauthenticated_Exploitation: "Sin autenticación",
  Wormable: "Se propaga solo", High_Lateral_Movement: "Movimiento lateral", Malware: "Malware", Predicted_High_Risk: "Alto riesgo previsto",
  Privilege_Escalation: "Escalada de privilegios", Denial_of_Service: "Denegación de servicio", High_Data_Loss: "Pérdida de datos",
  Zero_Day: "Día cero", No_Patch: "Sin parche", Exploit_Kit: "Kit de exploits",
};
const GRAVE_AMENAZA = /active_attacks|cisa|ransomware|wormable|zero_day/i;

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("es-AR"));
const dia = (f: string | null) => (f ? new Date(f).toLocaleDateString("es-AR") : "—");
const dias = (f: string | null, ahora: number) => (f ? Math.floor((ahora - Date.parse(f)) / 86400000) : null);

function Sev({ s }: { s: number }) {
  const x = SEV[s] ?? { t: `Sev. ${s}`, c: "bg-line/[0.05] text-ink/60" };
  return <span className={`pill ${x.c}`}>{s} · {x.t}</span>;
}
function Amenazas({ a, max = 4 }: { a: string[] | null; max?: number }) {
  const l = (a ?? []).slice().sort((x, y) => Number(GRAVE_AMENAZA.test(y)) - Number(GRAVE_AMENAZA.test(x)));
  if (!l.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {l.slice(0, max).map((t) => (
        <span key={t} className={`text-[11px] rounded-full px-2 py-0.5 ${GRAVE_AMENAZA.test(t) ? "bg-red-50 text-red-700 font-medium" : "bg-line/[0.05] text-ink/60"}`}>{AMENAZA[t] ?? t.replace(/_/g, " ")}</span>
      ))}
      {l.length > max && <span className="text-[11px] text-ink/45">+{l.length - max}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Configuración (solo administradores)
// ---------------------------------------------------------------------------------------------
function Configuracion({ estado, alCambiar }: { estado: Estado; alCambiar: () => void }) {
  const [f, setF] = useState({ activo: estado.activo, alertar_nuevas: estado.alertar_nuevas, alertar_cobertura: estado.alertar_cobertura, sev_alerta: estado.sev_alerta, dias_cobertura: estado.dias_cobertura });
  const [aviso, setAviso] = useState<{ ok: boolean; t: string } | null>(null);
  async function guardar() {
    const { error } = await createClient().rpc("qualys_guardar", { p: f });
    setAviso(error ? { ok: false, t: error.message } : { ok: true, t: "Guardado." });
    if (!error) alCambiar();
  }
  async function recargar() {
    if (!confirm("Se vuelve a leer todo Qualys desde cero en las próximas corridas (no se borra nada). ¿Seguir?")) return;
    const { error } = await createClient().rpc("qualys_recargar");
    setAviso(error ? { ok: false, t: error.message } : { ok: true, t: "Listo: la próxima corrida arranca una carga completa." });
    if (!error) alCambiar();
  }
  return (
    <div className="card p-5 space-y-4">
      <h2 className="font-medium text-ink">Configuración de Qualys</h2>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-3xl">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} />Leer Qualys cada 30 minutos</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.alertar_nuevas} onChange={(e) => setF({ ...f, alertar_nuevas: e.target.checked })} />Avisar vulnerabilidades nuevas graves</label>
        <label className="flex items-center gap-2">Avisar QID nuevos desde severidad
          <select className="input w-auto" value={f.sev_alerta} onChange={(e) => setF({ ...f, sev_alerta: Number(e.target.value) })}>
            <option value={5}>5 (urgente)</option><option value={4}>4 (crítica)</option><option value={3}>3 (grave)</option>
          </select></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.alertar_cobertura} onChange={(e) => setF({ ...f, alertar_cobertura: e.target.checked })} />Avisar equipos sin escanear</label>
        <label className="flex items-center gap-2">Sin escanear: más de
          <input type="number" min={1} max={365} className="input w-20" value={f.dias_cobertura} onChange={(e) => setF({ ...f, dias_cobertura: Number(e.target.value) })} />días</label>
      </div>
      <p className="text-xs text-ink/50">Las vulnerabilidades explotadas activamente (ataques en curso o catálogo KEV de CISA) se avisan siempre, sin importar la severidad.</p>
      <div className="flex items-center gap-3 flex-wrap">
        <button className="btn-primary" onClick={guardar}>Guardar</button>
        <button className="btn-secondary" onClick={recargar}>Volver a cargar todo</button>
        {aviso && <p role="status" className={`text-sm ${aviso.ok ? "text-emerald-700" : "text-red-600"}`}>{aviso.t}</p>}
      </div>
      <details className="text-sm text-ink/70" open={!estado.ultima_ejecucion}>
        <summary className="cursor-pointer font-medium text-ink">Cómo se conecta (usuario de solo lectura)</summary>
        <ol className="list-decimal pl-5 space-y-1.5 mt-2 max-w-3xl">
          <li>En Qualys: <b>Users → New → User</b>. Nombre sugerido: <code>accusys-cyber-api</code>. Rol: <b>Reader</b>.</li>
          <li>En <b>Asset Groups</b>, asignale <b>All</b> (o los grupos que quieras ver). Un Reader solo ve los equipos de sus grupos.</li>
          <li>En <b>Security</b> (o <b>Options</b>) tildá <b>Allow access to Qualys API</b> y destildá el acceso a la interfaz web si la política lo permite.
            No le restrinjas IPs de acceso: Vercel no tiene IP fija.</li>
          <li>Entrá una vez con ese usuario para cambiar la clave inicial (Qualys obliga a hacerlo antes de usar la API).</li>
          <li>En Vercel (proyecto accusys-cyber → Settings → Environment Variables) cargá:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li><code>QUALYS_API_URL</code>: la dirección de la API de su plataforma. Es la de la consola cambiando <code>qualysguard</code> por <code>qualysapi</code>,
                por ejemplo <code>https://qualysapi.qg2.apps.qualys.com</code>.</li>
              <li><code>QUALYS_USUARIO</code> y <code>QUALYS_CLAVE</code>.</li>
            </ul></li>
          <li>Publicá de nuevo (Redeploy) y tocá <b>Leer ahora</b>. La carga inicial puede llevar varias corridas y no genera avisos.</li>
        </ol>
        <p className="mt-2 text-xs text-ink/50">La clave no se guarda en la base. La app solo consulta: no lanza escaneos ni cambia nada en Qualys.
          Usa la misma clave <code>CRON_SECRET</code> que las demás tareas programadas.</p>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Detalle desplegable (equipos de un QID o vulnerabilidades de un equipo)
// ---------------------------------------------------------------------------------------------
function Detalle({ host, qid }: { host?: number; qid?: number }) {
  const [d, setD] = useState<{ kb: Kb | null; detecciones: Det[] } | null>(null);
  useEffect(() => {
    createClient().rpc("qualys_detalle", { p_host: host ?? null, p_qid: qid ?? null }).then(({ data }) => setD((data as any) ?? { kb: null, detecciones: [] }));
  }, [host, qid]);
  if (!d) return <p className="text-sm text-ink/40 py-2">Cargando…</p>;
  if (qid) {
    return (
      <div className="space-y-3 py-1">
        {d.kb && (
          <div className="text-sm space-y-1">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-ink/70">
              {d.kb.categoria && <span><b className="text-ink">Categoría:</b> {d.kb.categoria}</span>}
              {(d.kb.cvss3 ?? d.kb.cvss) != null && <span><b className="text-ink">CVSS:</b> {d.kb.cvss3 ?? d.kb.cvss}</span>}
              {d.kb.publicada && <span><b className="text-ink">Publicada:</b> {dia(d.kb.publicada)}</span>}
              <span><b className="text-ink">Parche:</b> {d.kb.parcheable == null ? "—" : d.kb.parcheable ? "disponible" : "no hay"}</span>
            </div>
            {d.kb.cves?.length > 0 && <div className="text-ink/70"><b className="text-ink">CVE:</b> {d.kb.cves.join(", ")}</div>}
            {d.kb.solucion && <div className="text-ink/70 whitespace-pre-line"><b className="text-ink">Solución:</b> {d.kb.solucion}</div>}
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="text-left text-ink/50"><tr><th className="py-1 pr-3">Equipo</th><th className="pr-3">Persona</th><th className="pr-3">Puerto</th><th className="pr-3">QDS</th><th className="pr-3">Desde</th><th>Última vez</th></tr></thead>
          <tbody>
            {d.detecciones.map((x) => (
              <tr key={x.clave} className="border-t border-line/[0.06]">
                <td className="py-1.5 pr-3 font-medium text-ink">{x.equipo}<span className="text-xs text-ink/45 font-normal"> {x.ip}</span>{x.estado === "Re-Opened" && <span className="pill bg-amber-500/15 text-amber-800 ml-1">Reabierta</span>}</td>
                <td className="pr-3 text-ink/70">{x.persona ?? "—"}</td>
                <td className="pr-3 text-ink/60">{x.puerto ? `${x.puerto}/${x.protocolo}` : "—"}</td>
                <td className="pr-3 tabular-nums">{x.qds ?? "—"}</td>
                <td className="pr-3 text-ink/70 whitespace-nowrap">{dia(x.primera)}</td>
                <td className="text-ink/70 whitespace-nowrap">{dia(x.ultima)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <table className="w-full text-sm my-1">
      <thead className="text-left text-ink/50"><tr><th className="py-1 pr-3">Vulnerabilidad</th><th className="pr-3">Severidad</th><th className="pr-3">QDS</th><th className="pr-3">Puerto</th><th>Desde</th></tr></thead>
      <tbody>
        {!d.detecciones.length && <tr><td colSpan={5} className="text-ink/40 py-2">Sin vulnerabilidades abiertas de severidad 3 a 5.</td></tr>}
        {d.detecciones.map((x) => (
          <tr key={x.clave} className="border-t border-line/[0.06] align-top">
            <td className="py-1.5 pr-3"><div className="text-ink">{x.titulo ?? `QID ${x.qid}`}{x.explotada && <span className="text-[11px] rounded-full px-2 py-0.5 bg-red-50 text-red-700 font-medium ml-1.5">Explotada</span>}</div>
              <div className="text-xs text-ink/50">QID {x.qid}{x.cves?.length ? ` · ${x.cves.slice(0, 3).join(", ")}` : ""}</div>
              {x.solucion && <details className="text-xs text-ink/60 mt-0.5"><summary className="cursor-pointer">Solución</summary><p className="whitespace-pre-line mt-1">{x.solucion}</p></details>}</td>
            <td className="pr-3"><Sev s={x.severidad} /></td>
            <td className="pr-3 tabular-nums">{x.qds ?? "—"}</td>
            <td className="pr-3 text-ink/60">{x.puerto ? `${x.puerto}/${x.protocolo}` : "—"}</td>
            <td className="text-ink/70 whitespace-nowrap">{dia(x.primera)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------------------------
function Contenido() {
  const { esAdmin } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (VISTAS.some(([k]) => k === params.get("vista")) ? params.get("vista") : "resumen") as Vista;
  const ir = (q: string) => router.replace(`/inventario/qualys${q ? `?${q}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<Estado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; t: string } | null>(null);
  const [ahora, setAhora] = useState(Date.now());
  const [texto, setTexto] = useState("");
  const [sev, setSev] = useState(0);
  const [soloExplotadas, setSoloExplotadas] = useState(false);
  const [tipoEq, setTipoEq] = useState("");
  const [abierto, setAbierto] = useState<number | null>(params.get("qid") ? Number(params.get("qid")) : null);

  const cargar = useCallback(async () => {
    const { data, error } = await createClient().rpc("qualys_estado");
    setError(error ? (/qualys_estado/.test(error.message) ? "Falta ejecutar supabase/qualys.sql en Supabase." : error.message) : null);
    setEstado((data as Estado) ?? null);
    setAhora(Date.now());
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 300000); return () => clearInterval(t); }, [cargar]);

  async function leerAhora() {
    setLeyendo(true); setResultado(null);
    const r = await fetch("/api/qualys/auto", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setLeyendo(false);
    if (!r.ok) setResultado({ ok: false, t: j.error ?? "No se pudo leer Qualys" });
    else if (j.omitido) setResultado({ ok: false, t: j.omitido });
    else setResultado({ ok: true, t: `Listo: ${j.paginas} página(s), ${num(j.detecciones)} detecciones leídas, ${j.nuevas} nuevas` + (j.pendiente ? ". Falta cargar más equipos: tocá «Leer ahora» de nuevo o esperá la próxima corrida." : ".") });
    cargar();
  }

  const vulns = estado?.vulns ?? [];
  const equipos = estado?.equipos ?? [];
  const cobertura = estado?.cobertura ?? [];
  const q = texto.trim().toLowerCase();

  const urgentes = vulns.filter((v) => v.severidad === 5);
  const explotadas = vulns.filter((v) => v.explotada);
  const conVulns = equipos.filter((e) => e.s5 + e.s4 + e.s3 > 0);
  const totalDet = equipos.reduce((s, e) => s + e.s5 + e.s4 + e.s3, 0);
  const viejas = equipos.filter((e) => e.mas_vieja && (dias(e.mas_vieja, ahora) ?? 0) > 30).length;
  const retraso = estado?.ultimo_ok ? ahora - Date.parse(estado.ultimo_ok) : null;
  const atrasada = !!estado?.activo && !!estado.ultima_ejecucion && (retraso == null || retraso > 90 * 60000);

  const tarjetas = [
    { t: "Vulnerabilidades abiertas", n: num(totalDet), c: "text-ink", v: "vulnerabilidades" as Vista, f: () => { setSev(0); setSoloExplotadas(false); } },
    { t: "Explotadas activamente (QID)", n: num(explotadas.length), c: explotadas.length ? "text-red-600" : "text-ink", v: "vulnerabilidades" as Vista, f: () => { setSev(0); setSoloExplotadas(true); } },
    { t: "Urgentes · severidad 5 (QID)", n: num(urgentes.length), c: urgentes.length ? "text-red-600" : "text-ink", v: "vulnerabilidades" as Vista, f: () => { setSev(5); setSoloExplotadas(false); } },
    { t: "Equipos con vulnerabilidades", n: `${num(conVulns.length)} de ${num(equipos.length)}`, c: "text-ink", v: "equipos" as Vista, f: () => setTipoEq("") },
    { t: `Sin escanear (+${estado?.dias_cobertura ?? 30} días)`, n: num(cobertura.length), c: cobertura.length ? "text-amber-700" : "text-ink", v: "cobertura" as Vista, f: () => {} },
    { t: "Corregidas en 30 días", n: num(estado?.corregidas_30d), c: "text-emerald-700", v: "resumen" as Vista, f: () => {} },
  ];

  const listaVulns = useMemo(() => vulns.filter((v) =>
    (!sev || v.severidad === sev) && (!soloExplotadas || v.explotada) &&
    (!q || String(v.qid).includes(q) || (v.titulo ?? "").toLowerCase().includes(q) || (v.cves ?? []).some((c) => c.toLowerCase().includes(q)) || (v.categoria ?? "").toLowerCase().includes(q))),
  [vulns, sev, soloExplotadas, q]);

  const listaEquipos = useMemo(() => equipos.filter((e) =>
    (!tipoEq || (tipoEq === "servidor" ? e.inv_tipo === "servidor" || e.origen === "servidor" : tipoEq === "sin_inventario" ? !e.inv_id : e.inv_id && e.inv_tipo !== "servidor" && e.origen !== "servidor")) &&
    (!q || [e.nombre, e.ip, e.dns, e.os, e.persona, e.inv_nombre].some((x) => x?.toLowerCase().includes(q)))),
  [equipos, tipoEq, q]);

  const exportarVulns = () => exportarExcel(`qualys-vulnerabilidades-${new Date().toISOString().slice(0, 10)}`,
    ["QID", "Título", "Severidad", "QDS máx.", "CVSS", "CVE", "Amenazas", "Explotada", "Parche", "Equipos", "Detectada desde"],
    listaVulns.map((v) => [v.qid, v.titulo ?? "", v.severidad, v.qds ?? "", v.cvss ?? "", (v.cves ?? []).join(", "), (v.amenazas ?? []).map((a) => AMENAZA[a] ?? a).join(", "),
      v.explotada ? "Sí" : "No", v.parcheable == null ? "" : v.parcheable ? "Sí" : "No", v.equipos, dia(v.primera)]),
    { Título: 60, CVE: 30, Amenazas: 40 });
  const exportarEquipos = () => exportarExcel(`qualys-equipos-${new Date().toISOString().slice(0, 10)}`,
    ["Equipo", "IP", "Sistema operativo", "Persona / responsable", "En inventario", "Sev. 5", "Sev. 4", "Sev. 3", "Explotadas", "QDS máx.", "Último escaneo", "Último escaneo autenticado"],
    listaEquipos.map((e) => [e.nombre, e.ip ?? "", e.os ?? "", e.persona ?? "", e.inv_id ? (e.origen === "servidor" ? "Servidor" : "Agente") : "No", e.s5, e.s4, e.s3, e.explotadas, e.qds_max ?? "",
      dia(e.ultimo_escaneo), dia(e.ultimo_escaneo_auth)]),
    { Equipo: 28, "Sistema operativo": 34 });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Qualys VMDR</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Vulnerabilidades confirmadas de severidad 3 a 5 que detecta Qualys en cada equipo, cuáles se están explotando activamente y qué equipos
            del inventario no se escanean. Se lee cada 30 minutos con un usuario de solo lectura: la app no lanza escaneos ni cambia nada en Qualys.
          </p>
        </div>
        {esAdmin && estado && (
          <div className="flex gap-2">
            {estado.clave_configurada && <button className="btn-secondary" onClick={leerAhora} disabled={leyendo}>{leyendo ? "Leyendo… (hasta 1 min)" : "Leer ahora"}</button>}
            <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {resultado && <p role="status" className={`text-sm rounded-md px-3 py-2 ${resultado.ok ? "text-emerald-800 bg-emerald-50" : "text-red-700 bg-red-50"}`}>{resultado.t}</p>}
      {estado && !estado.ultima_ejecucion && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no se leyó Qualys. {esAdmin ? "Tocá “Configurar” para ver cómo crear el usuario de solo lectura y cargarlo en Vercel." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <Configuracion estado={estado} alCambiar={cargar} />}

      {estado?.ultima_ejecucion && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${atrasada || estado.ultimo_error || !estado.carga_completa ? "bg-amber-500/10" : ""}`}>
          <span className={atrasada ? "text-red-600" : ""}><b>Última lectura:</b> {estado.ultimo_ok ? hace(estado.ultimo_ok, ahora) : "nunca terminó bien"}
            {!estado.activo && <span className="text-ink/50"> · lectura automática apagada</span>}</span>
          <span><b>Equipos en Qualys:</b> {num(equipos.length)}</span>
          {!estado.carga_completa && <span className="text-amber-800"><b>Carga inicial en curso</b> (sigue sola cada 30 minutos)</span>}
          {estado.sin_kb > 0 && <span className="text-ink/60">{estado.sin_kb} QID sin título todavía (se completan en las próximas corridas)</span>}
          {estado.ultimo_error && <span className="text-red-600 basis-full"><b>Error:</b> {estado.ultimo_error}</span>}
          {(estado.avisos ?? []).filter((a) => !/Carga inicial/.test(a)).length > 0 && <span className="text-amber-800 basis-full"><b>Avisos:</b> {estado.avisos.filter((a) => !/Carga inicial/.test(a)).join(" · ")}</span>}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {tarjetas.map((t) => (
          <button key={t.t} onClick={() => { t.f(); setAbierto(null); ir(t.v === "resumen" ? "" : `vista=${t.v}`); }} className="card p-5 text-left transition-colors hover:border-brand-300">
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div role="tablist" aria-label="Vistas" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1">
          {VISTAS.map(([k, t]) => (
            <button key={k} role="tab" aria-selected={vista === k} onClick={() => { setAbierto(null); ir(k === "resumen" ? "" : `vista=${k}`); }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${vista === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>{t}</button>
          ))}
        </div>
        {vista === "vulnerabilidades" && (
          <div className="flex flex-wrap gap-2 items-center">
            <select className="input w-auto" value={sev} onChange={(e) => setSev(Number(e.target.value))} aria-label="Severidad">
              <option value={0}>Todas las severidades</option><option value={5}>5 · Urgente</option><option value={4}>4 · Crítica</option><option value={3}>3 · Grave</option>
            </select>
            <label className="flex items-center gap-1.5 text-sm text-ink/70"><input type="checkbox" checked={soloExplotadas} onChange={(e) => setSoloExplotadas(e.target.checked)} />Solo explotadas</label>
            <input type="search" className="input max-w-xs" placeholder="Buscar QID, título o CVE…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
            <button className="btn-secondary" onClick={exportarVulns} disabled={!listaVulns.length}>Exportar a Excel</button>
          </div>
        )}
        {vista === "equipos" && (
          <div className="flex flex-wrap gap-2 items-center">
            <select className="input w-auto" value={tipoEq} onChange={(e) => setTipoEq(e.target.value)} aria-label="Tipo">
              <option value="">Todos los equipos</option><option value="puesto">Puestos (con agente)</option><option value="servidor">Servidores</option><option value="sin_inventario">No están en el inventario</option>
            </select>
            <input type="search" className="input max-w-xs" placeholder="Buscar equipo, IP o persona…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
            <button className="btn-secondary" onClick={exportarEquipos} disabled={!listaEquipos.length}>Exportar a Excel</button>
          </div>
        )}
      </div>

      {/* Resumen */}
      {vista === "resumen" && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="card p-4">
            <div className="text-sm font-medium text-ink mb-3">Lo primero a resolver</div>
            {!vulns.length && <p className="text-sm text-ink/40">{cargando ? "Cargando…" : "Sin vulnerabilidades abiertas de severidad 3 a 5."}</p>}
            <ul className="space-y-2.5">
              {vulns.slice(0, 8).map((v) => (
                <li key={v.qid} className="text-sm">
                  <button className="text-left hover:underline" onClick={() => { setAbierto(v.qid); ir(`vista=vulnerabilidades&qid=${v.qid}`); }}>
                    <span className="font-medium text-ink">{v.titulo ?? `QID ${v.qid}`}</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5 text-xs text-ink/55">
                    <Sev s={v.severidad} /><span>{v.equipos} {v.equipos === 1 ? "equipo" : "equipos"}</span><Amenazas a={v.amenazas} max={3} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs text-ink/45 mt-3">Ordenadas por explotación activa, severidad y cantidad de equipos.</p>
          </div>
          <div className="card p-4">
            <div className="text-sm font-medium text-ink mb-3">Equipos más expuestos</div>
            {!conVulns.length && <p className="text-sm text-ink/40">{cargando ? "Cargando…" : "Ningún equipo con vulnerabilidades abiertas."}</p>}
            <table className="w-full text-sm">
              <tbody>
                {conVulns.slice(0, 10).map((e) => (
                  <tr key={e.id} className="border-t border-line/[0.06] first:border-0">
                    <td className="py-1.5 pr-3"><button className="font-medium text-ink hover:underline text-left" onClick={() => { setTexto(e.nombre); ir("vista=equipos"); }}>{e.nombre}</button>
                      <div className="text-xs text-ink/50">{[e.persona, e.inv_tipo === "servidor" || e.origen === "servidor" ? "servidor" : null].filter(Boolean).join(" · ") || (e.inv_id ? "" : "no está en el inventario")}</div></td>
                    <td className="text-right whitespace-nowrap tabular-nums">
                      {e.explotadas > 0 && <span className="text-[11px] rounded-full px-2 py-0.5 bg-red-50 text-red-700 font-medium mr-2">{e.explotadas} explotadas</span>}
                      <span className="text-red-700 font-medium">{e.s5}</span><span className="text-ink/40"> · </span><span className="text-red-600">{e.s4}</span><span className="text-ink/40"> · </span><span className="text-amber-700">{e.s3}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-ink/45 mt-3">Cantidades por severidad: 5 · 4 · 3. {viejas > 0 && `${viejas} equipos tienen vulnerabilidades críticas abiertas hace más de 30 días.`}</p>
          </div>
        </div>
      )}

      {/* Vulnerabilidades por QID */}
      {vista === "vulnerabilidades" && (
        <div className="space-y-3">
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Vulnerabilidad</th><th>Severidad</th><th className="text-right">QDS</th><th className="text-right">Equipos</th><th>Desde</th><th></th></tr></thead>
              <tbody>
                {!listaVulns.length && <tr><td colSpan={6} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : vulns.length ? "Nada coincide con el filtro." : "Sin vulnerabilidades abiertas."}</td></tr>}
                {listaVulns.slice(0, 500).map((v) => (
                  <Fragment key={v.qid}>
                    <tr className="cursor-pointer align-top" onClick={() => setAbierto(abierto === v.qid ? null : v.qid)}>
                      <td className="text-sm max-w-xl"><div className="font-medium text-ink">{v.titulo ?? `QID ${v.qid}`}</div>
                        <div className="text-xs text-ink/50 mt-0.5">QID {v.qid}{v.cves?.length ? ` · ${v.cves.slice(0, 3).join(", ")}${v.cves.length > 3 ? "…" : ""}` : ""}{v.parcheable === false && " · sin parche"}</div>
                        <div className="mt-1"><Amenazas a={v.amenazas} /></div></td>
                      <td className="whitespace-nowrap"><Sev s={v.severidad} /></td>
                      <td className="text-sm text-right tabular-nums">{v.qds ?? "—"}</td>
                      <td className="text-sm text-right tabular-nums font-medium">{v.equipos}</td>
                      <td className="text-sm text-ink/70 whitespace-nowrap">{dia(v.primera)}</td>
                      <td className="text-xs text-brand-600 whitespace-nowrap">{abierto === v.qid ? "Ocultar" : "Ver equipos"}</td>
                    </tr>
                    {abierto === v.qid && <tr><td colSpan={6} className="bg-line/[0.02]"><Detalle qid={v.qid} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {listaVulns.length > 500 && <p className="text-xs text-ink/50">Se muestran las primeras 500 de {listaVulns.length}. Usá los filtros o exportá a Excel.</p>}
          <p className="text-xs text-ink/50 max-w-4xl">
            QDS es el puntaje de Qualys de 1 a 100, que combina severidad, explotación y amenazas actuales. «Explotada» = ataques activos o catálogo KEV
            de CISA según la inteligencia de Qualys. Solo se cuentan vulnerabilidades confirmadas (no las potenciales).
          </p>
        </div>
      )}

      {/* Equipos */}
      {vista === "equipos" && (
        <div className="space-y-3">
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Equipo</th><th>Persona / responsable</th><th className="text-center">5</th><th className="text-center">4</th><th className="text-center">3</th><th className="text-right">QDS máx.</th><th>Último escaneo</th><th></th></tr></thead>
              <tbody>
                {!listaEquipos.length && <tr><td colSpan={8} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : equipos.length ? "Nada coincide con el filtro." : "Sin equipos todavía."}</td></tr>}
                {listaEquipos.slice(0, 1000).map((e) => {
                  const d = dias(e.ultimo_escaneo, ahora);
                  return (
                    <Fragment key={e.id}>
                      <tr className="cursor-pointer" onClick={() => setAbierto(abierto === e.id ? null : e.id)}>
                        <td className="text-sm"><div className="font-medium text-ink">{e.nombre}
                          {e.explotadas > 0 && <span className="text-[11px] rounded-full px-2 py-0.5 bg-red-50 text-red-700 font-medium ml-1.5">{e.explotadas} explotadas</span>}</div>
                          <div className="text-xs text-ink/50">{[e.ip, e.os].filter(Boolean).join(" · ")}</div></td>
                        <td className="text-sm">{e.persona ?? <span className="text-ink/40">—</span>}
                          <div className="text-xs text-ink/50">{!e.inv_id ? <span className="text-amber-700">No está en el inventario</span> : e.origen === "servidor" || e.inv_tipo === "servidor" ? "Servidor" : "Puesto"}</div></td>
                        <td className={`text-sm text-center tabular-nums ${e.s5 ? "text-red-700 font-semibold" : "text-ink/30"}`}>{e.s5}</td>
                        <td className={`text-sm text-center tabular-nums ${e.s4 ? "text-red-600" : "text-ink/30"}`}>{e.s4}</td>
                        <td className={`text-sm text-center tabular-nums ${e.s3 ? "text-amber-700" : "text-ink/30"}`}>{e.s3}</td>
                        <td className="text-sm text-right tabular-nums">{e.qds_max ?? "—"}</td>
                        <td className={`text-sm whitespace-nowrap ${d != null && d > (estado?.dias_cobertura ?? 30) ? "text-amber-700" : "text-ink/70"}`}>{e.ultimo_escaneo ? hace(e.ultimo_escaneo, ahora) : "nunca"}
                          <div className="text-xs text-ink/45">{e.tracking === "AGENT" ? "agente de Qualys" : e.ultimo_escaneo_auth ? `autenticado ${dia(e.ultimo_escaneo_auth)}` : "sin escaneo autenticado"}</div></td>
                        <td className="text-xs text-brand-600 whitespace-nowrap">{abierto === e.id ? "Ocultar" : "Detalle"}</td>
                      </tr>
                      {abierto === e.id && <tr><td colSpan={8} className="bg-line/[0.02]"><Detalle host={e.id} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink/50 max-w-4xl">
            El equipo se cruza con el inventario (agente de Accusys Cyber) y con Servidores por nombre o IP. Sin escaneo autenticado, Qualys solo ve
            lo que el equipo expone por red y puede no detectar vulnerabilidades del software instalado.
          </p>
        </div>
      )}

      {/* Cobertura */}
      {vista === "cobertura" && (
        <div className="space-y-3">
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Equipo del inventario</th><th>Tipo</th><th>Persona / responsable</th><th>En Qualys</th><th>Último escaneo</th></tr></thead>
              <tbody>
                {!cobertura.length && <tr><td colSpan={5} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : `Todos los equipos del inventario tienen un escaneo de los últimos ${estado?.dias_cobertura ?? 30} días.`}</td></tr>}
                {cobertura.map((c) => (
                  <tr key={c.inv_id}>
                    <td className="text-sm font-medium text-ink">{c.nombre}{c.ip && <span className="text-xs text-ink/45 font-normal"> {c.ip}</span>}</td>
                    <td className="text-sm text-ink/70">{c.tipo === "servidor" ? "Servidor" : "Puesto"}</td>
                    <td className="text-sm text-ink/70">{c.persona ?? "—"}</td>
                    <td className="text-sm">{c.host_id ? <span className="text-ink/70">Sí</span> : <span className="pill bg-red-50 text-red-700">No figura</span>}</td>
                    <td className="text-sm text-ink/70 whitespace-nowrap">{c.ultimo_escaneo ? `${hace(c.ultimo_escaneo, ahora)} (${dia(c.ultimo_escaneo)})` : "Nunca"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink/50 max-w-4xl">
            Equipos aprobados del inventario y servidores sin agente que Qualys no tiene registrados o no escanea hace más de {estado?.dias_cobertura ?? 30} días.
            Las notebooks que trabajan fuera de la oficina sin VPN solo se escanean si tienen el agente de Qualys (Cloud Agent).
          </p>
        </div>
      )}
    </div>
  );
}

export default function QualysPage() {
  return <Suspense><Contenido /></Suspense>;
}
