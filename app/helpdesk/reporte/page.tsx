"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { exportarExcel } from "@/lib/excel";
import { clavePersona, esAjena } from "@/lib/helpdesk-personas";

// Reporte de estado de los tickets del helpdesk: resumen, por sector, por persona, por estado y
// detalle de todo lo que sigue sin cerrar. Se puede imprimir o guardar como PDF, y exportar a Excel.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ticket = Record<string, any>;
type Bandeja = "asignado" | "generado";

const DIA = 86400000;
const TZ = "America/Argentina/Buenos_Aires";
const slaVencidoRe = /vencido|escalado/i;
const sectoresDe = (t: Ticket): string[] => (t.sector ? String(t.sector).split(", ").filter(Boolean) : []);
// Varias personas asignadas vienen separadas con "; " (cada nombre es "Apellido, Nombre")
const personasDe = (t: Ticket): string[] => (t.asignado ? String(t.asignado).split("; ").map((x) => x.trim()).filter(Boolean) : []);
const fecha = (v: string | number | null) => (v ? new Date(v).toLocaleDateString("es-AR", { timeZone: TZ }) : "—");
const promedio = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function duracion(ms: number | null) {
  if (ms == null || ms < 0) return "—";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} min`;
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 día" : `${d} días`;
}
const dias = (ms: number | null) => (ms == null ? "" : Math.round((ms / DIA) * 10) / 10);
const horas = (ms: number | null) => (ms == null ? "" : Math.round((ms / 3600000) * 10) / 10);
function mediana(xs: number[]) {
  if (!xs.length) return null;
  const o = [...xs].sort((a, b) => a - b), m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}
// Tiempo de primera respuesta de un ticket: desde que se creó hasta el primer mensaje público de quien lo atiende
const demoraResp = (t: Ticket): number | null =>
  t.creado && t.primera_resp ? Math.max(0, Date.parse(t.primera_resp) - Date.parse(t.creado)) : null;

type Fila = {
  clave: string; abiertos: number; espera: number; falta: number; vencidos: number; quietos: number;
  creados: number; cerrados: number; resolucion: number | null; masAntiguo: number | null;
  resp: number | null; respMed: number | null; respMax: number | null; respN: number; esperaMax: number | null;
};

export default function ReporteHelpdesk() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bandeja, setBandeja] = useState<Bandeja>("asignado");
  const [periodo, setPeriodo] = useState(30);
  const [diasQuieto, setDiasQuieto] = useState(7);
  const [sectorResp, setSectorResp] = useState<string | null>(null);   // sector elegido en "Tiempo de primera respuesta"
  const [ahora] = useState(Date.now());

  useEffect(() => {
    (async () => {
      const sb = createClient();
      const todo: Ticket[] = [];
      for (let desde = 0; desde < 50000; desde += 1000) {
        const { data, error } = await sb.from("tickets_ext").select("*").order("bandeja").order("id").range(desde, desde + 999);
        if (error) { setError(/tickets_ext/.test(error.message) ? "Falta ejecutar supabase/tickets-lectura.sql en Supabase." : error.message); break; }
        todo.push(...(data ?? []));
        if ((data?.length ?? 0) < 1000) break;
      }
      setTickets(todo);
    })();
  }, []);

  const todos = tickets ?? [];
  const hayGenerados = todos.some((t) => t.bandeja === "generado");
  const lista = todos.filter((t) => (t.bandeja ?? "asignado") === bandeja);
  const desde = ahora - periodo * DIA;

  const tiempo = (t: Ticket): number | null => {
    if (!t.creado) return null;
    const fin = t.grupo === "cerrado" ? (t.cerrado ? Date.parse(t.cerrado) : null) : ahora;
    return fin == null ? null : fin - Date.parse(t.creado);
  };
  const quieto = (t: Ticket): number | null => {
    const u = t.actualizado ?? t.creado;
    return u ? ahora - Date.parse(u) : null;
  };
  const haySla = lista.some((t) => t.sla);
  const haySeg = lista.some((t) => t.seg_leido);

  // Mismas cuentas para cualquier conjunto de tickets (todo, un sector, una persona)
  const medir = (clave: string, xs: Ticket[]): Fila => {
    const sin = xs.filter((t) => t.grupo !== "cerrado");
    const cerr = xs.filter((t) => t.grupo === "cerrado" && t.cerrado && Date.parse(t.cerrado) >= desde);
    const ant = sin.map(tiempo).filter((x): x is number => x != null);
    // Primera respuesta: tickets creados en el período que ya tuvieron una
    const rs = xs.filter((t) => t.creado && Date.parse(t.creado) >= desde).map(demoraResp).filter((x): x is number => x != null);
    // Mayor espera actual: tickets donde falta la respuesta de quien atiende, desde el último mensaje del solicitante
    const esp = sin.filter((t) => t.respuesta_de === "atencion").map((t) => (t.ult_msj_fecha ?? t.creado ? ahora - Date.parse(t.ult_msj_fecha ?? t.creado) : null))
      .filter((x): x is number => x != null);
    return {
      resp: promedio(rs), respMed: mediana(rs), respMax: rs.length ? Math.max(...rs) : null, respN: rs.length,
      esperaMax: esp.length ? Math.max(...esp) : null,
      clave,
      abiertos: sin.filter((t) => t.grupo === "abierto").length,
      espera: sin.filter((t) => t.grupo === "en_espera").length,
      falta: sin.filter((t) => t.respuesta_de === "atencion").length,
      vencidos: sin.filter((t) => slaVencidoRe.test(t.sla ?? "")).length,
      quietos: sin.filter((t) => (quieto(t) ?? 0) >= diasQuieto * DIA).length,
      creados: xs.filter((t) => t.creado && Date.parse(t.creado) >= desde).length,
      cerrados: cerr.length,
      resolucion: promedio(cerr.map(tiempo).filter((x): x is number => x != null)),
      masAntiguo: ant.length ? Math.max(...ant) : null,
    };
  };

  const { total, porSector, porPersona, porEstado, sinCerrar } = useMemo(() => {
    const agrupar = (claves: (t: Ticket) => string[]) => {
      const m = new Map<string, Ticket[]>();
      lista.forEach((t) => claves(t).forEach((k) => { const a = m.get(k) ?? []; a.push(t); m.set(k, a); }));
      return Array.from(m.entries()).map(([k, xs]) => medir(k, xs))
        .filter((f) => f.abiertos + f.espera + f.creados + f.cerrados > 0)
        .sort((a, b) => b.abiertos + b.espera - (a.abiertos + a.espera) || b.cerrados - a.cerrados || a.clave.localeCompare(b.clave, "es"));
    };
    const sin = lista.filter((t) => t.grupo !== "cerrado")
      .sort((a, b) => (a.creado ? Date.parse(a.creado) : Infinity) - (b.creado ? Date.parse(b.creado) : Infinity));
    const est = new Map<string, number>();
    sin.forEach((t) => est.set(t.estado || "Sin estado", (est.get(t.estado || "Sin estado") ?? 0) + 1));
    return {
      total: medir("Total", lista),
      porSector: agrupar((t) => (sectoresDe(t).length ? sectoresDe(t) : ["Sin sector"])),
      // Sin las personas ajenas a los sectores (lib/helpdesk-personas.ts)
      porPersona: agrupar((t) => (personasDe(t).length ? personasDe(t).filter((p) => !esAjena(p)) : ["Sin asignar"])),
      porEstado: Array.from(est.entries()).sort((a, b) => b[1] - a[1]),
      sinCerrar: sin,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, bandeja, periodo, diasQuieto]);

  // Tiempo de primera respuesta: solo los sectores del área, con la opción de ver uno solo.
  // En "por quién respondió primero" entran únicamente las personas de esos sectores (las que tienen tickets asignados ahí),
  // menos las marcadas como ajenas en lib/helpdesk-personas.ts.
  const sectoresResp = porSector.map((f) => f.clave).filter((k) => k !== "Sin sector").sort((a, b) => a.localeCompare(b, "es"));
  const sectorR = sectorResp && sectoresResp.includes(sectorResp) ? sectorResp : null;
  const { totalR, sectoresR, respondieron, ajenos } = useMemo(() => {
    const listaR = sectorR ? lista.filter((t) => sectoresDe(t).includes(sectorR)) : lista;
    const delArea = new Set(listaR.filter((t) => sectoresDe(t).length > 0).flatMap(personasDe).map(clavePersona));
    const m = new Map<string, Ticket[]>();
    listaR.forEach((t) => { if (t.primera_resp_autor) { const k = String(t.primera_resp_autor); const a = m.get(k) ?? []; a.push(t); m.set(k, a); } });
    // Por quién dio la primera respuesta (no por quién está asignado), del más lento al más rápido
    const todosResp = Array.from(m.entries()).map(([k, xs]) => medir(k, xs)).filter((f) => f.respN > 0).sort((a, b) => (b.resp ?? 0) - (a.resp ?? 0));
    const esDelArea = (f: Fila) => delArea.has(clavePersona(f.clave)) && !esAjena(f.clave);
    const fuera = todosResp.filter((f) => !esDelArea(f));
    return {
      totalR: sectorR ? medir("Total", listaR) : total,
      sectoresR: porSector.filter((f) => f.respN > 0 && f.clave !== "Sin sector" && (!sectorR || f.clave === sectorR)).sort((a, b) => (b.resp ?? 0) - (a.resp ?? 0)),
      respondieron: todosResp.filter(esDelArea),
      ajenos: { personas: fuera.length, tickets: fuera.reduce((n, f) => n + f.respN, 0) },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, bandeja, periodo, diasQuieto, sectorR]);
  const lentoR = (v: number | null) => v != null && totalR.resp != null && v > Math.max(totalR.resp * 1.5, 4 * 3600000);

  const txtFalta = bandeja === "asignado" ? "Falta nuestra respuesta" : "Falta respuesta del otro sector";
  const respuesta = (t: Ticket) => (t.respuesta_de === "atencion" ? txtFalta : t.respuesta_de === "solicitante" ? "Espera al solicitante" : "");
  const titBandeja = bandeja === "asignado" ? "Tickets asignados al área" : "Tickets generados por el área";

  const columnas = ["Abiertos", "En espera", "Sin responder", "Mayor espera sin responder (días)", "SLA vencido", "Sin movimiento", `Creados (${periodo} d)`, `Cerrados (${periodo} d)`,
    "Primera respuesta promedio (horas)", "Primera respuesta mediana (horas)", "Primera respuesta más lenta (horas)", "Tickets con primera respuesta", "Resolución promedio (días)", "Más antiguo (días)"];
  const aFila = (f: Fila) => [f.clave, f.abiertos, f.espera, haySeg ? f.falta : "", dias(f.esperaMax), haySla ? f.vencidos : "", f.quietos, f.creados, f.cerrados,
    horas(f.resp), horas(f.respMed), horas(f.respMax), f.respN, dias(f.resolucion), dias(f.masAntiguo)];
  // Se remarca lo que supera en un 50 % el promedio general (y al menos 4 horas), y las esperas de más de 7 días
  const lento = (v: number | null) => v != null && total.resp != null && v > Math.max(total.resp * 1.5, 4 * 3600000);
  const esperaLarga = (v: number | null) => v != null && v > 7 * DIA;
  // Cobertura de la medición: tickets creados en el período con el seguimiento ya leído
  const delPeriodo = lista.filter((t) => t.creado && Date.parse(t.creado) >= desde);
  const sinLeer = delPeriodo.filter((t) => !t.seg_leido).length;
  const sinPrimera = delPeriodo.filter((t) => t.seg_leido && !t.primera_resp).length;
  const hoy = new Date(ahora).toLocaleDateString("en-CA", { timeZone: TZ });

  const exportar = async () => {
    await exportarExcel(`helpdesk-reporte-resumen-${hoy}`, ["Grupo", "Nombre", ...columnas],
      [["Total", ...aFila(total)], ...porSector.map((f) => ["Sector", ...aFila(f)]), ...porPersona.map((f) => ["Persona asignada", ...aFila(f)]),
        ...respondieron.map((f) => [sectorR ? `Quién respondió primero (${sectorR})` : "Quién respondió primero", ...aFila(f)])],
      { Nombre: 30 });
    await exportarExcel(`helpdesk-reporte-detalle-${hoy}`,
      ["Ticket", "Título", "Tipo", "Estado", "SLA", "Sector", "Prioridad", "Solicitante", "Asignado a", "Creado", "Días abierto", "Último movimiento", "Días sin movimiento", "Respuesta", "Último mensaje de", "Primera respuesta (horas)", "Primera respuesta de", "Recorrido"],
      sinCerrar.map((t) => [t.numero || t.id, t.titulo, t.tipo, t.estado, t.sla, t.sector, t.prioridad, t.solicitante, t.asignado, fecha(t.creado), dias(tiempo(t)),
        fecha(t.actualizado), quieto(t) == null ? "" : Math.floor((quieto(t) as number) / DIA), respuesta(t), t.ult_msj_autor, horas(demoraResp(t)), t.primera_resp_autor, t.recorrido]),
      { "Título": 40, Sector: 24, Solicitante: 26, "Asignado a": 26, Respuesta: 28, Recorrido: 50 });
  };

  const Tabla = ({ titulo, primera, filas, conTotal }: { titulo: string; primera: string; filas: Fila[]; conTotal?: boolean }) => (
    <div className="card p-5">
      <h2 className="font-medium text-ink mb-3">{titulo}</h2>
      {filas.length === 0 ? <p className="text-sm text-ink/50">Sin tickets.</p> : (
        <div className="overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th>{primera}</th><th>Abiertos</th><th>En espera</th><th title="Falta la respuesta de quien atiende">Sin responder</th>
                <th title="Tiempo desde el último mensaje del solicitante en el ticket que más espera">Mayor espera</th>
                <th title="Promedio desde la creación hasta la primera respuesta, tickets creados en el período">1.ª respuesta</th><th>SLA vencido</th>
                <th title={`Sin modificaciones hace más de ${diasQuieto} días`}>Sin movimiento</th><th>Creados</th><th>Cerrados</th><th>Resolución promedio</th><th>Más antiguo</th>
              </tr>
            </thead>
            <tbody>
              {[...filas, ...(conTotal ? [total] : [])].map((f) => (
                <tr key={f.clave} className={f.clave === "Total" ? "font-medium border-t-2 border-line/20" : ""}>
                  <td className="text-ink">{f.clave}</td>
                  <td className="tabular-nums">{f.abiertos}</td>
                  <td className="tabular-nums">{f.espera}</td>
                  <td className={`tabular-nums ${f.falta ? "text-red-600" : ""}`}>{haySeg ? f.falta : "—"}</td>
                  <td className={`whitespace-nowrap ${esperaLarga(f.esperaMax) ? "text-red-600 font-semibold" : ""}`}>{duracion(f.esperaMax)}</td>
                  <td className={`whitespace-nowrap ${lento(f.resp) ? "text-red-600 font-semibold" : ""}`}>{duracion(f.resp)}</td>
                  <td className={`tabular-nums ${f.vencidos ? "text-red-600" : ""}`}>{haySla ? f.vencidos : "—"}</td>
                  <td className={`tabular-nums ${f.quietos ? "text-amber-700" : ""}`}>{f.quietos}</td>
                  <td className="tabular-nums">{f.creados}</td>
                  <td className="tabular-nums">{f.cerrados}</td>
                  <td className="whitespace-nowrap">{duracion(f.resolucion)}</td>
                  <td className="whitespace-nowrap">{duracion(f.masAntiguo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  if (error) return <div className="card p-5 text-sm text-ink/60">{error}</div>;
  if (!tickets) return <p className="text-sm text-ink/50">Armando el reporte…</p>;

  const saldo = total.creados - total.cerrados;

  return (
    <div className="space-y-6">
      <style>{`@media print { @page { size: A4 landscape; margin: 12mm; } body { background: #fff !important; } .card { box-shadow: none !important; border: 1px solid #ddd !important; } table.data { font-size: 9px; } table.data th, table.data td { padding: 3px 5px !important; } .overflow-x-auto { overflow: visible !important; } tr { break-inside: avoid; } a { color: inherit !important; text-decoration: none !important; } }`}</style>

      <div className="flex items-end justify-between gap-4 flex-wrap print:hidden">
        <div>
          <Link href="/helpdesk" className="text-sm text-brand-600 hover:underline">← HelpDesk</Link>
          <h1 className="font-display text-2xl text-ink mt-1">Reporte de tickets</h1>
          <p className="text-ink/60 text-sm mt-1">Estado de todos los tickets del área, por sector y por persona. Se arma con la última lectura del helpdesk.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={exportar} disabled={lista.length === 0}>Exportar a Excel</button>
          <button className="btn-primary" onClick={() => window.print()} disabled={lista.length === 0}>Imprimir / PDF</button>
        </div>
      </div>

      <div className="card p-3 text-sm flex flex-wrap items-center gap-3 print:hidden">
        {hayGenerados && (
          <label className="flex items-center gap-2">Bandeja
            <select className="input w-auto" value={bandeja} onChange={(e) => setBandeja(e.target.value as Bandeja)}>
              <option value="asignado">Asignados al área</option><option value="generado">Generados por el área</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-2">Período
          <select className="input w-auto" value={periodo} onChange={(e) => setPeriodo(Number(e.target.value))}>
            {[7, 15, 30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>últimos {d} días</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">Sin movimiento
          <select className="input w-auto" value={diasQuieto} onChange={(e) => setDiasQuieto(Number(e.target.value))}>
            {[3, 7, 15, 30].map((d) => <option key={d} value={d}>hace más de {d} días</option>)}
          </select>
        </label>
      </div>

      <div className="hidden print:block border-b pb-3">
        <div className="text-xl font-semibold">Accusys Cyber · Reporte de tickets del helpdesk</div>
        <div className="text-sm">{titBandeja} · {fecha(ahora)} · período: últimos {periodo} días ({fecha(desde)} a {fecha(ahora)})</div>
      </div>

      {lista.length === 0 ? <p className="text-sm text-ink/60">No hay tickets leídos para esta bandeja.</p> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {([
              ["Sin cerrar", total.abiertos + total.espera, `${total.abiertos} abiertos · ${total.espera} en espera`, false],
              [txtFalta, haySeg ? total.falta : "—", "el último mensaje es del solicitante", total.falta > 0 && haySeg],
              ["SLA vencido", haySla ? total.vencidos : "—", "sin cerrar, vencidos o escalados", total.vencidos > 0 && haySla],
              ["Sin movimiento", total.quietos, `hace más de ${diasQuieto} días`, false],
              [`Creados en ${periodo} días`, total.creados, "", false],
              [`Cerrados en ${periodo} días`, total.cerrados, "", false],
              ["Saldo del período", saldo > 0 ? `+${saldo}` : saldo, saldo > 0 ? "el pendiente creció" : saldo < 0 ? "el pendiente bajó" : "sin cambios", saldo > 0],
              ["Primera respuesta", duracion(total.resp), total.respN ? `promedio · mediana ${duracion(total.respMed)}` : "todavía sin datos", false],
              ["Resolución promedio", duracion(total.resolucion), `de los cerrados en ${periodo} días`, false],
            ] as [string, string | number, string, boolean][]).map(([t, v, d, rojo]) => (
              <div key={t} className="card p-4">
                <div className="text-xs text-ink/50 font-medium">{t}</div>
                <div className={`font-display text-2xl mt-1 ${rojo ? "text-red-600" : "text-ink"}`}>{v}</div>
                {d && <div className="text-xs text-ink/50 mt-1">{d}</div>}
              </div>
            ))}
          </div>

          <div className="card p-5 border-2 border-red-500/40">
            <h2 className="font-medium text-ink">Tiempo de primera respuesta{sectorR ? ` · ${sectorR}` : ""}</h2>
            <p className="text-sm text-ink/60 mt-1 mb-3">
              Cuánto se tarda en contestarle por primera vez a quien pidió el ticket: desde que se crea hasta el primer mensaje público de quien lo atiende.
              Tickets creados en los últimos {periodo} días. En rojo, lo que supera en más de un 50 % el promedio {sectorR ? `de ${sectorR}` : "general"} ({duracion(totalR.resp)}).
            </p>
            {sectoresResp.length > 1 && (
              <div className="flex gap-2 flex-wrap items-center mb-4 print:hidden" role="group" aria-label="Sector">
                <span className="text-xs text-ink/50 mr-1">Sector:</span>
                {[null, ...sectoresResp].map((x) => (
                  <button key={x ?? "todos"} onClick={() => setSectorResp(x)} aria-pressed={sectorR === x}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${sectorR === x ? "border-brand-500 bg-brand-50 text-brand-700 font-medium" : "border-line/20 text-ink/70 hover:border-brand-300"}`}>
                    {x ?? "Todos"}
                  </button>
                ))}
              </div>
            )}
            {totalR.respN === 0 ? (
              <p className="text-sm text-ink/60">{sectorR ? `Todavía no hay primeras respuestas medidas para ${sectorR} en este período.` : "Todavía no hay datos: el seguimiento de los tickets se está leyendo. Se completa solo en las próximas horas."}</p>
            ) : (
              <div className="grid lg:grid-cols-2 gap-6 print:block print:space-y-4">
                {([["Por sector", "Sector", sectoresR],
                   ["Por quién respondió primero", "Persona", respondieron]] as [string, string, Fila[]][]).map(([tit, col, filas]) => (
                  <div key={tit}>
                    <h3 className="text-sm font-medium text-ink mb-2">{tit} (del más lento al más rápido)</h3>
                    <div className="overflow-x-auto">
                      <table className="data w-full text-sm">
                        <thead><tr><th>{col}</th><th>Promedio</th><th>Mediana</th><th>La más lenta</th><th>Tickets</th></tr></thead>
                        <tbody>
                          {filas.length === 0 && <tr><td colSpan={5} className="text-ink/50">Sin respuestas de personas del área en este período.</td></tr>}
                          {filas.map((f) => (
                            <tr key={f.clave} className={lentoR(f.resp) ? "bg-red-50" : ""}>
                              <td className={lentoR(f.resp) ? "text-red-600 font-semibold" : "text-ink"}>{f.clave}</td>
                              <td className={`whitespace-nowrap ${lentoR(f.resp) ? "text-red-600 font-semibold" : ""}`}>{duracion(f.resp)}</td>
                              <td className="whitespace-nowrap">{duracion(f.respMed)}</td>
                              <td className="whitespace-nowrap">{duracion(f.respMax)}</td>
                              <td className="tabular-nums">{f.respN}{f.respN < 5 && <span className="text-xs text-ink/40"> · pocos casos</span>}</td>
                            </tr>
                          ))}
                          <tr className="font-medium border-t-2 border-line/20">
                            <td>Total</td><td className="whitespace-nowrap">{duracion(totalR.resp)}</td><td className="whitespace-nowrap">{duracion(totalR.respMed)}</td>
                            <td className="whitespace-nowrap">{duracion(totalR.respMax)}</td><td className="tabular-nums">{totalR.respN}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-ink/50 mt-3">
              {ajenos.tickets > 0 && `En la tabla por persona no se listan ${ajenos.personas === 1 ? "1 persona ajena" : `${ajenos.personas} personas ajenas`} al área, que ${ajenos.personas === 1 ? "dio" : "dieron"} la primera respuesta en ${ajenos.tickets} ${ajenos.tickets === 1 ? "ticket" : "tickets"}; esos tickets sí cuentan en el sector y en el total. `}
              Es tiempo corrido: incluye noches, fines de semana y feriados. Las notas internas no cuentan como respuesta. El promedio sube mucho con pocos tickets muy demorados; la mediana muestra el caso típico.
              {sinLeer > 0 && <b className="text-amber-700"> Medición incompleta: {sinLeer} de los {delPeriodo.length} tickets del período todavía no tienen leído su seguimiento; se completa solo en las próximas horas.</b>}
              {sinPrimera > 0 && ` ${sinPrimera} ${sinPrimera === 1 ? "ticket del período no tiene" : "tickets del período no tienen"} ninguna respuesta pública registrada y no entran en el promedio.`}
            </p>
          </div>

          <Tabla titulo="Por sector" primera="Sector" filas={porSector} conTotal />
          <Tabla titulo="Por persona asignada" primera="Persona" filas={porPersona} />
          <p className="text-xs text-ink/50 -mt-3">
            Un ticket asignado a varios sectores o a varias personas cuenta en cada uno, por eso la suma de las filas puede superar el total.
            Creados, cerrados y resolución promedio corresponden a los últimos {periodo} días.
          </p>

          <div className="card p-5">
            <h2 className="font-medium text-ink mb-3">Sin cerrar, por estado</h2>
            <div className="flex flex-wrap gap-2">
              {porEstado.length === 0 ? <span className="text-sm text-ink/50">No hay tickets sin cerrar.</span>
                : porEstado.map(([e, n]) => <span key={e} className="pill bg-line/[0.06] text-ink/80">{e}: <b className="ml-1">{n}</b></span>)}
            </div>
          </div>

          <div className="card p-5">
            <h2 className="font-medium text-ink mb-3">Detalle de los {sinCerrar.length} tickets sin cerrar (del más antiguo al más nuevo)</h2>
            <div className="overflow-x-auto">
              <table className="data w-full text-sm">
                <thead><tr><th>Ticket</th><th>Título</th><th>Sector</th><th>Asignado a</th><th>Estado</th><th>Respuesta</th><th title="Tiempo desde el último mensaje del solicitante">Espera desde hace</th><th>SLA</th><th>Creado</th><th>Lleva</th><th>Sin movimiento</th></tr></thead>
                <tbody>
                  {sinCerrar.map((t) => (
                    <tr key={`${t.bandeja}-${t.id}`}>
                      <td className="whitespace-nowrap font-medium text-ink">{t.numero || `#${t.id}`}</td>
                      <td className="max-w-[22rem]">{t.titulo ?? "—"}<div className="text-xs text-ink/40">{[t.tipo, t.solicitante && `de ${t.solicitante}`].filter(Boolean).join(" · ")}</div></td>
                      <td>{t.sector ?? "—"}</td>
                      <td>{t.asignado ?? "Sin asignar"}</td>
                      <td className="whitespace-nowrap">{t.estado ?? "—"}</td>
                      <td className={t.respuesta_de === "atencion" ? "text-red-600" : "text-ink/60"}>{respuesta(t) || "—"}</td>
                      {(() => {
                        const e = t.respuesta_de === "atencion" && (t.ult_msj_fecha ?? t.creado) ? ahora - Date.parse(t.ult_msj_fecha ?? t.creado) : null;
                        return <td className={`whitespace-nowrap ${esperaLarga(e) ? "text-red-600 font-semibold" : ""}`}>{duracion(e)}</td>;
                      })()}
                      <td className={slaVencidoRe.test(t.sla ?? "") ? "text-red-600" : ""}>{t.sla ?? "—"}</td>
                      <td className="whitespace-nowrap">{fecha(t.creado)}</td>
                      <td className="whitespace-nowrap">{duracion(tiempo(t))}</td>
                      <td className={`whitespace-nowrap ${(quieto(t) ?? 0) >= diasQuieto * DIA ? "text-amber-700" : ""}`}>{duracion(quieto(t))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
