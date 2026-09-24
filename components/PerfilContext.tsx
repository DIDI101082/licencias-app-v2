"use client";

import { createContext, useContext } from "react";

export type Perfil = {
  id: string;
  nombre: string;
  email: string;
  rol: "administrador" | "lectura_escritura" | "solo_lectura";
  area: string | null;
  modulos?: string[];
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
  return { perfil, esAdmin, puedeEditar, puedeEditarEquipo };
}
