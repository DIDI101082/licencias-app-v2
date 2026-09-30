import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: any }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // se puede ignorar si se llama desde un Server Component
          }
        },
      },
    }
  );
}

// Se ejecuta una sola vez por request aunque la llamen el layout y la página.
// getClaims() valida el token de sesión localmente (con las JWT Signing Keys del proyecto)
// en lugar de consultar a Supabase Auth en cada navegación.
export const getPerfil = cache(async () => {
  const supabase = createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return { user: null, perfil: null };
  const user = { id: claims.sub as string, email: (claims.email as string | undefined) ?? null };

  const [{ data: perfil }, { data: modulos, error: errorModulos }, { data: paginas, error: errorPaginas }] = await Promise.all([
    supabase.from("perfiles").select("*").eq("id", user.id).single(),
    supabase.rpc("mis_modulos"),
    supabase.rpc("mis_paginas"),
  ]);

  // Solapas habilitadas según su grupo de acceso (los administradores ven todas).
  // Si todavía no se ejecutó accesos.sql, se muestran todas como antes.
  if (perfil) {
    perfil.modulos = errorModulos
      ? ["empleados", "licencias", "inventario", "seguridad", "ubicacion", "red", "auditoria"]
      : ((modulos as string[] | null) ?? []);
    // Páginas habilitadas dentro de cada solapa (null = todas). Sin paginas-acceso.sql, todas.
    perfil.paginas = errorPaginas ? null : (paginas ?? null);
  }
  return { user, perfil };
});
