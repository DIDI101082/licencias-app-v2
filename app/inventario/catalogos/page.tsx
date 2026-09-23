"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

type Def = { tabla: string; titulo: string; campos: { k: string; t: string; tipo?: "bool"; opciones?: string[] }[] };

const DEFS: Def[] = [
  { tabla: "inv_categorias", titulo: "Categorías de equipos", campos: [
    { k: "nombre", t: "Nombre" }, { k: "grupo", t: "Grupo" },
    { k: "requiere_serie", t: "Pide N° de serie", tipo: "bool" }, { k: "es_consumible", t: "Se cuenta por cantidad", tipo: "bool" },
  ]},
  { tabla: "inv_ubicaciones", titulo: "Ubicaciones", campos: [
    { k: "nombre", t: "Nombre" },
    { k: "tipo", t: "Tipo", opciones: ["oficina", "datacenter", "deposito", "sucursal", "remoto", "proveedor"] },
  ]},
  { tabla: "inv_proveedores", titulo: "Proveedores", campos: [
    { k: "nombre", t: "Nombre" }, { k: "contacto", t: "Contacto" }, { k: "email", t: "Email" }, { k: "telefono", t: "Teléfono" },
  ]},
];

function Tabla({ def }: { def: Def }) {
  const [filas, setFilas] = useState<any[]>([]);
  const [nuevo, setNuevo] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const cargar = () => createClient().from(def.tabla).select("*").order("nombre").then(({ data }) => setFilas(data ?? []));
  useEffect(() => { cargar(); }, []);

  async function agregar(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const { error } = await createClient().from(def.tabla).insert(nuevo);
    if (error) return setError(error.code === "23505" ? "Ya existe con ese nombre." : error.message);
    setNuevo({}); cargar();
  }
  async function borrar(id: number) {
    setError(null);
    const { error } = await createClient().from(def.tabla).delete().eq("id", id);
    if (error) setError(error.code === "23503" ? "No se puede borrar: hay equipos que lo usan." : error.message);
    cargar();
  }

  return (
    <div className="card p-5 space-y-4">
      <h2 className="font-medium text-ink">{def.titulo}</h2>
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      <form onSubmit={agregar} className="flex gap-3 flex-wrap items-end">
        {def.campos.map((c) =>
          c.tipo === "bool" ? (
            <label key={c.k} className="text-sm text-ink/70 flex items-center gap-2 pb-2">
              <input type="checkbox" checked={!!nuevo[c.k]} onChange={(e) => setNuevo({ ...nuevo, [c.k]: e.target.checked })} />
              {c.t}
            </label>
          ) : (
            <div key={c.k} className="flex-1 min-w-[160px]">
              <label className="label">{c.t}</label>
              {c.opciones ? (
                <select required className="input" value={nuevo[c.k] ?? ""} onChange={(e) => setNuevo({ ...nuevo, [c.k]: e.target.value })}>
                  <option value="">Elegí</option>{c.opciones.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input className="input" required={c.k === "nombre" || c.k === "grupo"} value={nuevo[c.k] ?? ""}
                  list={c.k === "grupo" ? "inv-grupos" : undefined}
                  onChange={(e) => setNuevo({ ...nuevo, [c.k]: e.target.value })} />
              )}
            </div>
          )
        )}
        <button className="btn-secondary">Agregar</button>
      </form>
      <datalist id="inv-grupos">
        {Array.from(new Set(filas.map((f) => f.grupo).filter(Boolean))).map((g) => <option key={g} value={g} />)}
      </datalist>
      <div className="max-h-96 overflow-y-auto">
        <table className="data w-full">
          <thead><tr>{def.campos.map((c) => <th key={c.k}>{c.t}</th>)}<th></th></tr></thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.id}>
                {def.campos.map((c) => (
                  <td key={c.k} className={c.k === "nombre" ? "text-ink" : "text-ink/60"}>
                    {c.tipo === "bool" ? (f[c.k] ? "Sí" : "No") : f[c.k] ?? "—"}
                  </td>
                ))}
                <td className="text-right">
                  <button className="text-ink/50 hover:text-red-600 hover:underline text-sm" onClick={() => borrar(f.id)}>Borrar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Catalogos() {
  const { esAdmin } = usePerfil();
  if (!esAdmin) {
    return (
      <div className="card p-6 max-w-md">
        <h1 className="font-display text-xl text-ink mb-2">Categorías y ubicaciones</h1>
        <p className="text-sm text-ink/60">Esta sección es solo para administradores.</p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Categorías y ubicaciones</h1>
        <p className="text-ink/60 text-sm mt-1">Las listas que se usan al cargar equipos.</p>
      </div>
      {DEFS.map((d) => <Tabla key={d.tabla} def={d} />)}
    </div>
  );
}
