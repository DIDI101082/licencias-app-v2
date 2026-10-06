import { NextResponse } from "next/server";
import { biosConfigurado, cifrar, descifrar, generarClave } from "@/lib/bios-claves";

export const dynamic = "force-dynamic";

const sinCache = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const responder = (cuerpo: object, status = 200) => NextResponse.json(cuerpo, { status, headers: sinCache });

async function rpc(nombre: string, cuerpo: object) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const r = await fetch(`${url}/rest/v1/rpc/${nombre}`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    cache: "no-store",
  });
  const datos = await r.json().catch(() => null);
  if (!r.ok) throw new Error(datos?.message ?? "No se pudo consultar la base (¿falta ejecutar bios-claves.sql?)");
  return datos;
}

// La llama el script de cada notebook (sin sesión): se identifica con la clave propia del agente.
// "reservar" entrega la clave de BIOS de ESE equipo; "confirmar" informa si quedó aplicada.
export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const texto = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");
  const equipo = { p_uuid: texto(b?.uuid, 100), p_hostname: texto(b?.hostname, 100), p_secreto: texto(b?.secreto, 200) };
  if (!equipo.p_secreto || (!equipo.p_uuid && !equipo.p_hostname)) return responder({ error: "Faltan datos del equipo." }, 400);

  try {
    if (b.accion === "reservar") {
      if (!biosConfigurado()) return responder({ error: "Falta configurar BIOS_CLAVE_MAESTRA en Vercel." }, 503);
      const guardada = await rpc("bios_reservar", { ...equipo, p_cifrada: cifrar(generarClave()) });
      return responder({ clave: descifrar(String(guardada)) });
    }
    if (b.accion === "confirmar") {
      await rpc("bios_confirmar", { ...equipo, p_ok: b.ok === true, p_usb: b.usb === true, p_detalle: texto(b.detalle, 300) });
      return responder({ ok: true });
    }
    return responder({ error: "Acción desconocida." }, 400);
  } catch (e: any) {
    return responder({ error: e.message }, 403);
  }
}
