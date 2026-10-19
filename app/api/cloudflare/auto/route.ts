import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient as clienteAnonimo } from "@supabase/supabase-js";
import { getPerfil } from "@/lib/supabase/server";
import { cloudflareConfigurado, leerCloudflare } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Lectura de Cloudflare (cada 15 minutos, vercel.json). Token de solo lectura en CLOUDFLARE_API_TOKEN.
// Usa la misma clave CRON_SECRET que las demás tareas; la base la valida contra su huella.

const igual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const msj = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

async function ejecutar(clave: string, manual: boolean) {
  const sb = clienteAnonimo(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: ini, error } = await sb.rpc("cf_auto_inicio", { p_token: clave });
  if (error) throw new Error(/cf_auto_inicio/.test(error.message) ? "Falta ejecutar supabase/cloudflare.sql en Supabase." : error.message);
  const inicio = ini as { activo: boolean; auditoria_hasta: string | null };
  if (!inicio.activo && !manual) return { omitido: "La lectura automática de Cloudflare está apagada" };
  if (!cloudflareConfigurado()) return { omitido: "Falta la variable CLOUDFLARE_API_TOKEN en Vercel" };

  try {
    const datos = await leerCloudflare({ auditoriaDesde: inicio.auditoria_hasta ? new Date(inicio.auditoria_hasta) : null });
    const { data, error: e2 } = await sb.rpc("cf_auto_aplicar", { p_token: clave, p: datos });
    if (e2) throw new Error(e2.message);
    return { ...(data as object), errores: datos.zonas.filter((z) => Object.keys(z.errores).length).map((z) => ({ zona: z.nombre, ...z.errores })), auditoria_error: datos.auditoria_error };
  } catch (e) {
    await sb.rpc("cf_auto_error", { p_token: clave, p_error: msj(e) });
    throw e;
  }
}

// Vercel Cron: llega con "Authorization: Bearer <CRON_SECRET>"
export async function GET(req: Request) {
  const clave = process.env.CRON_SECRET;
  if (!clave || !igual(req.headers.get("authorization") ?? "", `Bearer ${clave}`)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  try { return NextResponse.json(await ejecutar(clave, false)); }
  catch (e) { return NextResponse.json({ error: msj(e) }, { status: 500 }); }
}

// "Leer ahora" desde la app (solo administradores)
export async function POST() {
  const { perfil } = await getPerfil();
  if (perfil?.rol !== "administrador") return NextResponse.json({ error: "Solo los administradores pueden ejecutar la lectura." }, { status: 403 });
  const clave = process.env.CRON_SECRET;
  if (!clave) return NextResponse.json({ error: "Falta cargar CRON_SECRET en Vercel (se genera en Seguridad → verificación diaria → Configurar)." }, { status: 400 });
  try { return NextResponse.json(await ejecutar(clave, true)); }
  catch (e) {
    const m = msj(e);
    return NextResponse.json({ error: /inválida/.test(m) ? "La clave CRON_SECRET de Vercel no coincide con la generada en la app." : m }, { status: 500 });
  }
}
