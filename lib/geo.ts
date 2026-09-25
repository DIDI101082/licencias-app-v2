// Ubicación aproximada según la IP pública (datos de IP2Location.io)
export const ATRIBUCION_GEO = { texto: "Geolocalización por IP2Location.io", url: "https://www.ip2location.io" };

export function bandera(codigo?: string | null) {
  if (!codigo || codigo.length !== 2) return "";
  return String.fromCodePoint(...codigo.toUpperCase().split("").map((c) => 127397 + c.charCodeAt(0)));
}

// "Quilmes, Buenos Aires · Telecom Argentina" (agrega el país si no es Argentina)
export function textoUbicacion(d: Record<string, any>) {
  if (!d.geo_ciudad && !d.geo_pais) return null;
  const lugar = [d.geo_ciudad, d.geo_region && d.geo_region !== d.geo_ciudad ? d.geo_region : null, d.geo_pais_codigo !== "AR" ? d.geo_pais : null]
    .filter(Boolean).join(", ");
  return `${bandera(d.geo_pais_codigo)} ${lugar}${d.geo_isp ? " · " + d.geo_isp : ""}`.trim();
}
