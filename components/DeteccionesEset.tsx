"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

type Det = {
  uuid: string; fecha: string; nombre: string | null; tipo: string | null; categoria: string | null; severidad: string | null;
  puntaje: number | null; resuelta: boolean; equipo_nombre: string | null; dispositivo_id: string | null; usuario: string | null;
  objeto: string | null; circunstancias: string | null; proceso: string | null; revisada: boolean; revisada_por: string | null;
};
type Estado = {
  activo: boolean; region: string; usuario: string | null; con_clave: boolean; ultima_sync: string | null;
  ultimo_error: string | null; detecciones_ultima_sync: number | null; es_admin: boolean;
};

const SEV: Record<string, { texto: string; clase: string }> = {
  HIGH: { texto: "Alta", clase: "bg-red-600 text-white" },
  MEDIUM: { texto: "Media", clase: "bg-orange-500/15 text-orange-700" },
  LOW: { texto: "Baja", clase: "bg-amber-500/15 text-amber-700" },
  INFORMATIONAL: { texto: "Informativa", clase: "bg-black/[0.05] text-ink/60" },
  DIAGNOSTIC: { texto: "Diagnóstico", clase: "bg-black/[0.05] text-ink/50" },
};
const CATEGORIA: Record<string, string> = {
  ANTIVIRUS: "Antivirus", HIPS: "HIPS", HIPS_RULE: "Regla HIPS", FIREWALL_RULE: "Firewall", NETWORK_INTRUSION: "Ataque de red",
  WEB_ACCESS: "Acceso web", EDR_RULE: "EDR", VULNERABILITY: "Vulnerabilidad", APPLICATION_PATCH: "Parche", SUSPICIOUS_ACTIVITY: "Actividad sospechosa",
};
const REGIONES: [string, string][] = [["us", "Estados Unidos"], ["eu", "Europa"], ["de", "Alemania"], ["ca", "Canadá"], ["jpn", "Japón"]];
const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—");

function csv(nombre: string, cab: string[], filas: any[][]) {
  const esc = (v: any) => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + [cab, ...filas].map((f) => f.map(esc).join(";")).join("\n")], { type: "text/csv;charset=utf-8" }));
  a.download = nombre;
  a.click();
}

export default function DeteccionesEset() {
  const { puedeEditar } = usePerfil();
  const [dets, setDets] = useState<Det[]>([]);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [filtro, setFiltro] = useState<"pendientes" | "30dias" | "todas">("pendientes");
  const [info, setInfo] = useState(false);
  const [config, setConfig] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = async () => {
    const sb = createClient();
    const [d, e] = await Promise.all([
      sb.from("eset_detecciones").select("*").gte("fecha", new Date(Date.now() - 90 * 86400000).toISOString()).order("fecha", { ascending: false }).limit(1000),
      sb.rpc("eset_estado"),
    ]);
    if (d.error) setError(d.error.message.includes("eset_") ? "Falta ejecutar eset.sql en Supabase." : d.error.message);
    setDets((d.data ?? []) as Det[]);
    setEstado(e.data as Estado);
    setCargando(false);
  };
  useEffect(() => { cargar(); }, []);

  const menor = (d: Det) => d.severidad === "INFORMATIONAL" || d.severidad === "DIAGNOSTIC";
  const hace30 = Date.now() - 30 * 86400000;
  const pendientes = dets.filter((d) => !d.resuelta && !d.revisada && (info || !menor(d)));
  const ult30 = dets.filter((d) => new Date(d.fecha).getTime() > hace30 && (info || !menor(d)));
  const equipos30 = new Set(ult30.map((d) => d.equipo_nombre)).size;
  const filas = filtro === "pendientes" ? pendientes : filtro === "30dias" ? ult30 : dets.filter((d) => info || !menor(d));

  async function revisar(d: Det, v: boolean) {
    const { error } = await createClient().rpc("eset_marcar_revisada", { p_uuid: d.uuid, p_revisada: v });
    if (error) return setError(error.message);
    cargar();
  }

  const sinConfigurar = estado && (!estado.activo || !estado.usuario || !estado.con_clave);

  return (
    <div className="space-y-5">
      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}

      {estado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 items-center ${sinConfigurar || estado.ultimo_error ? "bg-amber-500/10" : ""}`}>
          <span><b>ESET PROTECT Cloud:</b> {sinConfigurar ? "sin conectar" : <span className="text-emerald-700">conectado</span>}</span>
          <span><b>Última sincronización:</b> {fh(estado.ultima_sync)}</span>
          {estado.ultimo_error && <span className="text-red-600"><b>Error:</b> {estado.ultimo_error}</span>}
          {estado.es_admin && (
            <button className="ml-auto text-brand-600 hover:underline" onClick={() => setConfig(!config)}>{config ? "Cerrar" : "Configurar"}</button>
          )}
        </div>
      )}
      {config && estado?.es_admin && <ConfigEset estado={estado} onCambio={cargar} />}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {([["pendientes", "Sin resolver ni revisar", pendientes.length, true], ["30dias", "Detecciones en 30 días", ult30.length, false]] as const).map(([k, t, n, peligro]) => (
          <button key={k} onClick={() => setFiltro(k)} aria-pressed={filtro === k}
            className={`card p-5 text-left ${filtro === k ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{t}</div>
            <div className={`font-display text-3xl mt-1 ${n && peligro ? "text-red-600" : "text-ink"}`}>{n}</div>
          </button>
        ))}
        <div className="card p-5"><div className="text-xs text-ink/50 font-medium">Equipos afectados en 30 días</div><div className="font-display text-3xl mt-1 text-ink">{equipos30}</div></div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1">
          {([["pendientes", "Sin resolver"], ["30dias", "Últimos 30 días"], ["todas", "Todas (90 días)"]] as const).map(([k, t]) => (
            <button key={k} onClick={() => setFiltro(k)} aria-pressed={filtro === k}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${filtro === k ? "bg-white text-brand-700 shadow-sm" : "text-ink/60 hover:text-ink"}`}>{t}</button>
          ))}
        </div>
        <div className="flex gap-3 items-center">
          <label className="text-sm text-ink/60 flex items-center gap-2"><input type="checkbox" checked={info} onChange={(e) => setInfo(e.target.checked)} /> Incluir informativas</label>
          <button className="btn-secondary" disabled={!filas.length}
            onClick={() => csv("detecciones-eset.csv", ["Fecha", "Equipo", "Usuario", "Detección", "Tipo", "Categoría", "Severidad", "Objeto", "Proceso", "Resuelta", "Revisada"],
              filas.map((d) => [new Date(d.fecha).toLocaleString("es-AR"), d.equipo_nombre, d.usuario, d.nombre, d.tipo, CATEGORIA[d.categoria ?? ""] ?? d.categoria,
                SEV[d.severidad ?? ""]?.texto ?? d.severidad, d.objeto, d.proceso, d.resuelta ? "Sí" : "No", d.revisada ? "Sí" : "No"]))}>
            Exportar a Excel
          </button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Fecha</th><th>Equipo</th><th>Detección</th><th>Estado</th><th>Objeto</th>{puedeEditar && <th></th>}</tr></thead>
          <tbody>
            {filas.map((d) => {
              const sev = SEV[d.severidad ?? ""] ?? { texto: d.severidad ?? "—", clase: "bg-black/[0.05] text-ink/60" };
              return (
                <tr key={d.uuid} className={d.revisada || d.resuelta ? "opacity-60" : ""}>
                  <td className="whitespace-nowrap text-ink/70">{fh(d.fecha)}</td>
                  <td>
                    <span className="font-medium text-ink">{d.equipo_nombre ?? "—"}</span>
                    <div className="text-xs text-ink/50">{d.usuario ?? ""}{!d.dispositivo_id ? (d.usuario ? " · " : "") + "sin agente Accusys" : ""}</div>
                  </td>
                  <td>
                    <div className="text-ink break-all">{d.nombre ?? d.tipo ?? "Detección"}</div>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      <span className={`pill ${sev.clase}`}>{sev.texto}</span>
                      {d.categoria && <span className="pill bg-brand-50 text-brand-700">{CATEGORIA[d.categoria] ?? d.categoria}</span>}
                    </div>
                    {d.circunstancias && <div className="text-xs text-ink/50 mt-1">{d.circunstancias}</div>}
                  </td>
                  <td>
                    {d.resuelta ? <span className="pill bg-emerald-50 text-emerald-700">Resuelta por ESET</span>
                      : d.revisada ? <span className="pill bg-black/[0.05] text-ink/60">Revisada{d.revisada_por ? ` · ${d.revisada_por}` : ""}</span>
                      : <span className="pill bg-red-50 text-red-600">Sin resolver</span>}
                  </td>
                  <td className="text-xs text-ink/60 max-w-[280px] break-all">
                    {d.objeto}
                    {d.proceso && <div className="text-ink/40 mt-0.5">Vía {d.proceso.split("\\").pop()}</div>}
                  </td>
                  {puedeEditar && (
                    <td className="text-right whitespace-nowrap">
                      {!d.resuelta && (
                        <button className="text-sm text-brand-600 hover:underline" onClick={() => revisar(d, !d.revisada)}>{d.revisada ? "Reabrir" : "Marcar revisada"}</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={6} className="text-center py-10">
                <span className={filtro === "pendientes" && !sinConfigurar ? "text-emerald-700" : "text-ink/40"}>
                  {sinConfigurar ? "Conectá ESET PROTECT Cloud para ver las detecciones." : filtro === "pendientes" ? "No hay detecciones sin resolver." : "Sin detecciones en este período."}
                </span>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Las detecciones vienen de la consola de ESET PROTECT Cloud cada 10 minutos (todas las categorías: antivirus, HIPS, firewall, web, red y EDR).
        “Resuelta por ESET” es lo que la consola ya marca como resuelto. Marcá como revisada una detección cuando ya la hayas investigado:
        deja de generar alerta.
      </p>
    </div>
  );
}

function ConfigEset({ estado, onCambio }: { estado: Estado; onCambio: () => void }) {
  const [f, setF] = useState({ region: estado.region, usuario: estado.usuario ?? "", password: "", activo: estado.activo || !estado.usuario });
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function guardar(e: React.FormEvent) {
    e.preventDefault(); setOcupado(true); setMsg(null);
    const sb = createClient();
    const { error } = await sb.rpc("eset_configurar", { p_region: f.region, p_usuario: f.usuario, p_password: f.password, p_activo: f.activo });
    if (error) { setOcupado(false); return setMsg({ ok: false, texto: error.message }); }
    setF({ ...f, password: "" });
    if (f.activo) {
      const { data, error: e2 } = await sb.rpc("eset_sincronizar_ahora");
      const r = data as { ok: boolean; detecciones?: number; error?: string } | null;
      setMsg(e2 ? { ok: false, texto: e2.message } : r?.ok ? { ok: true, texto: `Conectado: ${r.detecciones} detecciones traídas.` } : { ok: false, texto: r?.error ?? "No se pudo sincronizar" });
    } else setMsg({ ok: true, texto: "Guardado." });
    setOcupado(false);
    onCambio();
  }

  return (
    <form onSubmit={guardar} className="card p-5 space-y-4">
      <div>
        <h2 className="font-display text-lg text-ink">Conectar ESET PROTECT Cloud</h2>
        <ol className="text-sm text-ink/60 mt-1 list-decimal pl-5 space-y-0.5">
          <li>En <b>ESET PROTECT Hub</b> (o ESET Business Account), con un usuario Superusuario, creá un usuario nuevo solo para esto, por ejemplo <i>api-cyber@accusys.com.ar</i>.</li>
          <li>Dale permiso de <b>solo lectura</b> y activá <b>Integrations</b> en Permisos.</li>
          <li>Aceptá la invitación y entrá una vez con ese usuario a ESET PROTECT Hub.</li>
          <li>Cargá acá su email y contraseña, y la región de tu consola (figura en la dirección, por ejemplo <i>us</i>.protect.eset.com).</li>
        </ol>
        <p className="text-xs text-ink/50 mt-2">La contraseña se guarda cifrada en Supabase Vault y no se vuelve a mostrar.</p>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block"><span className="label">Región</span>
          <select className="input" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })}>
            {REGIONES.map(([k, t]) => <option key={k} value={k}>{t} ({k})</option>)}
          </select></label>
        <label className="block"><span className="label">Usuario de API (email)</span>
          <input className="input" type="email" required value={f.usuario} onChange={(e) => setF({ ...f, usuario: e.target.value })} /></label>
        <label className="block"><span className="label">Contraseña</span>
          <input className="input" type="password" autoComplete="new-password" value={f.password} required={!estado.con_clave}
            placeholder={estado.con_clave ? "Guardada (dejar vacío para no cambiarla)" : ""} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Sincronizar automáticamente cada 10 minutos</label>
      <div className="flex gap-2 items-center">
        <button className="btn-primary" disabled={ocupado}>{ocupado ? "Conectando…" : "Guardar y probar"}</button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.texto}</span>}
      </div>
    </form>
  );
}
