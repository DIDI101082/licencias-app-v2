// Menú de la app: solapas (módulos) y sus páginas. Lo usan la barra de navegación,
// la guardia de acceso y la configuración de grupos (qué páginas ve cada grupo).
import type { Modulo } from "./modulos";

export type Pagina = { href: string; label: string };
export type SeccionMenu = { id: Modulo; label: string; titulo?: string; inicio: string; links: Pagina[]; admin: Pagina[] };
// Páginas habilitadas por grupo: { modulo: [href, ...] }. Un módulo que no figura = todas sus páginas.
export type PaginasGrupo = Partial<Record<Modulo, string[]>>;

export const MENU: SeccionMenu[] = [
  {
    id: "empleados",
    label: "Empleados",
    inicio: "/empleados",
    links: [
      { href: "/empleados", label: "Empleados" },
      { href: "/empleados/movimientos", label: "Altas y bajas" },
    ],
    admin: [],
  },
  {
    id: "licencias",
    label: "Licencias",
    inicio: "/",
    links: [
      { href: "/", label: "Panel" },
      { href: "/licencias", label: "Licencias" },
      { href: "/asignaciones", label: "Asignaciones" },
      { href: "/reportes", label: "Reportes" },
      { href: "/vencimientos", label: "Vencimientos" },
    ],
    admin: [],
  },
  {
    id: "inventario",
    label: "Inventario IT",
    inicio: "/inventario",
    links: [
      { href: "/inventario", label: "Panel" },
      { href: "/inventario/equipos", label: "Equipos" },
      { href: "/inventario/escanear", label: "Escanear" },
      { href: "/inventario/personas", label: "Por persona" },
      { href: "/inventario/monitoreo", label: "Monitoreo" },
      { href: "/inventario/aplicaciones", label: "Aplicaciones" },
    ],
    admin: [{ href: "/inventario/catalogos", label: "Categorías y ubicaciones" }],
  },
  {
    id: "seguridad",
    label: "Seguridad",
    inicio: "/inventario/seguridad",
    links: [
      { href: "/inventario/cumplimiento", label: "Cumplimiento" },
      { href: "/inventario/normativa", label: "Normativa" },
      { href: "/inventario/informe", label: "Informe mensual" },
      { href: "/inventario/seguridad", label: "Estado de los equipos" },
      { href: "/inventario/riesgos", label: "Riesgos" },
      { href: "/inventario/vulnerabilidades", label: "Vulnerabilidades" },
      { href: "/inventario/identidad", label: "Identidad" },
      { href: "/inventario/securescore", label: "Secure Score" },
      { href: "/inventario/correo", label: "Correo y dominio" },
      { href: "/inventario/superficie", label: "Superficie expuesta" },
      { href: "/inventario/ad", label: "Active Directory" },
      { href: "/inventario/wifi", label: "WiFi" },
      { href: "/inventario/incidentes", label: "Incidentes" },
      { href: "/inventario/backups", label: "Backups" },
      { href: "/inventario/concientizacion", label: "Concientización" },
    ],
    admin: [],
  },
  {
    id: "ubicacion",
    label: "Home office",
    titulo: "Oficina / Home office",
    inicio: "/inventario/ubicacion",
    links: [
      { href: "/inventario/ubicacion", label: "Dónde están los equipos" },
      { href: "/inventario/ubicacion/asistencia", label: "Asistencia semanal" },
      { href: "/inventario/ubicacion/ocupacion", label: "Ocupación por piso" },
    ],
    admin: [],
  },
  {
    id: "red",
    label: "Red",
    titulo: "Monitoreo de red",
    inicio: "/red",
    links: [
      { href: "/red", label: "Mapas de PRTG" },
      { href: "/red/switches", label: "Switches" },
      { href: "/red/fortigate", label: "FortiGate" },
    ],
    admin: [],
  },
  {
    id: "servidores",
    label: "Servidores",
    titulo: "Servidores: estado, parches y backups",
    inicio: "/servidores",
    links: [
      { href: "/servidores", label: "Estado" },
      { href: "/servidores/parches", label: "Parches y fin de soporte" },
      { href: "/servidores/backups", label: "Backups" },
      { href: "/servidores/accesos", label: "Accesos" },
      { href: "/servidores/virtualizacion", label: "Virtualización" },
      { href: "/servidores/storage", label: "Storage" },
    ],
    admin: [{ href: "/servidores/configuracion", label: "Configuración" }],
  },
  {
    id: "auditoria",
    label: "Logs",
    titulo: "Registro de cambios, accesos y alertas",
    inicio: "/auditoria",
    links: [
      { href: "/auditoria", label: "Cambios" },
      { href: "/auditoria/sesiones", label: "Inicios de sesión" },
      { href: "/auditoria/alertas", label: "Alertas" },
      { href: "/auditoria/revision", label: "Revisión de accesos" },
    ],
    admin: [],
  },
];

// Páginas que solo coinciden con la dirección exacta (el resto abarca sus subpáginas)
const EXACTAS = ["/", "/inventario", "/inventario/ubicacion", "/auditoria", "/servidores", "/red"];

export function esActual(href: string, pathname: string) {
  if (EXACTAS.includes(href)) return pathname === href;
  if (href === "/empleados") return pathname === href || (/^\/empleados\/[^/]+$/.test(pathname) && !pathname.startsWith("/empleados/movimientos"));
  return pathname === href || pathname.startsWith(href + "/");
}

// Página del menú a la que pertenece una dirección (la coincidencia más específica)
export function paginaDeRuta(seccion: SeccionMenu, pathname: string): string | null {
  const todas = [...seccion.links, ...seccion.admin].filter((l) => esActual(l.href, pathname));
  return todas.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

// ¿El grupo tiene restringidas las páginas de este módulo? Devuelve la lista habilitada o null (= todas)
export function paginasHabilitadas(paginas: PaginasGrupo | null | undefined, modulo: Modulo): string[] | null {
  const l = paginas?.[modulo];
  return Array.isArray(l) ? l : null;
}

export function puedeVerPagina(paginas: PaginasGrupo | null | undefined, seccion: SeccionMenu, pathname: string) {
  const hab = paginasHabilitadas(paginas, seccion.id);
  if (!hab) return true;
  const p = paginaDeRuta(seccion, pathname);
  return !!p && hab.includes(p);
}

// Primera página que el usuario puede abrir dentro de un módulo
export function inicioPermitido(paginas: PaginasGrupo | null | undefined, seccion: SeccionMenu) {
  const hab = paginasHabilitadas(paginas, seccion.id);
  if (!hab) return seccion.inicio;
  return seccion.links.find((l) => hab.includes(l.href))?.href ?? seccion.inicio;
}
