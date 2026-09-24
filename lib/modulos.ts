// Solapas de la app y a qué módulo pertenece cada ruta.
export const MODULOS = ["empleados", "licencias", "inventario", "seguridad", "ubicacion"] as const;
export type Modulo = (typeof MODULOS)[number];

export const NOMBRE_MODULO: Record<Modulo, string> = {
  empleados: "Empleados",
  licencias: "Licencias",
  inventario: "Inventario IT",
  seguridad: "Seguridad",
  ubicacion: "Oficina / Home office",
};

export const INICIO_MODULO: Record<Modulo, string> = {
  empleados: "/empleados",
  licencias: "/",
  inventario: "/inventario",
  seguridad: "/inventario/seguridad",
  ubicacion: "/inventario/ubicacion",
};

const RUTAS_SEGURIDAD = ["/inventario/seguridad", "/inventario/riesgos"];

// null = ruta sin solapa (login, usuarios, etc.)
export function moduloDeRuta(pathname: string): Modulo | null {
  if (pathname.startsWith("/login") || pathname.startsWith("/auth") || pathname.startsWith("/usuarios") || pathname.startsWith("/api")) return null;
  if (pathname.startsWith("/empleados")) return "empleados";
  if (pathname.startsWith("/inventario/ubicacion")) return "ubicacion";
  if (RUTAS_SEGURIDAD.some((r) => pathname.startsWith(r))) return "seguridad";
  if (pathname.startsWith("/inventario")) return "inventario";
  if (pathname === "/" || pathname.startsWith("/licencias") || pathname.startsWith("/asignaciones") || pathname.startsWith("/reportes")) return "licencias";
  return null;
}
