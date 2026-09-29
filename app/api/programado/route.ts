import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient as clienteAnonimo } from "@supabase/supabase-js";
import { getPerfil } from "@/lib/supabase/server";
import { entraConfigurado } from "@/lib/entra";
import { leerSecureScore } from "@/lib/securescore";
import { revisarCorreo } from "@/lib/correo-dns";
import { revisarObjetivos } from "@/lib/superficie";
import { HOST_OK, separar, certificado, dominio, ymd } from "@/lib/verificar-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Verificaciones diarias: Secure Score, correo y dominio, superficie expuesta y certificados/dominios públicos.
// La dispara Vercel una vez por día (vercel.json) con la clave CRON_SECRET; un administrador también puede
// ejecutarla desde la app. La base solo acepta los resultados si la clave coincide con la huella guardada.

const conTiempo = <T,>(p: Promise<T>, ms: number, que: string) =>
  Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`${que}: se agotó el tiempo`)), ms))]);
// Comparación de la clave en tiempo constante (no revela cuántos caracteres coinciden)
const igual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const msj = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

async function ejecutar(clave: string) {
  const t0 = Date.now();
  const sb = clienteAnonimo(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: ini, error } = await sb.rpc("prog_inicio", { p_token: clave });
  if (error) throw new Error(/prog_inicio/.test(error.message) ? "Falta ejecutar supabase/postura.sql en Supabase." : error.message);
  const lista = ini as { correo: { dominio: string; selectores: string[] }[]; superficie: { id: number; direccion: string }[]; vencimientos: { id: number; tipo: string; host: string }[] };

  const [ss, correo, sup, venc] = await Promise.allSettled([
    entraConfigurado() ? conTiempo(leerSecureScore(), 45000, "Secure Score") : Promise.reject(new Error("Faltan las variables de Entra ID en Vercel")),
    conTiempo(Promise.all(lista.correo.map((d) => revisarCorreo(d.dominio, d.selectores).catch((e) => ({ dominio: d.dominio, error: msj(e) })))), 45000, "Correo"),
    conTiempo(revisarObjetivos(lista.superficie), 50000, "Superficie"),
    conTiempo(Promise.all(lista.vencimientos.map(async (it) => {
      const { host, puerto } = separar(it.host);
      if (!HOST_OK.test(host)) return { id: it.id, fecha: null, emisor: null, error: "Dirección inválida (si es interna, marcala como interna)" };
      try {
        const r = it.tipo === "certificado" ? await certificado(host, puerto) : await dominio(host);
        return { id: it.id, fecha: ymd(r.vence), emisor: r.emisor || null, error: null };
      } catch (e) { return { id: it.id, fecha: null, emisor: null, error: msj(e) }; }
    })), 45000, "Vencimientos"),
  ]);

  const datos: Record<string, unknown> = { duracion_s: Math.round((Date.now() - t0) / 1000) };
  if (ss.status === "fulfilled") datos.securescore = ss.value; else datos.error_securescore = msj(ss.reason);
  if (correo.status === "fulfilled") datos.correo = correo.value; else datos.error_correo = msj(correo.reason);
  if (sup.status === "fulfilled") datos.superficie = sup.value; else datos.error_superficie = msj(sup.reason);
  if (venc.status === "fulfilled") datos.vencimientos = venc.value; else datos.error_vencimientos = msj(venc.reason);

  const r = await sb.rpc("prog_reportar", { p_token: clave, p_datos: datos });
  if (r.error) throw new Error(r.error.message);
  return {
    duracion_s: datos.duracion_s,
    securescore: ss.status === "fulfilled" ? "ok" : datos.error_securescore,
    correo: correo.status === "fulfilled" ? `${lista.correo.length} dominio(s)` : datos.error_correo,
    superficie: sup.status === "fulfilled" ? `${lista.superficie.length} dirección(es)` : datos.error_superficie,
    vencimientos: venc.status === "fulfilled" ? `${lista.vencimientos.length} certificado(s)/dominio(s)` : datos.error_vencimientos,
  };
}

// Vercel Cron: llega con "Authorization: Bearer <CRON_SECRET>"
export async function GET(req: Request) {
  const clave = process.env.CRON_SECRET;
  if (!clave || !igual(req.headers.get("authorization") ?? "", `Bearer ${clave}`)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  try { return NextResponse.json(await ejecutar(clave)); }
  catch (e) { return NextResponse.json({ error: msj(e) }, { status: 500 }); }
}

// "Verificar ahora" desde la app (solo administradores)
export async function POST() {
  const { perfil } = await getPerfil();
  if (perfil?.rol !== "administrador") return NextResponse.json({ error: "Solo los administradores pueden ejecutar las verificaciones." }, { status: 403 });
  const clave = process.env.CRON_SECRET;
  if (!clave) return NextResponse.json({ error: "Falta cargar la clave en Vercel (variable CRON_SECRET) y volver a publicar. Ver “Configurar”." }, { status: 400 });
  try { return NextResponse.json(await ejecutar(clave)); }
  catch (e) {
    const m = msj(e);
    return NextResponse.json({ error: /inválida/.test(m) ? "La clave de Vercel (CRON_SECRET) no coincide con la generada en la app. Generala de nuevo y actualizala en Vercel." : m }, { status: 500 });
  }
}
