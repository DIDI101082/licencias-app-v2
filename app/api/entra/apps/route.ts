import { NextResponse } from "next/server";
import { createClient, getPerfil } from "@/lib/supabase/server";
import { entraConfigurado } from "@/lib/entra";
import { leerAppsEntra } from "@/lib/entra-apps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Aplicaciones del tenant de Entra ID: cuáles se usan, qué permisos tienen y qué secretos vencen.
// Consulta Microsoft Graph en vivo, solo lectura.
export async function GET() {
  const { perfil } = await getPerfil();
  if (!perfil?.modulos?.includes("seguridad")) {
    return NextResponse.json({ error: "No tenés acceso al módulo de Seguridad." }, { status: 403 });
  }
  if (!entraConfigurado()) return NextResponse.json({ configurado: false });
  try {
    const r = await leerAppsEntra();
    // Historial de borrados y deshabilitaciones que guarda la tarea de cada 15 minutos (si falta entra-apps-cambios.sql, se omite)
    const { data: c, error } = await createClient().rpc("entra_apps_cambios_estado");
    const cambios = error ? { falta: /entra_apps_cambios_estado/.test(error.message), error: error.message } : c;
    return NextResponse.json({ configurado: true, ...r, cambios });
  } catch (e: any) {
    return NextResponse.json({ configurado: true, error: e.message }, { status: 500 });
  }
}
