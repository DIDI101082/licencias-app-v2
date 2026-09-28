"use client";

import { useRef, useState } from "react";

export type PuntoTrafico = { fecha: string; rx_bps: number | null; tx_bps: number | null; rx_max: number | null; tx_max: number | null };

// Mbps legibles: "24,5 Mbps", "850 kbps", "1,2 Gbps"
export function velocidadBps(v: number | null | undefined) {
  if (v == null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace(".", ",")} Gbps`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1).replace(".", ",")} Mbps`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} kbps`;
  return `${Math.round(v)} bps`;
}

// Colores de serie: bajada = azul, subida = naranja (paleta validada para daltonismo en claro y oscuro)
const W = 640, H = 170, M = { l: 52, r: 8, t: 10, b: 22 };

function escalaMax(v: number) {
  if (v <= 0) return 1e6;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export default function GraficoTrafico({ puntos, horas, contratadoBajada, etiqueta }: {
  puntos: PuntoTrafico[]; horas: number; contratadoBajada: number | null; etiqueta: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const fin = Date.now();
  const inicio = fin - horas * 3600000;
  const x = (f: string) => M.l + ((Date.parse(f) - inicio) / (fin - inicio)) * (W - M.l - M.r);
  const tope = escalaMax(Math.max(1, ...puntos.map((p) => Math.max(p.rx_bps ?? 0, p.tx_bps ?? 0)), (contratadoBajada ?? 0) * 1e6));
  const y = (v: number) => M.t + (1 - v / tope) * (H - M.t - M.b);

  // Línea cortada donde faltan datos (más de 2,5 tramos sin reporte)
  const tramo = horas > 48 ? 3600000 : 600000;
  const linea = (k: "rx_bps" | "tx_bps") => {
    let d = "", prev = 0;
    for (const p of puntos) {
      const v = p[k];
      if (v == null) { prev = 0; continue; }
      const t = Date.parse(p.fecha);
      d += `${prev && t - prev <= tramo * 2.5 ? "L" : "M"}${x(p.fecha).toFixed(1)},${y(v).toFixed(1)}`;
      prev = t;
    }
    return d;
  };

  const marcas = [0, 0.5, 1].map((f) => tope * f);
  const horasEje = horas > 48
    ? Array.from({ length: 7 }, (_, i) => { const d = new Date(fin - (6 - i) * 86400000); d.setHours(0, 0, 0, 0); return d.getTime(); }).filter((t) => t > inicio + (fin - inicio) * 0.04 && t < fin - (fin - inicio) * 0.06)
    : Array.from({ length: 5 }, (_, i) => { const d = new Date(fin - (4 - i) * 6 * 3600000); d.setMinutes(0, 0, 0); return d.getTime(); }).filter((t) => t > inicio + (fin - inicio) * 0.04 && t < fin - (fin - inicio) * 0.06);

  function mover(ev: React.MouseEvent<SVGSVGElement>) {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !puntos.length) return;
    const px = ((ev.clientX - r.left) / r.width) * W;
    let mejor = 0, dist = Infinity;
    puntos.forEach((p, i) => { const d = Math.abs(x(p.fecha) - px); if (d < dist) { dist = d; mejor = i; } });
    setHover(dist < 40 ? mejor : null);
  }
  const h = hover != null ? puntos[hover] : null;

  if (!puntos.length) {
    return <div className="h-40 flex items-center justify-center text-sm text-ink/40 rounded-lg bg-line/[0.03]">Todavía no hay mediciones (se calculan a partir del segundo reporte del puente).</div>;
  }

  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img"
        aria-label={`${etiqueta}: consumo de bajada y subida en las últimas ${horas > 48 ? "7 días" : "24 horas"}`}
        onMouseMove={mover} onMouseLeave={() => setHover(null)}>
        {marcas.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="stroke-line/10" strokeWidth={1} />
            <text x={M.l - 6} y={y(v) + 3.5} textAnchor="end" className="fill-ink/45 text-[10px]">{velocidadBps(v).replace(" ", " ")}</text>
          </g>
        ))}
        {horasEje.map((t) => (
          <text key={t} x={M.l + ((t - inicio) / (fin - inicio)) * (W - M.l - M.r)} y={H - 6} textAnchor="middle" className="fill-ink/45 text-[10px]">
            {horas > 48 ? new Date(t).toLocaleDateString("es-AR", { weekday: "short", day: "numeric" }) : new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })}
          </text>
        ))}
        {contratadoBajada != null && contratadoBajada * 1e6 <= tope && (
          <g>
            <line x1={M.l} x2={W - M.r} y1={y(contratadoBajada * 1e6)} y2={y(contratadoBajada * 1e6)} className="stroke-ink/35" strokeWidth={1} strokeDasharray="4 4" />
            <text x={W - M.r} y={y(contratadoBajada * 1e6) - 4} textAnchor="end" className="fill-ink/50 text-[10px]">Contratado</text>
          </g>
        )}
        <path d={linea("tx_bps")} fill="none" className="stroke-[#eb6834] dark:stroke-[#d95926]" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={linea("rx_bps")} fill="none" className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {h && (
          <g>
            <line x1={x(h.fecha)} x2={x(h.fecha)} y1={M.t} y2={H - M.b} className="stroke-ink/30" strokeWidth={1} />
            {h.rx_bps != null && <circle cx={x(h.fecha)} cy={y(h.rx_bps)} r={4} className="fill-[#2a78d6] dark:fill-[#3987e5] stroke-surface" strokeWidth={2} />}
            {h.tx_bps != null && <circle cx={x(h.fecha)} cy={y(h.tx_bps)} r={4} className="fill-[#eb6834] dark:fill-[#d95926] stroke-surface" strokeWidth={2} />}
          </g>
        )}
      </svg>
      {h && (
        <div className="pointer-events-none absolute top-1 rounded-md border border-line/10 bg-surface shadow-sm px-2.5 py-1.5 text-xs text-ink/80 whitespace-nowrap"
          style={{ left: `${(x(h.fecha) / W) * 100}%`, transform: x(h.fecha) > W * 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}>
          <div className="text-ink/50 mb-0.5">{new Date(h.fecha).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", hour12: false })}</div>
          <div><i className="inline-block h-2 w-2 rounded-full bg-[#2a78d6] dark:bg-[#3987e5] mr-1.5" />Bajada {velocidadBps(h.rx_bps)}{horas > 48 && h.rx_max != null ? ` (pico ${velocidadBps(h.rx_max)})` : ""}</div>
          <div><i className="inline-block h-2 w-2 rounded-full bg-[#eb6834] dark:bg-[#d95926] mr-1.5" />Subida {velocidadBps(h.tx_bps)}{horas > 48 && h.tx_max != null ? ` (pico ${velocidadBps(h.tx_max)})` : ""}</div>
        </div>
      )}
      <div className="flex gap-4 text-xs text-ink/60 mt-1">
        <span className="flex items-center gap-1.5"><i className="inline-block h-0.5 w-4 rounded bg-[#2a78d6] dark:bg-[#3987e5]" />Bajada</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-0.5 w-4 rounded bg-[#eb6834] dark:bg-[#d95926]" />Subida</span>
        {contratadoBajada != null && <span className="flex items-center gap-1.5"><i className="inline-block w-4 border-t border-dashed border-ink/40" />Bajada contratada</span>}
      </div>
    </div>
  );
}
