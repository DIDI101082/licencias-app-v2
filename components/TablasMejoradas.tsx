"use client";

// ------------------------------------------------------------------
// Filtros por columna (tipo Excel) y páginas de a 50 en TODAS las tablas de la app.
//
// Se monta una sola vez en el layout. Busca cada <table class="data"> dentro de <main> y:
//   * agrega un embudo en cada encabezado con texto, que abre el mismo panel de filtros
//     que usan Monitoreo, Equipos, etc. (valores de la columna, buscador, tildes);
//   * si la tabla tiene más de 50 filas, la divide en páginas;
//   * agrega un botón "Columnas" en el último encabezado visible para ocultar y mostrar columnas
//     (la elección se guarda en el navegador, por pantalla y por tabla);
//   * se vuelve a acomodar solo cuando la pantalla cambia las filas (datos en vivo, pestañas).
//
// No toca los datos ni el código de cada pantalla: solo oculta filas con un atributo.
//   * data-sin-filtros en la tabla  → se deja como está (matrices de permisos, documentos para imprimir).
//   * data-paginada en la tabla     → la pantalla ya pagina por su cuenta; solo se agregan filtros si no los tiene.
//   * Tablas con filtros propios (ThFiltro) → se respetan y solo se paginan.
//   * data-sin-columnas en la tabla → no se ofrece elegir columnas.
// ------------------------------------------------------------------

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { PanelFiltro } from "@/components/FiltroColumna";
import { PanelColumnas } from "@/components/PanelColumnas";
import { VACIO, valoresDisponibles } from "@/lib/filtros-columna";

const POR_PAGINA = 50;
const MIN_FILAS_FILTRO = 5;       // con menos filas no vale la pena filtrar
const MARCA = "data-mt";           // todo lo que agrega este componente lleva esta marca
const MIN_COLUMNAS = 3;            // con menos columnas con título no se ofrece elegir

// Etiquetas que cortan el "valor principal" de una celda: "Daniel Creta<div>ÁREA</div>" → "Daniel Creta"
const BLOQUES = new Set(["DIV", "P", "UL", "OL", "LI", "BR", "TABLE", "DETAILS", "DL", "SECTION"]);

// Valor de una celda para filtrar: el texto principal, sin las líneas secundarias
export function valorCelda(td: HTMLTableCellElement): string {
  const select = td.querySelector("select");
  if (select) return select.selectedOptions[0]?.text.trim() || VACIO;
  const casillas = td.querySelectorAll('input[type="checkbox"]');
  if (casillas.length === 1 && !td.textContent?.trim()) return (casillas[0] as HTMLInputElement).checked ? "Sí" : "No";
  const input = td.querySelector('input:not([type="checkbox"]):not([type="radio"])') as HTMLInputElement | null;
  if (input && !td.textContent?.trim()) return input.value.trim() || VACIO;

  let texto = "";
  let listo = false;
  const recorrer = (n: Node) => {
    if (listo) return;
    if (n.nodeType === Node.TEXT_NODE) { texto += n.textContent ?? ""; return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.hasAttribute(MARCA) || el.tagName === "BUTTON" && !el.textContent?.trim()) return;
    if (BLOQUES.has(el.tagName)) {
      if (texto.trim()) { listo = true; return; }
      // bloque al principio de la celda: su contenido es el valor principal
      el.childNodes.forEach(recorrer);
      if (texto.trim()) listo = true;
      return;
    }
    el.childNodes.forEach(recorrer);
  };
  td.childNodes.forEach(recorrer);
  const v = texto.replace(/\s+/g, " ").trim();
  return v || VACIO;
}

type Fila = { tr: HTMLTableRowElement; anexas: HTMLTableRowElement[]; valores: string[] };

const ICONO_COLUMNAS = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 3v10M10 3v10" stroke="currentColor" stroke-width="1.4"/></svg>`;

function leerOcultas(clave: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(clave) ?? "[]")); } catch { return new Set(); }
}
function guardarOcultas(clave: string, s: Set<string>) {
  try { if (s.size) localStorage.setItem(clave, JSON.stringify(Array.from(s))); else localStorage.removeItem(clave); } catch { /* sin almacenamiento */ }
}

function iconoSvg(lleno: boolean) {
  return `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" fill="${lleno ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}

class TablaMejorada {
  tabla: HTMLTableElement;
  filtros = new Map<number, Set<string>>();
  pagina = 1;
  columnas: string[] = [];
  filas: Fila[] = [];
  botones = new Map<number, HTMLButtonElement>();
  pie: HTMLDivElement | null = null;
  raizPie: Root | null = null;
  panel: { raiz: Root; div: HTMLDivElement } | null = null;
  firmaCabecera = "";
  ruta: string;
  ocultas = new Set<string>();
  botonCols: HTMLButtonElement | null = null;

  constructor(t: HTMLTableElement, ruta: string) { this.tabla = t; this.ruta = ruta; }

  get claveColumnas() { return `mt-columnas:${this.ruta}:${this.firmaCabecera}`; }

  // Columnas que se pueden ocultar: con título único. Solo en tablas de una fila de encabezado sin celdas combinadas.
  elegibles(ths: HTMLTableCellElement[]): string[] {
    if (this.tabla.hasAttribute("data-sin-columnas")) return [];
    if ((this.tabla.tHead?.rows.length ?? 0) !== 1 || ths.some((th) => (th.colSpan || 1) > 1)) return [];
    const cuenta = new Map<string, number>();
    this.columnas.forEach((c) => c && cuenta.set(c, (cuenta.get(c) ?? 0) + 1));
    const lista = this.columnas.filter((c) => c && cuenta.get(c) === 1);
    return lista.length >= MIN_COLUMNAS ? lista : [];
  }

  aplicarColumnas(ths: HTMLTableCellElement[], elegibles: string[]) {
    const ocultar = ths.map((_, i) => elegibles.includes(this.columnas[i]) && this.ocultas.has(this.columnas[i]));
    const marcar = (el: Element | undefined, si: boolean) => {
      if (!el) return;
      if (si) { if (!el.hasAttribute("data-mt-col-oculta")) el.setAttribute("data-mt-col-oculta", ""); }
      else if (el.hasAttribute("data-mt-col-oculta")) el.removeAttribute("data-mt-col-oculta");
    };
    ths.forEach((th, i) => marcar(th, ocultar[i]));
    const filas = [
      ...this.filas.map((f) => f.tr),
      ...Array.from(this.tabla.tFoot?.rows ?? []),
    ];
    filas.forEach((tr) => {
      if (tr.cells.length !== ths.length) return;   // filas con celdas combinadas: se dejan como están
      Array.from(tr.cells).forEach((td, i) => marcar(td, ocultar[i]));
    });

    // Botón "Columnas" en el último encabezado visible
    if (!elegibles.length) { this.botonCols?.remove(); this.botonCols = null; return; }
    const destino = [...ths].reverse().find((th, j) => !ocultar[ths.length - 1 - j]);
    if (!destino) return;
    if (!this.botonCols) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute(MARCA, "");
      b.setAttribute("data-mt-cols", "");
      b.setAttribute("aria-haspopup", "dialog");
      b.addEventListener("click", (e) => { e.stopPropagation(); this.abrirColumnas(b); });
      b.innerHTML = ICONO_COLUMNAS;
      this.botonCols = b;
    }
    const b = this.botonCols;
    const hay = this.ocultas.size > 0;
    const cls = `ml-2 align-middle rounded p-1 -m-1 transition-colors print:hidden float-right ${hay ? "text-brand-600" : "text-ink/35 hover:text-ink/70"}`;
    if (b.className !== cls) b.className = cls;
    const etiqueta = hay ? `Elegir columnas (${this.ocultas.size} ocultas)` : "Elegir columnas";
    if (b.getAttribute("aria-label") !== etiqueta) { b.setAttribute("aria-label", etiqueta); b.title = etiqueta; }
    if (b.parentElement !== destino) destino.appendChild(b);
  }

  abrirColumnas(ancla: HTMLButtonElement) {
    if (this.panel) { this.cerrarPanel(); return; }
    const elegibles = this.elegibles(this.cabeceras());
    const div = document.createElement("div");
    div.setAttribute(MARCA, "");
    document.body.appendChild(div);
    const raiz = createRoot(div);
    this.panel = { raiz, div };
    flushSync(() => raiz.render(
      <PanelColumnas columnas={elegibles} ocultas={this.ocultas} ancla={ancla}
        onCambiar={(s) => { this.ocultas = s; guardarOcultas(this.claveColumnas, s); this.actualizar(); }}
        onCerrar={() => this.cerrarPanel()} />,
    ));
  }

  get conFiltrosPropios() { return !!this.tabla.querySelector('thead button[aria-label^="Filtrar"]:not([data-mt])'); }
  get paginaPropia() { return this.tabla.hasAttribute("data-paginada"); }

  // Encabezados: la última fila del thead (en tablas con dos filas de encabezado, la de abajo)
  cabeceras(): HTMLTableCellElement[] {
    const filas = this.tabla.tHead?.rows;
    if (!filas?.length) return [];
    return Array.from(filas[filas.length - 1].cells);
  }

  leerFilas() {
    const ncols = this.cabeceras().reduce((n, th) => n + (th.colSpan || 1), 0);
    const filas: Fila[] = [];
    Array.from(this.tabla.tBodies).forEach((tb) => Array.from(tb.rows).forEach((tr) => {
      if (tr.hasAttribute(MARCA)) return;
      const celdas = Array.from(tr.cells);
      const unaSola = celdas.length === 1 && (celdas[0].colSpan || 1) > 1;
      if (unaSola || !ncols) {
        // Fila de detalle (se despliega debajo de otra) o mensaje de "sin datos"
        if (filas.length && unaSola) filas[filas.length - 1].anexas.push(tr);
        return;
      }
      filas.push({ tr, anexas: [], valores: celdas.map(valorCelda) });
    }));
    this.filas = filas;
  }

  // Columnas que se pueden filtrar: con título y con algún valor
  filtrable(i: number) {
    return !!this.columnas[i] && this.filas.some((f) => f.valores[i] && f.valores[i] !== VACIO);
  }

  cumple(f: Fila, excepto?: number) {
    for (const [i, s] of this.filtros) {
      if (i === excepto) continue;
      if (!s.has(f.valores[i] ?? VACIO)) return false;
    }
    return true;
  }

  actualizar() {
    if (!this.tabla.isConnected) return;
    const ths = this.cabeceras();
    this.columnas = ths.map((th) => (th.textContent ?? "").replace(/\s+/g, " ").trim());
    const firma = this.columnas.join("|");
    if (firma !== this.firmaCabecera) {
      this.filtros.clear(); this.pagina = 1; this.firmaCabecera = firma;
      this.ocultas = leerOcultas(this.claveColumnas);
    }
    this.leerFilas();

    // Embudos en los encabezados
    const usarFiltros = !this.conFiltrosPropios && this.filas.length >= MIN_FILAS_FILTRO;
    ths.forEach((th, i) => {
      let b = th.querySelector(`button[${MARCA}]:not([data-mt-cols])`) as HTMLButtonElement | null;
      if (!usarFiltros || !this.filtrable(i)) {
        if (b && !this.filtros.has(i)) b.remove();
        if (!b || !this.filtros.has(i)) return;
      }
      if (!b) {
        b = document.createElement("button");
        b.type = "button";
        b.setAttribute(MARCA, "");
        b.setAttribute("aria-haspopup", "dialog");
        b.className = "ml-1.5 align-middle rounded p-1 -m-1 transition-colors print:hidden";
        b.addEventListener("click", (e) => { e.stopPropagation(); this.abrirPanel(i, b!); });
        th.insertBefore(b, th.querySelector("button[data-mt-cols]"));
      }
      const activo = this.filtros.has(i);
      b.className = `ml-1.5 align-middle rounded p-1 -m-1 transition-colors print:hidden ${activo ? "text-brand-600" : "text-ink/35 hover:text-ink/70"}`;
      b.setAttribute("aria-label", `Filtrar ${this.columnas[i]}${activo ? " (filtro activo)" : ""}`);
      b.title = activo ? "Filtro activo" : "Filtrar";
      if (b.dataset.lleno !== String(activo)) { b.innerHTML = iconoSvg(activo); b.dataset.lleno = String(activo); }
      this.botones.set(i, b);
    });

    // Filtrar y paginar
    const visibles = this.filas.filter((f) => this.cumple(f));
    const paginar = !this.paginaPropia && visibles.length > POR_PAGINA;
    const paginas = paginar ? Math.ceil(visibles.length / POR_PAGINA) : 1;
    this.pagina = Math.min(Math.max(1, this.pagina), paginas);
    const enPagina = new Set(paginar ? visibles.slice((this.pagina - 1) * POR_PAGINA, this.pagina * POR_PAGINA) : visibles);
    const pasan = new Set(visibles);
    this.filas.forEach((f) => {
      const estado = !pasan.has(f) ? "filtro" : !enPagina.has(f) ? "pagina" : null;
      [f.tr, ...f.anexas].forEach((tr) => {
        if (estado) { if (tr.getAttribute("data-mt-oculta") !== estado) tr.setAttribute("data-mt-oculta", estado); }
        else if (tr.hasAttribute("data-mt-oculta")) tr.removeAttribute("data-mt-oculta");
      });
    });

    // Columnas ocultas
    const elegibles = this.elegibles(ths);
    this.aplicarColumnas(ths, elegibles);
    const ocultasAhora = elegibles.filter((c) => this.ocultas.has(c)).length;

    this.dibujarPie({ total: this.filas.length, visibles: visibles.length, paginar, paginas, ocultas: ocultasAhora });
  }

  dibujarPie(d: { total: number; visibles: number; paginar: boolean; paginas: number; ocultas: number }) {
    const hace = d.paginar || this.filtros.size > 0 || d.ocultas > 0;
    if (!hace) { this.quitarPie(); return; }
    const envoltura = (this.tabla.closest(".overflow-x-auto, .card") as HTMLElement | null) ?? this.tabla;
    if (!this.pie || !this.pie.isConnected || this.pie.previousElementSibling !== envoltura) {
      this.quitarPie();
      this.pie = document.createElement("div");
      this.pie.setAttribute(MARCA, "");
      this.pie.className = "mt-3 print:hidden";
      envoltura.insertAdjacentElement("afterend", this.pie);
      this.raizPie = createRoot(this.pie);
    }
    const desde = (this.pagina - 1) * POR_PAGINA + 1;
    const hasta = Math.min(this.pagina * POR_PAGINA, d.visibles);
    this.raizPie!.render(
      <div className="flex items-center justify-between gap-3 flex-wrap text-sm">
        <span className="text-ink/60">
          {d.visibles === 0 ? "Ningún registro coincide con los filtros." : d.paginar ? `Mostrando ${desde}–${hasta} de ${d.visibles}` : `${d.visibles} de ${d.total}`}
          {this.filtros.size > 0 && (
            <>
              {" · "}{this.filtros.size === 1 ? "1 filtro de columna" : `${this.filtros.size} filtros de columna`}{" · "}
              <button type="button" className="text-brand-600 hover:underline" onClick={() => { this.filtros.clear(); this.pagina = 1; this.actualizar(); }}>
                Quitar filtros
              </button>
            </>
          )}
          {d.ocultas > 0 && (
            <>
              {" · "}{d.ocultas === 1 ? "1 columna oculta" : `${d.ocultas} columnas ocultas`}{" · "}
              <button type="button" className="text-brand-600 hover:underline"
                onClick={() => { this.ocultas = new Set(); guardarOcultas(this.claveColumnas, this.ocultas); this.actualizar(); }}>
                Mostrar todas
              </button>
            </>
          )}
        </span>
        {d.paginar && (
          <nav aria-label="Páginas" className="flex items-center gap-1 flex-wrap">
            <button type="button" className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={this.pagina === 1}
              onClick={() => this.irA(this.pagina - 1)}>Anterior</button>
            {Array.from({ length: d.paginas }, (_, i) => i + 1).map((n) => (
              <button type="button" key={n} onClick={() => this.irA(n)} aria-current={n === this.pagina ? "page" : undefined}
                className={`min-w-[2.25rem] px-2 py-1.5 rounded-lg tabular-nums transition-colors ${n === this.pagina ? "bg-brand-600 text-white font-medium" : "text-ink/60 hover:bg-line/[0.06] hover:text-ink"}`}>
                {n}
              </button>
            ))}
            <button type="button" className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={this.pagina === d.paginas}
              onClick={() => this.irA(this.pagina + 1)}>Siguiente</button>
          </nav>
        )}
      </div>,
    );
  }

  irA(n: number) {
    this.pagina = n;
    this.actualizar();
    this.tabla.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  abrirPanel(col: number, ancla: HTMLButtonElement) {
    if (this.panel) { this.cerrarPanel(); return; }
    const opciones = valoresDisponibles(this.filas.filter((f) => this.cumple(f, col)), (f: Fila) => f.valores[col]);
    const div = document.createElement("div");
    div.setAttribute(MARCA, "");
    document.body.appendChild(div);
    const raiz = createRoot(div);
    this.panel = { raiz, div };
    flushSync(() => raiz.render(
      <PanelFiltro titulo={this.columnas[col] || "columna"} ancla={ancla} opciones={opciones} elegidos={this.filtros.get(col) ?? null}
        onAplicar={(s) => {
          if (s) this.filtros.set(col, s); else this.filtros.delete(col);
          this.pagina = 1;
          this.cerrarPanel();
          this.actualizar();
        }}
        onCerrar={() => this.cerrarPanel()} />,
    ));
  }

  cerrarPanel() {
    const p = this.panel;
    if (!p) return;
    this.panel = null;
    // Se desmonta después del evento actual (React no permite desmontar durante su propio render)
    setTimeout(() => { p.raiz.unmount(); p.div.remove(); }, 0);
  }

  quitarPie() {
    const r = this.raizPie, d = this.pie;
    this.raizPie = null; this.pie = null;
    if (r) setTimeout(() => r.unmount(), 0);
    d?.remove();
  }

  destruir() {
    this.cerrarPanel();
    this.quitarPie();
    this.botones.forEach((b) => b.remove());
    this.botonCols?.remove();
    this.filas.forEach((f) => [f.tr, ...f.anexas].forEach((tr) => tr.removeAttribute("data-mt-oculta")));
    this.tabla.querySelectorAll("[data-mt-col-oculta]").forEach((el) => el.removeAttribute("data-mt-col-oculta"));
  }
}

export default function TablasMejoradas() {
  const ruta = usePathname();

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const tablas = new Map<HTMLTableElement, TablaMejorada>();
    let pendiente = 0;

    const escanear = () => {
      pendiente = 0;
      // Tablas que desaparecieron (cambio de pestaña, etc.)
      tablas.forEach((m, t) => { if (!t.isConnected) { m.destruir(); tablas.delete(t); } });
      main.querySelectorAll<HTMLTableElement>("table.data").forEach((t) => {
        if (t.hasAttribute("data-sin-filtros")) return;
        let m = tablas.get(t);
        if (!m) { m = new TablaMejorada(t, ruta); tablas.set(t, m); }
        m.actualizar();
      });
    };
    const programar = () => { if (!pendiente) pendiente = requestAnimationFrame(escanear); };

    // Se reacomoda cuando la pantalla cambia filas o textos (ignorando lo que agrega este componente)
    const obs = new MutationObserver((cambios) => {
      const propios = (n: Node | null) => !!(n && (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(`[${MARCA}]`));
      const relevante = cambios.some((c) => {
        if (propios(c.target)) return false;
        if (c.type === "childList") {
          const nodos = [...Array.from(c.addedNodes), ...Array.from(c.removedNodes)];
          return nodos.length === 0 || nodos.some((n) => !(n.nodeType === 1 && (n as Element).hasAttribute(MARCA)));
        }
        return true;
      });
      if (relevante) programar();
    });
    obs.observe(main, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["value", "checked"] });
    // Cambios en <select> e inputs (no generan mutaciones)
    const alCambiar = () => programar();
    main.addEventListener("change", alCambiar);
    escanear();

    return () => {
      obs.disconnect();
      main.removeEventListener("change", alCambiar);
      if (pendiente) cancelAnimationFrame(pendiente);
      tablas.forEach((m) => m.destruir());
    };
  }, [ruta]);

  return null;
}
