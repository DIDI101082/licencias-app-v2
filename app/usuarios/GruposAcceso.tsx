"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { NOMBRE_MODULO, moduloDeRuta } from "@/lib/modulos";
import { MENU, TEMAS, type PaginasGrupo } from "@/lib/menu";

export type Grupo = { id: number; nombre: string; modulos: string[]; paginas?: PaginasGrupo | null };

// ------------------------------------------------------------------
// La pantalla muestra los temas y páginas del menú (lo que ve la persona).
// En la base los permisos siguen guardados por módulo (modulos + paginas), que es
// lo que controla el acceso a los datos. Estas dos funciones traducen entre ambos.
// ------------------------------------------------------------------

// Páginas del menú que hoy puede abrir el grupo
export function paginasDeGrupo(g: Pick<Grupo, "modulos" | "paginas">): Set<string> {
  const s = new Set<string>();
  MENU.forEach((m) => {
    if (!g.modulos.includes(m.id)) return;
    const hab = g.paginas?.[m.id];
    m.links.forEach((l) => { if (!Array.isArray(hab) || hab.includes(l.href)) s.add(l.href); });
  });
  return s;
}

// De las páginas elegidas a los permisos por módulo. Un módulo con todas sus páginas queda
// sin restricción (así las páginas nuevas que se agreguen a la app se ven solas).
export function permisosDePaginas(elegidas: Set<string>, previo: Pick<Grupo, "modulos" | "paginas">) {
  const modulos: string[] = [];
  const paginas: PaginasGrupo = {};
  MENU.forEach((m) => {
    const todas = m.links.map((l) => l.href);
    const sel = todas.filter((h) => elegidas.has(h));
    if (!sel.length) return;
    modulos.push(m.id);
    if (sel.length < todas.length) paginas[m.id] = sel;
  });
  // Módulos sin páginas en el menú (si los hubiera) se conservan como estaban
  previo.modulos.filter((m) => !MENU.some((x) => x.id === m)).forEach((m) => modulos.push(m));
  return { modulos, paginas };
}

// Páginas de un tema que dependen de permisos (las de administrador se manejan aparte)
const paginasDeTema = (id: string) => (TEMAS.find((t) => t.id === id)?.paginas ?? []).filter((p) => moduloDeRuta(p.href));

function Casilla({ estado, onChange, label }: { estado: "todas" | "algunas" | "ninguna"; onChange: (on: boolean) => void; label: string }) {
  return (
    <input type="checkbox" className="h-4 w-4" aria-label={label}
      checked={estado === "todas"} aria-checked={estado === "algunas" ? "mixed" : estado === "todas"}
      ref={(el) => { if (el) el.indeterminate = estado === "algunas"; }}
      onChange={(e) => onChange(e.target.checked)} />
  );
}

export default function GruposAcceso({ grupos }: { grupos: Grupo[] }) {
  const router = useRouter();
  const [nuevo, setNuevo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [guardando, setGuardando] = useState<number | null>(null);

  async function guardar(g: Grupo, elegidas: Set<string>) {
    setError(null);
    const { modulos, paginas } = permisosDePaginas(elegidas, g);
    setGuardando(g.id);
    const { error } = await createClient().from("grupos_acceso").update({ modulos, paginas }).eq("id", g.id);
    setGuardando(null);
    if (error) return setError(/paginas/.test(error.message) ? "Falta ejecutar supabase/paginas-acceso.sql en Supabase." : error.message);
    router.refresh();
  }

  function cambiarTema(g: Grupo, tema: string, on: boolean) {
    const s = paginasDeGrupo(g);
    paginasDeTema(tema).forEach((p) => (on ? s.add(p.href) : s.delete(p.href)));
    guardar(g, s);
  }

  function cambiarPagina(g: Grupo, href: string, on: boolean) {
    const s = paginasDeGrupo(g);
    if (on) s.add(href); else s.delete(href);
    guardar(g, s);
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

  const temas = TEMAS.filter((t) => paginasDeTema(t.id).length);

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-medium text-ink">Grupos de acceso</h2>
        <p className="text-sm text-ink/60 mt-1">
          Marcá qué partes del menú ve cada grupo. Con “Páginas” podés elegir páginas sueltas dentro de un tema (por ejemplo, en Activos solo
          Escanear). El cambio aplica la próxima vez que la persona entre o refresque la página.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      <div className="overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Grupo</th>
              {temas.map((t) => <th key={t.id} className="text-center" title={t.titulo}>{t.label}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {grupos.map((g) => {
              const hab = paginasDeGrupo(g);
              const estadoTema = (id: string) => {
                const ps = paginasDeTema(id);
                const n = ps.filter((p) => hab.has(p.href)).length;
                return n === 0 ? "ninguna" : n === ps.length ? "todas" : "algunas";
              };
              const restringido = temas.some((t) => estadoTema(t.id) === "algunas");
              return (
                <Fragment key={g.id}>
                  <tr className={guardando === g.id ? "opacity-60" : ""}>
                    <td className="font-medium text-ink">{g.nombre}</td>
                    {temas.map((t) => (
                      <td key={t.id} className="text-center">
                        <Casilla estado={estadoTema(t.id)} label={`${g.nombre}: ${t.label}`} onChange={(on) => cambiarTema(g, t.id, on)} />
                      </td>
                    ))}
                    <td className="text-right whitespace-nowrap">
                      <button className="text-sm text-brand-600 hover:underline mr-3" aria-expanded={abierto === g.id} onClick={() => setAbierto(abierto === g.id ? null : g.id)}>
                        Páginas{restringido ? " (algunas)" : ""}
                      </button>
                      <button className="text-sm text-ink/40 hover:text-red-600" onClick={() => borrar(g)}>Borrar</button>
                    </td>
                  </tr>
                  {abierto === g.id && (
                    <tr>
                      <td colSpan={temas.length + 2} className="bg-line/[0.03]">
                        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 py-2">
                          {temas.map((t) => {
                            const est = estadoTema(t.id);
                            return (
                              <div key={t.id}>
                                <label className="flex items-center gap-2 text-xs uppercase tracking-wide text-ink/50 mb-1 cursor-pointer">
                                  <Casilla estado={est} label={`${g.nombre}: todo ${t.label}`} onChange={(on) => cambiarTema(g, t.id, on)} />
                                  {t.label}{est === "todas" ? " · todas" : est === "ninguna" ? " · ninguna" : ""}
                                </label>
                                {paginasDeTema(t.id).map((p) => (
                                  <label key={p.href} className="flex items-center gap-2 text-sm py-0.5 pl-6 cursor-pointer">
                                    <input type="checkbox" className="h-4 w-4" checked={hab.has(p.href)} onChange={(e) => cambiarPagina(g, p.href, e.target.checked)} />
                                    {p.label}
                                  </label>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-xs text-ink/50 pb-1">
                          En la base de datos, el acceso se controla por área de datos: una página habilitada deja consultar los datos de su área
                          ({Object.values(NOMBRE_MODULO).join(", ")}).
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
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
