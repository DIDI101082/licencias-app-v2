"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { LABELS_MOV_CEL, type MovimientoCel } from "@/lib/celulares";
import { fecha } from "@/lib/inventario";

export default function MovimientosCelulares() {
  const [movs, setMovs] = useState<MovimientoCel[]>([]);
  const [cargando, setCargando] = useState(true);
  const [tipo, setTipo] = useState("");
  const [texto, setTexto] = useState("");

  useEffect(() => {
    createClient()
      .from("cel_v_movimientos")
      .select("*")
      .order("fecha", { ascending: false })
      .limit(500)
      .then(({ data }) => { setMovs((data ?? []) as MovimientoCel[]); setCargando(false); });
  }, []);

  const lista = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return movs.filter((m) =>
      (!tipo || m.tipo_movimiento === tipo) &&
      (!q || [m.codigo, m.empleado_origen, m.empleado_destino, m.notas]
        .some((v) => v && String(v).toLowerCase().includes(q)))
    );
  }, [movs, tipo, texto]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Movimientos de celulares</h1>
          <p className="text-ink/60 text-sm mt-1">
            {cargando ? "Cargando…" : `${lista.length} movimientos`}
          </p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          type="search"
          className="input flex-1 min-w-[200px]"
          placeholder="Buscar por código, persona, notas…"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
        <select className="input w-auto" value={tipo} onChange={(e) => setTipo(e.target.value)}>
          <option value="">Todos los tipos</option>
          {Object.entries(LABELS_MOV_CEL).map(([k, v]) => (
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
              <th>Persona anterior</th>
              <th>Persona nueva</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((m) => (
              <tr key={m.id}>
                <td className="text-ink/60 whitespace-nowrap text-sm">{fecha(m.fecha)}</td>
                <td>
                  <Link href={`/celulares/${m.celular_id}`} className="tag-inv font-mono text-xs">
                    {m.codigo}
                  </Link>
                </td>
                <td>
                  <span className="tag-inv">{LABELS_MOV_CEL[m.tipo_movimiento] ?? m.tipo_movimiento}</span>
                </td>
                <td className="text-sm">{m.empleado_origen ?? <span className="text-ink/40">—</span>}</td>
                <td className="text-sm">{m.empleado_destino ?? <span className="text-ink/40">—</span>}</td>
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
