// Diagrama de red a partir de los equipos de PRTG.
// Conexiones: las que cargó un admin, o una automática (Internet → firewall principal → resto).

export type EquipoRed = { objid: number; nombre: string; host: string; padre: number; estado: string; total: number; zona?: string };
export const INTERNET = -1;

export const COLOR: Record<string, string> = {
  ok: "#10B981", advertencia: "#F59E0B", caido: "#EF4444", caido_reconocido: "#FCA5A5",
  inusual: "#F97316", pausado: "#7DD3FC", desconocido: "#9CA3AF",
};
const GRAVEDAD: Record<string, number> = { caido: 0, caido_reconocido: 1, advertencia: 2, inusual: 3, desconocido: 4, ok: 5, pausado: 6 };
export const peorEstado = (estados: string[]) =>
  estados.reduce((m, e) => ((GRAVEDAD[e] ?? 4) < (GRAVEDAD[m] ?? 4) ? e : m), "ok");

const esFirewall = (e: EquipoRed) => /forti|firewall|\bfw\b|pfsense|palo ?alto|sophos|checkpoint|mikrotik/i.test(e.nombre);

// Zona (sede o grupo de primer nivel) de cada equipo según el árbol de PRTG
export function crearUbicador(grupos: { objid: number; nombre: string; padre: number }[], sondas: { objid: number; nombre: string }[]) {
  const g = new Map(grupos.map((x) => [x.objid, x]));
  const s = new Map(sondas.map((x) => [x.objid, x.nombre]));
  return (padre: number) => {
    const cadena: string[] = [];
    let id = padre;
    for (let i = 0; i < 20 && id !== 0 && g.has(id) && !s.has(id); i++) {
      const x = g.get(id)!;
      cadena.unshift(x.nombre);
      id = x.padre;
    }
    if (!cadena.length) return { zona: s.get(padre) ?? "Sin grupo", sub: "" };
    return { zona: cadena[0], sub: cadena.slice(1).join(" › ") };
  };
}

// A qué se conecta cada equipo: lo guardado si es válido; si no, la regla automática
export function calcularConexiones(equipos: EquipoRed[], guardadas: Record<number, number>) {
  const ids = new Set(equipos.map((e) => e.objid));
  const firewalls = equipos.filter(esFirewall).sort((a, b) => b.total - a.total);
  const principal = firewalls[0];
  const automatica = (e: EquipoRed): number => {
    if (!principal || e.objid === principal.objid) return INTERNET;
    if (esFirewall(e)) return principal.objid;
    const local = firewalls.find((f) => f.objid !== e.objid && f.zona && f.zona === e.zona);
    return local ? local.objid : principal.objid;
  };
  const padre = new Map<number, number>();
  const manual = new Set<number>();
  for (const e of equipos) {
    const g = guardadas[e.objid];
    if (g !== undefined && g !== e.objid && (g === INTERNET || ids.has(g))) { padre.set(e.objid, g); manual.add(e.objid); }
    else padre.set(e.objid, automatica(e));
  }
  // Si una conexión guardada arma un ciclo, ese equipo vuelve a la regla automática
  for (const e of equipos) {
    const vistos = new Set<number>([e.objid]);
    let p = padre.get(e.objid)!;
    while (p !== INTERNET && padre.has(p)) {
      if (vistos.has(p)) { padre.set(e.objid, automatica(e)); manual.delete(e.objid); break; }
      vistos.add(p);
      p = padre.get(p)!;
    }
  }
  return { padre, manual, principal: principal?.objid };
}

// Descendientes de un equipo (para no ofrecerlos como "se conecta a" y evitar ciclos)
export function descendientes(padre: Map<number, number>, id: number) {
  const hijos = new Map<number, number[]>();
  padre.forEach((p, h) => hijos.set(p, [...(hijos.get(p) ?? []), h]));
  const out = new Set<number>();
  const pila = [...(hijos.get(id) ?? [])];
  while (pila.length) { const x = pila.pop()!; if (!out.has(x)) { out.add(x); pila.push(...(hijos.get(x) ?? [])); } }
  return out;
}

// ---------------- Diagramado (árbol de arriba hacia abajo) ----------------
export const NODO = { w: 176, h: 58, gx: 16, gy: 70, gyGrilla: 14 };
const UMBRAL_CAJA = 8; // con más de 8 equipos "hoja" colgando del mismo punto, se agrupan en un recuadro con grilla
const COLUMNAS = 6;

export type NodoDibujo = { id: number; x: number; y: number };
export type Caja = { x: number; y: number; w: number; h: number; ids: number[]; padre: number };
export type Linea = { desde: number; hasta: number | "caja"; caja?: Caja; x1: number; y1: number; x2: number; y2: number; estados: string[] };

export function diagramar(padre: Map<number, number>, orden: (a: number, b: number) => number) {
  const hijos = new Map<number, number[]>();
  padre.forEach((p, h) => hijos.set(p, [...(hijos.get(p) ?? []), h]));
  hijos.forEach((l) => l.sort(orden));
  const tieneHijos = (id: number) => (hijos.get(id) ?? []).length > 0;

  const anchoGrilla = (n: number) => { const c = Math.min(n, COLUMNAS); return c * NODO.w + (c - 1) * NODO.gx + 24; };
  const altoGrilla = (n: number) => { const f = Math.ceil(n / COLUMNAS); return f * NODO.h + (f - 1) * NODO.gyGrilla + 36; };
  const cache = new Map<number, number>();
  const medir = (id: number): number => {
    if (cache.has(id)) return cache.get(id)!;
    const h = hijos.get(id) ?? [];
    const hojas = h.filter((x) => !tieneHijos(x));
    const subs = h.filter(tieneHijos);
    const enCaja = hojas.length > UMBRAL_CAJA;
    const partes = [
      ...(enCaja ? [anchoGrilla(hojas.length)] : hojas.map(() => NODO.w)),
      ...subs.map(medir),
    ];
    const ancho = Math.max(NODO.w, partes.reduce((s, w) => s + w, 0) + Math.max(0, partes.length - 1) * NODO.gx);
    cache.set(id, ancho);
    return ancho;
  };

  const nodos: NodoDibujo[] = [];
  const cajas: Caja[] = [];
  const lineas: Linea[] = [];
  const ubicar = (id: number, x0: number, y: number) => {
    const ancho = medir(id);
    const x = x0 + ancho / 2 - NODO.w / 2;
    nodos.push({ id, x, y });
    const h = hijos.get(id) ?? [];
    if (!h.length) return;
    const hojas = h.filter((c) => !tieneHijos(c));
    const subs = h.filter(tieneHijos);
    const enCaja = hojas.length > UMBRAL_CAJA;
    const yh = y + NODO.h + NODO.gy;
    const anchoHijos = (enCaja ? anchoGrilla(hojas.length) : hojas.length * NODO.w + Math.max(0, hojas.length - 1) * NODO.gx)
      + subs.reduce((s, c) => s + medir(c), 0) + (hojas.length && subs.length ? NODO.gx : 0) + Math.max(0, subs.length - 1) * NODO.gx;
    let cx = x0 + (ancho - anchoHijos) / 2;
    const origen = { x: x + NODO.w / 2, y: y + NODO.h };
    if (enCaja) {
      const caja: Caja = { x: cx, y: yh, w: anchoGrilla(hojas.length), h: altoGrilla(hojas.length), ids: hojas, padre: id };
      cajas.push(caja);
      hojas.forEach((c, i) => {
        nodos.push({ id: c, x: cx + 12 + (i % COLUMNAS) * (NODO.w + NODO.gx), y: yh + 28 + Math.floor(i / COLUMNAS) * (NODO.h + NODO.gyGrilla) });
      });
      lineas.push({ desde: id, hasta: "caja", caja, x1: origen.x, y1: origen.y, x2: cx + caja.w / 2, y2: yh, estados: [] });
      cx += caja.w + NODO.gx;
    } else {
      for (const c of hojas) {
        nodos.push({ id: c, x: cx, y: yh });
        lineas.push({ desde: id, hasta: c, x1: origen.x, y1: origen.y, x2: cx + NODO.w / 2, y2: yh, estados: [] });
        cx += NODO.w + NODO.gx;
      }
    }
    for (const c of subs) {
      const w = medir(c);
      lineas.push({ desde: id, hasta: c, x1: origen.x, y1: origen.y, x2: cx + w / 2, y2: yh, estados: [] });
      ubicar(c, cx, yh);
      cx += w + NODO.gx;
    }
  };
  ubicar(INTERNET, 0, 0);
  const ancho = medir(INTERNET);
  const alto = Math.max(...nodos.map((n) => n.y + NODO.h), ...cajas.map((c) => c.y + c.h));
  return { nodos, cajas, lineas, ancho, alto };
}
