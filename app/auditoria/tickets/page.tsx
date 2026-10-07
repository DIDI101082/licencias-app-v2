"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { ThFiltro, FiltrosActivos, useFiltrosColumna } from "@/components/FiltroColumna";
import { exportarExcel } from "@/lib/excel";
import TicketsLectura from "@/components/TicketsLectura";

// Tickets del sistema de tickets (helpdesk), leídos cada 15 minutos. Solo lectura.

type Grupo = "abierto" | "en_espera" | "cerrado";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ticket = Record<string, any>;

const GRUPOS: Record<Grupo, { titulo: string; uno: string; pill: string }> = {
  abierto: { titulo: "Abiertos", uno: "Abierto", pill: "bg-brand-50 text-brand-700" },
  en_espera: { titulo: "En espera", uno: "En espera", pill: "bg-amber-500/10 text-amber-700" },
  cerrado: { titulo: "Cerrados (30 días)", uno: "Cerrado", pill: "bg-emerald-50 text-emerald-700" },
};
const DIA = 86400000;

function duracion(ms: number | null) {
  if (ms == null || ms < 0) return "—";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} min`;
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 día" : `${d} días`;
}
const fecha = (v: string | null) => (v ? new Date(v).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "—");

export default function Tickets() {
  const { esAdmin } = usePerfil();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [falta, setFalta] = useState(false);
  const [filtro, setFiltro] = useState<Grupo | null>(null);
  const [texto, setTexto] = useState("");
  const [verConfig, setVerConfig] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [ahora, setAhora] = useState(Date.now());

  const cargar = () =>
    createClient().from("tickets_ext").select("*").order("creado", { ascending: true, nullsFirst: false }).limit(5000)
      .then(({ data, error }) => { setFalta(!!error && /tickets_ext/.test(error.message)); setTickets(data ?? []); setAhora(Date.now()); });
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

  const lista = tickets ?? [];
  const sinCerrar = lista.filter((t) => t.grupo !== "cerrado");
  const cerrados30 = lista.filter((t) => t.grupo === "cerrado" && t.cerrado && ahora - Date.parse(t.cerrado) <= 30 * DIA);
  const cuenta: Record<Grupo, number> = {
    abierto: lista.filter((t) => t.grupo === "abierto").length,
    en_espera: lista.filter((t) => t.grupo === "en_espera").length,
    cerrado: cerrados30.length,
  };
  const tiempos = sinCerrar.map(tiempo).filter((x): x is number => x != null);
  const promedio = tiempos.length ? tiempos.reduce((a, b) => a + b, 0) / tiempos.length : null;
  const masAntiguo = tiempos.length ? Math.max(...tiempos) : null;
  const resolucion = cerrados30.map(tiempo).filter((x): x is number => x != null);
  const promResolucion = resolucion.length ? resolucion.reduce((a, b) => a + b, 0) / resolucion.length : null;

  // Por sector: abiertos, en espera y el más antiguo
  const sectores = useMemo(() => {
    const m = new Map<string, { sector: string; abierto: number; en_espera: number; max: number }>();
    sinCerrar.forEach((t) => {
      const k = t.sector || "Sin sector";
      const x = m.get(k) ?? { sector: k, abierto: 0, en_espera: 0, max: 0 };
      x[t.grupo as "abierto" | "en_espera"]++;
      x.max = Math.max(x.max, tiempo(t) ?? 0);
      m.set(k, x);
    });
    return Array.from(m.values()).sort((a, b) => b.abierto + b.en_espera - (a.abierto + a.en_espera));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, ahora]);

  // Sin filtro se muestran los que no están cerrados, del más antiguo al más nuevo
  const filas = useMemo(() => {
    const base = filtro === "cerrado" ? cerrados30 : filtro ? lista.filter((t) => t.grupo === filtro) : sinCerrar;
    const q = texto.trim().toLowerCase();
    return base.filter((t) => !q || [t.id, t.numero, t.titulo, t.estado, t.sector, t.asignado, t.solicitante, t.prioridad]
      .some((v) => v && String(v).toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, filtro, texto, ahora]);

  const fc = useFiltrosColumna(filas, {
    estado: (t) => t.estado || GRUPOS[t.grupo as Grupo].uno,
    sector: (t) => t.sector || "Sin sector",
    prioridad: (t) => t.prioridad || "—",
    asignado: (t) => t.asignado || "Sin asignar",
  });
  const enTabla = fc.filtradas;
  useEffect(() => { setPagina(1); }, [filtro, texto, fc.filtros]);
  const POR_PAGINA = 50;
  const paginas = Math.max(1, Math.ceil(enTabla.length / POR_PAGINA));
  const paginaActual = Math.min(pagina, paginas);
  const visibles = enTabla.slice((paginaActual - 1) * POR_PAGINA, paginaActual * POR_PAGINA);

  const exportar = () =>
    exportarExcel(
      `tickets-${new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })}`,
      ["Ticket", "Título", "Estado", "Situación", "Sector", "Prioridad", "Solicitante", "Asignado a", "Creado", "Cerrado", "Días"],
      enTabla.map((t) => {
        const ms = tiempo(t);
        return [t.numero || t.id, t.titulo, t.estado, GRUPOS[t.grupo as Grupo].uno, t.sector, t.prioridad, t.solicitante, t.asignado,
          fecha(t.creado), t.cerrado ? fecha(t.cerrado) : "", ms == null ? "" : Math.round((ms / DIA) * 10) / 10];
      }),
      { "Título": 40, Sector: 22, Solicitante: 26, "Asignado a": 26 },
    );

  if (falta) return <div className="card p-5 text-sm text-ink/60"><b>Tickets:</b> falta ejecutar supabase/tickets-lectura.sql en Supabase.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Tickets</h1>
          <p className="text-ink/60 text-sm mt-1">Estado de los tickets del sistema de tickets. Se leen cada 15 minutos; desde acá no se modifican.</p>
        </div>
        {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)} aria-expanded={verConfig}>Configurar lectura</button>}
      </div>

      {esAdmin && verConfig && <TicketsLectura alLeer={cargar} />}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {(["abierto", "en_espera", "cerrado"] as Grupo[]).map((g) => (
          <button key={g} onClick={() => setFiltro(filtro === g ? null : g)} aria-pressed={filtro === g}
            className={`card p-5 text-left transition-colors ${filtro === g ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{GRUPOS[g].titulo}</div>
            <div className="font-display text-3xl mt-1 text-ink">{cuenta[g]}</div>
          </button>
        ))}
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Antigüedad promedio</div>
          <div className="font-display text-3xl mt-1 text-ink">{duracion(promedio)}</div>
          <div className="text-xs text-ink/50 mt-1">de los que siguen sin cerrar</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">El más antiguo</div>
          <div className="font-display text-3xl mt-1 text-ink">{duracion(masAntiguo)}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Tiempo de resolución</div>
          <div className="font-display text-3xl mt-1 text-ink">{duracion(promResolucion)}</div>
          <div className="text-xs text-ink/50 mt-1">promedio, cerrados en 30 días</div>
        </div>
      </div>

      {tickets && lista.length === 0 && (
        <p className="text-sm text-ink/60">
          Todavía no hay tickets leídos. {esAdmin ? "Cargá la dirección y el token en “Configurar lectura” y tocá “Leer ahora”." : "Un administrador tiene que configurar la lectura."}
        </p>
      )}

      {sectores.length > 0 && (
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-3">Sin cerrar, por sector</h2>
          <div className="overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Sector</th><th>Abiertos</th><th>En espera</th><th>El más antiguo</th></tr></thead>
              <tbody>
                {sectores.map((s) => (
                  <tr key={s.sector}>
                    <td className="text-ink">{s.sector}</td>
                    <td className="tabular-nums">{s.abierto}</td>
                    <td className="tabular-nums">{s.en_espera}</td>
                    <td className="text-ink/70">{duracion(s.max || null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex gap-3 flex-wrap items-center">
        <input type="search" className="input flex-1 min-w-[14rem]" placeholder="Buscar por número, título, sector o persona…"
          value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
        <button className="btn-secondary" onClick={exportar} disabled={enTabla.length === 0}>Exportar a Excel ({enTabla.length})</button>
      </div>

      <FiltrosActivos ctl={fc} total={filas.length} />

      <div className="card overflow-x-auto">
        <table className="data w-full" data-paginada>
          <thead>
            <tr>
              <th>Ticket</th><ThFiltro ctl={fc} col="estado">Estado</ThFiltro><ThFiltro ctl={fc} col="sector">Sector</ThFiltro>
              <ThFiltro ctl={fc} col="prioridad">Prioridad</ThFiltro><ThFiltro ctl={fc} col="asignado">Asignado a</ThFiltro>
              <th>Creado</th><th>{filtro === "cerrado" ? "Tardó" : "Lleva"}</th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.url ? <a href={t.url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 hover:underline">{t.numero || `#${t.id}`}</a>
                    : <span className="font-medium text-ink">{t.numero || `#${t.id}`}</span>}
                  <div className="text-xs text-ink/60 max-w-[28rem] truncate" title={t.titulo ?? ""}>{t.titulo ?? "—"}</div>
                </td>
                <td><span className={`pill ${GRUPOS[t.grupo as Grupo].pill}`}>{t.estado || GRUPOS[t.grupo as Grupo].uno}</span></td>
                <td className="text-ink/70">{t.sector ?? "—"}</td>
                <td className="text-ink/70">{t.prioridad ?? "—"}</td>
                <td className="text-ink/70">{t.asignado ?? "Sin asignar"}</td>
                <td className="text-ink/60 whitespace-nowrap">{fecha(t.creado)}</td>
                <td className="text-ink whitespace-nowrap">{duracion(tiempo(t))}</td>
              </tr>
            ))}
            {enTabla.length === 0 && (
              <tr><td colSpan={7} className="text-center text-ink/40 py-10">
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
