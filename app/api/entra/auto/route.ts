import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient as clienteAnonimo } from "@supabase/supabase-js";
import { getPerfil } from "@/lib/supabase/server";
import { entraConfigurado, leerUsuariosEntra } from "@/lib/entra";
import { leerAuditoriaEntra } from "@/lib/entra-auditoria";
import { calcularPlan, type EmpleadoActual } from "@/lib/empleados-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Sincronización automática con Entra ID (cada 15 minutos, vercel.json).
// Usa la misma clave CRON_SECRET que la verificación diaria; la base la valida contra su huella.
// Los cambios se calculan acá con la misma lógica que la sincronización manual y los aplica la base.

const igual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const msj = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

async function ejecutar(clave: string) {
  const t0 = Date.now();
  const sb = clienteAnonimo(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

  const { data: ini, error } = await sb.rpc("entra_auto_inicio", { p_token: clave });
  if (error) throw new Error(/entra_auto_inicio/.test(error.message) ? "Falta ejecutar supabase/entra-auto.sql en Supabase." : error.message);
  const inicio = ini as { activo: boolean; requerir_area?: boolean; auditoria_desde?: string | null; empleados?: EmpleadoActual[] };
  if (!inicio.activo) return { omitido: "La sincronización automática está apagada" };

  try {
    if (!entraConfigurado()) throw new Error("Faltan las variables de Entra ID en Vercel (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)");

    const hasta = new Date();
    const { usuarios, total } = await leerUsuariosEntra({ requerirArea: inicio.requerir_area !== false });
    // Nunca aplicar con una respuesta vacía de Entra (dejaría a todos como eliminados)
    if (!usuarios.length) throw new Error("Entra ID no devolvió usuarios: no se aplicó ningún cambio");
    const plan = calcularPlan(usuarios, inicio.empleados ?? [], { desactivarAusentes: true });

    // Auditoría: desde la última lectura (con 10 min de margen) y como máximo 7 días atrás
    const base = inicio.auditoria_desde ? new Date(inicio.auditoria_desde) : new Date(hasta.getTime() - 86400000);
    const desde = new Date(Math.max(base.getTime() - 10 * 60000, hasta.getTime() - 7 * 86400000));
    let auditoria: Awaited<ReturnType<typeof leerAuditoriaEntra>> = [];
    let auditoria_error: string | null = null;
    try { auditoria = await leerAuditoriaEntra(desde); }
    catch (e) { auditoria_error = msj(e); }

    const { data, error: e2 } = await sb.rpc("entra_auto_aplicar", {
      p_token: clave,
      p: {
        nuevos: plan.nuevos, actualizar: plan.actualizar, desactivar: plan.desactivar,
        auditoria, auditoria_error, auditoria_hasta: hasta.toISOString(),
        total, duracion_s: Math.round((Date.now() - t0) / 1000),
      },
    });
    if (e2) throw new Error(e2.message);
    return data;
  } catch (e) {
    await sb.rpc("entra_auto_error", { p_token: clave, p_error: msj(e) });
    throw e;
  }
}

// Vercel Cron: llega con "Authorization: Bearer <CRON_SECRET>"
export async function GET(req: Request) {
  const clave = process.env.CRON_SECRET;
  if (!clave || !igual(req.headers.get("authorization") ?? "", `Bearer ${clave}`)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  try { return NextResponse.json(await ejecutar(clave)); }
  catch (e) { return NextResponse.json({ error: msj(e) }, { status: 500 }); }
}

// "Sincronizar ahora" desde la app (solo administradores)
export async function POST() {
  const { perfil } = await getPerfil();
  if (perfil?.rol !== "administrador") return NextResponse.json({ error: "Solo los administradores pueden ejecutar la sincronización." }, { status: 403 });
  const clave = process.env.CRON_SECRET;
  if (!clave) return NextResponse.json({ error: "Falta cargar CRON_SECRET en Vercel (se genera en Seguridad → verificación diaria → Configurar)." }, { status: 400 });
  try { return NextResponse.json(await ejecutar(clave)); }
  catch (e) {
    const m = msj(e);
    return NextResponse.json({ error: /inválida/.test(m) ? "La clave CRON_SECRET de Vercel no coincide con la generada en la app." : m }, { status: 500 });
  }
}
