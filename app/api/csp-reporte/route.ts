import { NextResponse } from "next/server";

// Recibe los avisos de la política de contenido (CSP) que manda el navegador cuando algo
// queda (o quedaría) bloqueado. Se ven en Vercel → Logs buscando "[csp]".
// Es pública porque el navegador la llama sin sesión; solo registra un resumen corto.
export async function POST(request: Request) {
  try {
    const texto = (await request.text()).slice(0, 4000);
    const cuerpo = JSON.parse(texto);
    const r = cuerpo?.["csp-report"] ?? cuerpo?.[0]?.body ?? cuerpo;
    console.warn("[csp]", JSON.stringify({
      pagina: r?.["document-uri"] ?? r?.documentURL,
      directiva: r?.["violated-directive"] ?? r?.effectiveDirective,
      bloqueado: r?.["blocked-uri"] ?? r?.blockedURL,
      origen: r?.["source-file"] ?? r?.sourceFile,
      linea: r?.["line-number"] ?? r?.lineNumber,
    }));
  } catch {}
  return new NextResponse(null, { status: 204 });
}
