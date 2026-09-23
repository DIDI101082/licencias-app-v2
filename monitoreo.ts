// Un equipo se considera conectado si reportó en los últimos 12 minutos
// (el agente reporta cada 5; así tolera un par de reportes perdidos).
export const MINUTOS_CONECTADO = 12;

export type Disco = { unidad: string; total_gb: number; libre_gb: number };

export function conectado(ultimo: string, ahora = Date.now()) {
  return ahora - new Date(ultimo).getTime() < MINUTOS_CONECTADO * 60000;
}

export function hace(ultimo: string, ahora = Date.now()) {
  const min = Math.floor((ahora - new Date(ultimo).getTime()) / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
}

export function usoDisco(d: Disco) {
  return d.total_gb ? Math.round(((d.total_gb - d.libre_gb) / d.total_gb) * 100) : 0;
}

export function discoCritico(discos: Disco[] | null) {
  return (discos ?? []).some((d) => usoDisco(d) >= 90);
}

export function encendidoDesde(arranque: string | null) {
  if (!arranque) return "—";
  const h = Math.floor((Date.now() - new Date(arranque).getTime()) / 3600000);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} días`;
}
