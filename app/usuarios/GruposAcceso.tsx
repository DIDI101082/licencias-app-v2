"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MODULOS, NOMBRE_MODULO, type Modulo } from "@/lib/modulos";

export type Grupo = { id: number; nombre: string; modulos: string[] };

// Configuración de qué solapas ve cada grupo
export default function GruposAcceso({ grupos }: { grupos: Grupo[] }) {
  const router = useRouter();
  const [nuevo, setNuevo] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function cambiar(g: Grupo, m: Modulo, on: boolean) {
    setError(null);
    const modulos = on ? [...g.modulos, m] : g.modulos.filter((x) => x !== m);
    const { error } = await createClient().from("grupos_acceso").update({ modulos }).eq("id", g.id);
    if (error) return setError(error.message);
    router.refresh();
  }

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!nuevo.trim()) return;
    setError(null);
    const { error } = await createClient().from("grupos_acceso").insert({ nombre: nuevo.trim(), modulos: ["empleados"] });
    if (error) return setError(error.code === "23505" ? "Ya existe un grupo con ese nombre." : error.message);
    setNuevo("");
    router.refresh();
  }

  async function borrar(g: Grupo) {
    if (!confirm(`¿Borrar el grupo ${g.nombre}? Los usuarios que lo tengan pasan a "sin grupo" y ven todas las solapas.`)) return;
    const { error } = await createClient().from("grupos_acceso").delete().eq("id", g.id);
    if (error) return setError(error.message);
    router.refresh();
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-medium text-ink">Grupos de acceso</h2>
        <p className="text-sm text-ink/60 mt-1">
          Marcá qué solapas ve cada grupo. El cambio aplica la próxima vez que la persona entre o refresque la página, y también se
          controla en la base de datos: sin la solapa, no puede consultar esos datos de ninguna forma.
        </p>
      </div>
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      <div className="overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Grupo</th>
              {MODULOS.map((m) => <th key={m} className="text-center">{NOMBRE_MODULO[m]}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {grupos.map((g) => (
              <tr key={g.id}>
                <td className="font-medium text-ink">{g.nombre}</td>
                {MODULOS.map((m) => (
                  <td key={m} className="text-center">
                    <input type="checkbox" checked={g.modulos.includes(m)} onChange={(e) => cambiar(g, m, e.target.checked)}
                      aria-label={`${g.nombre}: ${NOMBRE_MODULO[m]}`} className="h-4 w-4" />
                  </td>
                ))}
                <td className="text-right"><button className="text-sm text-ink/40 hover:text-red-600" onClick={() => borrar(g)}>Borrar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={crear} className="flex gap-2">
        <input className="input flex-1" placeholder="Nuevo grupo (ej: Finanzas)" value={nuevo} onChange={(e) => setNuevo(e.target.value)} />
        <button className="btn-secondary">Crear grupo</button>
      </form>
    </div>
  );
}
