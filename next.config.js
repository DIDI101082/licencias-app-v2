// Cabeceras de seguridad para todas las respuestas de la app.
// La política de contenido (CSP) solo deja cargar recursos de la propia app y de Supabase;
// los mapas de PRTG (iframe) y las imágenes de productos pueden venir de otras direcciones https.
const dev = process.env.NODE_ENV !== "production";

let supabase = "";
let supabaseWs = "";
try {
  const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
  supabase = u.origin;
  supabaseWs = `wss://${u.host}`;
} catch {}

const csp = [
  "default-src 'self'",
  // Next.js necesita scripts en línea (y eval solo en desarrollo)
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabase} ${supabaseWs}${dev ? " ws:" : ""}`.replace(/\s+/g, " ").trim(),
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const cabeceras = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // La cámara se usa en el escáner de códigos; el resto queda apagado
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: cabeceras }];
  },
};
module.exports = nextConfig;
