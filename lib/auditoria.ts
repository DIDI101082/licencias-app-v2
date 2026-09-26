// Nombres legibles para la pantalla de Logs
export const SECCION: Record<string, string> = {
  perfiles: "Usuarios", grupos_acceso: "Grupos de acceso", empleados: "Empleados", licencias: "Licencias",
  asignaciones: "Asignación de licencias", inv_equipos: "Equipos", inv_asignaciones: "Asignación de equipos",
  inv_mantenimientos: "Mantenimientos", inv_categorias: "Categorías", inv_ubicaciones: "Ubicaciones", inv_proveedores: "Proveedores",
  inv_productos: "Catálogo de productos", inv_dispositivos: "Equipos del agente", inv_agente_config: "Configuración del agente",
  inv_codigos_instalacion: "Instaladores del agente", inv_software_prohibido: "Software prohibido", inv_amenazas: "Amenazas",
  inv_redes: "Redes de la empresa", asistencia_config: "Política de asistencia", asistencia_feriados: "Feriados",
  asistencia_excepciones: "Días justificados", red_mapas: "Mapas de PRTG", red_puente_config: "Puente de PRTG",
  red_conexiones: "Diagrama de red",
};

const CAMPO: Record<string, string> = {
  rol: "rol", area: "área", grupo_id: "grupo de acceso", email: "email", nombre: "nombre", apellido: "apellido", puesto: "puesto",
  activo: "activo", estado: "estado", estado_registro: "estado de registro", empleado_id: "persona", equipo_id: "equipo",
  licencia_id: "licencia", costo_unitario: "costo", periodicidad: "periodicidad", cantidad: "cantidad", modulos: "solapas",
  fecha_liberacion: "fecha de liberación", fecha_devolucion: "fecha de devolución", fecha_entrega: "fecha de entrega",
  revocado: "revocado", revisada: "revisada", conecta_a: "se conecta a", dias_oficina_semana: "días de oficina por semana",
  dominios_autoaprobados: "dominios auto-aprobados", permitir_token_general: "permitir token general",
  geo_paises_permitidos: "países permitidos", numero_serie: "número de serie", categoria_id: "categoría", ubicacion_id: "ubicación",
  clave_confirmada: "clave confirmada", clave_restablecida_hasta: "clave restablecida hasta",
};
export const campo = (k: string) => CAMPO[k] ?? k.replace(/_id$/, "").replace(/_/g, " ");

export function valor(v: unknown): string {
  if (v === null || v === undefined || v === "") return "vacío";
  if (v === true) return "sí";
  if (v === false) return "no";
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : "ninguno";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return new Date(s).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

// En altas y bajas se muestran los datos más útiles, sin identificadores internos ni fechas técnicas
export const CAMPOS_OCULTOS_ALTA = new Set(["id", "created_at", "creado_en", "actualizado", "updated_at", "cargado_en", "orden"]);
