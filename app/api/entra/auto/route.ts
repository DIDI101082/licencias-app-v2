import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient as clienteAnonimo } from "@supabase/supabase-js";
import { getPerfil } from "@/lib/supabase/server";
import { entraConfigurado, leerUsuariosEntra } from "@/lib/entra";
import { leerAuditoriaEntra } from "@/lib/entra-auditoria";
import { leerLicenciasM365 } from "@/lib/entra-licencias";
import { leerRegistroMfa } from "@/lib/identidad-mfa";
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

// Licencias de Microsoft 365: va después de los empleados (para vincular las altas nuevas) y nunca
// hace fallar la sincronización de empleados. Tiene su propio interruptor en la pantalla Licencias.
async function licencias(clave: string) {
  const sb = clienteAnonimo(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: ini, error } = await sb.rpc("m365_auto_inicio", { p_token: clave });
  if (error) return { omitido: /m365_auto_inicio/.test(error.message) ? "Falta ejecutar supabase/m365-licencias.sql" : msj(error) };
  const c = ini as { automatica: boolean; incluir_gratuitas: boolean };
  if (!c?.automatica) return { omitido: "La actualización automática de licencias está apagada" };
  try {
    if (!entraConfigurado()) throw new Error("Faltan las variables de Entra ID en Vercel");
    const datos = await leerLicenciasM365({ incluirGratuitas: c.incluir_gratuitas });
    const { data, error: e2 } = await sb.rpc("m365_auto_aplicar", { p_token: clave, p: datos });
    if (e2) throw new Error(e2.message);
    return data;
  } catch (e) {
    await sb.rpc("m365_auto_error", { p_token: clave, p_error: msj(e) });
    return { error: msj(e) };
  }
}

// Seguimiento de MFA: compara el registro de MFA con la lectura anterior para detectar quién se quedó sin segundo factor.
async function mfa(clave: string) {
  const sb = clienteAnonimo(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  try {
    if (!entraConfigurado()) throw new Error("Faltan las variables de Entra ID en Vercel");
    const usuarios = await leerRegistroMfa();
    const { data, error } = await sb.rpc("identidad_mfa_auto_aplicar", { p_token: clave, p: { usuarios } });
    if (error) {
      if (/identidad_mfa_auto_aplicar/.test(error.message)) return { omitido: "Falta ejecutar supabase/identidad-mfa.sql" };
      throw new Error(error.message);
    }
    return data;
  } catch (e) {
    await sb.rpc("identidad_mfa_auto_error", { p_token: clave, p_error: msj(e) });
    return { error: msj(e) };
  }
}

async function todo(clave: string) {
  let empleados: any, fallo = false;
  try { empleados = await ejecutar(clave); }
  catch (e) { empleados = { error: msj(e) }; fallo = true; }
  // Si falló la clave, no tiene sentido seguir
  if (fallo && /inválida/.test(empleados.error)) return { cuerpo: empleados, fallo };
  const [m365, segundoFactor] = await Promise.all([licencias(clave), mfa(clave)]);
  return { cuerpo: { ...empleados, licencias: m365, mfa: segundoFactor }, fallo };
}

// Vercel Cron: llega con "Authorization: Bearer <CRON_SECRET>"
export async function GET(req: Request) {
  const clave = process.env.CRON_SECRET;
  if (!clave || !igual(req.headers.get("authorization") ?? "", `Bearer ${clave}`)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const r = await todo(clave);
  return NextResponse.json(r.cuerpo, { status: r.fallo ? 500 : 200 });
}

// "Sincronizar ahora" desde la app (solo administradores)
export async function POST() {
  const { perfil } = await getPerfil();
  if (perfil?.rol !== "administrador") return NextResponse.json({ error: "Solo los administradores pueden ejecutar la sincronización." }, { status: 403 });
  const clave = process.env.CRON_SECRET;
  if (!clave) return NextResponse.json({ error: "Falta cargar CRON_SECRET en Vercel (se genera en Seguridad → verificación diaria → Configurar)." }, { status: 400 });
  const r = await todo(clave);
  if (r.fallo && /inválida/.test(r.cuerpo.error)) r.cuerpo.error = "La clave CRON_SECRET de Vercel no coincide con la generada en la app.";
  return NextResponse.json(r.cuerpo, { status: r.fallo ? 500 : 200 });
}
