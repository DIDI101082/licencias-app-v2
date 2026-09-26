"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Eq = { id: string; codigo: string; categoria?: string | null; marca?: string | null; modelo?: string | null; numero_serie?: string | null; devuelto?: boolean };

// Genera un acta de entrega o devolución (numerada) con los equipos elegidos y la abre para imprimir
export default function NuevaActa({ empleadoId, tipo, onCerrar }: { empleadoId: string; tipo: "entrega" | "devolucion"; onCerrar: () => void }) {
  const router = useRouter();
  const [equipos, setEquipos] = useState<Eq[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [obs, setObs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    const sb = createClient();
    (async () => {
      const { data: actuales } = await sb.from("inv_v_equipos")
        .select("id, codigo, categoria, marca, modelo, numero_serie").eq("empleado_id", empleadoId).order("codigo");
      let lista: Eq[] = (actuales ?? []) as Eq[];
      // En la devolución también aparecen los equipos devueltos en los últimos 30 días
      if (tipo === "devolucion") {
        const { data: dev } = await sb.from("inv_asignaciones")
          .select("fecha_devolucion, inv_equipos(id, codigo, marca, modelo, numero_serie, inv_categorias(nombre))")
          .eq("empleado_id", empleadoId).gte("fecha_devolucion", new Date(Date.now() - 30 * 86400000).toISOString());
        for (const d of (dev ?? []) as any[]) {
          const e = d.inv_equipos;
          if (e && !lista.some((x) => x.id === e.id)) {
            lista.push({ id: e.id, codigo: e.codigo, categoria: e.inv_categorias?.nombre, marca: e.marca, modelo: e.modelo, numero_serie: e.numero_serie, devuelto: true });
          }
        }
      }
      setEquipos(lista);
      setSel(new Set(lista.map((e) => e.id)));
      setCargando(false);
    })();
  }, [empleadoId, tipo]);

  async function generar() {
    setOcupado(true); setError(null);
    const { data, error } = await createClient().rpc("empleados_acta_crear", {
      p_empleado: empleadoId, p_tipo: tipo, p_equipos: Array.from(sel), p_observaciones: obs,
    });
    setOcupado(false);
    if (error) return setError(error.message);
    router.push(`/empleados/actas/${data}`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center p-4 overflow-y-auto" onClick={onCerrar}>
      <div className="card p-5 w-full max-w-lg mt-16 space-y-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className="font-display text-lg text-ink">Acta de {tipo === "entrega" ? "entrega" : "devolución"} de equipos</h2>
        {cargando ? <p className="text-sm text-ink/50">Cargando equipos…</p> : equipos.length === 0 ? (
          <p className="text-sm text-ink/60">
            La persona no tiene equipos asignados{tipo === "devolucion" ? " ni devueltos en los últimos 30 días" : ""}.
            Asignalos primero en Inventario IT.
          </p>
        ) : (
          <ul className="divide-y divide-black/[0.05] max-h-72 overflow-y-auto">
            {equipos.map((e) => (
              <li key={e.id}>
                <label className="flex items-start gap-3 py-2 text-sm cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={sel.has(e.id)}
                    onChange={() => setSel((s) => { const n = new Set(s); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n; })} />
                  <span>
                    <b className="font-medium text-ink">{e.codigo}</b> · {e.categoria} {[e.marca, e.modelo].filter(Boolean).join(" ")}
                    <span className="block text-xs text-ink/50">{e.numero_serie ? `S/N ${e.numero_serie}` : "Sin número de serie"}{e.devuelto ? " · ya devuelto en Inventario" : ""}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <label className="block">
          <span className="label">Observaciones (estado, accesorios, faltantes)</span>
          <textarea className="input" rows={3} value={obs} onChange={(e) => setObs(e.target.value)}
            placeholder={tipo === "entrega" ? "Ej.: con cargador y funda" : "Ej.: devuelve sin cargador; pantalla con rayón"} />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCerrar}>Cancelar</button>
          <button className="btn-primary" disabled={ocupado || sel.size === 0} onClick={generar}>Generar acta</button>
        </div>
      </div>
    </div>
  );
}
