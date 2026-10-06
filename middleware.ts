import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

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
          response = NextResponse.next({ request });
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
    || request.nextUrl.pathname === "/api/entra/auto";   // sincronización automática con Entra ID (idem)

  // Pedido de la clave de BIOS desde cada notebook (se autentica con la clave propia del agente dentro de la ruta)
  const isBiosEquipo = request.nextUrl.pathname === "/api/bios/clave";

  if (!user && !isLoginPage && !isAuthCallback && !isInstalador && !isProgramado && !isBiosEquipo) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/inicio";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
