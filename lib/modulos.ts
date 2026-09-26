// Solapas de la app y a qué módulo pertenece cada ruta.
export const MODULOS = ["empleados", "licencias", "inventario", "seguridad", "ubicacion", "red", "auditoria"] as const;
export type Modulo = (typeof MODULOS)[number];

export const NOMBRE_MODULO: Record<Modulo, string> = {
  empleados: "Empleados",
  licencias: "Licencias",
  inventario: "Inventario IT",
  seguridad: "Seguridad",
  ubicacion: "Oficina / Home office",
  red: "Monitoreo de red",
  auditoria: "Logs",
};

export const INICIO_MODULO: Record<Modulo, string> = {
  empleados: "/empleados",
  licencias: "/",
  inventario: "/inventario",
  seguridad: "/inventario/seguridad",
  ubicacion: "/inventario/ubicacion",
  red: "/red",
  auditoria: "/auditoria",
};

const RUTAS_SEGURIDAD = ["/inventario/seguridad", "/inventario/riesgos", "/inventario/vulnerabilidades"];

// null = ruta sin solapa (login, usuarios, etc.)
export function moduloDeRuta(pathname: string): Modulo | null {
  if (pathname.startsWith("/login") || pathname.startsWith("/auth") || pathname.startsWith("/usuarios") || pathname.startsWith("/api")) return null;
  if (pathname.startsWith("/empleados")) return "empleados";
  if (pathname.startsWith("/red")) return "red";
  if (pathname.startsWith("/auditoria")) return "auditoria";
  if (pathname.startsWith("/inventario/ubicacion")) return "ubicacion";
  if (RUTAS_SEGURIDAD.some((r) => pathname.startsWith(r))) return "seguridad";
  if (pathname.startsWith("/inventario")) return "inventario";
  if (pathname === "/" || pathname.startsWith("/licencias") || pathname.startsWith("/asignaciones") || pathname.startsWith("/reportes") || pathname.startsWith("/vencimientos")) return "licencias";
  return null;
}
