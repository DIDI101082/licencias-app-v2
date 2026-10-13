// Política de contenido (CSP) de la app. La arma el middleware en cada pedido con un "nonce"
// (un número al azar que cambia en cada carga): solo se ejecutan los scripts que lo llevan,
// así que un script inyectado por un atacante queda bloqueado aunque logre meterse en la página.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   CSP_MODO            "reporte" (predeterminado) → la política nueva solo avisa en la consola y en /api/csp-reporte,
//                       sigue rigiendo la anterior. "aplicar" → la política nueva pasa a bloquear.
//   CSP_FRAME_ORIGENES  orígenes que se pueden mostrar en un iframe, separados por espacio.
//                       Ej.: "https://prtg.empresa.com:8443" (los mapas de PRTG de la solapa Red).
//   CSP_IMG_ORIGENES    orígenes extra de imágenes, separados por espacio (opcional).

const dev = process.env.NODE_ENV !== "production";

function origenesSupabase() {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return { https: u.origin, wss: `wss://${u.host}` };
  } catch {
    return { https: "", wss: "" };
  }
}

// Solo acepta orígenes https bien formados; descarta comodines y cualquier otra cosa
function origenesDeVariable(valor: string | undefined) {
  return (valor ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((o) => {
      try {
        const u = new URL(o);
        return u.protocol === "https:" && !u.host.includes("*") ? u.origin : null;
      } catch {
        return null;
      }
    })
    .filter((o): o is string => !!o);
}

function unir(directiva: string, fuentes: (string | false | undefined)[]) {
  return [directiva, ...fuentes.filter(Boolean)].join(" ");
}

/** Política nueva, con nonce y sin comodines en imágenes ni iframes. */
export function cspConNonce(nonce: string) {
  const sb = origenesSupabase();
  return [
    "default-src 'self'",
    // 'strict-dynamic': los scripts con nonce (los de Next.js) pueden cargar sus propios fragmentos.
    // 'self' queda solo como respaldo para navegadores viejos que no entienden 'strict-dynamic'.
    unir("script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", dev && "'unsafe-eval'"]),
    // Los estilos en línea se mantienen: React y Tailwind los usan y el riesgo es bajo (hallazgo aceptado)
    "style-src 'self' 'unsafe-inline'",
    unir("img-src", ["'self'", "data:", "blob:", sb.https, ...origenesDeVariable(process.env.CSP_IMG_ORIGENES)]),
    "font-src 'self' data:",
    unir("connect-src", ["'self'", sb.https, sb.wss, dev && "ws:"]),
    unir("frame-src", ["'self'", ...origenesDeVariable(process.env.CSP_FRAME_ORIGENES)]),
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
    "report-uri /api/csp-reporte",
  ].join("; ");
}

/** Política anterior (la que estaba en next.config.js). Rige mientras CSP_MODO sea "reporte". */
export function cspAnterior() {
  const sb = origenesSupabase();
  return [
    "default-src 'self'",
    unir("script-src", ["'self'", "'unsafe-inline'", dev && "'unsafe-eval'"]),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    unir("connect-src", ["'self'", sb.https, sb.wss, dev && "ws:"]),
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export const cspAplicada = () => process.env.CSP_MODO === "aplicar";

/** Nonce de 128 bits en base64 (funciona en el runtime Edge del middleware). */
export function nuevoNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}
