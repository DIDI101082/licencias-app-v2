"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MODULOS, NOMBRE_MODULO, type Modulo } from "@/lib/modulos";
import { MENU, type PaginasGrupo } from "@/lib/menu";

export type Grupo = { id: number; nombre: string; modulos: string[]; paginas?: PaginasGrupo | null };

// Configuración de qué solapas ve cada grupo
export default function GruposAcceso({ grupos }: { grupos: Grupo[] }) {
  const router = useRouter();
  const [nuevo, setNuevo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<number | null>(null);

  // Páginas de una solapa: todas marcadas = sin restricción (se borra la clave; las páginas nuevas se ven)
  async function cambiarPagina(g: Grupo, m: Modulo, href: string, on: boolean) {
    setError(null);
    const todas = MENU.find((x) => x.id === m)?.links.map((l) => l.href) ?? [];
    const actual = g.paginas?.[m] ?? todas;
    const lista = on ? Array.from(new Set([...actual, href])) : actual.filter((x) => x !== href);
    if (!lista.length) return setError("Dejá al menos una página, o destildá la solapa entera.");
    const paginas: PaginasGrupo = { ...(g.paginas ?? {}) };
    if (todas.every((h) => lista.includes(h))) delete paginas[m]; else paginas[m] = todas.filter((h) => lista.includes(h));
    const { error } = await createClient().from("grupos_acceso").update({ paginas }).eq("id", g.id);
    if (error) return setError(/paginas/.test(error.message) ? "Falta ejecutar supabase/paginas-acceso.sql en Supabase." : error.message);
    router.refresh();
  }

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
    if (!confirm(`¿Borrar el grupo ${g.nombre}? Los usuarios que lo tengan pasan a "sin grupo" y se quedan sin acceso hasta que les asignes otro.`)) return;
    const { error } = await createClient().from("grupos_acceso").delete().eq("id", g.id);
    if (error) return setError(error.message);
    router.refresh();
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-medium text-ink">Grupos de acceso</h2>
        <p className="text-sm text-ink/60 mt-1">
          Marcá qué solapas ve cada grupo. Con “Páginas” podés dejar solo algunas páginas dentro de una solapa (por ejemplo, en Inventario IT solo Escanear). El cambio aplica la próxima vez que la persona entre o refresque la página, y también se
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
              <Fragment key={g.id}>
              <tr>
                <td className="font-medium text-ink">{g.nombre}</td>
                {MODULOS.map((m) => (
                  <td key={m} className="text-center">
                    <input type="checkbox" checked={g.modulos.includes(m)} onChange={(e) => cambiar(g, m, e.target.checked)}
                      aria-label={`${g.nombre}: ${NOMBRE_MODULO[m]}`} className="h-4 w-4" />
                  </td>
                ))}
                <td className="text-right whitespace-nowrap">
                  <button className="text-sm text-brand-600 hover:underline mr-3" aria-expanded={abierto === g.id} onClick={() => setAbierto(abierto === g.id ? null : g.id)}>
                    Páginas{Object.keys(g.paginas ?? {}).length ? " (restringidas)" : ""}
                  </button>
                  <button className="text-sm text-ink/40 hover:text-red-600" onClick={() => borrar(g)}>Borrar</button>
                </td>
              </tr>
              {abierto === g.id && (
                <tr>
                  <td colSpan={MODULOS.length + 2} className="bg-line/[0.03]">
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 py-2">
                      {MENU.filter((m) => g.modulos.includes(m.id)).map((m) => {
                        const hab = g.paginas?.[m.id];
                        return (
                          <div key={m.id}>
                            <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">{m.label}{hab ? "" : " · todas"}</div>
                            {m.links.map((l) => (
                              <label key={l.href} className="flex items-center gap-2 text-sm py-0.5">
                                <input type="checkbox" className="h-4 w-4" checked={!hab || hab.includes(l.href)} onChange={(e) => cambiarPagina(g, m.id, l.href, e.target.checked)} />
                                {l.label}
                              </label>
                            ))}
                          </div>
                        );
                      })}
                      {!g.modulos.length && <p className="text-sm text-ink/50">Este grupo no tiene solapas habilitadas.</p>}
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
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
