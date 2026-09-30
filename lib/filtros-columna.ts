// Lógica de los filtros por columna tipo Excel (sin React, para poder probarla sola).

// Qué valor (o valores) muestra una fila en una columna. Un arreglo sirve para columnas
// con varios valores por fila (por ejemplo, las unidades de disco).
export type Extractor<T> = (fila: T) => string | number | boolean | null | undefined | (string | number | null | undefined)[];

// Valores elegidos por columna. Una columna sin entrada no filtra.
export type Filtros = Record<string, Set<string>>;

export const VACIO = "(Vacío)";

export function valoresDe<T>(fila: T, extraer: Extractor<T>): string[] {
  const v = extraer(fila);
  const lista = Array.isArray(v) ? v : [v];
  const limpios = lista.map((x) => (x === null || x === undefined || String(x).trim() === "" ? VACIO : String(x).trim()));
  return limpios.length ? Array.from(new Set(limpios)) : [VACIO];
}

// Filas que cumplen todos los filtros. Con `excepto` se ignora el filtro de esa columna:
// así la lista de una columna muestra los valores que quedan según las OTRAS columnas, como en Excel.
export function aplicarFiltros<T>(filas: T[], columnas: Record<string, Extractor<T>>, filtros: Filtros, excepto?: string): T[] {
  const activos = Object.entries(filtros).filter(([c, s]) => c !== excepto && columnas[c] && s);
  if (!activos.length) return filas;
  return filas.filter((f) => activos.every(([c, elegidos]) => valoresDe(f, columnas[c]).some((v) => elegidos.has(v))));
}

// Valores distintos de una columna con su cantidad, ordenados (los números se ordenan como números; "(Vacío)" al final)
export function valoresDisponibles<T>(filas: T[], extraer: Extractor<T>): { valor: string; n: number }[] {
  const m = new Map<string, number>();
  filas.forEach((f) => valoresDe(f, extraer).forEach((v) => m.set(v, (m.get(v) ?? 0) + 1)));
  return Array.from(m.entries())
    .map(([valor, n]) => ({ valor, n }))
    .sort((a, b) => (a.valor === VACIO ? 1 : b.valor === VACIO ? -1 : a.valor.localeCompare(b.valor, "es", { numeric: true, sensitivity: "base" })));
}
