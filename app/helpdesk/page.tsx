"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { ThFiltro, FiltrosActivos, useFiltrosColumna } from "@/components/FiltroColumna";
import { exportarExcel } from "@/lib/excel";
import TicketsLectura from "@/components/TicketsLectura";
import TicketSeguimiento from "@/components/TicketSeguimiento";

// Solapa HelpDesk: tickets del área en el helpdesk, leídos cada 15 minutos, con su seguimiento. Solo lectura.

type Grupo = "abierto" | "en_espera" | "cerrado";
type Bandeja = "asignado" | "generado";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ticket = Record<string, any>;

const GRUPOS: Record<Grupo, { titulo: string; uno: string; pill: string }> = {
  abierto: { titulo: "Abiertos", uno: "Abierto", pill: "bg-brand-50 text-brand-700" },
  en_espera: { titulo: "En espera", uno: "En espera", pill: "bg-amber-500/10 text-amber-700" },
  cerrado: { titulo: "Cerrados (30 días)", uno: "Cerrado", pill: "bg-emerald-50 text-emerald-700" },
};
const BANDEJAS: Record<Bandeja, { titulo: string; detalle: string }> = {
  asignado: { titulo: "Asignados al área", detalle: "Tickets que el área tiene que resolver." },
  generado: { titulo: "Generados por el área", detalle: "Tickets que el área abrió hacia otros sectores." },
};
const DIA = 86400000;
const SEMANAS = 12;
// Color del estado de SLA que informa el sistema de tickets
const slaVencidoRe = /vencido|escalado/i;
const slaPill = (v: string | null) =>
  slaVencidoRe.test(v ?? "") ? "bg-red-50 text-red-600"
    : /por vencer|sin responder/i.test(v ?? "") ? "bg-amber-500/10 text-amber-700"
    : /en tiempo/i.test(v ?? "") ? "bg-emerald-50 text-emerald-700" : "bg-line/[0.05] text-ink/60";

function duracion(ms: number | null) {
  if (ms == null || ms < 0) return "—";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} min`;
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 día" : `${d} días`;
}
const fecha = (v: string | null) => (v ? new Date(v).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "—");
// Un ticket puede estar asignado a más de un sector ("CAU Servidores, Ciberseguridad")
const sectoresDe = (t: Ticket): string[] => (t.sector ? String(t.sector).split(", ").filter(Boolean) : []);
// Varias personas asignadas vienen separadas con "; " (cada nombre es "Apellido, Nombre")
const personasDe = (t: Ticket): string[] => (t.asignado ? String(t.asignado).split("; ").map((x) => x.trim()).filter(Boolean) : []);
const promedio = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
// Lunes de la semana (hora de Argentina) como AAAA-MM-DD
function semanaDe(ms: number) {
  const d = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Lista de conteos con barra proporcional (por tipo, por prioridad)
function Conteos({ titulo, datos }: { titulo: string; datos: [string, number][] }) {
  const max = Math.max(1, ...datos.map(([, n]) => n));
  return (
    <div className="card p-5">
      <h2 className="font-medium text-ink mb-3">{titulo}</h2>
      {datos.length === 0 ? <p className="text-sm text-ink/50">Sin tickets.</p> : (
        <ul className="space-y-2">
          {datos.map(([k, n]) => (
            <li key={k} className="text-sm">
              <div className="flex justify-between gap-3"><span className="text-ink truncate">{k}</span><span className="tabular-nums text-ink/70">{n}</span></div>
              <div className="h-1.5 rounded bg-line/[0.06] mt-1"><div className="h-1.5 rounded bg-brand-500" style={{ width: `${(n / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Tickets() {
  const { esAdmin } = usePerfil();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [falta, setFalta] = useState(false);
  const [bandeja, setBandeja] = useState<Bandeja>("asignado");
  const [sector, setSector] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Grupo | null>(null);
  const [quietos, setQuietos] = useState(false);
  const [sinResponder, setSinResponder] = useState(false);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [seg, setSeg] = useState<{ ocupado: boolean; texto: string | null }>({ ocupado: false, texto: null });
  const [diasQuieto, setDiasQuieto] = useState(7);
  const [texto, setTexto] = useState("");
  const [verConfig, setVerConfig] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [ahora, setAhora] = useState(Date.now());

  // La base devuelve como máximo 1000 filas por consulta: se trae de a páginas hasta completar
  const cargar = async () => {
    const sb = createClient();
    const todo: Ticket[] = [];
    const PAGINA = 1000;
    for (let desde = 0; desde < 50000; desde += PAGINA) {
      const { data, error } = await sb.from("tickets_ext").select("*").order("bandeja").order("id").range(desde, desde + PAGINA - 1);
      if (error) { setFalta(/tickets_ext/.test(error.message)); break; }
      todo.push(...(data ?? []));
      if ((data?.length ?? 0) < PAGINA) break;
    }
    // Del más antiguo al más nuevo; sin fecha de creación, al final
    todo.sort((a, b) => (a.creado ? Date.parse(a.creado) : Infinity) - (b.creado ? Date.parse(b.creado) : Infinity));
    setTickets(todo); setAhora(Date.now());
  };
  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 5 * 60000);
    return () => clearInterval(t);
  }, []);

  // Tiempo que lleva: abiertos y en espera, desde que se crearon hasta ahora; cerrados, hasta el cierre
  const tiempo = (t: Ticket): number | null => {
    if (!t.creado) return null;
    const fin = t.grupo === "cerrado" ? (t.cerrado ? Date.parse(t.cerrado) : null) : ahora;
    return fin == null ? null : fin - Date.parse(t.creado);
  };
  // Tiempo sin movimiento: desde la última modificación (o la creación) hasta ahora
  const quieto = (t: Ticket): number | null => {
    const u = t.actualizado ?? t.creado;
    return u ? ahora - Date.parse(u) : null;
  };

  const todos = tickets ?? [];
  const hayGenerados = todos.some((t) => t.bandeja === "generado");
  const hayAsignados = todos.some((t) => t.bandeja !== "generado");
  const bandejaActual: Bandeja = bandeja === "generado" && !hayGenerados ? "asignado" : bandeja === "asignado" && !hayAsignados && hayGenerados ? "generado" : bandeja;
  const enBandeja = todos.filter((t) => (t.bandeja ?? "asignado") === bandejaActual);
  // Sectores presentes en la bandeja, con cuántos tickets sin cerrar tiene cada uno
  const sectores = useMemo(() => {
    const m = new Map<string, number>();
    enBandeja.forEach((t) => sectoresDe(t).forEach((x) => m.set(x, (m.get(x) ?? 0) + (t.grupo !== "cerrado" ? 1 : 0))));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, bandejaActual]);
  const sectorActual = sector && sectores.some(([x]) => x === sector) ? sector : null;
  const lista = sectorActual ? enBandeja.filter((t) => sectoresDe(t).includes(sectorActual)) : enBandeja;
  const sinCerrar = lista.filter((t) => t.grupo !== "cerrado");
  const cerrados30 = lista.filter((t) => t.grupo === "cerrado" && t.cerrado && ahora - Date.parse(t.cerrado) <= 30 * DIA);
  const cuenta: Record<Grupo, number> = {
    abierto: lista.filter((t) => t.grupo === "abierto").length,
    en_espera: lista.filter((t) => t.grupo === "en_espera").length,
    cerrado: cerrados30.length,
  };
  const antiguedad = promedio(sinCerrar.map(tiempo).filter((x): x is number => x != null));
  const resolucion = promedio(cerrados30.map(tiempo).filter((x): x is number => x != null));
  const slaVencido = sinCerrar.filter((t) => slaVencidoRe.test(t.sla ?? "")).length;
  const haySla = lista.some((t) => t.sla);
  const sinMovimiento = sinCerrar.filter((t) => (quieto(t) ?? 0) >= diasQuieto * DIA);
  // Falta la respuesta de quien atiende: el último mensaje público es de quien pidió el ticket (o no hay ninguno)
  const faltaRespuesta = sinCerrar.filter((t) => t.respuesta_de === "atencion");
  const haySeguimiento = lista.some((t) => t.seg_leido);
  const sinSeguimiento = todos.filter((t) => t.grupo !== "cerrado" && !t.seg_leido).length;
  // En "Asignados" quien atiende es el área; en "Generados", el otro sector
  const txtFalta = bandejaActual === "asignado" ? "Falta nuestra respuesta" : "Falta respuesta del otro sector";

  // Lee desde el helpdesk el seguimiento de los tickets sin cerrar, de a lotes chicos, hasta terminar
  async function actualizarSeguimientos() {
    const sb = createClient();
    setSeg({ ocupado: true, texto: "Leyendo seguimientos…" });
    let leidos = 0;
    for (let i = 0; i < 200; i++) {
      const { data, error } = await sb.rpc("tickets_seguimiento_lote", { p_max: 3 });
      if (error) { setSeg({ ocupado: false, texto: /tickets_seguimiento_lote/.test(error.message) ? "Falta ejecutar supabase/helpdesk.sql en Supabase." : error.message }); return; }
      leidos += data?.leidos ?? 0;
      if (!data?.ok) { setSeg({ ocupado: false, texto: `Se leyeron ${leidos}. Se detuvo: ${data?.error}` }); await cargar(); return; }
      if (!data.leidos || !data.pendientes) break;
      setSeg({ ocupado: true, texto: `Leyendo seguimientos… ${leidos} listos, faltan ${data.pendientes}` });
    }
    await cargar();
    setSeg({ ocupado: false, texto: `Seguimiento actualizado: ${leidos} ${leidos === 1 ? "ticket" : "tickets"}.` });
  }

  // Sin cerrar, por persona asignada (un ticket con varias personas cuenta en cada una)
  const carga = useMemo(() => {
    const m = new Map<string, { clave: string; abierto: number; en_espera: number; vencidos: number; quietos: number; falta: number; max: number }>();
    sinCerrar.forEach((t) => {
      const personas: string[] = personasDe(t).length ? personasDe(t) : ["Sin asignar"];
      personas.forEach((k) => {
        const x = m.get(k) ?? { clave: k, abierto: 0, en_espera: 0, vencidos: 0, quietos: 0, falta: 0, max: 0 };
        if (t.respuesta_de === "atencion") x.falta++;
        x[t.grupo as "abierto" | "en_espera"]++;
        if (slaVencidoRe.test(t.sla ?? "")) x.vencidos++;
        if ((quieto(t) ?? 0) >= diasQuieto * DIA) x.quietos++;
        x.max = Math.max(x.max, tiempo(t) ?? 0);
        m.set(k, x);
      });
    });
    return Array.from(m.values()).sort((a, b) => b.abierto + b.en_espera - (a.abierto + a.en_espera));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, ahora, bandejaActual, sectorActual, diasQuieto]);

  const contar = (f: (t: Ticket) => string) => {
    const m = new Map<string, number>();
    sinCerrar.forEach((t) => m.set(f(t), (m.get(f(t)) ?? 0) + 1));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };
  const porTipo = contar((t) => t.tipo || "Sin tipo");
  const porPrioridad = contar((t) => t.prioridad || "Sin prioridad");

  // Últimas semanas: cuántos tickets se crearon y cuántos se cerraron en cada una
  const semanas = useMemo(() => {
    const out: { semana: string; creados: number; cerrados: number }[] = [];
    const idx = new Map<string, number>();
    for (let i = SEMANAS - 1; i >= 0; i--) { const s = semanaDe(ahora - i * 7 * DIA); idx.set(s, out.length); out.push({ semana: s, creados: 0, cerrados: 0 }); }
    lista.forEach((t) => {
      const c = t.creado ? idx.get(semanaDe(Date.parse(t.creado))) : undefined;
      if (c != null) out[c].creados++;
      const z = t.grupo === "cerrado" && t.cerrado ? idx.get(semanaDe(Date.parse(t.cerrado))) : undefined;
      if (z != null) out[z].cerrados++;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, ahora, bandejaActual, sectorActual]);
  const maxSemana = Math.max(1, ...semanas.map((s) => Math.max(s.creados, s.cerrados)));
  const haySemanas = semanas.some((s) => s.creados + s.cerrados > 0);

  // Sin filtro se muestran los que no están cerrados, del más antiguo al más nuevo
  const filas = useMemo(() => {
    const base = sinResponder ? faltaRespuesta : quietos ? sinMovimiento : filtro === "cerrado" ? cerrados30 : filtro ? lista.filter((t) => t.grupo === filtro) : sinCerrar;
    const q = texto.trim().toLowerCase();
    return base.filter((t) => !q || [t.id, t.numero, t.titulo, t.estado, t.sector, t.asignado, t.solicitante, t.prioridad, t.tipo, t.sla, t.cliente]
      .some((v) => v && String(v).toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, filtro, quietos, sinResponder, diasQuieto, texto, ahora, bandejaActual, sectorActual]);

  const fc = useFiltrosColumna(filas, {
    estado: (t) => t.estado || GRUPOS[t.grupo as Grupo].uno,
    sector: (t) => (sectoresDe(t).length ? sectoresDe(t) : ["Sin sector"]),
    prioridad: (t) => t.prioridad || "—",
    asignado: (t) => (personasDe(t).length ? personasDe(t) : ["Sin asignar"]),
    respuesta: (t) => (t.grupo === "cerrado" ? "—" : t.respuesta_de === "atencion" ? txtFalta : t.respuesta_de === "solicitante" ? "Espera al solicitante" : "Sin leer"),
    sla: (t) => t.sla || "—",
  });
  const enTabla = fc.filtradas;
  useEffect(() => { setPagina(1); }, [filtro, quietos, sinResponder, texto, bandejaActual, sectorActual, fc.filtros]);
  const POR_PAGINA = 50;
  const paginas = Math.max(1, Math.ceil(enTabla.length / POR_PAGINA));
  const paginaActual = Math.min(pagina, paginas);
  const visibles = enTabla.slice((paginaActual - 1) * POR_PAGINA, paginaActual * POR_PAGINA);

  const exportar = () =>
    exportarExcel(
      `tickets-${bandejaActual}s-${new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })}`,
      ["Ticket", "Título", "Tipo", "Estado", "Situación", "SLA", "Sector", "Prioridad", "Solicitante", "Asignado a", "Cliente", "Creado", "Último movimiento", "Cerrado", "Días", "Días sin movimiento", "Respuesta", "Último mensaje de", "Fecha último mensaje", "Mensajes", "Recorrido"],
      enTabla.map((t) => {
        const ms = tiempo(t), q = t.grupo === "cerrado" ? null : quieto(t);
        return [t.numero || t.id, t.titulo, t.tipo, t.estado, GRUPOS[t.grupo as Grupo].uno, t.sla, t.sector, t.prioridad, t.solicitante, t.asignado, t.cliente,
          fecha(t.creado), fecha(t.actualizado), t.cerrado ? fecha(t.cerrado) : "", ms == null ? "" : Math.round((ms / DIA) * 10) / 10, q == null ? "" : Math.floor(q / DIA),
          t.grupo === "cerrado" ? "" : t.respuesta_de === "atencion" ? txtFalta : t.respuesta_de === "solicitante" ? "Espera al solicitante" : "",
          t.ult_msj_autor, t.ult_msj_fecha ? fecha(t.ult_msj_fecha) : "", t.mensajes, t.recorrido];
      }),
      { "Título": 40, Sector: 22, Solicitante: 26, "Asignado a": 26, Respuesta: 28, Recorrido: 50 },
    );

  if (falta) return <div className="card p-5 text-sm text-ink/60"><b>HelpDesk:</b> falta ejecutar supabase/tickets-lectura.sql en Supabase.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">HelpDesk</h1>
          <p className="text-ink/60 text-sm mt-1">Tickets del área en el helpdesk, con su seguimiento. Se leen cada 15 minutos; desde acá no se modifican.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/helpdesk/reporte" className="btn-secondary">Reporte</Link>
          {esAdmin && <button className="btn-secondary" onClick={actualizarSeguimientos} disabled={seg.ocupado}>Actualizar seguimientos</button>}
          {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)} aria-expanded={verConfig}>Configurar lectura</button>}
        </div>
      </div>
      {seg.texto && <p className="text-sm text-ink/60" role="status">{seg.texto}</p>}
      {!seg.texto && todos.length > 0 && sinSeguimiento > 0 && (
        <p className="text-sm text-ink/60">
          {sinSeguimiento} {sinSeguimiento === 1 ? "ticket sin cerrar todavía no tiene" : "tickets sin cerrar todavía no tienen"} leído su seguimiento. Se completa solo en los próximos minutos
          {esAdmin ? ", o ahora con “Actualizar seguimientos”." : "."}
        </p>
      )}

      {esAdmin && verConfig && <TicketsLectura alLeer={cargar} />}

      {hayGenerados && hayAsignados && (
        <div>
          <div className="flex gap-2 flex-wrap" role="tablist" aria-label="Bandeja">
            {(["asignado", "generado"] as Bandeja[]).map((b) => (
              <button key={b} role="tab" aria-selected={bandejaActual === b} onClick={() => { setBandeja(b); setFiltro(null); setQuietos(false); setSinResponder(false); setAbierto(null); fc.limpiar(); }}
                className={`px-4 py-2 rounded-lg text-sm transition-colors ${bandejaActual === b ? "bg-brand-600 text-white font-medium" : "text-ink/70 hover:bg-line/[0.06]"}`}>
                {BANDEJAS[b].titulo} ({todos.filter((t) => (t.bandeja ?? "asignado") === b && t.grupo !== "cerrado").length})
              </button>
            ))}
          </div>
          <p className="text-xs text-ink/50 mt-2">{BANDEJAS[bandejaActual].detalle}</p>
        </div>
      )}

      {sectores.length > 1 && (
        <div className="flex gap-2 flex-wrap items-center" role="group" aria-label="Sector">
          <span className="text-xs text-ink/50 mr-1">Sector:</span>
          {[[null, enBandeja.filter((t) => t.grupo !== "cerrado").length] as [string | null, number], ...sectores].map(([x, n]) => (
            <button key={x ?? "todos"} onClick={() => setSector(x)} aria-pressed={sectorActual === x}
              className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${sectorActual === x ? "border-brand-500 bg-brand-50 text-brand-700 font-medium" : "border-line/20 text-ink/70 hover:border-brand-300"}`}>
              {x ?? "Todos"} <span className="tabular-nums text-ink/50">{n}</span>
            </button>
          ))}
          <span className="text-xs text-ink/40">El número es la cantidad de tickets sin cerrar.</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {(["abierto", "en_espera", "cerrado"] as Grupo[]).map((g) => (
          <button key={g} onClick={() => { setQuietos(false); setSinResponder(false); setFiltro(filtro === g ? null : g); }} aria-pressed={!quietos && !sinResponder && filtro === g}
            className={`card p-5 text-left transition-colors ${!quietos && !sinResponder && filtro === g ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{GRUPOS[g].titulo}</div>
            <div className="font-display text-3xl mt-1 text-ink">{cuenta[g]}</div>
          </button>
        ))}
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">SLA vencido</div>
          <div className={`font-display text-3xl mt-1 ${slaVencido ? "text-red-600" : "text-ink"}`}>{haySla ? slaVencido : "—"}</div>
          <div className="text-xs text-ink/50 mt-1">sin cerrar, vencidos o escalados</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Antigüedad promedio</div>
          <div className="font-display text-3xl mt-1 text-ink">{duracion(antiguedad)}</div>
          <div className="text-xs text-ink/50 mt-1">de los que siguen sin cerrar</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Tiempo de resolución</div>
          <div className="font-display text-3xl mt-1 text-ink">{duracion(resolucion)}</div>
          <div className="text-xs text-ink/50 mt-1">promedio, cerrados en 30 días</div>
        </div>
      </div>

      {tickets && todos.length === 0 && (
        <p className="text-sm text-ink/60">
          Todavía no hay tickets leídos. {esAdmin ? "Cargá la dirección y el token en “Configurar lectura” y tocá “Leer ahora”." : "Un administrador tiene que configurar la lectura."}
        </p>
      )}

      {lista.length > 0 && (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="card p-5">
            <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
              <h2 className="font-medium text-ink">Últimas {SEMANAS} semanas</h2>
              <span className="text-xs text-ink/50 flex gap-3">
                <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-brand-500 inline-block" /> Creados</span>
                <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> Cerrados</span>
              </span>
            </div>
            {!haySemanas ? <p className="text-sm text-ink/50">Sin movimientos en este período.</p> : (
              <div className="flex items-end gap-2 h-36" role="img" aria-label="Tickets creados y cerrados por semana">
                {semanas.map((s) => (
                  <div key={s.semana} className="flex-1 flex flex-col h-full" title={`Semana del ${s.semana.split("-").reverse().join("/")}: ${s.creados} creados, ${s.cerrados} cerrados`}>
                    <div className="flex-1 flex items-end gap-[2px]">
                      <div className="flex-1 bg-brand-500 rounded-t-sm" style={{ height: `${(s.creados / maxSemana) * 100}%` }} />
                      <div className="flex-1 bg-emerald-500 rounded-t-sm" style={{ height: `${(s.cerrados / maxSemana) * 100}%` }} />
                    </div>
                    <div className="text-[10px] text-ink/40 text-center mt-1">{s.semana.slice(8)}/{s.semana.slice(5, 7)}</div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-ink/50 mt-2">Si se crean más de los que se cierran, el pendiente crece. Cada barra es una semana (de lunes a domingo).</p>
          </div>

          <div className="card p-5">
            <h2 className="font-medium text-ink mb-3">Sin cerrar, por persona asignada</h2>
            {carga.length === 0 ? <p className="text-sm text-ink/50">No hay tickets sin cerrar.</p> : (
              <div className="overflow-x-auto">
                <table className="data w-full">
                  <thead><tr><th>Asignado a</th><th>Abiertos</th><th>Espera</th><th title="Tickets donde falta la respuesta de quien atiende">Sin resp.</th><th title="SLA vencido o escalado">SLA venc.</th><th title="Sin movimiento">Quietos</th><th>Más antiguo</th></tr></thead>
                  <tbody>
                    {carga.map((s) => (
                      <tr key={s.clave}>
                        <td className="text-ink">{s.clave}</td>
                        <td className="tabular-nums">{s.abierto}</td>
                        <td className="tabular-nums">{s.en_espera}</td>
                        <td className={`tabular-nums ${s.falta ? "text-red-600 font-medium" : "text-ink/50"}`}>{haySeguimiento ? s.falta : "—"}</td>
                        <td className={`tabular-nums ${s.vencidos ? "text-red-600 font-medium" : "text-ink/50"}`}>{s.vencidos}</td>
                        <td className={`tabular-nums ${s.quietos ? "text-amber-700" : "text-ink/50"}`}>{s.quietos}</td>
                        <td className="text-ink/70 whitespace-nowrap">{duracion(s.max || null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <Conteos titulo="Sin cerrar, por tipo" datos={porTipo} />
          <Conteos titulo="Sin cerrar, por prioridad" datos={porPrioridad} />
        </div>
      )}

      <div className="flex gap-3 flex-wrap items-center">
        <input type="search" className="input flex-1 min-w-[14rem]" placeholder="Buscar por número, título, sector o persona…"
          value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
        <button onClick={() => { setSinResponder(!sinResponder); setQuietos(false); setFiltro(null); }} aria-pressed={sinResponder}
          className={`px-3 py-2 rounded-lg text-sm border transition-colors ${sinResponder ? "border-red-500 bg-red-50 text-red-600 font-medium" : "border-line/20 text-ink/70 hover:border-brand-300"}`}>
          {txtFalta} ({haySeguimiento ? faltaRespuesta.length : "—"})
        </button>
        <button onClick={() => { setQuietos(!quietos); setSinResponder(false); setFiltro(null); }} aria-pressed={quietos}
          className={`px-3 py-2 rounded-lg text-sm border transition-colors ${quietos ? "border-amber-500 bg-amber-500/10 text-amber-700 font-medium" : "border-line/20 text-ink/70 hover:border-brand-300"}`}>
          Sin movimiento ({sinMovimiento.length})
        </button>
        <select className="input w-auto" value={diasQuieto} onChange={(e) => setDiasQuieto(Number(e.target.value))} aria-label="Días sin movimiento">
          {[3, 7, 15, 30].map((d) => <option key={d} value={d}>hace más de {d} días</option>)}
        </select>
        <button className="btn-secondary" onClick={exportar} disabled={enTabla.length === 0}>Exportar a Excel ({enTabla.length})</button>
      </div>

      <FiltrosActivos ctl={fc} total={filas.length} />

      <div className="card overflow-x-auto">
        <table className="data w-full" data-paginada>
          <thead>
            <tr>
              <th>Ticket</th><ThFiltro ctl={fc} col="estado">Estado</ThFiltro><ThFiltro ctl={fc} col="sector">Sector</ThFiltro>
              <ThFiltro ctl={fc} col="prioridad">Prioridad</ThFiltro><ThFiltro ctl={fc} col="asignado">Asignado a</ThFiltro>
              <ThFiltro ctl={fc} col="respuesta">Respuesta</ThFiltro><ThFiltro ctl={fc} col="sla">SLA</ThFiltro><th>Creado</th>
              <th>{filtro === "cerrado" && !quietos && !sinResponder ? "Tardó" : "Lleva"}</th><th>Último movimiento</th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((t) => {
              const q = t.grupo === "cerrado" ? null : quieto(t);
              const clave = `${t.bandeja}-${t.id}`;
              const haceMsj = t.ult_msj_fecha ? ahora - Date.parse(t.ult_msj_fecha) : null;
              return (
                <Fragment key={clave}>
                  <tr className="cursor-pointer hover:bg-line/[0.03]" onClick={() => setAbierto(abierto === clave ? null : clave)} aria-expanded={abierto === clave}>
                    <td>
                      <span className="text-ink/40 mr-1" aria-hidden>{abierto === clave ? "▾" : "▸"}</span>
                      {t.url ? <a href={t.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="font-medium text-brand-600 hover:underline">{t.numero || `#${t.id}`}</a>
                        : <span className="font-medium text-ink">{t.numero || `#${t.id}`}</span>}
                      <div className="text-xs text-ink/60 max-w-[28rem] truncate" title={t.titulo ?? ""}>{t.titulo ?? "—"}</div>
                      {(t.tipo || t.solicitante) && <div className="text-xs text-ink/40">{[t.tipo, t.solicitante && `de ${t.solicitante}`].filter(Boolean).join(" · ")}</div>}
                    </td>
                    <td><span className={`pill ${GRUPOS[t.grupo as Grupo].pill}`}>{t.estado || GRUPOS[t.grupo as Grupo].uno}</span></td>
                    <td className="text-ink/70">
                      {t.sector ?? "—"}
                      {t.sector_inferido && <div className="text-xs text-ink/40" title="El ticket está asignado solo a personas; el sector se deduce del sector habitual de esas personas.">por persona asignada</div>}
                    </td>
                    <td className="text-ink/70">{t.prioridad ?? "—"}</td>
                    <td className="text-ink/70">{t.asignado ?? "Sin asignar"}</td>
                    <td>
                      {t.grupo === "cerrado" || !t.respuesta_de ? <span className="text-ink/40">—</span> : (
                        <>
                          <span className={`pill ${t.respuesta_de === "atencion" ? "bg-red-50 text-red-600" : "bg-line/[0.05] text-ink/60"}`}>{t.respuesta_de === "atencion" ? txtFalta : "Espera al solicitante"}</span>
                          {t.ult_msj_autor && <div className="text-xs text-ink/40 mt-0.5">último: {t.ult_msj_autor}{haceMsj != null && `, hace ${duracion(haceMsj)}`}</div>}
                        </>
                      )}
                    </td>
                    <td>{t.sla ? <span className={`pill ${slaPill(t.sla)}`}>{t.sla}</span> : <span className="text-ink/40">—</span>}</td>
                    <td className="text-ink/60 whitespace-nowrap">{fecha(t.creado)}</td>
                    <td className="text-ink whitespace-nowrap">{duracion(tiempo(t))}</td>
                    <td className={`whitespace-nowrap ${q != null && q >= diasQuieto * DIA ? "text-amber-700" : "text-ink/60"}`}>{q == null ? "—" : `hace ${duracion(q)}`}</td>
                  </tr>
                  {abierto === clave && (
                    <tr>
                      <td colSpan={10} className="bg-line/[0.02]">
                        <div className="p-2 max-w-4xl"><TicketSeguimiento id={String(t.id)} solicitante={t.solicitante ?? null} recorrido={t.recorrido ?? null} /></div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {enTabla.length === 0 && (
              <tr><td colSpan={10} className="text-center text-ink/40 py-10">
                {texto || fc.activos ? "Ningún ticket coincide con el filtro." : "No hay tickets en esta situación."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {enTabla.length > POR_PAGINA && (
        <nav aria-label="Páginas de tickets" className="flex items-center justify-between gap-3 flex-wrap text-sm">
          <span className="text-ink/60">
            Mostrando {(paginaActual - 1) * POR_PAGINA + 1}–{Math.min(paginaActual * POR_PAGINA, enTabla.length)} de {enTabla.length} tickets
          </span>
          <div className="flex items-center gap-1">
            <button className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={paginaActual === 1} onClick={() => setPagina(paginaActual - 1)}>Anterior</button>
            <span className="px-2 text-ink/60 tabular-nums">{paginaActual} / {paginas}</span>
            <button className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={paginaActual === paginas} onClick={() => setPagina(paginaActual + 1)}>Siguiente</button>
          </div>
        </nav>
      )}
    </div>
  );
}
