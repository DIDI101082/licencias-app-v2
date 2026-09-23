"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { claseCodigo } from "@/lib/inventario";

// Qué equipos tiene cada empleado (útil para entregas y bajas de personal)
export default function PorPersona() {
  const [empleados, setEmpleados] = useState<any[]>([]);
  const [equipos, setEquipos] = useState<any[]>([]);
  const [texto, setTexto] = useState("");
  const [soloConEquipos, setSoloConEquipos] = useState(true);

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("empleados").select("id,nombre,apellido,email,area,activo").order("apellido"),
      sb.from("inv_v_equipos").select("id,codigo,categoria,marca,modelo,empleado_id").eq("estado", "asignado"),
    ]).then(([a, b]) => { setEmpleados(a.data ?? []); setEquipos(b.data ?? []); });
  }, []);

  const q = texto.toLowerCase();
  const filas = empleados
    .map((p) => ({ ...p, suyos: equipos.filter((e) => e.empleado_id === p.id) }))
    .filter((p) => (!soloConEquipos || p.suyos.length > 0 || !p.activo) &&
      (!q || [p.nombre, p.apellido, p.email, p.area].some((v) => v?.toLowerCase().includes(q))))
    // primero los inactivos con equipos: son los que hay que recuperar
    .sort((a, b) => Number(a.activo) - Number(b.activo));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl text-ink">Equipos por persona</h1>
        <p className="text-ink/60 text-sm mt-1">
          Los empleados se cargan en la solapa Licencias → Empleados y se comparten entre los dos módulos.
        </p>
      </div>
      <div className="flex gap-3 items-center flex-wrap">
        <input type="search" className="input flex-1 min-w-[240px]" placeholder="Buscar por nombre, email o área"
          value={texto} onChange={(e) => setTexto(e.target.value)} />
        <label className="text-sm text-ink/70 flex items-center gap-2">
          <input type="checkbox" checked={soloConEquipos} onChange={(e) => setSoloConEquipos(e.target.checked)} />
          Solo personas con equipos
        </label>
      </div>
      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Persona</th><th>Área</th><th>Equipos asignados</th></tr></thead>
          <tbody>
            {filas.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="font-medium text-ink">{p.apellido}, {p.nombre}</span>
                  <div className="text-xs text-ink/50">{p.email}</div>
                  {!p.activo && p.suyos.length > 0 && (
                    <span className="pill bg-red-50 text-red-600 mt-1">Inactivo con equipos a recuperar</span>
                  )}
                </td>
                <td className="text-ink/60">{p.area}</td>
                <td>
                  {p.suyos.length === 0 ? <span className="text-ink/40">—</span> : (
                    <ul className="space-y-1">
                      {p.suyos.map((e: any) => (
                        <li key={e.id} className="flex items-center gap-2">
                          <Link href={`/inventario/equipos/${e.id}`} className={claseCodigo(e.codigo)}>{e.codigo}</Link>
                          <span className="text-ink/70">{e.categoria} {e.marca} {e.modelo}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
            {filas.length === 0 && (
              <tr><td colSpan={3} className="text-center text-ink/40 py-8">No hay personas con equipos asignados.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
