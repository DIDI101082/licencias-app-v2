import { NextResponse } from "next/server";
import { createClient, getPerfil } from "@/lib/supabase/server";
import { entraConfigurado } from "@/lib/entra";
import { leerLicenciasM365 } from "@/lib/entra-licencias";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// "Sincronizar ahora" de la pantalla Licencias (solo administradores).
// Lee Microsoft 365 en modo solo lectura y actualiza Licencias y Asignaciones.
export async function POST() {
  try {
    const { perfil } = await getPerfil();
    if (perfil?.rol !== "administrador") return NextResponse.json({ error: "Solo los administradores pueden sincronizar las licencias." }, { status: 403 });
    if (!entraConfigurado()) return NextResponse.json({ error: "Faltan las variables de Entra ID en Vercel (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)." }, { status: 400 });

    const supabase = createClient();
    const { data: estado, error } = await supabase.rpc("m365_estado");
    if (error) throw new Error(/m365_estado/.test(error.message) ? "Falta ejecutar supabase/m365-licencias.sql en Supabase." : error.message);

    const datos = await leerLicenciasM365({ incluirGratuitas: !!(estado as any)?.incluir_gratuitas });
    const { data, error: e2 } = await supabase.rpc("m365_aplicar", { p: datos });
    if (e2) throw new Error(e2.message);
    return NextResponse.json({ ok: true, ...(data as object), avisos: datos.avisos });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
