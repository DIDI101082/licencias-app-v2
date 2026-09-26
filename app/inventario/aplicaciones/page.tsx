"use client";

import { Fragment, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { fecha, claseCodigo } from "@/lib/inventario";
import { hace } from "@/lib/monitoreo";

type Vista = "apps" | "equipo" | "cambios";

function csv(nombre: string, cab: string[], filas: (string | number | null)[][]) {
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const texto = [cab, ...filas].map((f) => f.map(esc).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + texto], { type: "text/csv;charset=utf-8" }));
  a.download = nombre;
  a.click();
}

function useDebounce<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

// ---------------- Por aplicación ----------------
function PorAplicacion() {
  const [texto, setTexto] = useState("");
  const q = useDebounce(texto);
  const [filas, setFilas] = useState<any[]>([]);
  const [cargando, setCargando] = useState(true);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [equipos, setEquipos] = useState<any[]>([]);

  useEffect(() => {
    setCargando(true);
    let consulta = createClient().from("inv_v_apps_resumen").select("*").order("equipos", { ascending: false }).order("nombre").limit(500);
    // se limpian comas y paréntesis porque rompen el filtro "or" de Supabase
    const limpio = q.replace(/[,()*%\\]/g, " ").trim();
    if (limpio) consulta = consulta.or(`nombre.ilike.%${limpio}%,editor.ilike.%${limpio}%`);
    consulta.then(({ data }) => { setFilas(data ?? []); setCargando(false); });
  }, [q]);

  async function abrir(nombre: string) {
    if (abierta === nombre) return setAbierta(null);
    setAbierta(nombre);
    setEquipos([]);
    const { data } = await createClient()
      .from("inv_dispositivo_apps")
      .select("version, fecha_instalacion, primera_vez, inv_dispositivos(id, hostname, usuario, inv_equipos(id, codigo))")
      .eq("nombre", nombre)
      .order("version", { ascending: false });
    setEquipos(data ?? []);
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <input type="search" className="input flex-1 min-w-[240px]" placeholder="Buscar aplicación o editor (ej: Chrome, Adobe, Microsoft)"
          value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar aplicación" />
        <button className="btn-secondary" disabled={!filas.length}
          onClick={() => csv("aplicaciones.csv", ["Aplicación", "Editor", "Equipos", "Versiones"],
            filas.map((f) => [f.nombre, f.editor, f.equipos, (f.versiones ?? []).join(", ")]))}>
          Exportar a Excel
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Aplicación</th><th>Equipos</th><th>Versiones</th></tr></thead>
          <tbody>
            {filas.map((f) => (
              <Fragment key={f.nombre}>
                <tr className="hover:bg-line/[0.015] cursor-pointer" onClick={() => abrir(f.nombre)}>
                  <td>
                    <button className="font-medium text-ink hover:underline text-left" aria-expanded={abierta === f.nombre}>{f.nombre}</button>
                    {f.editor && <div className="text-xs text-ink/50">{f.editor}</div>}
                  </td>
                  <td className="font-medium">{f.equipos}</td>
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      {(f.versiones ?? []).slice(-4).reverse().map((v: string) => (
                        <span key={v} className="pill bg-line/[0.05] text-ink/70">{v}</span>
                      ))}
                      {(f.versiones ?? []).length > 4 && <span className="text-xs text-ink/50">+{f.versiones.length - 4}</span>}
                    </div>
                  </td>
                </tr>
                {abierta === f.nombre && (
                  <tr>
                    <td colSpan={3} className="bg-canvas">
                      {equipos.length === 0 ? <span className="text-sm text-ink/50">Cargando…</span> : (
                        <ul className="space-y-1.5 text-sm">
                          {equipos.map((e, i) => (
                            <li key={i} className="flex items-center gap-3 flex-wrap">
                              {e.inv_dispositivos?.inv_equipos
                                ? <Link href={`/inventario/equipos/${e.inv_dispositivos.inv_equipos.id}`} className={claseCodigo(e.inv_dispositivos.inv_equipos.codigo)}>{e.inv_dispositivos.inv_equipos.codigo}</Link>
                                : null}
                              <Link href={`/inventario/aplicaciones?vista=equipo&equipo=${e.inv_dispositivos?.id}`} className="font-medium text-brand-600 hover:underline">
                                {e.inv_dispositivos?.hostname}
                              </Link>
                              <span className="text-ink/50">{e.inv_dispositivos?.usuario ?? ""}</span>
                              <span className="pill bg-surface text-ink/70 border border-line/10">{e.version || "sin versión"}</span>
                              <span className="text-xs text-ink/50">
                                {e.fecha_instalacion ? `Instalada el ${fecha(e.fecha_instalacion)}` : `Detectada ${hace(e.primera_vez)}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={3} className="text-center text-ink/40 py-10">
                {q ? "Ninguna aplicación coincide con la búsqueda." : "Todavía ningún equipo informó sus aplicaciones. Reinstalá el agente (versión 1.1) desde Monitoreo → Instalar agente."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {filas.length === 500 && <p className="text-xs text-ink/50">Se muestran las 500 aplicaciones más instaladas. Usá el buscador para encontrar otras.</p>}
    </div>
  );
}

// ---------------- Por equipo ----------------
function PorEquipo({ inicial }: { inicial: string | null }) {
  const router = useRouter();
  const [dispositivos, setDispositivos] = useState<any[]>([]);
  const [sel, setSel] = useState(inicial ?? "");
  const [apps, setApps] = useState<any[]>([]);
  const [texto, setTexto] = useState("");

  useEffect(() => {
    createClient().from("inv_dispositivos").select("id, hostname, usuario, apps_cantidad, apps_actualizado").eq("estado_registro", "aprobado")
      .order("hostname").then(({ data }) => setDispositivos(data ?? []));
  }, []);

  useEffect(() => {
    if (!sel) return setApps([]);
    createClient().from("inv_dispositivo_apps").select("nombre, version, editor, fecha_instalacion, primera_vez")
      .eq("dispositivo_id", sel).order("nombre").then(({ data }) => setApps(data ?? []));
  }, [sel]);

  const disp = dispositivos.find((d) => d.id === sel);
  const q = texto.toLowerCase();
  const filtradas = apps.filter((a) => !q || a.nombre.toLowerCase().includes(q) || a.editor?.toLowerCase().includes(q));

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <select className="input w-auto min-w-[260px]" value={sel} aria-label="Equipo"
          onChange={(e) => { setSel(e.target.value); router.replace(`/inventario/aplicaciones?vista=equipo&equipo=${e.target.value}`); }}>
          <option value="">Elegí un equipo</option>
          {dispositivos.map((d) => (
            <option key={d.id} value={d.id}>{d.hostname}{d.usuario ? ` · ${d.usuario}` : ""}{d.apps_cantidad != null ? ` (${d.apps_cantidad})` : ""}</option>
          ))}
        </select>
        {sel && <input type="search" className="input flex-1 min-w-[200px]" placeholder="Filtrar aplicaciones" value={texto} onChange={(e) => setTexto(e.target.value)} />}
        {sel && (
          <button className="btn-secondary" disabled={!apps.length}
            onClick={() => csv(`aplicaciones-${disp?.hostname}.csv`, ["Aplicación", "Versión", "Editor", "Instalada"],
              apps.map((a) => [a.nombre, a.version, a.editor, a.fecha_instalacion]))}>
            Exportar a Excel
          </button>
        )}
      </div>
      {disp && (
        <p className="text-sm text-ink/60">
          {disp.apps_actualizado ? `${disp.apps_cantidad} aplicaciones · lista actualizada ${hace(disp.apps_actualizado)}` : "Este equipo todavía no informó sus aplicaciones (necesita el agente 1.1)."}
        </p>
      )}
      {sel && apps.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Aplicación</th><th>Versión</th><th>Instalada</th></tr></thead>
            <tbody>
              {filtradas.map((a) => (
                <tr key={a.nombre + a.version}>
                  <td><span className="text-ink">{a.nombre}</span>{a.editor && <div className="text-xs text-ink/50">{a.editor}</div>}</td>
                  <td className="text-ink/70">{a.version || "—"}</td>
                  <td className="text-ink/60 whitespace-nowrap">{a.fecha_instalacion ? fecha(a.fecha_instalacion) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------- Cambios recientes ----------------
const ACCION: Record<string, string> = {
  instalada: "bg-emerald-50 text-emerald-700",
  desinstalada: "bg-red-50 text-red-600",
  actualizada: "bg-brand-50 text-brand-700",
};

function Cambios() {
  const [filas, setFilas] = useState<any[]>([]);
  const [cargando, setCargando] = useState(true);
  const [accion, setAccion] = useState("");

  useEffect(() => {
    let c = createClient().from("inv_apps_cambios").select("*, inv_dispositivos(id, hostname, usuario)")
      .order("fecha", { ascending: false }).limit(200);
    if (accion) c = c.eq("accion", accion);
    c.then(({ data }) => { setFilas(data ?? []); setCargando(false); });
  }, [accion]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {["", "instalada", "desinstalada", "actualizada"].map((a) => (
          <button key={a} onClick={() => setAccion(a)} aria-pressed={accion === a}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${accion === a ? "bg-surface text-brand-700 shadow-sm" : "text-ink/60 hover:text-ink"}`}>
            {a === "" ? "Todos" : a[0].toUpperCase() + a.slice(1) + "s"}
          </button>
        ))}
      </div>
      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Cuándo</th><th>Equipo</th><th>Aplicación</th><th>Cambio</th></tr></thead>
          <tbody>
            {filas.map((c) => (
              <tr key={c.id}>
                <td className="text-ink/60 whitespace-nowrap">{new Date(c.fecha).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>
                  <Link href={`/inventario/aplicaciones?vista=equipo&equipo=${c.inv_dispositivos?.id}`} className="text-brand-600 hover:underline">{c.inv_dispositivos?.hostname}</Link>
                  {c.inv_dispositivos?.usuario && <div className="text-xs text-ink/50">{c.inv_dispositivos.usuario}</div>}
                </td>
                <td className="text-ink">{c.nombre}</td>
                <td>
                  <span className={`pill ${ACCION[c.accion]}`}>{c.accion[0].toUpperCase() + c.accion.slice(1)}</span>
                  <span className="text-xs text-ink/50 ml-2">
                    {c.accion === "actualizada" ? `${c.version_anterior || "?"} → ${c.version_nueva || "?"}` : c.version_nueva || c.version_anterior || ""}
                  </span>
                </td>
              </tr>
            ))}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={4} className="text-center text-ink/40 py-10">
                Sin cambios registrados todavía. Los cambios aparecen a partir del segundo reporte de cada equipo.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Contenido() {
  const params = useSearchParams();
  const router = useRouter();
  const vista = (params.get("vista") as Vista) || "apps";
  const pestañas: [Vista, string][] = [["apps", "Por aplicación"], ["equipo", "Por equipo"], ["cambios", "Cambios recientes"]];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Aplicaciones instaladas</h1>
        <p className="text-ink/60 text-sm mt-1">
          Informadas por el agente de cada equipo. La lista se envía cuando hay cambios o, como mínimo, una vez por día.
        </p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-line/[0.08]">
        {pestañas.map(([k, t]) => (
          <button key={k} role="tab" aria-selected={vista === k} onClick={() => router.replace(`/inventario/aplicaciones?vista=${k}`)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${vista === k ? "border-brand-600 text-brand-700" : "border-transparent text-ink/60 hover:text-ink"}`}>
            {t}
          </button>
        ))}
      </div>
      {vista === "apps" && <PorAplicacion />}
      {vista === "equipo" && <PorEquipo inicial={params.get("equipo")} />}
      {vista === "cambios" && <Cambios />}
    </div>
  );
}

export default function Aplicaciones() {
  return <Suspense><Contenido /></Suspense>;
}
