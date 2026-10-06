// Menú de la app, ordenado por tema (solapas de arriba o menú lateral, a elección de cada usuario).
// Los permisos siguen siendo por módulo (grupos de acceso): cada página pertenece al módulo que indica
// moduloDeRuta(), y MENU (por módulo) se arma solo a partir de TEMAS. Lo usan la navegación,
// la guardia de acceso, el buscador y la configuración de grupos.
import { MODULOS, NOMBRE_MODULO, INICIO_MODULO, moduloDeRuta, type Modulo } from "./modulos";

export type Pagina = { href: string; label: string };
export type Tema = { id: string; label: string; titulo: string; paginas: Pagina[]; admin?: Pagina[] };
export type SeccionMenu = { id: Modulo; label: string; titulo?: string; inicio: string; links: Pagina[]; admin: Pagina[] };
// Páginas habilitadas por grupo: { modulo: [href, ...] }. Un módulo que no figura = todas sus páginas.
export type PaginasGrupo = Partial<Record<Modulo, string[]>>;

export const TEMAS: Tema[] = [
  { id: "inicio", label: "Inicio", titulo: "Resumen del día e integraciones", paginas: [
    { href: "/inicio", label: "Resumen del día" },
    { href: "/inicio/integraciones", label: "Integraciones" },
  ] },
  { id: "personas", label: "Personas", titulo: "Empleados, identidades y concientización", paginas: [
    { href: "/empleados", label: "Empleados" },
    { href: "/empleados/movimientos", label: "Altas y bajas" },
    { href: "/inventario/identidad", label: "Identidad (Entra ID)" },
    { href: "/inventario/ad", label: "Active Directory" },
    { href: "/inventario/concientizacion", label: "Concientización" },
  ] },
  { id: "activos", label: "Activos", titulo: "Equipos, licencias y vencimientos", paginas: [
    { href: "/inventario", label: "Panel de inventario" },
    { href: "/inventario/equipos", label: "Equipos" },
    { href: "/inventario/escanear", label: "Escanear" },
    { href: "/inventario/personas", label: "Por persona" },
    { href: "/inventario/aplicaciones", label: "Aplicaciones" },
    { href: "/", label: "Panel de licencias" },
    { href: "/licencias", label: "Licencias" },
    { href: "/asignaciones", label: "Asignaciones" },
    { href: "/reportes", label: "Reportes" },
    { href: "/vencimientos", label: "Vencimientos" },
  ], admin: [{ href: "/inventario/catalogos", label: "Categorías y ubicaciones" }] },
  { id: "endpoints", label: "Endpoints", titulo: "Estado de seguridad de los equipos", paginas: [
    { href: "/inventario/seguridad", label: "Estado de los equipos" },
    { href: "/inventario/riesgos", label: "Riesgos" },
    { href: "/inventario/vulnerabilidades", label: "Vulnerabilidades" },
    { href: "/inventario/monitoreo", label: "Monitoreo" },
  ] },
  { id: "perimetro", label: "Perímetro", titulo: "Perímetro, correo y nube", paginas: [
    { href: "/inventario/superficie", label: "Superficie expuesta" },
    { href: "/inventario/correo", label: "Correo y dominio" },
    { href: "/inventario/securescore", label: "Secure Score" },
    { href: "/inventario/apps-entra", label: "Aplicaciones de Entra ID" },
    { href: "/red/fortigate", label: "FortiGate" },
    { href: "/inventario/wifi", label: "WiFi" },
  ] },
  { id: "infraestructura", label: "Infraestructura", titulo: "Servidores, virtualización, backups y red", paginas: [
    { href: "/servidores", label: "Servidores" },
    { href: "/servidores/parches", label: "Parches y fin de soporte" },
    { href: "/servidores/accesos", label: "Accesos a servidores" },
    { href: "/servidores/virtualizacion", label: "Virtualización" },
    { href: "/servidores/storage", label: "Storage" },
    { href: "/inventario/backups", label: "Backups (Veeam)" },
    { href: "/servidores/backups", label: "Backups por servidor" },
    { href: "/red", label: "Mapas de PRTG" },
    { href: "/red/switches", label: "Switches" },
    { href: "/red/dns", label: "DNS interno" },
    { href: "/servidores/grupo-electrogeno", label: "Grupo electrógeno" },
    { href: "/servidores/ups", label: "UPS" },
    { href: "/servidores/ambiente", label: "Temperatura y humedad" },
  ], admin: [{ href: "/servidores/configuracion", label: "Configuración de servidores" }] },
  { id: "oficina", label: "Oficina", titulo: "Oficina y home office", paginas: [
    { href: "/inventario/ubicacion", label: "Dónde están los equipos" },
    { href: "/inventario/ubicacion/asistencia", label: "Asistencia semanal" },
    { href: "/inventario/ubicacion/ocupacion", label: "Ocupación por piso" },
  ] },
  { id: "gobierno", label: "Gobierno", titulo: "Cumplimiento, normativa, incidentes y registros", paginas: [
    { href: "/inventario/cumplimiento", label: "Cumplimiento" },
    { href: "/inventario/normativa", label: "Normativa" },
    { href: "/inventario/informe", label: "Informe mensual" },
    { href: "/inventario/incidentes", label: "Incidentes" },
    { href: "/auditoria/revision", label: "Revisión de accesos" },
    { href: "/auditoria/alertas", label: "Alertas" },
    { href: "/auditoria", label: "Cambios" },
    { href: "/auditoria/sesiones", label: "Inicios de sesión" },
  ] },
];

// Por módulo (para permisos y grupos de acceso): las mismas páginas, agrupadas por su módulo
export const MENU: SeccionMenu[] = MODULOS.map((m) => ({
  id: m, label: NOMBRE_MODULO[m], inicio: INICIO_MODULO[m],
  links: TEMAS.flatMap((t) => t.paginas).filter((p) => moduloDeRuta(p.href) === m),
  admin: TEMAS.flatMap((t) => t.admin ?? []).filter((p) => moduloDeRuta(p.href) === m),
}));

// Páginas que solo coinciden con la dirección exacta (el resto abarca sus subpáginas)
const EXACTAS = ["/", "/inicio", "/inventario", "/inventario/ubicacion", "/auditoria", "/servidores", "/red"];

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

// ¿Puede abrir esta página? (solapa del módulo habilitada y, si el grupo restringe páginas, que esté entre las suyas)
export function paginaVisible(href: string, modulos: string[], paginas: PaginasGrupo | null | undefined, esAdmin: boolean, esPaginaAdmin = false) {
  if (esPaginaAdmin && !esAdmin) return false;
  const m = moduloDeRuta(href);
  if (!m) return true;
  if (!modulos.includes(m)) return false;
  const s = MENU.find((x) => x.id === m);
  return !s || puedeVerPagina(paginas, s, href);
}

// Temas con las páginas que el usuario puede ver (los temas sin ninguna página no se muestran)
export function temasVisibles(modulos: string[], paginas: PaginasGrupo | null | undefined, esAdmin: boolean) {
  return TEMAS.map((t) => ({
    ...t,
    paginas: [...t.paginas.filter((p) => paginaVisible(p.href, modulos, paginas, esAdmin)),
              ...(t.admin ?? []).filter((p) => paginaVisible(p.href, modulos, paginas, esAdmin, true))],
  })).filter((t) => t.paginas.length);
}

// Tema y página del menú que corresponden a una dirección (la coincidencia más específica)
export function ubicar(temas: { id: string; paginas: Pagina[] }[], pathname: string) {
  let mejor: { tema: string; href: string } | null = null;
  for (const t of temas) for (const p of t.paginas) {
    if (esActual(p.href, pathname) && (!mejor || p.href.length > mejor.href.length)) mejor = { tema: t.id, href: p.href };
  }
  return mejor;
}
