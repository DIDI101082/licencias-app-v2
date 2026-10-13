"use client";

import { Fragment, Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { useEstadoProg } from "@/components/TareasProgramadas";
import { calcularIndicadores, nivel, type Kpi } from "@/lib/indicadores";
import { COLOR } from "@/components/indicadores-estilo";

type Control = { id: string; marco: "BCRA" | "ISO27001"; codigo: string; dominio: string; titulo: string; indicadores: string[]; orden: number };
type Evaluacion = { control_id: string; estado: string; responsable: string | null; evidencia: string | null; notas: string | null; justificacion?: string | null; revisado: string | null; proxima: string | null; actualizado: string };
type RiesgoMini = { id: number; codigo: string; titulo: string; nivel: number; nivel_residual: number | null; estado: string; controles: string[] };
type Foto = { fecha: string; avance: number | null; cumple: number; parcial: number; no_cumple: number };
type Cambio = { id: number; fecha: string; estado_anterior: string | null; estado_nuevo: string; usuario_nombre: string | null };

const MARCOS = { BCRA: 'BCRA "A" 7724', ISO27001: "ISO/IEC 27001:2022" } as const;
const ESTADOS: Record<string, { t: string; c: string }> = {
  sin_evaluar: { t: "Sin evaluar", c: "bg-line/[0.05] text-ink/50" }, cumple: { t: "Cumple", c: "bg-emerald-50 text-emerald-700" },
  parcial: { t: "Parcial", c: "bg-amber-500/15 text-amber-700" }, no_cumple: { t: "No cumple", c: "bg-red-50 text-red-700" },
  no_aplica: { t: "No aplica", c: "bg-line/[0.05] text-ink/40" },
};
const orden = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const hoy = () => new Date().toISOString().slice(0, 10);

const fechaCorta = (f: string) => new Date(f + "T12:00").toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" });

// Evolución del nivel de cumplimiento (una foto por día en que hubo cambios)
function Evolucion({ fotos }: { fotos: Foto[] }) {
  const puntos = fotos.filter((f) => f.avance != null);
  if (puntos.length < 2) {
    return <p className="text-sm text-ink/55">El historial se arma solo: cada día que se evalúa un control queda una foto del nivel de cumplimiento. Con dos días o más aparece acá la evolución.</p>;
  }
  const W = 640, H = 150, I = 34, D = 10, A = 16, B = 22;
  const t = puntos.map((f) => new Date(f.fecha + "T12:00").getTime());
  const t0 = t[0], t1 = t[t.length - 1] === t0 ? t0 + 1 : t[t.length - 1];
  const x = (v: number) => I + ((v - t0) / (t1 - t0)) * (W - I - D);
  const y = (v: number) => A + (1 - v / 100) * (H - A - B);
  const linea = puntos.map((f, i) => `${i ? "L" : "M"}${x(t[i]).toFixed(1)},${y(f.avance!).toFixed(1)}`).join(" ");
  const ult = puntos[puntos.length - 1], prim = puntos[0];
  const delta = Math.round((ult.avance! - prim.avance!) * 10) / 10;
  return (
    <div>
      <p className="text-sm text-ink/70">
        {delta === 0 ? "Sin cambios" : <><b className={delta > 0 ? "text-emerald-700" : "text-red-600"}>{delta > 0 ? "+" : ""}{delta} puntos</b></>} desde el {fechaCorta(prim.fecha)} ({prim.avance}% → {ult.avance}%)
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto mt-2" role="img" aria-label={`Nivel de cumplimiento: de ${prim.avance}% el ${fechaCorta(prim.fecha)} a ${ult.avance}% el ${fechaCorta(ult.fecha)}`}>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={I} x2={W - D} y1={y(v)} y2={y(v)} className="stroke-line/20" strokeWidth={1} />
            <text x={I - 6} y={y(v) + 4} textAnchor="end" className="fill-ink/45 text-[11px]">{v}%</text>
          </g>
        ))}
        <text x={I} y={H - 4} className="fill-ink/45 text-[11px]">{fechaCorta(prim.fecha)}</text>
        <text x={W - D} y={H - 4} textAnchor="end" className="fill-ink/45 text-[11px]">{fechaCorta(ult.fecha)}</text>
        <path d={linea} fill="none" className="stroke-brand-600 dark:stroke-brand-300" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {puntos.map((f, i) => (
          <g key={f.fecha}>
            <circle cx={x(t[i])} cy={y(f.avance!)} r={12} fill="transparent"><title>{`${fechaCorta(f.fecha)}: ${f.avance}% · ${f.cumple} cumplen, ${f.parcial} parciales, ${f.no_cumple} no cumplen`}</title></circle>
            <circle cx={x(t[i])} cy={y(f.avance!)} r={4} className="fill-brand-600 dark:fill-brand-300 stroke-surface pointer-events-none" strokeWidth={2} />
          </g>
        ))}
      </svg>
    </div>
  );
}

function Contenido() {
  const { esAdmin, puedeEditar } = usePerfil();
  const { estado: prog, guardar: guardarProg } = useEstadoProg();
  const params = useSearchParams();
  const router = useRouter();
  const marco = (params.get("marco") === "ISO27001" ? "ISO27001" : "BCRA") as keyof typeof MARCOS;
  const [controles, setControles] = useState<Control[]>([]);
  const [evals, setEvals] = useState<Record<string, Evaluacion>>({});
  const [kpis, setKpis] = useState<Kpi[] | null>(null);
  const [filtro, setFiltro] = useState(params.get("estado") ?? "");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Evaluacion>>({});
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [riesgos, setRiesgos] = useState<RiesgoMini[]>([]);
  const [cambios, setCambios] = useState<Cambio[] | null>(null);
  const [historialPorMarco, setHistorialPorMarco] = useState<(Foto & { marco: string })[]>([]);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [c, e] = await Promise.all([sb.from("norma_controles").select("*"), sb.from("norma_evaluacion").select("*")]);
    if (c.error) setError(/norma_/.test(c.error.message) ? "Falta ejecutar supabase/postura.sql en Supabase." : c.error.message);
    setControles(((c.data ?? []) as Control[]).sort((a, b) => a.marco.localeCompare(b.marco) || orden(a.codigo, b.codigo)));
    setEvals(Object.fromEntries(((e.data ?? []) as Evaluacion[]).map((x) => [x.control_id, x])));
    setCargando(false);
    // Registro de riesgos e historial (si todavía no se ejecutó normativa-soa.sql, quedan vacíos)
    const [r, h] = await Promise.all([
      sb.from("norma_riesgos").select("id, codigo, titulo, nivel, nivel_residual, estado, controles"),
      sb.from("norma_historial").select("fecha, marco, avance, cumple, parcial, no_cumple").order("fecha"),
    ]);
    setRiesgos((r.data ?? []) as RiesgoMini[]);
    setHistorialPorMarco((h.data ?? []) as (Foto & { marco: string })[]);
  }, []);
  useEffect(() => { cargar(); calcularIndicadores(createClient()).then(setKpis); }, [cargar]);

  const delMarco = controles.filter((c) => c.marco === marco);
  const est = (id: string) => evals[id]?.estado ?? "sin_evaluar";
  const evaluables = delMarco.filter((c) => est(c.id) !== "no_aplica" && est(c.id) !== "sin_evaluar");
  const avance = evaluables.length ? Math.round((100 * (evaluables.filter((c) => est(c.id) === "cumple").length + 0.5 * evaluables.filter((c) => est(c.id) === "parcial").length)) / evaluables.length) : null;
  const vencidas = delMarco.filter((c) => evals[c.id]?.proxima && evals[c.id]!.proxima! < hoy() && est(c.id) !== "no_aplica");
  const q = texto.trim().toLowerCase();
  const lista = delMarco.filter((c) => (!filtro || (filtro === "vencidas" ? vencidas.includes(c) : est(c.id) === filtro))
    && (!q || `${c.codigo} ${c.titulo} ${c.dominio} ${evals[c.id]?.responsable ?? ""}`.toLowerCase().includes(q)));
  const dominios = Array.from(new Set(lista.map((c) => c.dominio)));
  const kpi = (clave: string) => kpis?.find((k) => k.clave === clave);
  const fotosMarco = historialPorMarco.filter((f) => f.marco === marco);
  const riesgosDe = (id: string) => riesgos.filter((r) => r.controles?.includes(id));

  function abrir(c: Control) {
    if (abierto === c.id) return setAbierto(null);
    const e = evals[c.id];
    setForm({ estado: e?.estado ?? "sin_evaluar", responsable: e?.responsable ?? "", evidencia: e?.evidencia ?? "", notas: e?.notas ?? "", justificacion: e?.justificacion ?? "", revisado: e?.revisado ?? "", proxima: e?.proxima ?? "" });
    setAbierto(c.id);
    setCambios(null);
    createClient().from("norma_cambios").select("id, fecha, estado_anterior, estado_nuevo, usuario_nombre").eq("control_id", c.id).order("fecha", { ascending: false }).limit(8)
      .then(({ data }) => setCambios((data ?? []) as Cambio[]));
  }
  async function guardar(id: string) {
    setError(null);
    const p = { ...form, revisado: form.revisado || (form.estado !== "sin_evaluar" ? hoy() : "") };
    const { error } = await createClient().rpc("norma_guardar", { p_control: id, p });
    if (error) return setError(error.message);
    setAbierto(null); cargar();
  }

  return (
    <div className="space-y-5">
      <style>{`@media print { @page { size: A4; margin: 12mm; } body { background: #fff !important; } .card { box-shadow: none !important; border: 1px solid #ddd !important; } }`}</style>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Normativa</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Matriz de controles de la Comunicación “A” 7724 del BCRA (requisitos de tecnología y seguridad de la información que los bancos
            exigen también a sus proveedores) y del Anexo A de ISO/IEC 27001:2022. Cada control tiene su evaluación, responsable y evidencia,
            y muestra los indicadores de la app que lo respaldan.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          {marco === "ISO27001" && <Link href="/inventario/normativa/soa" className="btn-secondary">Declaración de aplicabilidad</Link>}
          <Link href="/inventario/normativa/riesgos" className="btn-secondary">Registro de riesgos</Link>
          <button className="btn-secondary" onClick={() => window.print()}>Exportar PDF</button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div role="tablist" className="flex gap-1 rounded-xl bg-line/[0.05] p-1 w-fit print:hidden">
        {(Object.keys(MARCOS) as (keyof typeof MARCOS)[]).map((m) => (
          <button key={m} role="tab" aria-selected={marco === m} onClick={() => { router.replace(`/inventario/normativa${m === "BCRA" ? "" : "?marco=ISO27001"}`, { scroll: false }); setAbierto(null); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${marco === m ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>{MARCOS[m]}</button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="card p-4"><div className="text-xs text-ink/50">Nivel de cumplimiento</div>
          <div className={`font-display text-3xl mt-1 ${avance == null ? "text-ink/30" : avance >= 80 ? "text-emerald-700" : avance >= 50 ? "text-amber-700" : "text-red-600"}`}>{avance == null ? "—" : `${avance}%`}</div>
          <div className="text-xs text-ink/50">parciales cuentan la mitad</div></div>
        {(["cumple", "parcial", "no_cumple", "sin_evaluar"] as const).map((k) => (
          <button key={k} onClick={() => setFiltro(filtro === k ? "" : k)} className={`card p-4 text-left hover:border-brand-300 ${filtro === k ? "ring-1 ring-brand-400" : ""}`}>
            <div className="text-xs text-ink/50">{ESTADOS[k].t}</div>
            <div className="font-display text-3xl mt-1 tabular-nums">{delMarco.filter((c) => est(c.id) === k).length}</div>
          </button>
        ))}
      </div>

      <div className="card p-4">
        <div className="text-sm font-medium text-ink">Evolución del cumplimiento</div>
        <div className="mt-1"><Evolucion fotos={fotosMarco} /></div>
      </div>

      <div className="flex flex-wrap gap-2 print:hidden">
        <select className="input w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option>
          {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v.t}</option>)}
          <option value="vencidas">Con revisión vencida ({vencidas.length})</option>
        </select>
        <input type="search" className="input max-w-xs" placeholder="Buscar control o responsable…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
      </div>

      {cargando && <p className="text-sm text-ink/50">Cargando…</p>}
      {dominios.map((d) => (
        <div key={d} className="card overflow-x-auto">
          <div className="px-4 pt-4 font-medium text-ink">{d}</div>
          <table className="data w-full">
            <tbody>
              {lista.filter((c) => c.dominio === d).map((c) => {
                const e = evals[c.id];
                const venc = e?.proxima && e.proxima < hoy() && est(c.id) !== "no_aplica";
                return (
                  <Fragment key={c.id}>
                    <tr className="cursor-pointer hover:bg-line/[0.02]" onClick={() => abrir(c)}>
                      <td className="text-sm font-mono text-ink/60 w-20 align-top">{c.codigo}</td>
                      <td className="text-sm align-top">
                        <div className="font-medium text-ink">{c.titulo}</div>
                        {c.indicadores.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {c.indicadores.map((i) => {
                              const k = kpi(i);
                              if (!k) return null;
                              const n = nivel(k);
                              return <Link key={i} href={k.enlace} onClick={(ev) => ev.stopPropagation()} className={`pill bg-line/[0.04] ${COLOR[n].texto} hover:underline`} title={k.detalle ?? k.titulo}>
                                <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${COLOR[n].punto}`} />{k.titulo}: {k.valor == null ? "sin datos" : `${k.valor}${k.unidad === "%" ? "%" : ""}`}</Link>;
                            })}
                          </div>
                        )}
                      </td>
                      <td className="text-sm text-ink/60 align-top">
                        {e?.responsable ?? ""}
                        {riesgosDe(c.id).length > 0 && <div className="text-xs text-ink/50 mt-0.5">{riesgosDe(c.id).length} riesgo{riesgosDe(c.id).length > 1 ? "s" : ""} vinculado{riesgosDe(c.id).length > 1 ? "s" : ""}</div>}
                      </td>
                      <td className="text-sm whitespace-nowrap align-top">{e?.proxima ? <span className={venc ? "text-red-600 font-medium" : "text-ink/60"}>Revisar {new Date(e.proxima + "T12:00").toLocaleDateString("es-AR")}</span> : ""}</td>
                      <td className="text-right align-top"><span className={`pill ${ESTADOS[est(c.id)].c}`}>{ESTADOS[est(c.id)].t}</span></td>
                    </tr>
                    {abierto === c.id && (
                      <tr>
                        <td colSpan={5} className="bg-line/[0.03]">
                          {puedeEditar ? (
                            <div className="grid sm:grid-cols-4 gap-3 py-2">
                              <label className="block text-sm">Estado
                                <select className="input mt-1" value={form.estado} onChange={(ev) => setForm({ ...form, estado: ev.target.value })}>
                                  {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v.t}</option>)}
                                </select></label>
                              <label className="block text-sm">Responsable<input className="input mt-1" value={form.responsable ?? ""} onChange={(ev) => setForm({ ...form, responsable: ev.target.value })} placeholder="Ciberseguridad, CAU, RRHH…" /></label>
                              <label className="block text-sm">Revisado el<input type="date" className="input mt-1" value={form.revisado ?? ""} onChange={(ev) => setForm({ ...form, revisado: ev.target.value })} /></label>
                              <label className="block text-sm">Próxima revisión<input type="date" className="input mt-1" value={form.proxima ?? ""} onChange={(ev) => setForm({ ...form, proxima: ev.target.value })} /></label>
                              <label className="block text-sm sm:col-span-2">Evidencia (documento, política, enlace, pantalla de la app)
                                <textarea className="input mt-1 min-h-[80px]" value={form.evidencia ?? ""} onChange={(ev) => setForm({ ...form, evidencia: ev.target.value })} /></label>
                              <label className="block text-sm sm:col-span-2">Notas / plan de acción
                                <textarea className="input mt-1 min-h-[80px]" value={form.notas ?? ""} onChange={(ev) => setForm({ ...form, notas: ev.target.value })} /></label>
                              <label className="block text-sm sm:col-span-4">{form.estado === "no_aplica" ? "Por qué se excluye" : "Por qué se incluye"} (Declaración de aplicabilidad)
                                <input className="input mt-1" value={form.justificacion ?? ""} onChange={(ev) => setForm({ ...form, justificacion: ev.target.value })}
                                  placeholder={form.estado === "no_aplica" ? "Ej.: no hay desarrollo de software propio" : "Ej.: riesgo R-003, requisito contractual de clientes bancarios"} /></label>
                              <div className="sm:col-span-4 flex gap-2 justify-end items-center">
                                {e?.actualizado && <span className="text-xs text-ink/45 mr-auto">Última modificación {new Date(e.actualizado).toLocaleString("es-AR")}</span>}
                                <button className="btn-secondary" onClick={() => setAbierto(null)}>Cancelar</button>
                                <button className="btn-primary" onClick={() => guardar(c.id)}>Guardar</button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-sm space-y-1 py-2">
                              <div><b>Evidencia:</b> {e?.evidencia ?? "—"}</div>
                              <div><b>Notas:</b> {e?.notas ?? "—"}</div>
                              {e?.justificacion && <div><b>Justificación:</b> {e.justificacion}</div>}
                            </div>
                          )}
                          <div className="grid sm:grid-cols-2 gap-4 pb-3 text-sm">
                            <div>
                              <div className="text-xs text-ink/50 mb-1">Riesgos vinculados</div>
                              {riesgosDe(c.id).length === 0 ? (
                                <p className="text-ink/55">Ninguno. <Link href={`/inventario/normativa/riesgos?nuevo=${encodeURIComponent(c.id)}`} className="text-brand-700 hover:underline">Registrar un riesgo para este control</Link></p>
                              ) : (
                                <ul className="space-y-1">
                                  {riesgosDe(c.id).map((r) => (
                                    <li key={r.id}><Link href={`/inventario/normativa/riesgos?ver=${r.id}`} className="hover:underline"><span className="font-mono text-ink/55">{r.codigo}</span> {r.titulo}</Link>
                                      <span className="text-ink/50"> · nivel {r.nivel}{r.nivel_residual != null ? ` → ${r.nivel_residual}` : ""}</span></li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <div>
                              <div className="text-xs text-ink/50 mb-1">Historial de cambios</div>
                              {cambios == null ? <p className="text-ink/45">Cargando…</p> : cambios.length === 0 ? <p className="text-ink/55">Sin cambios registrados.</p> : (
                                <ul className="space-y-1">
                                  {cambios.map((x) => (
                                    <li key={x.id} className="text-ink/70">
                                      {new Date(x.fecha).toLocaleDateString("es-AR")} · {x.estado_anterior ? `${ESTADOS[x.estado_anterior]?.t ?? x.estado_anterior} → ` : ""}<b>{ESTADOS[x.estado_nuevo]?.t ?? x.estado_nuevo}</b>
                                      {x.usuario_nombre ? <span className="text-ink/50"> · {x.usuario_nombre}</span> : ""}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {!cargando && !lista.length && <div className="card p-6 text-center text-sm text-ink/50">Ningún control con este filtro.</div>}

      <p className="text-xs text-ink/45">
        Estructura según el texto ordenado del BCRA “Requisitos mínimos para la gestión y control de los riesgos de tecnología y seguridad de la
        información” (actualizado con la Com. “A” 8401) y el Anexo A de ISO/IEC 27001:2022. Los títulos son un resumen: la evaluación se hace
        contra el texto oficial.
      </p>

      {esAdmin && prog && (
        <label className="card p-4 flex items-center gap-2 text-sm print:hidden">
          <input type="checkbox" checked={prog.alertas_normativa} onChange={(e) => guardarProg({ alertas_normativa: e.target.checked })} />
          Enviar alertas: controles que no se cumplen y revisiones vencidas
        </label>
      )}
    </div>
  );
}

export default function Normativa() {
  return <Suspense><Contenido /></Suspense>;
}
