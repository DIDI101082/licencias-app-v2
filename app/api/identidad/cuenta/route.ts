import { NextResponse } from "next/server";
import { getPerfil } from "@/lib/supabase/server";
import { entraConfigurado } from "@/lib/entra";
import { leerCuenta } from "@/lib/identidad";

export const dynamic = "force-dynamic";

// Estado en Entra ID de una cuenta puntual (lo usa el checklist de altas y bajas)
export async function GET(req: Request) {
  const { perfil } = await getPerfil();
  if (!perfil?.modulos?.some((m: string) => m === "empleados" || m === "seguridad")) {
    return NextResponse.json({ error: "Sin acceso." }, { status: 403 });
  }
  if (!entraConfigurado()) return NextResponse.json({ configurado: false });
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return NextResponse.json({ error: "Email inválido." }, { status: 400 });
  try {
    return NextResponse.json({ configurado: true, ...(await leerCuenta(email)) });
  } catch (e: any) {
    return NextResponse.json({ configurado: true, error: e.message }, { status: 500 });
  }
}
