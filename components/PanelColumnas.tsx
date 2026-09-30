"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ANCHO = 260;

// Panel para elegir qué columnas se ven en una tabla (los cambios se aplican al instante)
export function PanelColumnas({
  columnas, ocultas, ancla, onCambiar, onCerrar,
}: {
  columnas: string[];          // títulos de las columnas que se pueden ocultar
  ocultas: Set<string>;
  ancla: HTMLElement;
  onCambiar: (ocultas: Set<string>) => void;
  onCerrar: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [sel, setSel] = useState<Set<string>>(() => new Set(ocultas));

  useLayoutEffect(() => {
    const r = ancla.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - ANCHO, window.innerWidth - ANCHO - 8));
    setPos({ top: r.bottom + 6, left });
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [ancla]);

  useEffect(() => {
    const fuera = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !ancla.contains(e.target as Node)) onCerrar();
    };
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape") { onCerrar(); ancla.focus(); } };
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

  const visibles = columnas.filter((c) => !sel.has(c)).length;

  function cambiar(s: Set<string>) { setSel(s); onCambiar(s); }
  function alternar(c: string) {
    const s = new Set(sel);
    if (s.has(c)) s.delete(c); else s.add(c);
    cambiar(s);
  }

  return createPortal(
    <div ref={panel} role="dialog" aria-label="Elegir columnas"
      style={{ position: "fixed", top: pos.top, left: pos.left, width: ANCHO, zIndex: 60 }}
      className="bg-surface border border-line/10 rounded-xl shadow-lg p-3 space-y-2 normal-case tracking-normal font-normal text-left">
      <p className="text-xs text-ink/50">Columnas visibles ({visibles} de {columnas.length})</p>
      <div className="max-h-72 overflow-y-auto -mx-1 px-1">
        {columnas.map((c) => {
          const ultima = !sel.has(c) && visibles === 1;   // siempre queda al menos una
          return (
            <label key={c} className={`flex items-center gap-2 py-1 text-sm text-ink ${ultima ? "opacity-50" : "cursor-pointer"}`}>
              <input type="checkbox" checked={!sel.has(c)} disabled={ultima} onChange={() => alternar(c)} />
              <span className="flex-1 min-w-0 truncate" title={c}>{c}</span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-line/[0.06]">
        <button type="button" className="text-sm text-ink/55 hover:text-ink hover:underline disabled:opacity-40" disabled={sel.size === 0}
          onClick={() => cambiar(new Set())}>
          Mostrar todas
        </button>
        <button type="button" className="btn-secondary px-3 py-1.5" onClick={onCerrar}>Listo</button>
      </div>
    </div>,
    document.body,
  );
}
