"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { LABELS_MOVIMIENTO, type MovimientoMob } from "@/lib/mobiliario";
import { fecha } from "@/lib/inventario";

export default function MovimientosMobiliario() {
  const [movs, setMovs] = useState<MovimientoMob[]>([]);
  const [cargando, setCargando] = useState(true);
  const [tipo, setTipo] = useState("");
  const [texto, setTexto] = useState("");

  useEffect(() => {
    createClient()
      .from("mob_v_movimientos")
      .select("*")
      .order("fecha", { ascending: false })
      .limit(500)
      .then(({ data }) => { setMovs((data ?? []) as MovimientoMob[]); setCargando(false); });
  }, []);

  const lista = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return movs.filter((m) =>
      (!tipo || m.tipo_movimiento === tipo) &&
      (!q || [m.codigo, m.empleado_origen, m.empleado_destino, m.piso_origen,
               m.piso_destino, m.sector_origen, m.sector_destino, m.notas]
        .some((v) => v && String(v).toLowerCase().includes(q)))
    );
  }, [movs, tipo, texto]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Movimientos de mobiliario</h1>
          <p className="text-ink/60 text-sm mt-1">
            {cargando ? "Cargando…" : `${lista.length} movimientos`}
          </p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          type="search"
          className="input flex-1 min-w-[200px]"
          placeholder="Buscar por código, persona, piso, sector…"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
        <select className="input w-auto" value={tipo} onChange={(e) => setTipo(e.target.value)}>
          <option value="">Todos los tipos</option>
          {Object.entries(LABELS_MOVIMIENTO).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Código</th>
              <th>Tipo</th>
              <th>Origen</th>
              <th>Destino</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((m) => (
              <tr key={m.id}>
                <td className="text-ink/60 whitespace-nowrap text-sm">{fecha(m.fecha)}</td>
                <td>
                  <Link href={`/mobiliario/${m.mobiliario_id}`} className="tag-inv font-mono text-xs">
                    {m.codigo}
                  </Link>
                </td>
                <td>
                  <span className="tag-inv">{LABELS_MOVIMIENTO[m.tipo_movimiento] ?? m.tipo_movimiento}</span>
                </td>
                <td>
                  {m.piso_origen && <div className="text-sm">{m.piso_origen}{m.sector_origen ? ` – ${m.sector_origen}` : ""}</div>}
                  {m.empleado_origen && <div className="text-xs text-ink/50">{m.empleado_origen}</div>}
                  {!m.piso_origen && !m.empleado_origen && <span className="text-ink/40">—</span>}
                </td>
                <td>
                  {m.piso_destino && <div className="text-sm">{m.piso_destino}{m.sector_destino ? ` – ${m.sector_destino}` : ""}</div>}
                  {m.empleado_destino && <div className="text-xs text-ink/50">{m.empleado_destino}</div>}
                  {!m.piso_destino && !m.empleado_destino && <span className="text-ink/40">—</span>}
                </td>
                <td className="text-ink/60 text-sm max-w-xs">{m.notas ?? "—"}</td>
              </tr>
            ))}
            {!cargando && lista.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-ink/40 py-8">
                  {movs.length === 0 ? "Sin movimientos registrados." : "Ningún movimiento coincide con los filtros."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
