"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { calcularIndicadores, nivel, type Kpi } from "@/lib/indicadores";
import { COLOR } from "@/components/indicadores-estilo";

export default function Cumplimiento() {
  const [kpis, setKpis] = useState<Kpi[] | null>(null);
  const [fecha] = useState(new Date());

  useEffect(() => {
    calcularIndicadores(createClient()).then(setKpis);
  }, []);

  const areas = kpis ? Array.from(new Set(kpis.map((k) => k.area))) : [];
  const medidos = (kpis ?? []).filter((k) => nivel(k) !== "nd");
  const puntaje = medidos.length ? Math.round((medidos.filter((k) => nivel(k) === "ok").length / medidos.length) * 100) : null;
  const fechaTxt = fecha.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "long", timeStyle: "short" });

  return (
    <div className="space-y-5">
      <style>{`@media print {
        @page { size: A4; margin: 14mm; }
        body { background: #fff !important; }
        .card { break-inside: avoid; box-shadow: none !important; border: 1px solid #ddd !important; }
        a { color: inherit !important; text-decoration: none !important; }
      }`}</style>

      <div className="hidden print:block border-b pb-3 mb-2">
        <div className="text-xs uppercase tracking-wide text-ink/50">Accusys Technology · Ciberseguridad y Tecnología</div>
        <div className="font-display text-2xl text-ink">Reporte de cumplimiento de seguridad</div>
        <div className="text-sm text-ink/60">{fechaTxt}</div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="font-display text-2xl text-ink">Cumplimiento</h1>
          <p className="text-ink/60 text-sm mt-1">
            Resumen de la postura de seguridad en indicadores con meta, para gerencia o auditorías de clientes.
            Se calcula en el momento con los datos de todos los módulos.
          </p>
        </div>
        <button className="btn-primary" onClick={() => window.print()} disabled={!kpis}>Exportar PDF</button>
      </div>

      {!kpis ? <p className="text-sm text-ink/50">Calculando…</p> : (
        <>
          <div className="grid md:grid-cols-3 gap-3">
            <div className="card p-5">
              <div className="text-xs text-ink/50">Indicadores que cumplen la meta</div>
              <div className={`font-display text-5xl mt-1 ${puntaje == null ? "text-ink/30" : puntaje >= 80 ? "text-emerald-700" : puntaje >= 60 ? "text-amber-600" : "text-red-600"}`}>{puntaje == null ? "—" : `${puntaje}%`}</div>
              <div className="text-xs text-ink/50 mt-1">{medidos.filter((k) => nivel(k) === "ok").length} de {medidos.length} medidos{kpis.length > medidos.length ? ` · ${kpis.length - medidos.length} sin datos` : ""}</div>
            </div>
            <div className="card p-5 md:col-span-2">
              <div className="text-xs text-ink/50 mb-2">A resolver primero</div>
              {kpis.filter((k) => nivel(k) === "mal").length === 0 ? <p className="text-sm text-emerald-700">Ningún indicador está fuera de meta.</p> : (
                <ul className="space-y-1 text-sm">
                  {kpis.filter((k) => nivel(k) === "mal").map((k) => (
                    <li key={k.clave} className="flex gap-2"><span className="text-red-600">●</span>
                      <Link href={k.enlace} className="text-ink hover:text-brand-700">{k.titulo}: <b>{k.valor}{k.unidad === "%" ? "%" : ""}</b> <span className="text-ink/50">(meta {k.menorEsMejor ? "≤ " : "≥ "}{k.meta}{k.unidad === "%" ? "%" : ""})</span></Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {areas.map((a) => (
            <div key={a}>
              <h2 className="font-display text-lg text-ink mb-2">{a}</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {kpis.filter((k) => k.area === a).map((k) => {
                  const n = nivel(k);
                  return (
                    <Link key={k.clave} href={k.enlace} className={`card p-4 border-l-4 ${COLOR[n].borde} hover:ring-1 hover:ring-line/20`}>
                      <div className="flex justify-between gap-2">
                        <div className="text-sm text-ink/80">{k.titulo}</div>
                        <span className={`text-xs whitespace-nowrap ${COLOR[n].texto}`}>{COLOR[n].etiqueta}</span>
                      </div>
                      <div className={`font-display text-3xl mt-1 ${COLOR[n].texto}`}>{k.valor == null ? "—" : `${k.valor}${k.unidad === "%" ? "%" : ""}`}</div>
                      <div className="text-xs text-ink/50 mt-1">
                        Meta: {k.menorEsMejor ? (k.meta === 0 ? "ninguno" : `≤ ${k.meta}`) : `≥ ${k.meta}${k.unidad === "%" ? "%" : ""}`}
                        {k.valor == null && k.sinDatos ? ` · ${k.sinDatos}` : k.detalle ? ` · ${k.detalle}` : ""}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-xs text-ink/40">
            Metas sugeridas según buenas prácticas (CIS Controls / ISO 27001); ajustalas en <code>lib/indicadores.ts</code> si tu política define otras.
            Generado el {fechaTxt}.
          </p>
        </>
      )}
    </div>
  );
}
