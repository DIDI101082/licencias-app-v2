import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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

export async function getPerfil() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, perfil: null };

  const [{ data: perfil }, { data: modulos, error: errorModulos }] = await Promise.all([
    supabase.from("perfiles").select("*").eq("id", user.id).single(),
    supabase.rpc("mis_modulos"),
  ]);

  // Solapas habilitadas según su grupo de acceso (los administradores ven todas).
  // Si todavía no se ejecutó accesos.sql, se muestran todas como antes.
  if (perfil) {
    perfil.modulos = errorModulos
      ? ["empleados", "licencias", "inventario", "seguridad", "ubicacion"]
      : ((modulos as string[] | null) ?? []);
  }
  return { user, perfil };
}
