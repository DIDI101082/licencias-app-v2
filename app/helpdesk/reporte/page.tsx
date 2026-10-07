"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { exportarExcel } from "@/lib/excel";

// Reporte de estado de los tickets del helpdesk: resumen, por sector, por persona, por estado y
// detalle de todo lo que sigue sin cerrar. Se puede imprimir o guardar como PDF, y exportar a Excel.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ticket = Record<string, any>;
type Bandeja = "asignado" | "generado";

const DIA = 86400000;
const TZ = "America/Argentina/Buenos_Aires";
const slaVencidoRe = /vencido|escalado/i;
const sectoresDe = (t: Ticket): string[] => (t.sector ? String(t.sector).split(", ").filter(Boolean) : []);
const personasDe = (t: Ticket): string[] => (t.asignado ? String(t.asignado).split(", ").filter(Boolean) : []);
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

type Fila = {
  clave: string; abiertos: number; espera: number; falta: number; vencidos: number; quietos: number;
  creados: number; cerrados: number; resolucion: number | null; masAntiguo: number | null;
};

export default function ReporteHelpdesk() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bandeja, setBandeja] = useState<Bandeja>("asignado");
  const [periodo, setPeriodo] = useState(30);
  const [diasQuieto, setDiasQuieto] = useState(7);
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
    return {
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
      porPersona: agrupar((t) => (personasDe(t).length ? personasDe(t) : ["Sin asignar"])),
      porEstado: Array.from(est.entries()).sort((a, b) => b[1] - a[1]),
      sinCerrar: sin,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, bandeja, periodo, diasQuieto]);

  const txtFalta = bandeja === "asignado" ? "Falta nuestra respuesta" : "Falta respuesta del otro sector";
  const respuesta = (t: Ticket) => (t.respuesta_de === "atencion" ? txtFalta : t.respuesta_de === "solicitante" ? "Espera al solicitante" : "");
  const titBandeja = bandeja === "asignado" ? "Tickets asignados al área" : "Tickets generados por el área";

  const columnas = ["Abiertos", "En espera", "Sin responder", "SLA vencido", "Sin movimiento", `Creados (${periodo} d)`, `Cerrados (${periodo} d)`, "Resolución promedio (días)", "Más antiguo (días)"];
  const aFila = (f: Fila) => [f.clave, f.abiertos, f.espera, haySeg ? f.falta : "", haySla ? f.vencidos : "", f.quietos, f.creados, f.cerrados, dias(f.resolucion), dias(f.masAntiguo)];
  const hoy = new Date(ahora).toLocaleDateString("en-CA", { timeZone: TZ });

  const exportar = async () => {
    await exportarExcel(`helpdesk-reporte-resumen-${hoy}`, ["Grupo", "Nombre", ...columnas],
      [["Total", ...aFila(total)], ...porSector.map((f) => ["Sector", ...aFila(f)]), ...porPersona.map((f) => ["Persona", ...aFila(f)])],
      { Nombre: 30 });
    await exportarExcel(`helpdesk-reporte-detalle-${hoy}`,
      ["Ticket", "Título", "Tipo", "Estado", "SLA", "Sector", "Prioridad", "Solicitante", "Asignado a", "Creado", "Días abierto", "Último movimiento", "Días sin movimiento", "Respuesta", "Último mensaje de", "Recorrido"],
      sinCerrar.map((t) => [t.numero || t.id, t.titulo, t.tipo, t.estado, t.sla, t.sector, t.prioridad, t.solicitante, t.asignado, fecha(t.creado), dias(tiempo(t)),
        fecha(t.actualizado), quieto(t) == null ? "" : Math.floor((quieto(t) as number) / DIA), respuesta(t), t.ult_msj_autor, t.recorrido]),
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
                <th>{primera}</th><th>Abiertos</th><th>En espera</th><th title="Falta la respuesta de quien atiende">Sin responder</th><th>SLA vencido</th>
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
      <style>{`@media print { @page { size: A4 landscape; margin: 12mm; } body { background: #fff !important; } .card { box-shadow: none !important; border: 1px solid #ddd !important; } table.data { font-size: 10px; } tr { break-inside: avoid; } a { color: inherit !important; text-decoration: none !important; } }`}</style>

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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {([
              ["Sin cerrar", total.abiertos + total.espera, `${total.abiertos} abiertos · ${total.espera} en espera`, false],
              [txtFalta, haySeg ? total.falta : "—", "el último mensaje es del solicitante", total.falta > 0 && haySeg],
              ["SLA vencido", haySla ? total.vencidos : "—", "sin cerrar, vencidos o escalados", total.vencidos > 0 && haySla],
              ["Sin movimiento", total.quietos, `hace más de ${diasQuieto} días`, false],
              [`Creados en ${periodo} días`, total.creados, "", false],
              [`Cerrados en ${periodo} días`, total.cerrados, "", false],
              ["Saldo del período", saldo > 0 ? `+${saldo}` : saldo, saldo > 0 ? "el pendiente creció" : saldo < 0 ? "el pendiente bajó" : "sin cambios", saldo > 0],
              ["Resolución promedio", duracion(total.resolucion), `de los cerrados en ${periodo} días`, false],
            ] as [string, string | number, string, boolean][]).map(([t, v, d, rojo]) => (
              <div key={t} className="card p-4">
                <div className="text-xs text-ink/50 font-medium">{t}</div>
                <div className={`font-display text-2xl mt-1 ${rojo ? "text-red-600" : "text-ink"}`}>{v}</div>
                {d && <div className="text-xs text-ink/50 mt-1">{d}</div>}
              </div>
            ))}
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
                <thead><tr><th>Ticket</th><th>Título</th><th>Sector</th><th>Asignado a</th><th>Estado</th><th>Respuesta</th><th>SLA</th><th>Creado</th><th>Lleva</th><th>Sin movimiento</th></tr></thead>
                <tbody>
                  {sinCerrar.map((t) => (
                    <tr key={`${t.bandeja}-${t.id}`}>
                      <td className="whitespace-nowrap font-medium text-ink">{t.numero || `#${t.id}`}</td>
                      <td className="max-w-[22rem]">{t.titulo ?? "—"}<div className="text-xs text-ink/40">{[t.tipo, t.solicitante && `de ${t.solicitante}`].filter(Boolean).join(" · ")}</div></td>
                      <td>{t.sector ?? "—"}</td>
                      <td>{t.asignado ?? "Sin asignar"}</td>
                      <td className="whitespace-nowrap">{t.estado ?? "—"}</td>
                      <td className={t.respuesta_de === "atencion" ? "text-red-600" : "text-ink/60"}>{respuesta(t) || "—"}</td>
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
