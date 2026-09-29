import { NextResponse } from "next/server";
import { createClient, getPerfil } from "@/lib/supabase/server";
import { HOST_OK, separar, certificado, dominio, ymd } from "@/lib/verificar-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  const { perfil } = await getPerfil();
  if (!perfil || !["administrador", "lectura_escritura"].includes(perfil.rol) || !(perfil.modulos ?? []).includes("licencias")) {
    return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
  }
  const supabase = createClient();
  const { data: items, error } = await supabase.from("vencimientos")
    .select("*").in("tipo", ["certificado", "dominio"]).eq("activo", true).not("host", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Los certificados internos los verifica el puente de Virtualización (desde la red interna)
  const resultados = await Promise.all((items ?? []).filter((it: any) => !it.interno).map(async (it: any) => {
    const { host, puerto } = separar(it.host);
    let fecha: string | null = null, emisor: string | null = null, err: string | null = null;
    if (!HOST_OK.test(host)) {
      err = "Dirección inválida: usá solo el nombre, por ejemplo www.accusys.com.ar";
    } else {
      try {
        const r = it.tipo === "certificado" ? await certificado(host, puerto) : await dominio(host);
        fecha = ymd(r.vence); emisor = r.emisor || null;
      } catch (e: any) {
        err = String(e?.message ?? e).slice(0, 200);
      }
    }
    await supabase.rpc("vencimientos_guardar_verificacion", { p_id: it.id, p_fecha: fecha, p_emisor: emisor, p_error: err });
    return { id: it.id, host, fecha, error: err };
  }));

  return NextResponse.json({ verificados: resultados.length, errores: resultados.filter((r) => r.error).length, resultados });
}
