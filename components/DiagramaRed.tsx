"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { COLOR, INTERNET, NODO, calcularConexiones, descendientes, diagramar, peorEstado, type EquipoRed } from "@/lib/topologia";

// Líneas neutras: se adaptan al modo claro u oscuro
const LINEA = "rgb(var(--c-line) / 0.22)";

type Sensor = { objid: number; nombre: string; dispositivo: number; estado: string; mensaje: string; valor: string; desde: string };
type Equipo = EquipoRed & { ok: number; advertencia: number; caido: number; inusual: number; pausado: number; ubicacion: string; sub?: string };

const TEXTO: Record<string, string> = {
  ok: "OK", advertencia: "Advertencia", caido: "Caído", caido_reconocido: "Caído (reconocido)", inusual: "Inusual", pausado: "Pausado", desconocido: "Sin datos",
};
const corto = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

export default function DiagramaRed({ equipos, sensores, guardadas, base, texto, alGuardar }: {
  equipos: Equipo[]; sensores: Sensor[]; guardadas: Record<number, number>; base: string; texto: string; alGuardar: () => void;
}) {
  const { esAdmin } = usePerfil();
  const [sel, setSel] = useState<number | null>(null);
  const [escala, setEscala] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const porId = useMemo(() => new Map(equipos.map((e) => [e.objid, e])), [equipos]);
  const { padre, manual } = useMemo(() => calcularConexiones(equipos, guardadas), [equipos, guardadas]);
  const dibujo = useMemo(() => diagramar(padre, (a, b) => {
    const x = porId.get(a), y = porId.get(b);
    return (x?.zona ?? "").localeCompare(y?.zona ?? "") || (x?.nombre ?? "").localeCompare(y?.nombre ?? "");
  }), [padre, porId]);

  const q = texto.trim().toLowerCase();
  const coincide = (e?: Equipo) => !q || !!e && [e.nombre, e.host, e.zona].some((v) => v?.toLowerCase().includes(q));
  const pos = new Map(dibujo.nodos.map((n) => [n.id, n]));
  const colorLinea = (estado: string) => (estado === "caido" || estado === "caido_reconocido" ? COLOR.caido : estado === "advertencia" ? COLOR.advertencia : LINEA);

  async function conectar(objid: number, destino: number | null) {
    setError(null);
    const sb = createClient();
    const { error } = destino === null
      ? await sb.from("red_conexiones").delete().eq("objid", objid)
      : await sb.from("red_conexiones").upsert({ objid, conecta_a: destino, actualizado: new Date().toISOString() });
    if (error) return setError(error.message.includes("red_conexiones") ? "Falta ejecutar red-topologia.sql en Supabase." : error.message);
    alGuardar();
  }

  const elegido = sel !== null ? porId.get(sel) : undefined;
  const prohibidos = sel !== null ? descendientes(padre, sel) : new Set<number>();

  return (
    <div className="space-y-4">
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-line/[0.06] text-xs text-ink/60 flex-wrap">
          <span className="flex items-center gap-3 flex-wrap">
            {(["ok", "advertencia", "inusual", "caido", "pausado"] as const).map((k) => (
              <span key={k} className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full inline-block" style={{ background: COLOR[k] }} aria-hidden />{TEXTO[k]}</span>
            ))}
            <span className="text-ink/40">· Tocá un equipo para ver el detalle{esAdmin ? " y ajustar su conexión" : ""}</span>
          </span>
          <span className="flex items-center gap-1">
            <button className="btn-secondary px-2 py-1" onClick={() => setEscala((e) => Math.max(0.5, +(e - 0.1).toFixed(1)))} aria-label="Alejar">−</button>
            <span className="w-10 text-center tabular-nums">{Math.round(escala * 100)}%</span>
            <button className="btn-secondary px-2 py-1" onClick={() => setEscala((e) => Math.min(1.5, +(e + 0.1).toFixed(1)))} aria-label="Acercar">+</button>
          </span>
        </div>
        <div className="overflow-auto bg-canvas" style={{ maxHeight: "70vh" }}>
          <svg width={(dibujo.ancho + 40) * escala} height={(dibujo.alto + 40) * escala} viewBox={`-20 -20 ${dibujo.ancho + 40} ${dibujo.alto + 40}`}
            role="img" aria-label="Diagrama de la red con el estado de cada equipo" className="block mx-auto">
            {/* Recuadros de equipos agrupados */}
            {dibujo.cajas.map((c) => {
              const peor = peorEstado(c.ids.map((i) => porId.get(i)?.estado ?? "desconocido"));
              return (
                <g key={`caja-${c.padre}`}>
                  <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={14} fill="rgb(var(--c-surface))" stroke={peor === "ok" ? "rgb(var(--c-line) / 0.16)" : COLOR[peor]} strokeDasharray="5 4" />
                  <text x={c.x + 12} y={c.y + 18} fontSize={11} fill="rgb(var(--c-ink) / 0.6)">{c.ids.length} equipos</text>
                </g>
              );
            })}
            {/* Líneas: en rojo o amarillo si el equipo al que llegan tiene problemas */}
            {dibujo.lineas.map((l, i) => {
              const estado = l.hasta === "caja" ? peorEstado(l.caja!.ids.map((x) => porId.get(x)?.estado ?? "desconocido")) : porId.get(l.hasta)?.estado ?? "ok";
              const m = (l.y1 + l.y2) / 2;
              const color = colorLinea(estado);
              return (
                <path key={i} d={`M ${l.x1} ${l.y1} C ${l.x1} ${m}, ${l.x2} ${m}, ${l.x2} ${l.y2}`} fill="none"
                  stroke={color} strokeWidth={color === LINEA ? 1.5 : 2.5} strokeDasharray={estado === "caido" ? "6 4" : undefined} />
              );
            })}
            {/* Nodos */}
            {dibujo.nodos.map((n) => {
              if (n.id === INTERNET) {
                return (
                  <g key="internet" transform={`translate(${n.x},${n.y})`}>
                    <rect width={NODO.w} height={NODO.h} rx={NODO.h / 2} fill="rgb(var(--c-surface))" stroke="rgb(var(--c-line) / 0.2)" />
                    <text x={NODO.w / 2} y={NODO.h / 2 + 5} textAnchor="middle" fontSize={15} fontWeight={700} fill="rgb(var(--c-brand))">Internet</text>
                  </g>
                );
              }
              const e = porId.get(n.id);
              if (!e) return null;
              const activo = sel === n.id;
              const cont = [e.caido ? `✗${e.caido}` : "", e.advertencia ? `W${e.advertencia}` : "", e.inusual ? `U${e.inusual}` : "", e.ok ? `✓${e.ok}` : ""].filter(Boolean).join(" ");
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={coincide(e) ? 1 : 0.25}
                  role="button" tabIndex={0} aria-label={`${e.nombre}: ${TEXTO[e.estado] ?? e.estado}`} style={{ cursor: "pointer" }}
                  onClick={() => setSel(activo ? null : n.id)} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSel(activo ? null : n.id); } }}>
                  <rect width={NODO.w} height={NODO.h} rx={10} fill="rgb(var(--c-surface))" stroke={activo ? "rgb(var(--c-brand))" : "rgb(var(--c-line) / 0.16)"} strokeWidth={activo ? 2 : 1} />
                  <rect width={6} height={NODO.h} rx={3} fill={COLOR[e.estado] ?? COLOR.desconocido} />
                  <text x={16} y={23} fontSize={13} fontWeight={600} fill="rgb(var(--c-ink))">{corto(e.nombre, 21)}</text>
                  <text x={16} y={42} fontSize={10.5} fill="rgb(var(--c-ink) / 0.6)" fontFamily="ui-monospace, monospace">{corto(e.host || e.zona || "", 14)}</text>
                  <text x={NODO.w - 10} y={42} fontSize={10.5} textAnchor="end" fill={e.caido ? COLOR.caido : e.advertencia ? "rgb(var(--c-aviso))" : "rgb(var(--c-ok))"}>{cont}</text>
                  {manual.has(n.id) && <circle cx={NODO.w - 9} cy={10} r={3} fill="#F2C230"><title>Conexión ajustada a mano</title></circle>}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {elegido && (
        <div className="card p-5 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-display font-bold text-ink text-lg">{elegido.nombre}</h2>
              <p className="text-sm text-ink/60">
                <span className="font-mono">{elegido.host}</span>{elegido.zona ? ` · ${elegido.zona}` : ""}{elegido.sub ? ` › ${elegido.sub}` : ""}
                {elegido.ubicacion ? ` · ${elegido.ubicacion}` : ""}
              </p>
            </div>
            <span className="pill text-white" style={{ background: COLOR[elegido.estado] ?? COLOR.desconocido }}>{TEXTO[elegido.estado] ?? elegido.estado}</span>
          </div>
          <div className="text-sm space-y-1.5">
            {sensores.filter((s) => s.dispositivo === elegido.objid).map((s) => (
              <div key={s.objid}>
                <span className="pill mr-1.5 text-white" style={{ background: COLOR[s.estado] ?? COLOR.desconocido }}>{TEXTO[s.estado] ?? s.estado}</span>
                <b className="text-ink">{s.nombre}</b>{s.valor && s.valor !== "-" ? <span className="text-ink/60"> · {s.valor}</span> : null}
                {s.mensaje && <div className="text-xs text-ink/60">{s.mensaje}{s.desde ? ` · hace ${s.desde}` : ""}</div>}
              </div>
            ))}
            {!sensores.some((s) => s.dispositivo === elegido.objid) && <p className="text-ink/50">Ningún sensor con problemas ({elegido.ok} OK{elegido.pausado ? `, ${elegido.pausado} pausados` : ""}).</p>}
          </div>
          <div className="flex items-center gap-3 flex-wrap pt-1">
            {base && <a href={`${base}/device.htm?id=${elegido.objid}`} target="_blank" rel="noopener noreferrer" className="btn-secondary">Abrir en PRTG</a>}
            {esAdmin && (
              <label className="flex items-center gap-2 text-sm text-ink/70">
                Se conecta a
                <select className="input w-auto" value={padre.get(elegido.objid) ?? INTERNET}
                  onChange={(ev) => conectar(elegido.objid, Number(ev.target.value))}>
                  <option value={INTERNET}>Internet</option>
                  {equipos.filter((x) => x.objid !== elegido.objid && !prohibidos.has(x.objid))
                    .sort((a, b) => a.nombre.localeCompare(b.nombre))
                    .map((x) => <option key={x.objid} value={x.objid}>{x.nombre}{x.zona ? ` (${x.zona})` : ""}</option>)}
                </select>
                {manual.has(elegido.objid) && (
                  <button className="text-brand-600 hover:underline" onClick={() => conectar(elegido.objid, null)}>Volver a automático</button>
                )}
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
