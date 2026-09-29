"use client";

import { createContext, useContext } from "react";
import { moduloDeRuta } from "@/lib/modulos";
import { MENU, puedeVerPagina, type PaginasGrupo } from "@/lib/menu";

export type Perfil = {
  id: string;
  nombre: string;
  email: string;
  rol: "administrador" | "lectura_escritura" | "solo_lectura";
  area: string | null;
  modulos?: string[];
  paginas?: PaginasGrupo | null;
};

const Ctx = createContext<Perfil | null>(null);

export function PerfilProvider({ perfil, children }: { perfil: Perfil | null; children: React.ReactNode }) {
  return <Ctx.Provider value={perfil}>{children}</Ctx.Provider>;
}

export function usePerfil() {
  const perfil = useContext(Ctx);
  const esAdmin = perfil?.rol === "administrador";
  const puedeEditar = esAdmin || perfil?.rol === "lectura_escritura";
  const puedeEditarEquipo = (area: string | null) =>
    esAdmin || (perfil?.rol === "lectura_escritura" && (!area || area === perfil?.area));
  // ¿Puede abrir esta página? (solapa habilitada y, si el grupo restringe páginas, que esté entre las suyas)
  const verPagina = (href: string) => {
    if (!perfil || esAdmin) return true;
    const m = moduloDeRuta(href);
    if (!m) return true;
    if (perfil.modulos && !perfil.modulos.includes(m)) return false;
    const s = MENU.find((x) => x.id === m);
    return !s || puedeVerPagina(perfil.paginas, s, href);
  };
  return { perfil, esAdmin, puedeEditar, puedeEditarEquipo, verPagina };
}
