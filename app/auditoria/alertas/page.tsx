"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Alerta = {
  id: number; clave: string; regla: string; severidad: "critica" | "alta" | "media" | "info";
  titulo: string; detalle: string | null; enlace: string | null;
  abierta: string; ultima_vez: string; resuelta: string | null; enviada: string | null; envio_error: string | null;
};
type Config = {
  activo: boolean; url_app: string | null; reglas: string[]; dias_sin_reportar: number; dias_sin_parches: number;
  minutos_puente: number; resumen_semanal: boolean; ultima_evaluacion: string | null; ultimo_envio: string | null;
  ultimo_error: string | null; webhook: string | null; es_admin: boolean;
};

const REGLAS: { k: string; titulo: string; ayuda: string }[] = [
  { k: "prtg_caido", titulo: "Equipo de red caído", ayuda: "Un equipo de PRTG pasa a Caído. Avisa también cuando se recupera." },
  { k: "puente_caido", titulo: "Puente de PRTG sin reportar", ayuda: "El script del servidor de PRTG dejó de enviar datos." },
  { k: "amenaza", titulo: "Amenaza detectada", ayuda: "ESET detectó algo que no se resolvió ni se marcó como revisado (requiere la integración con ESET, en Seguridad → Riesgos)." },
  { k: "fuera_pais", titulo: "Equipo fuera del país", ayuda: "Un equipo se conecta desde un país no permitido." },
  { k: "sin_reportar", titulo: "Equipo que no reporta", ayuda: "El agente no reporta hace varios días (apagado, robado, desinstalado)." },
  { k: "sin_cifrar", titulo: "Disco sin cifrar", ayuda: "BitLocker, ESET o LUKS informan el disco sin cifrar o suspendido." },
  { k: "sin_parches", titulo: "Sin parches", ayuda: "Equipos Windows sin actualizaciones hace muchos días." },
  { k: "antivirus", titulo: "Sin antivirus activo", ayuda: "Equipos Windows sin ningún antivirus activo." },
  { k: "software_prohibido", titulo: "Software prohibido", ayuda: "Aparece una aplicación de la lista de software prohibido." },
  { k: "equipo_pendiente", titulo: "Equipo nuevo por aprobar", ayuda: "Se instaló el agente en un equipo que espera aprobación." },
  { k: "vulnerabilidad", titulo: "Vulnerabilidad explotada", ayuda: "Una app instalada tiene vulnerabilidades que se usan en ataques reales (CISA KEV)." },
  { k: "vencimiento", titulo: "Vencimientos", ayuda: "Licencias, garantías, certificados, dominios o secretos por vencer o vencidos." },
  { k: "baja_pendiente", titulo: "Baja sin cerrar", ayuda: "La baja de un empleado sigue abierta después de 7 días." },
  { k: "revision_accesos", titulo: "Revisión de accesos", ayuda: "Pasaron 90 días sin revisar los accesos, o la revisión abierta está vencida." },
];
const NOMBRE_REGLA = Object.fromEntries(REGLAS.map((r) => [r.k, r.titulo]));

const SEV = {
  critica: { texto: "Crítica", clase: "bg-red-600 text-white" },
  alta: { texto: "Alta", clase: "bg-orange-500/15 text-orange-700" },
  media: { texto: "Media", clase: "bg-amber-500/15 text-amber-700" },
  info: { texto: "Info", clase: "bg-brand-50 text-brand-700" },
};
const ZONA = "America/Argentina/Buenos_Aires";
const fecha = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: ZONA, dateStyle: "short", timeStyle: "short" }) : "—");

export default function Alertas() {
  const [alertas, setAlertas] = useState<Alerta[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [vista, setVista] = useState<"abiertas" | "historial">("abiertas");
  const [regla, setRegla] = useState("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [configAbierta, setConfigAbierta] = useState(false);

  const cargar = async () => {
    const sb = createClient();
    const [a, c] = await Promise.all([
      sb.from("alertas").select("*").gte("abierta", new Date(Date.now() - 90 * 86400000).toISOString())
        .order("abierta", { ascending: false }).limit(1000),
      sb.rpc("alertas_config_ver"),
    ]);
    if (a.error) setError(a.error.message.includes("alertas") ? "Falta ejecutar alertas.sql en Supabase." : a.error.message);
    setAlertas((a.data ?? []) as Alerta[]);
    if (c.data) setConfig(c.data as Config);
    setCargando(false);
  };
  useEffect(() => { cargar(); }, []);

  const lista = useMemo(() => {
    const base = alertas.filter((a) => (vista === "abiertas" ? !a.resuelta : true)).filter((a) => !regla || a.regla === regla);
    const orden = { critica: 0, alta: 1, media: 2, info: 3 };
    return vista === "abiertas" ? [...base].sort((x, y) => orden[x.severidad] - orden[y.severidad] || y.abierta.localeCompare(x.abierta)) : base;
  }, [alertas, vista, regla]);

  const abiertas = alertas.filter((a) => !a.resuelta);
  const cuenta = (s: Alerta["severidad"]) => abiertas.filter((a) => a.severidad === s).length;

  async function evaluar() {
    setAviso(null); setError(null);
    const { data, error } = await createClient().rpc("alertas_evaluar_ahora");
    if (error) return setError(error.message);
    const r = data as { nuevas: number; resueltas: number; abiertas: number; error_envio: string | null };
    setAviso(`Revisión hecha: ${r.nuevas} nuevas, ${r.resueltas} resueltas, ${r.abiertas} abiertas.${r.error_envio ? ` No se pudo avisar a Teams: ${r.error_envio}` : ""}`);
    cargar();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Alertas</h1>
          <p className="text-ink/60 text-sm mt-1">
            La app revisa cada 10 minutos la red, la seguridad de los equipos y el agente, y avisa por Teams lo nuevo.
          </p>
        </div>
        {config?.es_admin && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={evaluar}>Revisar ahora</button>
            <button className="btn-primary" onClick={() => setConfigAbierta(!configAbierta)}>{configAbierta ? "Cerrar configuración" : "Configurar"}</button>
          </div>
        )}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}
      {aviso && <div className="card p-3 text-sm text-ink/80 bg-brand-50">{aviso}</div>}

      {config && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${config.activo && config.webhook ? "" : "bg-amber-500/10"}`}>
          <span>
            <b>Teams:</b>{" "}
            {config.activo && config.webhook ? <span className="text-emerald-700">activo</span>
              : !config.webhook ? "sin webhook configurado" : "desactivado (las alertas se registran igual, sin aviso)"}
          </span>
          <span><b>Última revisión:</b> {fecha(config.ultima_evaluacion)}</span>
          <span><b>Último aviso enviado:</b> {fecha(config.ultimo_envio)}</span>
          {config.ultimo_error && <span className="text-red-600"><b>Error:</b> {config.ultimo_error}</span>}
        </div>
      )}

      {configAbierta && config?.es_admin && <Configuracion config={config} onGuardado={cargar} />}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(["critica", "alta", "media", "info"] as const).map((s) => (
          <div key={s} className="card p-4">
            <div className="text-xs text-ink/50 uppercase tracking-wide">{SEV[s].texto}</div>
            <div className={`font-display text-3xl mt-1 ${s === "critica" && cuenta(s) ? "text-red-600" : "text-ink"}`}>{cuenta(s)}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-black/10 bg-white p-0.5">
          {(["abiertas", "historial"] as const).map((v) => (
            <button key={v} onClick={() => setVista(v)}
              className={`px-3 py-1.5 text-sm rounded-md ${vista === v ? "bg-brand-600 text-white" : "text-ink/60 hover:text-ink"}`}>
              {v === "abiertas" ? `Abiertas (${abiertas.length})` : "Historial (90 días)"}
            </button>
          ))}
        </div>
        <select className="input w-auto" value={regla} onChange={(e) => setRegla(e.target.value)} aria-label="Tipo de alerta">
          <option value="">Todos los tipos</option>
          {REGLAS.map((r) => <option key={r.k} value={r.k}>{r.titulo}</option>)}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr><th>Severidad</th><th>Alerta</th><th>Tipo</th><th>Desde</th>{vista === "historial" && <th>Resuelta</th>}<th>Teams</th></tr>
          </thead>
          <tbody>
            {lista.map((a) => (
              <tr key={a.id} className={a.resuelta ? "opacity-60" : ""}>
                <td><span className={`pill ${SEV[a.severidad].clase}`}>{SEV[a.severidad].texto}</span></td>
                <td>
                  {a.enlace ? <Link href={a.enlace} className="text-ink font-medium hover:text-brand-700">{a.titulo}</Link>
                    : <span className="text-ink font-medium">{a.titulo}</span>}
                  {a.detalle && <div className="text-xs text-ink/55 mt-0.5">{a.detalle}</div>}
                </td>
                <td className="text-ink/70 whitespace-nowrap">{NOMBRE_REGLA[a.regla] ?? a.regla}</td>
                <td className="text-ink/70 whitespace-nowrap">{fecha(a.abierta)}</td>
                {vista === "historial" && <td className="text-ink/70 whitespace-nowrap">{a.resuelta ? fecha(a.resuelta) : <span className="text-ink">Abierta</span>}</td>}
                <td className="whitespace-nowrap text-xs">
                  {a.enviada ? <span className="text-emerald-700">Avisada {fecha(a.enviada)}</span>
                    : a.envio_error ? <span className="text-red-600" title={a.envio_error}>Error al avisar</span>
                    : <span className="text-ink/40">—</span>}
                </td>
              </tr>
            ))}
            {!cargando && lista.length === 0 && (
              <tr><td colSpan={6} className="text-center text-ink/40 py-10">{vista === "abiertas" ? "No hay alertas abiertas. 🎉" : "Sin alertas en este período."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Cada problema se avisa una sola vez. Cuando se soluciona, la alerta se cierra sola en la siguiente revisión.
        Los lunes a las 9:00 llega un resumen semanal al mismo canal.
      </p>
    </div>
  );
}

function Configuracion({ config, onGuardado }: { config: Config; onGuardado: () => void }) {
  const [f, setF] = useState({
    activo: config.activo, url_app: config.url_app ?? "", reglas: config.reglas,
    dias_sin_reportar: config.dias_sin_reportar, dias_sin_parches: config.dias_sin_parches,
    minutos_puente: config.minutos_puente, resumen_semanal: config.resumen_semanal,
  });
  const [webhook, setWebhook] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    if (!f.url_app && typeof window !== "undefined") setF((x) => ({ ...x, url_app: window.location.origin }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k: string) => setF((x) => ({ ...x, reglas: x.reglas.includes(k) ? x.reglas.filter((r) => r !== k) : [...x.reglas, k] }));

  async function correr(fn: () => PromiseLike<{ error: any; data?: any }>, ok: string) {
    setOcupado(true); setMsg(null);
    const { error, data } = await fn();
    setOcupado(false);
    if (error) return setMsg({ ok: false, texto: error.message });
    if (typeof data === "string" && data !== "ok" && data !== "Enviado") return setMsg({ ok: false, texto: data });
    setMsg({ ok: true, texto: ok });
    onGuardado();
  }

  const sb = createClient();
  return (
    <div className="card p-5 space-y-5">
      <div>
        <h2 className="font-display text-lg text-ink">1. Canal de Teams</h2>
        <p className="text-sm text-ink/60 mt-1">
          En Teams, en el canal donde quieras recibir las alertas: <b>⋯ → Flujos de trabajo → “Publicar en un canal cuando se reciba
          una solicitud de webhook”</b>. Al terminar, Teams muestra una dirección: copiala y pegala acá.
          La dirección es secreta (quien la tenga puede escribir en el canal): se guarda en la base y no se vuelve a mostrar.
        </p>
        <div className="flex gap-2 mt-3 flex-wrap">
          <input type="password" autoComplete="off" className="input flex-1 min-w-[260px] font-mono"
            placeholder={config.webhook ? `Configurado (${config.webhook}). Pegá otra para reemplazarla` : "https://…logic.azure.com/… o https://…powerplatform.com/…"}
            value={webhook} onChange={(e) => setWebhook(e.target.value)} aria-label="Webhook de Teams" />
          <button className="btn-primary" disabled={ocupado || !webhook.trim()}
            onClick={() => correr(() => sb.rpc("alertas_webhook_guardar", { p_url: webhook.trim() }), "Webhook guardado.").then(() => setWebhook(""))}>
            Guardar
          </button>
          {config.webhook && (
            <>
              <button className="btn-secondary" disabled={ocupado} onClick={() => correr(() => sb.rpc("alertas_probar"), "Mensaje de prueba enviado: revisá el canal.")}>Enviar prueba</button>
              <button className="btn-secondary text-red-600" disabled={ocupado}
                onClick={() => confirm("¿Quitar el webhook? Dejan de llegar avisos a Teams.") && correr(() => sb.rpc("alertas_webhook_guardar", { p_url: null }), "Webhook quitado.")}>
                Quitar
              </button>
            </>
          )}
        </div>
      </div>

      <div>
        <h2 className="font-display text-lg text-ink">2. Qué avisar</h2>
        <div className="grid sm:grid-cols-2 gap-2 mt-3">
          {REGLAS.map((r) => (
            <label key={r.k} className="flex gap-3 items-start p-3 rounded-lg border border-black/[0.06] hover:bg-black/[0.02] cursor-pointer">
              <input type="checkbox" className="mt-1" checked={f.reglas.includes(r.k)} onChange={() => toggle(r.k)} />
              <span>
                <span className="text-sm font-medium text-ink">{r.titulo}</span>
                <span className="block text-xs text-ink/55">{r.ayuda}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4">
          <label className="block"><span className="label">Sin reportar a partir de (días)</span>
            <input type="number" min={1} max={90} className="input" value={f.dias_sin_reportar} onChange={(e) => setF({ ...f, dias_sin_reportar: Number(e.target.value) })} /></label>
          <label className="block"><span className="label">Sin parches a partir de (días)</span>
            <input type="number" min={7} max={365} className="input" value={f.dias_sin_parches} onChange={(e) => setF({ ...f, dias_sin_parches: Number(e.target.value) })} /></label>
          <label className="block"><span className="label">Puente de PRTG caído tras (minutos)</span>
            <input type="number" min={5} max={240} className="input" value={f.minutos_puente} onChange={(e) => setF({ ...f, minutos_puente: Number(e.target.value) })} /></label>
        </div>
      </div>

      <div>
        <h2 className="font-display text-lg text-ink">3. Envío</h2>
        <div className="space-y-2 mt-3">
          <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Enviar avisos a Teams</label>
          <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={f.resumen_semanal} onChange={(e) => setF({ ...f, resumen_semanal: e.target.checked })} /> Resumen semanal (lunes 9:00)</label>
          <label className="block max-w-md"><span className="label">Dirección de la app (para el botón “Abrir” de los avisos)</span>
            <input className="input" value={f.url_app} onChange={(e) => setF({ ...f, url_app: e.target.value })} placeholder="https://…" /></label>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button className="btn-primary" disabled={ocupado} onClick={() => correr(() => sb.rpc("alertas_config_guardar", { p: f }), "Configuración guardada.")}>Guardar configuración</button>
        {config.webhook && (
          <button className="btn-secondary" disabled={ocupado} onClick={() => correr(() => sb.rpc("alertas_resumen_ahora"), "Resumen enviado: revisá el canal.")}>Enviar resumen ahora</button>
        )}
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.texto}</span>}
      </div>
    </div>
  );
}
