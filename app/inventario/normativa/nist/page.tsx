"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

// ── Tipos ────────────────────────────────────────────────────────
type Eval = {
  categoria_id: string;
  nivel: number;
  responsable: string | null;
  evidencia: string | null;
  notas: string | null;
  actualizado: string;
};
type Ev = { label: string; href: string };
type Cat = { id: string; nombre: string; evidencias: Ev[] };
type Fun = { id: string; nombre: string; desc: string; hex: string; categorias: Cat[] };

// ── Niveles de madurez ───────────────────────────────────────────
const NIVELES = [
  { n: 0, t: "Sin evaluar", c: "bg-line/[0.05] text-ink/40", desc: "" },
  { n: 1, t: "Inicial",    c: "bg-red-50 text-red-700",          desc: "Reactivo, sin procesos formales" },
  { n: 2, t: "Definido",   c: "bg-amber-50 text-amber-700",      desc: "Procesos definidos, parcialmente implementados" },
  { n: 3, t: "Gestionado", c: "bg-blue-50 text-blue-700",        desc: "Implementado y medido sistemáticamente" },
  { n: 4, t: "Optimizado", c: "bg-emerald-50 text-emerald-700",  desc: "Mejora continua, completamente integrado" },
];

// ── Framework NIST CSF 2.0 ───────────────────────────────────────
const FNS: Fun[] = [
  {
    id: "GV", nombre: "Govern", hex: "#7c3aed",
    desc: "Define el contexto organizacional, la estrategia de riesgos, las políticas y los roles de ciberseguridad.",
    categorias: [
      { id: "GV.OC", nombre: "Contexto organizacional",          evidencias: [{ label: "Proyectos / OKRs",   href: "/inicio" }, { label: "Cumplimiento", href: "/inventario/cumplimiento" }] },
      { id: "GV.RM", nombre: "Estrategia de riesgos",            evidencias: [{ label: "Registro de riesgos", href: "/inventario/normativa/riesgos" }] },
      { id: "GV.RR", nombre: "Roles y responsabilidades",        evidencias: [{ label: "Usuarios", href: "/usuarios" }, { label: "Normativa", href: "/inventario/normativa" }] },
      { id: "GV.PO", nombre: "Políticas",                        evidencias: [{ label: "Normativa BCRA",  href: "/inventario/normativa" }, { label: "ISO 27001 SOA", href: "/inventario/normativa/soa" }] },
      { id: "GV.OV", nombre: "Supervisión",                      evidencias: [{ label: "Cumplimiento", href: "/inventario/cumplimiento" }, { label: "Auditoría", href: "/auditoria" }] },
      { id: "GV.SC", nombre: "Cadena de suministro",             evidencias: [{ label: "Vencimientos",  href: "/vencimientos" }, { label: "Catálogos", href: "/inventario/catalogos" }] },
    ],
  },
  {
    id: "ID", nombre: "Identify", hex: "#2563eb",
    desc: "Comprende los activos, vulnerabilidades y riesgos del entorno para priorizar la gestión de ciberseguridad.",
    categorias: [
      { id: "ID.AM", nombre: "Gestión de activos",    evidencias: [{ label: "Equipos",    href: "/inventario/equipos" }, { label: "Servidores",  href: "/servidores" }, { label: "Celulares", href: "/celulares" }, { label: "Aplicaciones", href: "/inventario/aplicaciones" }, { label: "Superficie", href: "/inventario/superficie" }] },
      { id: "ID.RA", nombre: "Evaluación de riesgos", evidencias: [{ label: "Qualys",     href: "/inventario/qualys" }, { label: "Riesgos",     href: "/inventario/normativa/riesgos" }, { label: "Vulnerabilidades", href: "/inventario/vulnerabilidades" }] },
      { id: "ID.IM", nombre: "Mejora continua",        evidencias: [{ label: "Cumplimiento", href: "/inventario/cumplimiento" }, { label: "Incidentes", href: "/inventario/incidentes" }] },
    ],
  },
  {
    id: "PR", nombre: "Protect", hex: "#059669",
    desc: "Implementa salvaguardas para limitar el impacto de eventos de ciberseguridad.",
    categorias: [
      { id: "PR.AA", nombre: "Identidad y control de acceso", evidencias: [{ label: "Active Directory", href: "/inventario/ad" }, { label: "Apps Entra ID", href: "/inventario/apps-entra" }, { label: "Identidad", href: "/inventario/identidad" }] },
      { id: "PR.AT", nombre: "Concientización y capacitación", evidencias: [{ label: "Phishing / Concientización", href: "/inventario/concientizacion" }] },
      { id: "PR.DS", nombre: "Seguridad de datos",              evidencias: [{ label: "Backups servidores", href: "/servidores/backups" }, { label: "Backups inventario", href: "/inventario/backups" }, { label: "Correo", href: "/inventario/correo" }] },
      { id: "PR.PS", nombre: "Seguridad de plataformas",        evidencias: [{ label: "Qualys", href: "/inventario/qualys" }, { label: "Vulnerabilidades", href: "/inventario/vulnerabilidades" }, { label: "Parches", href: "/servidores/parches" }, { label: "Seguridad", href: "/inventario/seguridad" }] },
      { id: "PR.IR", nombre: "Resiliencia de infraestructura",  evidencias: [{ label: "Fortigate / HA", href: "/red/fortigate" }, { label: "UPS", href: "/servidores/ups" }, { label: "Grupo electrógeno", href: "/servidores/grupo-electrogeno" }, { label: "Virtualización", href: "/servidores/virtualizacion" }] },
    ],
  },
  {
    id: "DE", nombre: "Detect", hex: "#d97706",
    desc: "Ejecuta actividades continuas para detectar e identificar eventos de ciberseguridad.",
    categorias: [
      { id: "DE.CM", nombre: "Monitoreo continuo",          evidencias: [{ label: "Monitoreo", href: "/inventario/monitoreo" }, { label: "Qualys", href: "/inventario/qualys" }, { label: "Secure Score", href: "/inventario/securescore" }, { label: "Cloudflare", href: "/inventario/cloudflare" }] },
      { id: "DE.AE", nombre: "Análisis de eventos adversos", evidencias: [{ label: "Alertas auditoría", href: "/auditoria/alertas" }, { label: "Incidentes", href: "/inventario/incidentes" }, { label: "Forti EMS", href: "/red/forti-ems" }] },
    ],
  },
  {
    id: "RS", nombre: "Respond", hex: "#ea580c",
    desc: "Desarrolla e implementa actividades de respuesta ante incidentes de ciberseguridad detectados.",
    categorias: [
      { id: "RS.MA", nombre: "Gestión de incidentes",   evidencias: [{ label: "Incidentes", href: "/inventario/incidentes" }] },
      { id: "RS.AN", nombre: "Análisis de incidentes",  evidencias: [{ label: "Incidentes", href: "/inventario/incidentes" }, { label: "Auditoría", href: "/auditoria" }] },
      { id: "RS.CO", nombre: "Comunicación",             evidencias: [{ label: "Incidentes", href: "/inventario/incidentes" }] },
      { id: "RS.MI", nombre: "Mitigación",               evidencias: [{ label: "Vulnerabilidades", href: "/inventario/vulnerabilidades" }, { label: "Qualys", href: "/inventario/qualys" }] },
    ],
  },
  {
    id: "RC", nombre: "Recover", hex: "#0d9488",
    desc: "Mantiene planes de resiliencia y restaura las capacidades afectadas por incidentes.",
    categorias: [
      { id: "RC.RP", nombre: "Plan de recuperación",      evidencias: [{ label: "Backups servidores", href: "/servidores/backups" }, { label: "Virtualización", href: "/servidores/virtualizacion" }] },
      { id: "RC.CO", nombre: "Comunicación de recuperación", evidencias: [{ label: "Incidentes", href: "/inventario/incidentes" }] },
    ],
  },
];

// ── Radar SVG ────────────────────────────────────────────────────
function Radar({ evals }: { evals: Record<string, Eval> }) {
  const n = FNS.length;
  const cx = 200, cy = 200, r = 140;

  const pts = FNS.map((f, i) => {
    const ang = (i * 2 * Math.PI) / n - Math.PI / 2;
    const cats = f.categorias;
    const sum = cats.reduce((a, c) => a + (evals[c.id]?.nivel ?? 0), 0);
    const evaluated = cats.filter((c) => (evals[c.id]?.nivel ?? 0) > 0).length;
    const avg = evaluated > 0 ? sum / cats.length : 0;
    const fac = avg / 4;
    return {
      x: cx + r * fac * Math.cos(ang),
      y: cy + r * fac * Math.sin(ang),
      ax: cx + (r + 32) * Math.cos(ang),
      ay: cy + (r + 32) * Math.sin(ang),
      f,
      avg,
    };
  });

  const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const grid = (lv: number) =>
    FNS.map((_, i) => {
      const a = (i * 2 * Math.PI) / n - Math.PI / 2;
      return `${(cx + r * (lv / 4) * Math.cos(a)).toFixed(1)},${(cy + r * (lv / 4) * Math.sin(a)).toFixed(1)}`;
    }).join(" ");

  return (
    <svg
      viewBox="0 0 400 400"
      className="w-full max-w-xs mx-auto"
      role="img"
      aria-label="Radar de madurez NIST CSF 2.0 por función"
    >
      {/* Grid */}
      {[1, 2, 3, 4].map((lv) => (
        <polygon key={lv} points={grid(lv)} fill="none" className="stroke-line/20" strokeWidth={1} />
      ))}
      {/* Level labels on rightmost axis */}
      {[1, 2, 3, 4].map((lv) => (
        <text
          key={lv}
          x={(cx + r * (lv / 4) * Math.cos(0) + 4).toFixed(1)}
          y={(cy + r * (lv / 4) * Math.sin(0) - 3).toFixed(1)}
          fontSize="9"
          className="fill-ink/40"
        >
          T{lv}
        </text>
      ))}
      {/* Axes */}
      {FNS.map((_, i) => {
        const a = (i * 2 * Math.PI) / n - Math.PI / 2;
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={(cx + r * Math.cos(a)).toFixed(1)}
            y2={(cy + r * Math.sin(a)).toFixed(1)}
            className="stroke-line/20"
            strokeWidth={1}
          />
        );
      })}
      {/* Data */}
      <polygon points={poly} fill="rgba(99,102,241,0.15)" stroke="rgba(99,102,241,0.7)" strokeWidth={2} />
      {/* Points + labels */}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={5} fill="rgba(99,102,241,0.85)" />
          <text
            x={p.ax.toFixed(1)}
            y={(p.ay + 4).toFixed(1)}
            textAnchor="middle"
            fontSize="13"
            fontWeight="700"
            className="fill-ink"
            style={{ fill: p.f.hex }}
          >
            {p.f.id}
          </text>
          <text
            x={p.ax.toFixed(1)}
            y={(p.ay + 17).toFixed(1)}
            textAnchor="middle"
            fontSize="9"
            className="fill-ink/50"
          >
            {p.avg > 0 ? p.avg.toFixed(1) : "—"}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ── Página principal ─────────────────────────────────────────────
export default function NistPage() {
  const { puedeEditar } = usePerfil();
  const [evals, setEvals] = useState<Record<string, Eval>>({});
  const [abierto, setAbierto] = useState<string | null>(null);
  const [form, setForm] = useState({ nivel: 0, responsable: "", evidencia: "", notas: "" });
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const { data, error: err } = await sb.from("nist_evaluacion").select("*");
    if (err) {
      setError(
        /nist_evaluacion/.test(err.message)
          ? "Falta ejecutar supabase/nist.sql en Supabase."
          : err.message
      );
    } else {
      setEvals(Object.fromEntries(((data ?? []) as Eval[]).map((e) => [e.categoria_id, e])));
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  function abrir(cat: Cat) {
    if (abierto === cat.id) return setAbierto(null);
    const e = evals[cat.id];
    setForm({
      nivel: e?.nivel ?? 0,
      responsable: e?.responsable ?? "",
      evidencia: e?.evidencia ?? "",
      notas: e?.notas ?? "",
    });
    setAbierto(cat.id);
  }

  async function guardar(catId: string) {
    setGuardando(true);
    setError(null);
    const { error: err } = await createClient()
      .from("nist_evaluacion")
      .upsert({ categoria_id: catId, ...form, actualizado: new Date().toISOString() });
    setGuardando(false);
    if (err) return setError(err.message);
    setAbierto(null);
    cargar();
  }

  const nivelInfo = (n: number) => NIVELES.find((l) => l.n === n) ?? NIVELES[0];

  // Promedio por función
  const resumen = FNS.map((f) => {
    const vals = f.categorias.map((c) => evals[c.id]?.nivel ?? 0);
    const evaluated = vals.filter((v) => v > 0);
    const avg = evaluated.length > 0 ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    return { f, avg };
  });

  // Madurez global: promedio de todas las categorías evaluadas
  const allVals = FNS.flatMap((f) => f.categorias.map((c) => evals[c.id]?.nivel ?? 0)).filter((v) => v > 0);
  const madurezGlobal = allVals.length > 0 ? (allVals.reduce((a, v) => a + v, 0) / FNS.flatMap((f) => f.categorias).length).toFixed(1) : null;

  const totalCats = FNS.flatMap((f) => f.categorias).length;
  const evaluadas = FNS.flatMap((f) => f.categorias).filter((c) => (evals[c.id]?.nivel ?? 0) > 0).length;

  return (
    <div className="space-y-5">
      <style>{`
        @media print {
          @page { size: A4; margin: 12mm; }
          body { background: #fff !important; }
          .card { box-shadow: none !important; border: 1px solid #ddd !important; break-inside: avoid; }
          .no-print { display: none !important; }
          a { color: inherit !important; text-decoration: none !important; }
        }
      `}</style>

      {/* Print header */}
      <div className="hidden print:block border-b pb-3 mb-4">
        <div className="text-xs uppercase tracking-wide text-ink/50">
          Accusys Technology · Ciberseguridad y Tecnología
        </div>
        <div className="font-display text-2xl text-ink">Marco NIST CSF 2.0 — Evaluación de Madurez</div>
        <div className="text-sm text-ink/60">
          {new Date().toLocaleDateString("es-AR", { dateStyle: "long" })} · Preparado para presentación al Comité
        </div>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 no-print">
        <div>
          <h1 className="font-display text-2xl text-ink">NIST CSF 2.0</h1>
          <p className="text-sm text-ink/60 mt-1 max-w-3xl">
            Nivel de madurez de Accusys Technology según el{" "}
            <a
              href="https://www.nist.gov/cyberframework"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 hover:underline"
            >
              NIST Cybersecurity Framework 2.0
            </a>
            . Cada categoría está mapeada a los módulos de la app que sirven como evidencia de implementación.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/inventario/normativa" className="btn-secondary">
            ← Normativa
          </Link>
          <button className="btn-secondary" onClick={() => window.print()}>
            Exportar PDF
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* KPI global + resumen por función */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <div className="card p-4 col-span-1">
          <div className="text-xs text-ink/50">Madurez global</div>
          <div
            className={`font-display text-3xl mt-1 ${
              madurezGlobal == null
                ? "text-ink/30"
                : +madurezGlobal >= 3
                ? "text-emerald-700"
                : +madurezGlobal >= 2
                ? "text-amber-700"
                : "text-red-600"
            }`}
          >
            {madurezGlobal ?? "—"}
          </div>
          <div className="text-xs text-ink/50 mt-0.5">
            {evaluadas}/{totalCats} categorías
          </div>
        </div>
        {resumen.map(({ f, avg }) => {
          const level = avg != null ? Math.round(avg) : 0;
          const ni = nivelInfo(level);
          return (
            <div key={f.id} className="card p-4 text-center">
              <div className="text-xs font-mono font-bold" style={{ color: f.hex }}>
                {f.id}
              </div>
              <div
                className={`font-display text-2xl mt-0.5 ${
                  avg == null
                    ? "text-ink/30"
                    : avg >= 3
                    ? "text-emerald-700"
                    : avg >= 2
                    ? "text-amber-700"
                    : "text-red-600"
                }`}
              >
                {avg != null ? avg.toFixed(1) : "—"}
              </div>
              <div className="text-xs text-ink/55 mt-0.5 truncate">{f.nombre}</div>
              {avg != null && (
                <span className={`pill mt-1 text-xs ${ni.c}`}>T{ni.n}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Radar + leyenda */}
      {!cargando && (
        <div className="card p-4">
          <div className="text-sm font-medium text-ink mb-1">Madurez por función</div>
          <div className="grid md:grid-cols-2 gap-4 items-center">
            <Radar evals={evals} />
            <div className="space-y-2">
              <p className="text-sm text-ink/60">
                Niveles de madurez basados en los Tiers del NIST CSF. El polígono refleja el promedio de
                todas las categorías de cada función.
              </p>
              <div className="grid grid-cols-1 gap-1.5">
                {NIVELES.filter((l) => l.n > 0).map((l) => (
                  <div key={l.n} className="flex items-start gap-2 text-sm">
                    <span className={`pill shrink-0 ${l.c}`}>T{l.n}</span>
                    <span className="text-ink/70">
                      <b>{l.t}</b>
                      {l.desc ? ` — ${l.desc}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Por función: acordeón de categorías */}
      {FNS.map((f) => (
        <div key={f.id} className="card overflow-hidden">
          {/* Función header */}
          <div className="px-4 py-3 border-b border-line/10 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-xl font-bold" style={{ color: f.hex }}>
              {f.id}
            </span>
            <span className="font-semibold text-ink">{f.nombre}</span>
            <span className="text-sm text-ink/55 hidden sm:inline">— {f.desc}</span>
            {(() => {
              const { avg } = resumen.find((r) => r.f.id === f.id)!;
              if (avg == null) return null;
              const ni = nivelInfo(Math.round(avg));
              return (
                <span className={`pill ml-auto text-xs ${ni.c}`}>
                  Promedio {avg.toFixed(1)} · {ni.t}
                </span>
              );
            })()}
          </div>

          <table className="data w-full">
            <tbody>
              {f.categorias.map((cat) => {
                const e = evals[cat.id];
                const ni = nivelInfo(e?.nivel ?? 0);
                return (
                  <Fragment key={cat.id}>
                    <tr
                      className="cursor-pointer hover:bg-line/[0.02]"
                      onClick={() => abrir(cat)}
                    >
                      <td className="text-sm font-mono text-ink/50 w-20 align-top">
                        {cat.id}
                      </td>
                      <td className="text-sm align-top">
                        <div className="font-medium text-ink">{cat.nombre}</div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {cat.evidencias.map((ev) => (
                            <Link
                              key={ev.href}
                              href={ev.href}
                              onClick={(ev2) => ev2.stopPropagation()}
                              className="pill bg-brand-50 text-brand-700 hover:bg-brand-100 text-xs no-print"
                            >
                              {ev.label}
                            </Link>
                          ))}
                          {/* Print: show as plain text */}
                          <span className="hidden print:inline text-xs text-ink/55">
                            {cat.evidencias.map((ev) => ev.label).join(" · ")}
                          </span>
                        </div>
                      </td>
                      <td className="text-sm text-ink/60 align-top hidden sm:table-cell">
                        {e?.responsable ?? ""}
                      </td>
                      <td className="text-right align-top">
                        <span className={`pill ${ni.c}`}>
                          {ni.n === 0 ? "Sin evaluar" : `T${ni.n} · ${ni.t}`}
                        </span>
                      </td>
                    </tr>

                    {/* Edición expandida */}
                    {abierto === cat.id && (
                      <tr className="no-print">
                        <td colSpan={4} className="bg-line/[0.03]">
                          {puedeEditar ? (
                            <div className="grid sm:grid-cols-2 gap-3 py-3 px-2">
                              <label className="block text-sm sm:col-span-1">
                                Nivel de madurez
                                <select
                                  className="input mt-1"
                                  value={form.nivel}
                                  onChange={(ev) =>
                                    setForm({ ...form, nivel: +ev.target.value })
                                  }
                                >
                                  {NIVELES.map((l) => (
                                    <option key={l.n} value={l.n}>
                                      {l.n === 0
                                        ? "Sin evaluar"
                                        : `T${l.n}: ${l.t}${l.desc ? ` — ${l.desc}` : ""}`}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="block text-sm sm:col-span-1">
                                Responsable
                                <input
                                  className="input mt-1"
                                  value={form.responsable}
                                  onChange={(ev) =>
                                    setForm({ ...form, responsable: ev.target.value })
                                  }
                                  placeholder="Ciberseguridad, IT…"
                                />
                              </label>
                              <label className="block text-sm sm:col-span-2">
                                Evidencia (documentos, políticas, módulos de la app, registros…)
                                <textarea
                                  className="input mt-1 min-h-[72px]"
                                  value={form.evidencia}
                                  onChange={(ev) =>
                                    setForm({ ...form, evidencia: ev.target.value })
                                  }
                                />
                              </label>
                              <label className="block text-sm sm:col-span-2">
                                Notas / Plan de mejora
                                <textarea
                                  className="input mt-1 min-h-[72px]"
                                  value={form.notas}
                                  onChange={(ev) =>
                                    setForm({ ...form, notas: ev.target.value })
                                  }
                                />
                              </label>
                              <div className="sm:col-span-2 flex gap-2 justify-end items-center">
                                {e?.actualizado && (
                                  <span className="text-xs text-ink/45 mr-auto">
                                    Actualizado{" "}
                                    {new Date(e.actualizado).toLocaleDateString("es-AR")}
                                  </span>
                                )}
                                <button
                                  className="btn-secondary"
                                  onClick={() => setAbierto(null)}
                                >
                                  Cancelar
                                </button>
                                <button
                                  className="btn-primary"
                                  onClick={() => guardar(cat.id)}
                                  disabled={guardando}
                                >
                                  {guardando ? "Guardando…" : "Guardar"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-sm space-y-1 py-2 px-2">
                              <div>
                                <b>Evidencia:</b> {e?.evidencia ?? "—"}
                              </div>
                              <div>
                                <b>Notas:</b> {e?.notas ?? "—"}
                              </div>
                            </div>
                          )}
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

      <p className="text-xs text-ink/45 print:mt-6">
        Basado en NIST Cybersecurity Framework 2.0 (febrero 2024). Los niveles T1–T4 son una adaptación
        operativa de los Tiers oficiales del NIST (Partial → Risk Informed → Repeatable → Adaptive) para
        facilitar la evaluación y el seguimiento interno. Generado el{" "}
        {new Date().toLocaleDateString("es-AR", { dateStyle: "long" })}.
      </p>
    </div>
  );
}
