import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cspConNonce, cspAnterior, cspAplicada, nuevoNonce } from "@/lib/csp";

// Agrega la política de contenido a la respuesta (ver lib/csp.ts)
function conCsp(response: NextResponse, politica: string) {
  if (cspAplicada()) {
    response.headers.set("Content-Security-Policy", politica);
  } else {
    response.headers.set("Content-Security-Policy", cspAnterior());
    response.headers.set("Content-Security-Policy-Report-Only", politica);
  }
  return response;
}

export async function middleware(request: NextRequest) {
  // Nonce nuevo en cada pedido. Next.js lo toma de la cabecera del pedido y se lo pone a sus propios
  // scripts; el layout lo lee de "x-nonce" para el script del tema.
  const nonce = nuevoNonce();
  const politica = cspConNonce(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", politica);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: any }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          // Pasa las cookies renovadas a la página que se está por dibujar
          requestHeaders.set("cookie", request.cookies.toString());
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Valida la sesión localmente (y la renueva si venció) sin consultar a Supabase Auth en cada clic
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims?.sub ? data.claims : null;

  const isLoginPage = request.nextUrl.pathname.startsWith("/login");
  const isAuthCallback = request.nextUrl.pathname.startsWith("/auth/callback");
  // Descarga del instalador del agente con código de instalación (la usa ESET PROTECT, sin sesión)
  const isInstalador = request.nextUrl.pathname === "/api/agente/instalar";
  // Tarea diaria de Vercel (se autentica con CRON_SECRET dentro de la ruta)
  const isProgramado = request.nextUrl.pathname === "/api/programado"
    || request.nextUrl.pathname === "/api/entra/auto"    // sincronización automática con Entra ID (idem)
    || request.nextUrl.pathname === "/api/cloudflare/auto"   // lectura de Cloudflare (idem)
    || request.nextUrl.pathname === "/api/qualys/auto";   // lectura de Qualys VMDR (idem)

  // Pedido de la clave de BIOS desde cada notebook (se autentica con la clave propia del agente dentro de la ruta)
  const isBiosEquipo = request.nextUrl.pathname === "/api/bios/clave";
  // Avisos de violaciones de la CSP que manda el navegador (pueden llegar sin sesión)
  const isReporteCsp = request.nextUrl.pathname === "/api/csp-reporte";

  if (!user && !isLoginPage && !isAuthCallback && !isInstalador && !isProgramado && !isBiosEquipo && !isReporteCsp) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return conCsp(NextResponse.redirect(url), politica);
  }

  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/inicio";
    return conCsp(NextResponse.redirect(url), politica);
  }

  return conCsp(response, politica);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
