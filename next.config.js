// Cabeceras de seguridad para todas las respuestas de la app.
// La política de contenido (CSP) ya no se define acá: la arma middleware.ts en cada pedido,
// con un nonce nuevo (ver lib/csp.ts).

const cabeceras = [
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
