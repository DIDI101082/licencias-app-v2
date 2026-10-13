"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

// Registro de riesgos de seguridad de la información (ISO/IEC 27001, cláusulas 6.1.2, 6.1.3 y 8.2-8.3):
// cada riesgo con su valoración (probabilidad × impacto), plan de tratamiento, riesgo residual
// y los controles de Normativa que lo tratan.

type Riesgo = {
  id: number; codigo: string; titulo: string; descripcion: string | null; activo: string | null; amenaza: string | null; vulnerabilidad: string | null;
  probabilidad: number; impacto: number; nivel: number; tratamiento: string; plan: string | null; responsable: string | null; fecha_objetivo: string | null;
  estado: string; prob_residual: number | null; impacto_residual: number | null; nivel_residual: number | null;
  aceptado_por: string | null; aceptado_en: string | null; controles: string[]; actualizado: string;
};
type Control = { id: string; marco: string; codigo: string; titulo: string };
type Form = Partial<Omit<Riesgo, "probabilidad" | "impacto" | "prob_residual" | "impacto_residual">> & {
  probabilidad?: number | string; impacto?: number | string; prob_residual?: number | string | null; impacto_residual?: number | string | null;
};

const TRATAMIENTOS: Record<string, string> = { mitigar: "Mitigar", aceptar: "Aceptar", transferir: "Transferir", evitar: "Evitar" };
const ESTADOS: Record<string, string> = { identificado: "Identificado", en_tratamiento: "En tratamiento", tratado: "Tratado", aceptado: "Aceptado", cerrado: "Cerrado" };
const ESCALA = ["", "Muy baja", "Baja", "Media", "Alta", "Muy alta"];
const ESCALA_I = ["", "Muy bajo", "Bajo", "Medio", "Alto", "Muy alto"];

// Niveles de riesgo (probabilidad × impacto, de 1 a 25)
function nivelDe(n: number | null) {
  if (n == null) return null;
  if (n >= 15) return { t: "Crítico", c: "bg-red-50 text-red-700", celda: "bg-red-500/25" };
  if (n >= 10) return { t: "Alto", c: "bg-orange-50 text-orange-700", celda: "bg-orange-400/25" };
  if (n >= 5) return { t: "Medio", c: "bg-amber-500/15 text-amber-700", celda: "bg-amber-400/20" };
  return { t: "Bajo", c: "bg-emerald-50 text-emerald-700", celda: "bg-emerald-500/15" };
}
function Nivel({ n }: { n: number | null }) {
  const v = nivelDe(n);
  return v ? <span className={`pill ${v.c} tabular-nums`}>{n} · {v.t}</span> : <span className="text-ink/40">—</span>;
}
const hoy = () => new Date().toISOString().slice(0, 10);
const abierto = (r: Riesgo) => !["tratado", "aceptado", "cerrado"].includes(r.estado);
const orden = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function Mapa({ riesgos, residual, celda, onCelda }: { riesgos: Riesgo[]; residual: boolean; celda: string | null; onCelda: (c: string | null) => void }) {
  const cuenta = (p: number, i: number) =>
    riesgos.filter((r) => (residual ? r.prob_residual === p && r.impacto_residual === i : r.probabilidad === p && r.impacto === i)).length;
  return (
    <div className="flex gap-2">
      <div className="flex items-center"><span className="text-xs text-ink/50 [writing-mode:vertical-rl] rotate-180">Impacto</span></div>
      <div className="flex-1">
        <div className="grid grid-cols-[3.5rem_repeat(5,minmax(0,1fr))] gap-1">
          {[5, 4, 3, 2, 1].map((i) => (
            <div key={i} className="contents">
              <div className="text-[11px] text-ink/50 flex items-center justify-end pr-1 text-right leading-tight">{ESCALA_I[i]}</div>
              {[1, 2, 3, 4, 5].map((p) => {
                const n = cuenta(p, i), clave = `${p}-${i}`, sel = celda === clave;
                return (
                  <button key={p} onClick={() => onCelda(sel ? null : clave)} disabled={!n}
                    title={`Probabilidad ${ESCALA[p].toLowerCase()} × impacto ${ESCALA_I[i].toLowerCase()} = ${p * i} (${nivelDe(p * i)!.t}): ${n} riesgo${n === 1 ? "" : "s"}`}
                    className={`h-11 rounded-md text-sm font-medium tabular-nums ${nivelDe(p * i)!.celda} ${n ? "text-ink hover:ring-1 hover:ring-ink/30" : "text-transparent"} ${sel ? "ring-2 ring-brand-500" : ""}`}>
                    {n || "·"}
                  </button>
                );
              })}
            </div>
          ))}
          <div />
          {[1, 2, 3, 4, 5].map((p) => <div key={p} className="text-[11px] text-ink/50 text-center leading-tight pt-1">{ESCALA[p]}</div>)}
        </div>
        <div className="text-xs text-ink/50 text-center mt-1">Probabilidad</div>
      </div>
    </div>
  );
}

function Contenido() {
  const { esAdmin, puedeEditar } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const [riesgos, setRiesgos] = useState<Riesgo[]>([]);
  const [controles, setControles] = useState<Control[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [buscaControl, setBuscaControl] = useState("");
  const [filtro, setFiltro] = useState("abiertos");
  const [residual, setResidual] = useState(false);
  const [celda, setCelda] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [r, c] = await Promise.all([
      sb.from("norma_riesgos").select("*").order("nivel", { ascending: false }),
      sb.from("norma_controles").select("id, marco, codigo, titulo"),
    ]);
    if (r.error) setError(/norma_riesgos/.test(r.error.message) ? "Falta ejecutar supabase/normativa-soa.sql en Supabase." : r.error.message);
    setRiesgos((r.data ?? []) as Riesgo[]);
    setControles(((c.data ?? []) as Control[]).sort((a, b) => b.marco.localeCompare(a.marco) || orden(a.codigo, b.codigo)));
    setCargando(false);
    return (r.data ?? []) as Riesgo[];
  }, []);

  // ?nuevo=<control> abre el alta con ese control; ?ver=<id> abre ese riesgo
  useEffect(() => {
    cargar().then((lista) => {
      const nuevo = params.get("nuevo"), ver = Number(params.get("ver"));
      if (nuevo) setForm({ probabilidad: 3, impacto: 3, tratamiento: "mitigar", estado: "identificado", controles: [nuevo] });
      else if (ver) { const r = lista.find((x) => x.id === ver); if (r) setForm(r); }
    });
  }, [cargar, params]);

  const ctrl = useMemo(() => new Map(controles.map((c) => [c.id, c])), [controles]);
  const base = riesgos.filter((r) => filtro === "todos" || (filtro === "abiertos" ? r.estado !== "cerrado" : filtro === "vencidos"
    ? abierto(r) && !!r.fecha_objetivo && r.fecha_objetivo < hoy() : r.estado === filtro));
  const lista = base.filter((r) => {
    if (!celda) return true;
    const [p, i] = celda.split("-").map(Number);
    return residual ? r.prob_residual === p && r.impacto_residual === i : r.probabilidad === p && r.impacto === i;
  });
  const vigentes = riesgos.filter((r) => r.estado !== "cerrado");
  const vencidos = riesgos.filter((r) => abierto(r) && r.fecha_objetivo && r.fecha_objetivo < hoy());

  function cerrarForm() {
    setForm(null); setBuscaControl("");
    if (params.get("nuevo") || params.get("ver")) router.replace("/inventario/normativa/riesgos", { scroll: false });
  }
  async function guardar() {
    if (!form) return;
    setError(null);
    const { error } = await createClient().rpc("norma_riesgo_guardar", { p_id: form.id ?? null, p: form });
    if (error) return setError(error.message);
    cerrarForm(); cargar();
  }
  async function borrar(id: number) {
    if (!window.confirm("¿Borrar este riesgo del registro? No se puede deshacer.")) return;
    const { error } = await createClient().rpc("norma_riesgo_borrar", { p_id: id });
    if (error) return setError(error.message);
    cerrarForm(); cargar();
  }
  const set = (k: keyof Form, v: unknown) => setForm((f) => ({ ...(f ?? {}), [k]: v }));
  const nivelForm = Number(form?.probabilidad || 0) * Number(form?.impacto || 0);
  const residualForm = form?.prob_residual && form?.impacto_residual ? Number(form.prob_residual) * Number(form.impacto_residual) : null;
  const q = buscaControl.trim().toLowerCase();
  const candidatos = q ? controles.filter((c) => !form?.controles?.includes(c.id) && `${c.codigo} ${c.titulo}`.toLowerCase().includes(q)).slice(0, 8) : [];

  return (
    <div className="space-y-5">
      <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } body { background: #fff !important; } .card { box-shadow: none !important; border: 1px solid #ddd !important; } }`}</style>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/inventario/normativa" className="text-sm text-ink/50 hover:text-ink print:hidden">← Normativa</Link>
          <h1 className="font-display text-2xl text-ink mt-1">Registro de riesgos</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Riesgos de seguridad de la información con su valoración, plan de tratamiento y riesgo residual. Cada riesgo se vincula a los
            controles de ISO 27001 o del BCRA que lo tratan; la Declaración de aplicabilidad los toma de acá.
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          {puedeEditar && !form && <button className="btn-primary" onClick={() => setForm({ probabilidad: 3, impacto: 3, tratamiento: "mitigar", estado: "identificado", controles: [] })}>Nuevo riesgo</button>}
          <button className="btn-secondary" onClick={() => window.print()}>Exportar PDF</button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {form && (
        <div className="card p-4 space-y-3 print:hidden">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-medium text-ink">{form.id ? `${form.codigo} · Editar riesgo` : "Nuevo riesgo"}</h2>
            {!puedeEditar && <span className="text-xs text-ink/50">Solo lectura</span>}
          </div>
          <fieldset disabled={!puedeEditar} className="grid sm:grid-cols-4 gap-3">
            <label className="block text-sm sm:col-span-4">Riesgo<input className="input mt-1" value={form.titulo ?? ""} onChange={(e) => set("titulo", e.target.value)} placeholder="Ej.: Cifrado de servidores por ransomware" /></label>
            <label className="block text-sm sm:col-span-2">Activo afectado<input className="input mt-1" value={form.activo ?? ""} onChange={(e) => set("activo", e.target.value)} placeholder="Servidores de producción, base de clientes…" /></label>
            <label className="block text-sm">Amenaza<input className="input mt-1" value={form.amenaza ?? ""} onChange={(e) => set("amenaza", e.target.value)} placeholder="Ransomware" /></label>
            <label className="block text-sm">Vulnerabilidad<input className="input mt-1" value={form.vulnerabilidad ?? ""} onChange={(e) => set("vulnerabilidad", e.target.value)} placeholder="Parches atrasados" /></label>
            <label className="block text-sm sm:col-span-4">Descripción<textarea className="input mt-1 min-h-[60px]" value={form.descripcion ?? ""} onChange={(e) => set("descripcion", e.target.value)} /></label>

            <label className="block text-sm">Probabilidad
              <select className="input mt-1" value={form.probabilidad ?? 3} onChange={(e) => set("probabilidad", Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {ESCALA[n]}</option>)}
              </select></label>
            <label className="block text-sm">Impacto
              <select className="input mt-1" value={form.impacto ?? 3} onChange={(e) => set("impacto", Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {ESCALA_I[n]}</option>)}
              </select></label>
            <div className="text-sm"><div>Nivel inherente</div><div className="mt-2"><Nivel n={nivelForm || null} /></div></div>
            <label className="block text-sm">Tratamiento
              <select className="input mt-1" value={form.tratamiento ?? "mitigar"} onChange={(e) => set("tratamiento", e.target.value)}>
                {Object.entries(TRATAMIENTOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></label>

            <label className="block text-sm sm:col-span-4">Plan de tratamiento (acciones)
              <textarea className="input mt-1 min-h-[70px]" value={form.plan ?? ""} onChange={(e) => set("plan", e.target.value)}
                placeholder={"1. Parches críticos en 7 días\n2. Backup inmutable fuera de línea\n3. EDR en todos los servidores"} /></label>
            <label className="block text-sm">Responsable<input className="input mt-1" value={form.responsable ?? ""} onChange={(e) => set("responsable", e.target.value)} placeholder="CAU Servidores" /></label>
            <label className="block text-sm">Fecha objetivo<input type="date" className="input mt-1" value={form.fecha_objetivo ?? ""} onChange={(e) => set("fecha_objetivo", e.target.value)} /></label>
            <label className="block text-sm">Estado
              <select className="input mt-1" value={form.estado ?? "identificado"} onChange={(e) => set("estado", e.target.value)}>
                {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></label>
            <span />

            <label className="block text-sm">Probabilidad residual
              <select className="input mt-1" value={form.prob_residual ?? ""} onChange={(e) => set("prob_residual", e.target.value)}>
                <option value="">Sin valorar</option>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {ESCALA[n]}</option>)}
              </select></label>
            <label className="block text-sm">Impacto residual
              <select className="input mt-1" value={form.impacto_residual ?? ""} onChange={(e) => set("impacto_residual", e.target.value)}>
                <option value="">Sin valorar</option>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {ESCALA_I[n]}</option>)}
              </select></label>
            <div className="text-sm"><div>Nivel residual</div><div className="mt-2"><Nivel n={residualForm} /></div></div>
            <span />
            <label className="block text-sm sm:col-span-2">Riesgo residual aceptado por<input className="input mt-1" value={form.aceptado_por ?? ""} onChange={(e) => set("aceptado_por", e.target.value)} placeholder="Dueño del riesgo (nombre y cargo)" /></label>
            <label className="block text-sm">Fecha de aceptación<input type="date" className="input mt-1" value={form.aceptado_en ?? ""} onChange={(e) => set("aceptado_en", e.target.value)} /></label>
            <span />

            <div className="sm:col-span-4 text-sm">
              Controles que lo tratan
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {(form.controles ?? []).map((id) => (
                  <span key={id} className="pill bg-line/[0.05] text-ink/80">
                    {ctrl.get(id) ? `${ctrl.get(id)!.marco === "ISO27001" ? "ISO" : "BCRA"} ${ctrl.get(id)!.codigo} · ${ctrl.get(id)!.titulo}` : id}
                    <button type="button" className="ml-1.5 text-ink/45 hover:text-red-600" aria-label={`Quitar ${id}`} onClick={() => set("controles", (form.controles ?? []).filter((x) => x !== id))}>×</button>
                  </span>
                ))}
                {!(form.controles ?? []).length && <span className="text-ink/45">Ninguno todavía.</span>}
              </div>
              <input className="input mt-2 max-w-md" value={buscaControl} onChange={(e) => setBuscaControl(e.target.value)} placeholder="Buscar control para agregar (ej.: 8.7, malware, backup)…" aria-label="Buscar control" />
              {candidatos.length > 0 && (
                <ul className="mt-1 max-w-md rounded-md border border-line/10 divide-y divide-line/10">
                  {candidatos.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="w-full text-left px-3 py-1.5 hover:bg-line/[0.04]" onClick={() => { set("controles", [...(form.controles ?? []), c.id]); setBuscaControl(""); }}>
                        <span className="font-mono text-ink/55">{c.marco === "ISO27001" ? "ISO" : "BCRA"} {c.codigo}</span> {c.titulo}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </fieldset>
          <div className="flex gap-2 justify-end items-center">
            {form.id && form.actualizado && <span className="text-xs text-ink/45 mr-auto">Última modificación {new Date(form.actualizado).toLocaleString("es-AR")}</span>}
            {esAdmin && form.id && <button className="text-sm text-red-600 hover:underline mr-2" onClick={() => borrar(form.id!)}>Borrar</button>}
            <button className="btn-secondary" onClick={cerrarForm}>{puedeEditar ? "Cancelar" : "Cerrar"}</button>
            {puedeEditar && <button className="btn-primary" onClick={guardar}>Guardar</button>}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4">
        <div className="grid grid-cols-2 gap-3 content-start">
          <div className="card p-4"><div className="text-xs text-ink/50">Riesgos vigentes</div><div className="font-display text-3xl mt-1 tabular-nums">{vigentes.length}</div></div>
          <div className="card p-4"><div className="text-xs text-ink/50">Críticos o altos</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${vigentes.some((r) => r.nivel >= 10) ? "text-red-600" : ""}`}>{vigentes.filter((r) => r.nivel >= 10).length}</div>
            <div className="text-xs text-ink/50">nivel inherente 10 o más</div></div>
          <div className="card p-4"><div className="text-xs text-ink/50">En tratamiento</div><div className="font-display text-3xl mt-1 tabular-nums">{riesgos.filter((r) => r.estado === "en_tratamiento").length}</div></div>
          <button className={`card p-4 text-left hover:border-brand-300 ${filtro === "vencidos" ? "ring-1 ring-brand-400" : ""}`} onClick={() => setFiltro(filtro === "vencidos" ? "abiertos" : "vencidos")}>
            <div className="text-xs text-ink/50">Plan vencido</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${vencidos.length ? "text-red-600" : ""}`}>{vencidos.length}</div>
            <div className="text-xs text-ink/50">pasó la fecha objetivo</div></button>
        </div>
        <div className="card p-4">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <div className="text-sm font-medium text-ink">Mapa de calor</div>
            <div role="tablist" className="flex gap-1 rounded-lg bg-line/[0.05] p-0.5 text-xs print:hidden">
              {[["Inherente", false], ["Residual", true]].map(([t, v]) => (
                <button key={String(t)} role="tab" aria-selected={residual === v} onClick={() => { setResidual(v as boolean); setCelda(null); }}
                  className={`px-2 py-1 rounded-md ${residual === v ? "bg-surface text-ink shadow-sm" : "text-ink/55"}`}>{t as string}</button>
              ))}
            </div>
          </div>
          <Mapa riesgos={base} residual={residual} celda={celda} onCelda={setCelda} />
          <p className="text-xs text-ink/50 mt-2">Tocá una celda para ver esos riesgos. Bajo 1-4 · Medio 5-9 · Alto 10-14 · Crítico 15-25.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center print:hidden">
        <select className="input w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Estado">
          <option value="abiertos">Vigentes (sin los cerrados)</option>
          <option value="todos">Todos</option>
          {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="vencidos">Con el plan vencido</option>
        </select>
        {celda && <button className="text-sm text-brand-700 hover:underline" onClick={() => setCelda(null)}>Quitar filtro del mapa</button>}
      </div>

      {cargando ? <p className="text-sm text-ink/50">Cargando…</p> : !lista.length ? (
        <div className="card p-6 text-center text-sm text-ink/55">
          {riesgos.length ? "Ningún riesgo con este filtro." : "Todavía no hay riesgos cargados. Empezá por los activos más importantes: servidores de producción, datos de clientes, accesos privilegiados."}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr><th>Riesgo</th><th>Inherente</th><th>Tratamiento</th><th>Responsable</th><th>Fecha objetivo</th><th>Residual</th><th>Estado</th><th>Controles</th></tr>
            </thead>
            <tbody>
              {lista.map((r) => {
                const venc = abierto(r) && r.fecha_objetivo && r.fecha_objetivo < hoy();
                return (
                  <tr key={r.id} className="cursor-pointer hover:bg-line/[0.02] align-top" onClick={() => { setForm(r); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                    <td><div className="font-medium text-ink"><span className="font-mono text-ink/50">{r.codigo}</span> {r.titulo}</div>
                      {(r.activo || r.amenaza) && <div className="text-xs text-ink/50">{[r.activo, r.amenaza].filter(Boolean).join(" · ")}</div>}</td>
                    <td className="whitespace-nowrap"><Nivel n={r.nivel} /></td>
                    <td>{TRATAMIENTOS[r.tratamiento]}</td>
                    <td className="text-ink/70">{r.responsable ?? "—"}</td>
                    <td className={`whitespace-nowrap ${venc ? "text-red-600 font-medium" : "text-ink/70"}`}>{r.fecha_objetivo ? new Date(r.fecha_objetivo + "T12:00").toLocaleDateString("es-AR") : "—"}</td>
                    <td className="whitespace-nowrap"><Nivel n={r.nivel_residual} /></td>
                    <td>{ESTADOS[r.estado]}</td>
                    <td className="text-xs text-ink/60">{r.controles?.length ? r.controles.map((id) => ctrl.get(id) ? `${ctrl.get(id)!.marco === "ISO27001" ? "ISO" : "BCRA"} ${ctrl.get(id)!.codigo}` : id).join(", ") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Riesgos() {
  return <Suspense><Contenido /></Suspense>;
}
