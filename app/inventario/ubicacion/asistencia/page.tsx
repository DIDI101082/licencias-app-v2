"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

const ZONA = "America/Argentina/Buenos_Aires";
const DIAS = ["Lun", "Mar", "Mié", "Jue", "Vie"];

type Dia = { fecha: string; estado: "oficina" | "home" | "sin_datos" | "feriado" | "justificado"; sede: string | null; detalle: string | null };
type Fila = { empleado_id: string; empleado: string; area: string | null; dias: Dia[] };
type Resultado = "cumple" | "no_cumple" | "en_curso" | "sin_datos";

// Fechas como texto AAAA-MM-DD (sin problemas de zona horaria)
const hoyAR = () => new Date().toLocaleDateString("en-CA", { timeZone: ZONA });
const sumarDias = (f: string, n: number) => {
  const d = new Date(f + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const lunesDe = (f: string) => {
  const dia = new Date(f + "T12:00:00Z").getUTCDay(); // 0 domingo
  return sumarDias(f, dia === 0 ? -6 : 1 - dia);
};
const corta = (f: string) => f.slice(8, 10) + "/" + f.slice(5, 7);

const CELDA: Record<Dia["estado"], { texto: string; clase: string }> = {
  oficina: { texto: "Oficina", clase: "bg-brand-50 text-brand-700" },
  home: { texto: "Home", clase: "bg-emerald-50 text-emerald-700" },
  sin_datos: { texto: "—", clase: "text-ink/30" },
  feriado: { texto: "Feriado", clase: "bg-line/[0.05] text-ink/50" },
  justificado: { texto: "Justif.", clase: "bg-violet-50 text-violet-700" },
};
const RESULTADO: Record<Resultado, { texto: string; clase: string }> = {
  cumple: { texto: "Cumple", clase: "bg-emerald-50 text-emerald-700" },
  no_cumple: { texto: "No cumple", clase: "bg-red-50 text-red-600" },
  en_curso: { texto: "En curso", clase: "bg-amber-500/10 text-amber-700" },
  sin_datos: { texto: "Sin datos", clase: "bg-line/[0.05] text-ink/50" },
};

function evaluarSemana(dias: Dia[], requeridosPolitica: number, hoy: string) {
  const oficina = dias.filter((d) => d.estado === "oficina").length;
  const home = dias.filter((d) => d.estado === "home").length;
  const disponibles = dias.filter((d) => d.estado !== "feriado" && d.estado !== "justificado").length;
  const requeridos = Math.min(requeridosPolitica, disponibles);
  const viernes = dias[dias.length - 1]?.fecha ?? "";
  const terminada = viernes < hoy;
  let resultado: Resultado;
  if (oficina >= requeridos) resultado = "cumple";
  else if (!terminada) resultado = "en_curso";
  else if (oficina + home === 0) resultado = "sin_datos";
  else resultado = "no_cumple";
  return { oficina, home, requeridos, resultado };
}

export default function Asistencia() {
  const { esAdmin, puedeEditar } = usePerfil();
  const hoy = hoyAR();
  const [lunes, setLunes] = useState(lunesDe(hoy));
  const [filas, setFilas] = useState<Fila[]>([]);
  const [politica, setPolitica] = useState(3);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState("");
  const [soloIncumplen, setSoloIncumplen] = useState(false);
  const [feriados, setFeriados] = useState<{ fecha: string; nombre: string }[]>([]);
  const [nuevoFeriado, setNuevoFeriado] = useState({ fecha: "", nombre: "" });
  const [verConfig, setVerConfig] = useState(false);

  const cargar = async () => {
    setCargando(true); setError(null);
    const sb = createClient();
    const [a, c, f] = await Promise.all([
      sb.rpc("inv_asistencia", { p_desde: sumarDias(lunes, -21), p_hasta: sumarDias(lunes, 4) }),
      sb.from("asistencia_config").select("dias_oficina_semana").eq("id", 1).maybeSingle(),
      sb.from("asistencia_feriados").select("*").order("fecha", { ascending: false }).limit(30),
    ]);
    if (a.error) setError(a.error.message.includes("inv_asistencia") ? "Falta ejecutar asistencia.sql en Supabase." : a.error.message);
    setFilas((a.data ?? []) as Fila[]);
    if (c.data) setPolitica(c.data.dias_oficina_semana);
    setFeriados(f.data ?? []);
    setCargando(false);
  };
  useEffect(() => { cargar(); }, [lunes]);

  const semanas = [sumarDias(lunes, -21), sumarDias(lunes, -14), sumarDias(lunes, -7), lunes];
  const evaluadas = useMemo(() => filas.map((p) => {
    const porSemana = semanas.map((l) => evaluarSemana(p.dias.filter((d) => d.fecha >= l && d.fecha <= sumarDias(l, 4)), politica, hoy));
    const actual = porSemana[3];
    const cerradas = porSemana.filter((s) => s.resultado === "cumple" || s.resultado === "no_cumple");
    return {
      ...p,
      semana: p.dias.filter((d) => d.fecha >= lunes && d.fecha <= sumarDias(lunes, 4)),
      actual,
      historial: { cumplidas: cerradas.filter((s) => s.resultado === "cumple").length, total: cerradas.length },
    };
  }), [filas, politica, lunes]);

  const areas = Array.from(new Set(filas.map((f) => f.area).filter(Boolean))) as string[];
  const visibles = evaluadas.filter((p) => (!area || p.area === area) && (!soloIncumplen || p.actual.resultado === "no_cumple"));
  const cuenta = (r: Resultado) => evaluadas.filter((p) => (!area || p.area === area) && p.actual.resultado === r).length;

  async function justificar(p: Fila, d: Dia) {
    if (!puedeEditar) return;
    const sb = createClient();
    if (d.estado === "justificado") {
      if (!confirm(`¿Quitar la justificación del ${corta(d.fecha)} de ${p.empleado}?`)) return;
      const { error } = await sb.from("asistencia_excepciones").delete().eq("empleado_id", p.empleado_id).eq("fecha", d.fecha);
      if (error) return setError(error.message);
    } else if (d.estado !== "feriado") {
      const motivo = prompt(`Justificar el ${corta(d.fecha)} de ${p.empleado}.\nMotivo (vacaciones, licencia, viaje…):`);
      if (!motivo?.trim()) return;
      const { error } = await sb.from("asistencia_excepciones").insert({ empleado_id: p.empleado_id, fecha: d.fecha, motivo: motivo.trim() });
      if (error) return setError(error.message);
    }
    cargar();
  }

  async function guardarPolitica(n: number) {
    const { error } = await createClient().from("asistencia_config").update({ dias_oficina_semana: n }).eq("id", 1);
    if (error) return setError(error.message);
    setPolitica(n);
  }
  async function agregarFeriado(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await createClient().from("asistencia_feriados").insert(nuevoFeriado);
    if (error) return setError(error.code === "23505" ? "Ese día ya está cargado como feriado." : error.message);
    setNuevoFeriado({ fecha: "", nombre: "" }); cargar();
  }
  async function quitarFeriado(fecha: string) {
    await createClient().from("asistencia_feriados").delete().eq("fecha", fecha); cargar();
  }

  async function exportar() {
    const writeExcelFile = (await import("write-excel-file/browser")).default;
    const cab = ["Persona", "Área", ...DIAS.map((d, i) => `${d} ${corta(sumarDias(lunes, i))}`), "Días en oficina", "Días en home", "Días requeridos", "Resultado", "Últimas 4 semanas"];
    const filasX = visibles.map((p) => [
      p.empleado, p.area ?? "",
      ...p.semana.map((d) => (d.estado === "oficina" ? `Oficina${d.sede ? " (" + d.sede + ")" : ""}` : d.estado === "justificado" ? `Justificado: ${d.detalle}` : CELDA[d.estado].texto)),
      p.actual.oficina, p.actual.home, p.actual.requeridos, RESULTADO[p.actual.resultado].texto,
      p.historial.total ? `${p.historial.cumplidas} de ${p.historial.total}` : "Sin datos",
    ].map((v) => ({ value: v as any })));
    await writeExcelFile([cab.map((t) => ({ value: t, fontWeight: "bold" as const })), ...filasX], { columns: cab.map((_, i) => ({ width: i === 0 ? 26 : 16 })) })
      .toFile(`asistencia-semana-${lunes}.xlsx`);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Asistencia semanal</h1>
          <p className="text-ink/60 text-sm mt-1">
            Días en la oficina y en home office según la red desde la que se conectó la notebook de cada persona.
            Política: {politica} {politica === 1 ? "día" : "días"} de oficina por semana.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={exportar} disabled={!visibles.length}>Exportar a Excel</button>
          {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)} aria-expanded={verConfig}>Política y feriados</button>}
        </div>
      </div>

      {esAdmin && verConfig && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm text-ink" htmlFor="politica">Días de oficina requeridos por semana</label>
            <select id="politica" className="input w-auto" value={politica} onChange={(e) => guardarPolitica(Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <div className="text-sm font-medium text-ink mb-2">Feriados</div>
            <p className="text-xs text-ink/50 mb-2">No cuentan como día hábil. Si una semana tiene un feriado, se piden los días de oficina que entren en los días que quedan.</p>
            <form onSubmit={agregarFeriado} className="flex gap-2 flex-wrap mb-2">
              <input type="date" required className="input w-auto" value={nuevoFeriado.fecha} onChange={(e) => setNuevoFeriado({ ...nuevoFeriado, fecha: e.target.value })} />
              <input required className="input flex-1 min-w-[200px]" placeholder="Día de la Soberanía Nacional" value={nuevoFeriado.nombre} onChange={(e) => setNuevoFeriado({ ...nuevoFeriado, nombre: e.target.value })} />
              <button className="btn-secondary">Agregar feriado</button>
            </form>
            <ul className="text-sm divide-y divide-line/[0.05]">
              {feriados.map((f) => (
                <li key={f.fecha} className="flex justify-between py-1.5">
                  <span>{f.fecha.split("-").reverse().join("/")} · {f.nombre}</span>
                  <button className="text-xs text-ink/40 hover:text-red-600" onClick={() => quitarFeriado(f.fecha)}>Quitar</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={() => setLunes(sumarDias(lunes, -7))} aria-label="Semana anterior">←</button>
          <div className="text-sm font-medium text-ink min-w-[190px] text-center">
            Semana del {corta(lunes)} al {corta(sumarDias(lunes, 4))}/{lunes.slice(0, 4)}
          </div>
          <button className="btn-secondary" onClick={() => setLunes(sumarDias(lunes, 7))} disabled={lunes >= lunesDe(hoy)} aria-label="Semana siguiente">→</button>
          {lunes !== lunesDe(hoy) && <button className="text-sm text-brand-600 hover:underline" onClick={() => setLunes(lunesDe(hoy))}>Esta semana</button>}
        </div>
        <div className="flex gap-3 items-center flex-wrap">
          <select className="input w-auto" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Área">
            <option value="">Todas las áreas</option>
            {areas.map((a) => <option key={a}>{a}</option>)}
          </select>
          <label className="text-sm text-ink/70 flex items-center gap-2">
            <input type="checkbox" checked={soloIncumplen} onChange={(e) => setSoloIncumplen(e.target.checked)} /> Solo quienes no cumplen
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(["cumple", "no_cumple", "en_curso", "sin_datos"] as Resultado[]).map((r) => (
          <div key={r} className="card p-4">
            <div className="text-xs text-ink/50 font-medium">{RESULTADO[r].texto}</div>
            <div className={`font-display text-3xl mt-1 ${r === "no_cumple" && cuenta(r) ? "text-red-600" : "text-ink"}`}>{cuenta(r)}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Persona</th>
              {DIAS.map((d, i) => <th key={d} className="text-center">{d} {corta(sumarDias(lunes, i))}</th>)}
              <th className="text-center">Oficina</th>
              <th>Resultado</th>
              <th>Últimas 4 semanas</th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((p) => (
              <tr key={p.empleado_id}>
                <td>
                  <span className="font-medium text-ink">{p.empleado}</span>
                  {p.area && <div className="text-xs text-ink/50">{p.area}</div>}
                </td>
                {p.semana.map((d) => {
                  const c = CELDA[d.estado];
                  const futuro = d.fecha > hoy;
                  const editable = puedeEditar && d.estado !== "feriado";
                  return (
                    <td key={d.fecha} className="text-center">
                      <button
                        type="button"
                        onClick={() => editable && justificar(p, d)}
                        disabled={!editable}
                        title={d.detalle ? d.detalle : d.estado === "oficina" && d.sede ? d.sede : editable ? "Tocá para justificar el día" : undefined}
                        className={`pill ${futuro && d.estado === "sin_datos" ? "text-ink/15" : c.clase} ${editable ? "hover:ring-2 hover:ring-brand-500/20 cursor-pointer" : "cursor-default"}`}
                      >
                        {c.texto}
                      </button>
                    </td>
                  );
                })}
                <td className="text-center whitespace-nowrap">
                  <span className="font-display text-lg text-ink">{p.actual.oficina}</span>
                  <span className="text-ink/50 text-xs"> de {p.actual.requeridos}</span>
                </td>
                <td><span className={`pill ${RESULTADO[p.actual.resultado].clase}`}>{RESULTADO[p.actual.resultado].texto}</span></td>
                <td className="text-sm text-ink/70 whitespace-nowrap">
                  {p.historial.total ? `Cumplió ${p.historial.cumplidas} de ${p.historial.total}` : <span className="text-ink/40">Sin datos</span>}
                </td>
              </tr>
            ))}
            {!cargando && visibles.length === 0 && (
              <tr><td colSpan={9} className="text-center text-ink/40 py-10">
                {filas.length === 0 ? "No hay personas con una notebook asignada y monitoreada por el agente." : "Nadie en esta situación."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-ink/50 space-y-1">
        <p>
          Un día cuenta como <b>oficina</b> si la notebook se conectó ese día desde una red de la oficina, aunque después haya trabajado
          desde su casa. <b>Home</b> es un día conectado solo desde otras redes. <b>—</b> significa que la notebook no se conectó.
          {puedeEditar && " Tocá un día para justificarlo (vacaciones, licencia, viaje): no se cuenta y baja los días requeridos de esa semana."}
        </p>
        <p>
          Es una estimación a partir de la conexión de la notebook, no de la presencia de la persona: sirve para ver patrones. Antes de tomar
          una medida, conversalo con la persona y con RRHH.
        </p>
      </div>
    </div>
  );
}
