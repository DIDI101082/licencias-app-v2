import { NextResponse } from "next/server";
import { createClient, getPerfil } from "@/lib/supabase/server";
import { biosConfigurado, descifrar } from "@/lib/bios-claves";

export const dynamic = "force-dynamic";

const sinCache = { "Cache-Control": "no-store" };

// Muestra la clave de BIOS de un equipo a un administrador. La consulta queda registrada
// (quién, cuándo y motivo) dentro de bios_ver antes de devolver nada.
export async function POST(req: Request) {
  const { perfil } = await getPerfil();
  if (perfil?.rol !== "administrador") return NextResponse.json({ error: "Solo administradores." }, { status: 403, headers: sinCache });
  if (!biosConfigurado()) return NextResponse.json({ error: "Falta configurar BIOS_CLAVE_MAESTRA en Vercel." }, { status: 503, headers: sinCache });

  const b = await req.json().catch(() => null);
  const serie = typeof b?.serie === "string" ? b.serie.trim() : "";
  const motivo = typeof b?.motivo === "string" ? b.motivo.trim() : "";
  if (!serie || motivo.length < 5) return NextResponse.json({ error: "Indicá el equipo y el motivo de la consulta." }, { status: 400, headers: sinCache });

  const { data, error } = await createClient().rpc("bios_ver", { p_serie: serie, p_motivo: motivo });
  if (error) return NextResponse.json({ error: error.message }, { status: 400, headers: sinCache });
  try {
    return NextResponse.json({ clave: descifrar(String(data)) }, { headers: sinCache });
  } catch {
    return NextResponse.json({ error: "No se pudo descifrar: BIOS_CLAVE_MAESTRA no es la misma con la que se guardó." }, { status: 500, headers: sinCache });
  }
}
