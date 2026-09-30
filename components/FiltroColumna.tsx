"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { aplicarFiltros, valoresDisponibles, type Extractor, type Filtros } from "@/lib/filtros-columna";

// ------------------------------------------------------------------
// Hook: filtros por columna tipo Excel para cualquier tabla.
//   const f = useFiltrosColumna(filas, { estado: (e) => ESTADOS[e.estado], area: (e) => e.area });
//   f.filtradas → las filas que cumplen los filtros
//   <ThFiltro ctl={f} col="estado">Estado</ThFiltro> en el encabezado
// ------------------------------------------------------------------
export type ControlFiltros<T> = ReturnType<typeof useFiltrosColumna<T>>;

export function useFiltrosColumna<T>(filas: T[], columnas: Record<string, Extractor<T>>) {
  const [filtros, setFiltros] = useState<Filtros>({});
  // Las funciones de cada columna cambian en cada render; se usan siempre las últimas
  const cols = useRef(columnas);
  cols.current = columnas;

  const filtradas = useMemo(() => aplicarFiltros(filas, cols.current, filtros), [filas, filtros]);
  const opciones = useCallback(
    (col: string) => valoresDisponibles(aplicarFiltros(filas, cols.current, filtros, col), cols.current[col]),
    [filas, filtros],
  );
  const fijar = useCallback((col: string, valores: Set<string> | null) => {
    setFiltros((prev) => {
      const nuevo = { ...prev };
      if (valores) nuevo[col] = valores; else delete nuevo[col];
      return nuevo;
    });
  }, []);
  const limpiar = useCallback(() => setFiltros({}), []);
  const activos = Object.keys(filtros).length;

  return { filtradas, filtros, opciones, fijar, limpiar, activos };
}

// ------------------------------------------------------------------
// Encabezado de columna con el botón de filtro
// ------------------------------------------------------------------
export function IconoFiltro({ lleno }: { lleno: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="shrink-0">
      <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" fill={lleno ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function ThFiltro<T>({
  ctl, col, children, className = "",
}: { ctl: ControlFiltros<T>; col: string; children: React.ReactNode; className?: string }) {
  const [abierto, setAbierto] = useState(false);
  const boton = useRef<HTMLButtonElement>(null);
  const activo = !!ctl.filtros[col];
  const titulo = typeof children === "string" ? children : col;

  return (
    <th className={className}>
      <span className="inline-flex items-center gap-1.5">
        {children}
        <button ref={boton} type="button" onClick={(e) => { e.stopPropagation(); setAbierto(!abierto); }}
          aria-haspopup="dialog" aria-expanded={abierto} aria-label={`Filtrar ${titulo}${activo ? " (filtro activo)" : ""}`}
          title={activo ? "Filtro activo" : "Filtrar"}
          className={`rounded p-1 -m-1 transition-colors ${activo ? "text-brand-600" : "text-ink/35 hover:text-ink/70"}`}>
          <IconoFiltro lleno={activo} />
        </button>
      </span>
      {abierto && boton.current && (
        <PanelFiltro titulo={titulo} ancla={boton.current} opciones={ctl.opciones(col)} elegidos={ctl.filtros[col] ?? null}
          onAplicar={(s) => { ctl.fijar(col, s); setAbierto(false); }} onCerrar={() => setAbierto(false)} />
      )}
    </th>
  );
}

// ------------------------------------------------------------------
// Panel desplegable: buscador + lista de valores con tildes
// ------------------------------------------------------------------
const ANCHO = 280;

export function PanelFiltro({
  titulo, ancla, opciones, elegidos, onAplicar, onCerrar,
}: {
  titulo: string; ancla: HTMLElement; opciones: { valor: string; n: number }[]; elegidos: Set<string> | null;
  onAplicar: (s: Set<string> | null) => void; onCerrar: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const buscador = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [q, setQ] = useState("");

  // Si había valores elegidos que ya no aparecen (por otro filtro), se siguen mostrando con 0
  const todas = useMemo(() => {
    const vistos = new Set(opciones.map((o) => o.valor));
    return [...opciones, ...Array.from(elegidos ?? []).filter((v) => !vistos.has(v)).map((valor) => ({ valor, n: 0 }))];
  }, [opciones, elegidos]);
  const [marcados, setMarcados] = useState<Set<string>>(() => new Set(elegidos ?? todas.map((o) => o.valor)));

  const visibles = todas.filter((o) => !q || o.valor.toLowerCase().includes(q.trim().toLowerCase()));
  const todosVisiblesMarcados = visibles.length > 0 && visibles.every((o) => marcados.has(o.valor));

  useLayoutEffect(() => {
    const r = ancla.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left - 8, window.innerWidth - ANCHO - 8));
    setPos({ top: r.bottom + 6, left });
    buscador.current?.focus();
  }, [ancla]);

  useEffect(() => {
    const fuera = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !ancla.contains(e.target as Node)) onCerrar();
    };
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape") { onCerrar(); ancla.focus(); } };
    // Al desplazar la página el panel quedaría desfasado del encabezado: se cierra
    const scroll = (e: Event) => { if (!panel.current?.contains(e.target as Node)) onCerrar(); };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", tecla);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onCerrar);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", tecla);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onCerrar);
    };
  }, [ancla, onCerrar]);

  function alternar(v: string) {
    const s = new Set(marcados);
    if (s.has(v)) s.delete(v); else s.add(v);
    setMarcados(s);
  }
  function alternarVisibles() {
    const s = new Set(marcados);
    visibles.forEach((o) => (todosVisiblesMarcados ? s.delete(o.valor) : s.add(o.valor)));
    setMarcados(s);
  }
  function aplicar() {
    // Con una búsqueda escrita, se aplica solo lo que coincide (como el "Seleccionar resultados" de Excel)
    const final = q ? new Set(visibles.filter((o) => marcados.has(o.valor)).map((o) => o.valor)) : marcados;
    const todo = todas.every((o) => final.has(o.valor));
    onAplicar(todo ? null : final);
  }

  return createPortal(
    <div ref={panel} role="dialog" aria-label={`Filtrar ${titulo}`}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: ANCHO, zIndex: 60 }}
      className="bg-surface border border-line/10 rounded-xl shadow-lg p-3 space-y-2 normal-case tracking-normal font-normal text-left"
      onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "search") aplicar(); }}>
      <input ref={buscador} type="search" className="input py-1.5 text-sm" placeholder={`Buscar en ${titulo.toLowerCase()}…`}
        value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar valores" />
      <div className="max-h-64 overflow-y-auto -mx-1 px-1">
        <label className="flex items-center gap-2 py-1 text-sm text-ink cursor-pointer border-b border-line/[0.06] mb-1">
          <input type="checkbox" checked={todosVisiblesMarcados} onChange={alternarVisibles} />
          <span className="font-medium">{q ? "Seleccionar resultados" : "Seleccionar todo"}</span>
        </label>
        {visibles.map((o) => (
          <label key={o.valor} className="flex items-center gap-2 py-1 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={marcados.has(o.valor)} onChange={() => alternar(o.valor)} />
            <span className="flex-1 min-w-0 truncate" title={o.valor}>{o.valor}</span>
            <span className="text-xs text-ink/40 tabular-nums">{o.n}</span>
          </label>
        ))}
        {visibles.length === 0 && <p className="text-sm text-ink/40 py-2">Ningún valor coincide.</p>}
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" className="text-sm text-ink/55 hover:text-ink hover:underline disabled:opacity-40" disabled={!elegidos}
          onClick={() => onAplicar(null)}>
          Quitar filtro
        </button>
        <button type="button" className="btn-primary px-3 py-1.5" onClick={aplicar}
          disabled={marcados.size === 0 || (!!q && !visibles.some((o) => marcados.has(o.valor)))}>
          Aplicar
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------
// Aviso de filtros activos, para poner arriba o abajo de la tabla
// ------------------------------------------------------------------
export function FiltrosActivos<T>({ ctl, total }: { ctl: ControlFiltros<T>; total: number }) {
  if (!ctl.activos) return null;
  return (
    <div className="flex items-center gap-3 text-sm text-ink/60">
      <span>
        {ctl.filtradas.length} de {total} con {ctl.activos === 1 ? "1 filtro de columna" : `${ctl.activos} filtros de columna`}
      </span>
      <button type="button" className="text-brand-600 hover:underline" onClick={ctl.limpiar}>Quitar filtros de columna</button>
    </div>
  );
}
