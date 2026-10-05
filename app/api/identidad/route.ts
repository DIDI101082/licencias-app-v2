import { NextResponse } from "next/server";
import { createClient, getPerfil } from "@/lib/supabase/server";
import { entraConfigurado } from "@/lib/entra";
import { leerIdentidad, resumirIdentidad } from "@/lib/identidad";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Postura de identidad en Entra ID: MFA, inactivos, administradores e invitados.
// Consulta Graph en vivo y guarda el resumen del día para ver la evolución.
export async function GET(req: Request) {
  const { perfil } = await getPerfil();
  if (!perfil?.modulos?.includes("seguridad")) {
    return NextResponse.json({ error: "No tenés acceso al módulo de Seguridad." }, { status: 403 });
  }
  if (!entraConfigurado()) return NextResponse.json({ configurado: false });

  try {
    const dias = Math.max(15, Math.min(365, Number(new URL(req.url).searchParams.get("dias")) || 90));
    const r = await leerIdentidad();
    const { esInactivo, ...resumen } = resumirIdentidad(r, dias);

    // Historial diario (si todavía no se ejecutó identidad.sql, se ignora)
    await createClient().from("identidad_resumen").upsert(
      { fecha: r.consultado.slice(0, 10), ...resumen, dias_inactivo: dias, actualizado: r.consultado },
      { onConflict: "fecha" }
    );

    // Cuentas nominales (figuran en Empleados) y cambios de MFA detectados. Si falta identidad-mfa.sql, se omite.
    const { data: seg } = await createClient().rpc("identidad_mfa_estado");
    const s = seg as any;
    const ids = new Set<string>(s?.nominales_id ?? []), mails = new Set<string>(s?.nominales_email ?? []);
    const usuarios = r.usuarios.map((u) => ({
      ...u, inactivo: esInactivo(u),
      nominal: s ? ids.has(u.id) || mails.has(u.upn.toLowerCase()) || (!!u.email && mails.has(u.email.toLowerCase())) : null,
    }));
    const seguimiento = s ? { alertar: s.alertar, ultima_ejecucion: s.ultima_ejecucion, ultimo_error: s.ultimo_error, eventos: s.eventos } : null;
    return NextResponse.json({ configurado: true, resumen, usuarios, avisos: r.avisos, disponibles: r.disponibles, consultado: r.consultado, dias, seguimiento });
  } catch (e: any) {
    return NextResponse.json({ configurado: true, error: e.message }, { status: 500 });
  }
}
