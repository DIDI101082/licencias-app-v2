"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

type Resumen = {
  cpe: string; version: string; aplicacion: string; equipos: number; estado: string | null; consultado: string | null;
  total: number | null; criticas: number | null; altas: number | null; kev: number | null; max_cvss: number | null;
};
type Cve = { id: string; cvss: number | null; severidad: string; kev: boolean; descripcion: string | null; accion: string | null };
type Estado = { activo: boolean; con_clave: boolean; dias_cache: number; ultima_corrida: string | null; ultimo_error: string | null; pendientes: number };
type Producto = { id: number; patron: string; excluir: string | null; cpe: string; version_regex: string; activo: boolean };

const SEV: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white", HIGH: "bg-orange-500/15 text-orange-700", MEDIUM: "bg-amber-500/15 text-amber-700", LOW: "bg-black/[0.05] text-ink/60",
};
const SEV_ES: Record<string, string> = { CRITICAL: "Crítica", HIGH: "Alta", MEDIUM: "Media", LOW: "Baja" };
const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—");

export default function Vulnerabilidades() {
  const { esAdmin } = usePerfil();
  const [filas, setFilas] = useState<Resumen[]>([]);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<{ cves: Cve[]; equipos: { hostname: string; usuario: string | null; aplicacion: string }[] } | null>(null);
  const [filtro, setFiltro] = useState("con");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [config, setConfig] = useState(false);

  const cargar = async () => {
    const sb = createClient();
    const [r, e] = await Promise.all([sb.from("vuln_v_resumen").select("*"), sb.rpc("vuln_estado")]);
    if (r.error) setError(r.error.message.includes("vuln_") ? "Falta ejecutar vulnerabilidades.sql en Supabase." : r.error.message);
    setFilas((r.data ?? []) as Resumen[]);
    setEstado(e.data as Estado);
    setCargando(false);
  };
  useEffect(() => { cargar(); }, []);

  const lista = useMemo(() => filas
    .filter((f) => filtro === "todas" || (filtro === "kev" ? (f.kev ?? 0) > 0 : filtro === "pend" ? !f.estado : (f.total ?? 0) > 0))
    .sort((a, b) => (b.kev ?? 0) - (a.kev ?? 0) || (b.criticas ?? 0) - (a.criticas ?? 0) || (b.max_cvss ?? 0) - (a.max_cvss ?? 0) || b.equipos - a.equipos),
  [filas, filtro]);

  const clave = (f: Resumen) => `${f.cpe}|${f.version}`;
  async function abrir(f: Resumen) {
    const k = clave(f);
    if (abierta === k) { setAbierta(null); return; }
    setAbierta(k); setDetalle(null);
    const sb = createClient();
    const [c, e] = await Promise.all([
      sb.from("vuln_consultas").select("cves").eq("cpe", f.cpe).eq("version", f.version).maybeSingle(),
      sb.from("vuln_v_equipos").select("hostname, usuario, aplicacion").eq("cpe", f.cpe).eq("version", f.version).order("hostname"),
    ]);
    setDetalle({ cves: (c.data?.cves ?? []) as Cve[], equipos: (e.data ?? []) as any[] });
  }

  const conKev = filas.filter((f) => (f.kev ?? 0) > 0);
  const equiposKev = conKev.reduce((s, f) => s + f.equipos, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Vulnerabilidades</h1>
          <p className="text-ink/60 text-sm mt-1">
            Las aplicaciones instaladas se comparan, por versión exacta, con la base oficial de vulnerabilidades (NVD).
            Las marcadas <b>“explotada”</b> están siendo usadas en ataques reales (catálogo KEV de CISA): son las primeras a actualizar.
          </p>
        </div>
        {esAdmin && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}
      {config && esAdmin && <Configuracion estado={estado} onCambio={cargar} />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-4"><div className="text-xs text-ink/50">Versiones con vulnerabilidades explotadas</div><div className={`font-display text-3xl mt-1 ${conKev.length ? "text-red-600" : "text-ink"}`}>{conKev.length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Instalaciones afectadas (explotadas)</div><div className={`font-display text-3xl mt-1 ${equiposKev ? "text-red-600" : "text-ink"}`}>{equiposKev}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Versiones con críticas</div><div className="font-display text-3xl mt-1 text-ink">{filas.filter((f) => (f.criticas ?? 0) > 0).length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Pendientes de analizar</div><div className="font-display text-3xl mt-1 text-ink">{estado?.pendientes ?? "—"}</div>
          <div className="text-xs text-ink/40">última corrida {fh(estado?.ultima_corrida ?? null)}</div></div>
      </div>
      {estado?.ultimo_error && <p className="text-xs text-red-600">{estado.ultimo_error}</p>}

      <div className="flex gap-2 flex-wrap">
        <select className="input w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtro">
          <option value="con">Con vulnerabilidades</option><option value="kev">Solo explotadas activamente</option>
          <option value="pend">Sin analizar todavía</option><option value="todas">Todas las controladas</option>
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Aplicación</th><th>Versión</th><th>Equipos</th><th>Explotadas</th><th>Críticas</th><th>Altas</th><th>Total</th><th>Peor CVSS</th></tr></thead>
          <tbody>
            {lista.map((f) => (
              <Fragment key={clave(f)}>
                <tr className="cursor-pointer hover:bg-black/[0.02]" onClick={() => abrir(f)}>
                  <td className="text-ink font-medium">{abierta === clave(f) ? "▾ " : "▸ "}{f.aplicacion}</td>
                  <td className="font-mono text-xs">{f.version}</td>
                  <td>{f.equipos}</td>
                  <td>{f.estado ? (f.kev ? <span className="pill bg-red-600 text-white">{f.kev}</span> : "0") : <span className="text-ink/40 text-xs">pendiente</span>}</td>
                  <td>{f.estado ? f.criticas : "—"}</td>
                  <td>{f.estado ? f.altas : "—"}</td>
                  <td>{f.estado === "error" ? <span className="text-xs text-red-600">error</span> : f.estado ? f.total : "—"}</td>
                  <td>{f.max_cvss ?? "—"}</td>
                </tr>
                {abierta === clave(f) && (
                  <tr>
                    <td colSpan={8} className="bg-[#F9FAFC]">
                      {!detalle ? <p className="text-sm text-ink/50">Cargando…</p> : (
                        <div className="grid lg:grid-cols-3 gap-4 py-2">
                          <div className="lg:col-span-2">
                            <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">Vulnerabilidades {detalle.cves.length === 50 ? "(las 50 más importantes)" : ""}</div>
                            {detalle.cves.length === 0 ? <p className="text-sm text-ink/50">Ninguna registrada para esta versión.</p> : (
                              <ul className="space-y-2">
                                {detalle.cves.map((c) => (
                                  <li key={c.id} className="text-sm">
                                    <a href={`https://nvd.nist.gov/vuln/detail/${c.id}`} target="_blank" rel="noopener noreferrer" className="font-mono text-brand-700 hover:underline">{c.id}</a>{" "}
                                    {c.kev && <span className="pill bg-red-600 text-white">Explotada</span>}{" "}
                                    <span className={`pill ${SEV[c.severidad] ?? "bg-black/[0.05] text-ink/60"}`}>{SEV_ES[c.severidad] ?? "Sin puntaje"}{c.cvss != null ? ` ${c.cvss}` : ""}</span>
                                    <div className="text-xs text-ink/60 mt-0.5">{c.descripcion}</div>
                                    {c.kev && c.accion && <div className="text-xs text-red-700 mt-0.5">CISA: {c.accion}</div>}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">Equipos con esta versión</div>
                            <ul className="text-sm space-y-0.5">
                              {detalle.equipos.map((e, i) => <li key={i}>{e.hostname} <span className="text-xs text-ink/50">{e.usuario ?? ""}</span></li>)}
                            </ul>
                            <p className="text-xs text-ink/50 mt-3">Solución habitual: actualizar la aplicación a la última versión (o desinstalarla si no se usa).</p>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!cargando && lista.length === 0 && <tr><td colSpan={8} className="text-center text-ink/40 py-10">Nada para mostrar con este filtro.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        La base consulta NVD sola cada 10 minutos, de a pocas versiones, y guarda cada resultado {estado?.dias_cache ?? 7} días.
        Solo se controlan las aplicaciones de la lista de productos (Configurar). Fuente: NVD (NIST) y CISA KEV.
      </p>
    </div>
  );
}

function Configuracion({ estado, onCambio }: { estado: Estado | null; onCambio: () => void }) {
  const [productos, setProductos] = useState<Producto[]>([]);
  const [clave, setClave] = useState("");
  const [nuevo, setNuevo] = useState({ patron: "", cpe: "", excluir: "", version_regex: "^[0-9]+(\\.[0-9]+)*" });
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const sb = createClient();

  const cargar = () => sb.from("vuln_productos").select("*").order("patron").then(({ data }) => setProductos((data ?? []) as Producto[]));
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resultado = (error: any, ok: string) => { setMsg(error ? { ok: false, texto: error.message } : { ok: true, texto: ok }); if (!error) { cargar(); onCambio(); } };

  return (
    <div className="card p-5 space-y-5">
      <div>
        <h2 className="font-display text-lg text-ink">Clave de NVD (opcional)</h2>
        <p className="text-sm text-ink/60">
          Sin clave, NVD permite una consulta cada 6 segundos; con clave es mucho más rápido. Se pide gratis en{" "}
          <a className="text-brand-600 hover:underline" href="https://nvd.nist.gov/developers/request-an-api-key" target="_blank" rel="noopener noreferrer">nvd.nist.gov</a>.
          Estado: {estado?.con_clave ? "configurada" : "sin clave"}.
        </p>
        <div className="flex gap-2 mt-2 flex-wrap">
          <input type="password" autoComplete="off" className="input flex-1 min-w-[240px] font-mono" placeholder="Pegá la clave" value={clave} onChange={(e) => setClave(e.target.value)} />
          <button className="btn-primary" disabled={!clave.trim()} onClick={async () => { const { error } = await sb.rpc("vuln_guardar_clave", { p_clave: clave }); setClave(""); resultado(error, "Clave guardada."); }}>Guardar</button>
          {estado?.con_clave && <button className="btn-secondary" onClick={async () => { const { error } = await sb.rpc("vuln_guardar_clave", { p_clave: null }); resultado(error, "Clave quitada."); }}>Quitar</button>}
          <button className="btn-secondary" onClick={async () => { const { error } = await sb.rpc("vuln_reanalizar"); resultado(error, "Se vuelve a analizar todo en las próximas corridas."); }}>Reanalizar todo</button>
        </div>
      </div>

      <div>
        <h2 className="font-display text-lg text-ink">Aplicaciones controladas</h2>
        <p className="text-sm text-ink/60">
          “Nombre” es como aparece en Inventario → Aplicaciones (% = cualquier texto). “Producto NVD” es fabricante:producto
          según el diccionario CPE (buscalo en <a className="text-brand-600 hover:underline" href="https://nvd.nist.gov/products/cpe/search" target="_blank" rel="noopener noreferrer">nvd.nist.gov/products/cpe</a>).
        </p>
        <div className="overflow-x-auto mt-2">
          <table className="data w-full">
            <thead><tr><th>Nombre</th><th>Excluir</th><th>Producto NVD</th><th>Versión (regex)</th><th></th></tr></thead>
            <tbody>
              {productos.map((p) => (
                <tr key={p.id} className={p.activo ? "" : "opacity-50"}>
                  <td>{p.patron}</td><td className="text-ink/60">{p.excluir ?? "—"}</td>
                  <td className="font-mono text-xs">{p.cpe}</td><td className="font-mono text-xs">{p.version_regex}</td>
                  <td className="whitespace-nowrap text-xs">
                    <button className="text-brand-600 hover:underline mr-3" onClick={async () => { const { error } = await sb.from("vuln_productos").update({ activo: !p.activo }).eq("id", p.id); resultado(error, "Actualizado."); }}>{p.activo ? "Desactivar" : "Activar"}</button>
                    <button className="text-red-600 hover:underline" onClick={async () => { if (!confirm(`¿Quitar ${p.patron}?`)) return; const { error } = await sb.from("vuln_productos").delete().eq("id", p.id); resultado(error, "Quitado."); }}>Quitar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="flex gap-2 flex-wrap mt-3" onSubmit={async (e) => {
          e.preventDefault();
          const { error } = await sb.from("vuln_productos").insert({ patron: nuevo.patron.trim(), cpe: nuevo.cpe.trim().toLowerCase(), excluir: nuevo.excluir.trim() || null, version_regex: nuevo.version_regex.trim() });
          if (!error) setNuevo({ ...nuevo, patron: "", cpe: "", excluir: "" });
          resultado(error, "Agregado: se analiza en las próximas corridas.");
        }}>
          <input className="input w-48" required placeholder="Nombre (ej. Zoom%)" value={nuevo.patron} onChange={(e) => setNuevo({ ...nuevo, patron: e.target.value })} />
          <input className="input w-36" placeholder="Excluir (opcional)" value={nuevo.excluir} onChange={(e) => setNuevo({ ...nuevo, excluir: e.target.value })} />
          <input className="input w-56 font-mono" required placeholder="fabricante:producto" value={nuevo.cpe} onChange={(e) => setNuevo({ ...nuevo, cpe: e.target.value })} />
          <input className="input w-44 font-mono" required value={nuevo.version_regex} onChange={(e) => setNuevo({ ...nuevo, version_regex: e.target.value })} aria-label="Versión (regex)" />
          <button className="btn-primary">Agregar</button>
        </form>
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.texto}</p>}
    </div>
  );
}
