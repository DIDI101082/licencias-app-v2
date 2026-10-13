"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

// Declaración de Aplicabilidad (SoA) de ISO/IEC 27001:2022: los 93 controles del Anexo A, si se aplican,
// por qué, cómo está su implementación y qué riesgos tratan. Se imprime o se guarda como PDF desde el navegador.

type Control = { id: string; codigo: string; dominio: string; titulo: string };
type Evaluacion = { control_id: string; estado: string; responsable: string | null; evidencia: string | null; justificacion: string | null; revisado: string | null };
type Soa = { organizacion: string; alcance: string | null; version: string; aprobado_por: string | null; aprobado_en: string | null; actualizado: string };
type Riesgo = { codigo: string; controles: string[] };

const IMPLEMENTACION: Record<string, string> = {
  cumple: "Implementado", parcial: "Parcialmente implementado", no_cumple: "No implementado", sin_evaluar: "Sin evaluar", no_aplica: "—",
};
const orden = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const fecha = (f: string | null) => (f ? new Date(f + "T12:00").toLocaleDateString("es-AR") : "—");

export default function DeclaracionAplicabilidad() {
  const { esAdmin } = usePerfil();
  const [controles, setControles] = useState<Control[]>([]);
  const [evals, setEvals] = useState<Record<string, Evaluacion>>({});
  const [soa, setSoa] = useState<Soa | null>(null);
  const [riesgos, setRiesgos] = useState<Riesgo[]>([]);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState<Partial<Soa>>({});
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [c, e, s, r] = await Promise.all([
      sb.from("norma_controles").select("id, codigo, dominio, titulo").eq("marco", "ISO27001"),
      sb.from("norma_evaluacion").select("control_id, estado, responsable, evidencia, justificacion, revisado"),
      sb.from("norma_soa").select("*").eq("id", 1).maybeSingle(),
      sb.from("norma_riesgos").select("codigo, controles").neq("estado", "cerrado"),
    ]);
    if (s.error || e.error) setError("Falta ejecutar supabase/normativa-soa.sql en Supabase.");
    setControles(((c.data ?? []) as Control[]).sort((a, b) => orden(a.codigo, b.codigo)));
    setEvals(Object.fromEntries(((e.data ?? []) as Evaluacion[]).map((x) => [x.control_id, x])));
    setSoa((s.data as Soa) ?? null);
    setRiesgos((r.data ?? []) as Riesgo[]);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  async function guardar() {
    setError(null);
    const { error } = await createClient().rpc("norma_soa_guardar", { p: form });
    if (error) return setError(error.message);
    setEditando(false); cargar();
  }

  const est = (id: string) => evals[id]?.estado ?? "sin_evaluar";
  const aplican = controles.filter((c) => est(c.id) !== "no_aplica");
  const excluidos = controles.length - aplican.length;
  const sinJustificar = controles.filter((c) => !evals[c.id]?.justificacion).length;
  const riesgosDe = (id: string) => riesgos.filter((r) => r.controles?.includes(id)).map((r) => r.codigo);
  const dominios = Array.from(new Set(controles.map((c) => c.dominio)));

  return (
    <div className="space-y-5">
      <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } body { background: #fff !important; } .card { box-shadow: none !important; border: 1px solid #ddd !important; } tr { break-inside: avoid; } }`}</style>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/inventario/normativa?marco=ISO27001" className="text-sm text-ink/50 hover:text-ink print:hidden">← Normativa</Link>
          <h1 className="font-display text-2xl text-ink mt-1">Declaración de Aplicabilidad</h1>
          <p className="text-ink/60 text-sm mt-1">ISO/IEC 27001:2022, Anexo A · {soa?.organizacion ?? "Accusys Technology"}</p>
        </div>
        <div className="flex gap-2 print:hidden">
          {esAdmin && soa && !editando && <button className="btn-secondary" onClick={() => { setForm(soa); setEditando(true); }}>Editar datos del documento</button>}
          <button className="btn-primary" onClick={() => window.print()}>Exportar PDF</button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {editando ? (
        <div className="card p-4 grid sm:grid-cols-4 gap-3 print:hidden">
          <label className="block text-sm sm:col-span-2">Organización<input className="input mt-1" value={form.organizacion ?? ""} onChange={(e) => setForm({ ...form, organizacion: e.target.value })} /></label>
          <label className="block text-sm">Versión<input className="input mt-1" value={form.version ?? ""} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
          <span />
          <label className="block text-sm sm:col-span-4">Alcance del SGSI
            <textarea className="input mt-1 min-h-[70px]" value={form.alcance ?? ""} onChange={(e) => setForm({ ...form, alcance: e.target.value })}
              placeholder="Ej.: servicios de desarrollo, implementación y soporte de la Plataforma Core para entidades financieras, desde las oficinas de Buenos Aires y Córdoba" /></label>
          <label className="block text-sm sm:col-span-2">Aprobado por<input className="input mt-1" value={form.aprobado_por ?? ""} onChange={(e) => setForm({ ...form, aprobado_por: e.target.value })} placeholder="Nombre y cargo" /></label>
          <label className="block text-sm">Fecha de aprobación<input type="date" className="input mt-1" value={form.aprobado_en ?? ""} onChange={(e) => setForm({ ...form, aprobado_en: e.target.value })} /></label>
          <div className="flex items-end justify-end gap-2">
            <button className="btn-secondary" onClick={() => setEditando(false)}>Cancelar</button>
            <button className="btn-primary" onClick={guardar}>Guardar</button>
          </div>
        </div>
      ) : soa && (
        <div className="card p-4 grid sm:grid-cols-4 gap-x-6 gap-y-2 text-sm">
          <div className="sm:col-span-4"><div className="text-xs text-ink/50">Alcance</div><div className="whitespace-pre-wrap">{soa.alcance || <span className="text-ink/45">Sin definir</span>}</div></div>
          <div><div className="text-xs text-ink/50">Versión</div>{soa.version}</div>
          <div><div className="text-xs text-ink/50">Aprobado por</div>{soa.aprobado_por || "—"}</div>
          <div><div className="text-xs text-ink/50">Fecha de aprobación</div>{fecha(soa.aprobado_en)}</div>
          <div><div className="text-xs text-ink/50">Última modificación</div>{new Date(soa.actualizado).toLocaleDateString("es-AR")}</div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-4"><div className="text-xs text-ink/50">Controles del Anexo A</div><div className="font-display text-3xl mt-1 tabular-nums">{controles.length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Aplicables</div><div className="font-display text-3xl mt-1 tabular-nums">{aplican.length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Excluidos</div><div className="font-display text-3xl mt-1 tabular-nums">{excluidos}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Sin justificación</div>
          <div className={`font-display text-3xl mt-1 tabular-nums ${sinJustificar ? "text-amber-700" : "text-emerald-700"}`}>{sinJustificar}</div>
          <div className="text-xs text-ink/50 print:hidden">se completa en Normativa</div></div>
      </div>

      {dominios.map((d) => (
        <div key={d} className="card overflow-x-auto">
          <div className="px-4 pt-4 font-medium text-ink">{d}</div>
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th className="w-16">Control</th>
                <th>Título</th>
                <th className="w-20">¿Aplica?</th>
                <th>Justificación</th>
                <th className="w-40">Implementación</th>
                <th>Evidencia</th>
                <th className="w-24">Riesgos</th>
              </tr>
            </thead>
            <tbody>
              {controles.filter((c) => c.dominio === d).map((c) => {
                const e = evals[c.id];
                const aplica = est(c.id) !== "no_aplica";
                return (
                  <tr key={c.id} className="align-top">
                    <td className="font-mono text-ink/60">{c.codigo}</td>
                    <td className="text-ink">{c.titulo}</td>
                    <td className={aplica ? "" : "text-ink/50"}>{aplica ? "Sí" : "No"}</td>
                    <td className={e?.justificacion ? "text-ink/75" : "text-amber-700"}>{e?.justificacion || "Falta justificar"}</td>
                    <td className="text-ink/75">{aplica ? IMPLEMENTACION[est(c.id)] : "—"}{e?.revisado && aplica ? <div className="text-xs text-ink/45">revisado {fecha(e.revisado)}</div> : null}</td>
                    <td className="text-ink/65 whitespace-pre-wrap">{e?.evidencia || "—"}</td>
                    <td className="font-mono text-xs text-ink/60">{riesgosDe(c.id).join(", ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <p className="text-xs text-ink/45">
        La justificación, la implementación y la evidencia de cada control se cargan en Normativa → ISO/IEC 27001:2022. Los riesgos vinculados salen
        del Registro de riesgos (no se listan los cerrados). Los títulos de los controles son un resumen: la declaración se hace contra el texto oficial.
      </p>
    </div>
  );
}
