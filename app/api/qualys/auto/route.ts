import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient as clienteAnonimo } from "@supabase/supabase-js";
import { getPerfil } from "@/lib/supabase/server";
import { qualysConfigurado, leerHosts, leerDetecciones, leerKb } from "@/lib/qualys";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Lectura de Qualys VMDR (cada 30 minutos, vercel.json). Usuario de API de solo lectura en QUALYS_USUARIO / QUALYS_CLAVE.
// Cada corrida trabaja hasta ~20 segundos pidiendo páginas de equipos y sigue en la próxima donde quedó,
// así la carga inicial de una suscripción grande no pasa el minuto que da Vercel.

const igual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const msj = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

type Inicio = { activo: boolean; cursor_id_min: number | null; procesado_desde: string | null; ciclo_inicio: string | null; carga_completa: boolean; leer_hosts: boolean };
type Respuesta = { hosts: number; detecciones: number; nuevas: number; kb: number; faltan_kb: number[]; cursor: number | null; carga_completa: boolean };

async function ejecutar(clave: string, manual: boolean) {
  const t0 = Date.now();
  const sb = clienteAnonimo(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: ini, error } = await sb.rpc("qualys_auto_inicio", { p_token: clave });
  if (error) throw new Error(/qualys_auto_inicio/.test(error.message) ? "Falta ejecutar supabase/qualys.sql en Supabase." : error.message);
  const inicio = ini as Inicio;
  if (!inicio.activo && !manual) return { omitido: "La lectura automática de Qualys está apagada" };
  if (!qualysConfigurado()) return { omitido: "Faltan las variables QUALYS_API_URL, QUALYS_USUARIO y QUALYS_CLAVE en Vercel" };

  const aplicar = async (p: Record<string, unknown>) => {
    const { data, error: e } = await sb.rpc("qualys_auto_aplicar", { p_token: clave, p });
    if (e) throw new Error(e.message);
    return data as Respuesta;
  };

  try {
    const avisos: string[] = [];
    let hosts = 0, paginas = 0, detecciones = 0, nuevas = 0, kb = 0;
    let faltan: number[] = [];

    // Lista de equipos (cobertura de escaneo): cada 6 horas, y siempre que se pide "Leer ahora"
    if (inicio.leer_hosts || manual) {
      try { const r = await aplicar({ hosts: await leerHosts(15000) }); hosts = r.hosts; faltan = r.faltan_kb; }
      catch (e) { avisos.push(`Lista de equipos: ${msj(e)}`); }
    }

    // Detecciones: páginas de equipos hasta agotar el tiempo de esta corrida
    let cursor = inicio.cursor_id_min != null ? String(inicio.cursor_id_min) : null;
    const cicloInicio = inicio.ciclo_inicio ?? new Date().toISOString();
    let completa = inicio.carga_completa;
    do {
      const pagina = await leerDetecciones({ idMin: cursor, procesadoDesde: inicio.procesado_desde });
      const r = await aplicar({ pagina, ciclo_inicio: cicloInicio });
      paginas++; detecciones += r.detecciones; nuevas += r.nuevas; faltan = r.faltan_kb; completa = r.carga_completa;
      cursor = pagina.siguiente;
    } while (cursor && Date.now() - t0 < 20000);

    // Base de conocimiento de los QID que faltan
    if (faltan.length && Date.now() - t0 < 40000) {
      try { const r = await aplicar({ kb: await leerKb(faltan.slice(0, 200)) }); kb = r.kb; }
      catch (e) { avisos.push(`Base de conocimiento: ${msj(e)}`); }
    }
    if (!completa) avisos.push(cursor ? "Carga inicial en curso: sigue en la próxima corrida" : "Carga inicial en curso");

    await aplicar({ fin: true, avisos, duracion_s: Math.round((Date.now() - t0) / 1000) });
    return { hosts, paginas, detecciones, nuevas, kb, pendiente: !!cursor, carga_completa: completa, avisos };
  } catch (e) {
    await sb.rpc("qualys_auto_error", { p_token: clave, p_error: msj(e) });
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
