import { NextResponse } from "next/server";
import tls from "node:tls";
import { createClient, getPerfil } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Solo nombres de dominio públicos (nada de IPs, localhost ni nombres internos)
const HOST_OK = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function separar(host: string) {
  const [h, p] = host.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":");
  return { host: h, puerto: Number(p) || 443 };
}

// Lee el certificado que presenta el servidor (aunque esté vencido, para informar la fecha)
function certificado(host: string, puerto: number): Promise<{ vence: Date; emisor: string }> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: puerto, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      if (!c || !c.valid_to) return reject(new Error("El servidor no presentó certificado"));
      const emisor = String((c.issuer as any)?.O ?? (c.issuer as any)?.CN ?? "");
      resolve({ vence: new Date(c.valid_to), emisor });
    });
    s.on("timeout", () => { s.destroy(); reject(new Error("Sin respuesta en el puerto " + puerto)); });
    s.on("error", (e) => reject(new Error(e.message)));
  });
}

// Fecha de vencimiento del dominio por RDAP (el reemplazo moderno de WHOIS)
async function dominio(host: string): Promise<{ vence: Date; emisor: string }> {
  // www.accusys.com.ar → accusys.com.ar · app.ejemplo.com → ejemplo.com
  const partes = host.split(".");
  const segundoNivel = partes.length > 2 && partes[partes.length - 1].length === 2 &&
    ["com", "net", "org", "gob", "gov", "edu", "co", "int", "mil", "tur"].includes(partes[partes.length - 2]);
  const base = partes.slice(segundoNivel ? -3 : -2).join(".");
  const urls = [`https://rdap.org/domain/${base}`];
  if (base.endsWith(".ar")) urls.unshift(`https://rdap.nic.ar/domain/${base}`);
  let ultimo = "No se encontró el dominio";
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Accept: "application/rdap+json" }, cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!r.ok) { ultimo = `RDAP respondió ${r.status}`; continue; }
      const j: any = await r.json();
      const ev = (j.events ?? []).find((e: any) => /expiration/i.test(e.eventAction));
      if (!ev?.eventDate) { ultimo = "El registro no informa vencimiento"; continue; }
      const registrar = (j.entities ?? []).find((e: any) => (e.roles ?? []).includes("registrar"));
      const nombre = registrar?.vcardArray?.[1]?.find((v: any) => v[0] === "fn")?.[3] ?? "";
      return { vence: new Date(ev.eventDate), emisor: String(nombre) };
    } catch (e: any) {
      ultimo = e?.name === "TimeoutError" ? "Sin respuesta del registro" : String(e?.message ?? e);
    }
  }
  throw new Error(ultimo);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function POST() {
  const { perfil } = await getPerfil();
  if (!perfil || !["administrador", "lectura_escritura"].includes(perfil.rol) || !(perfil.modulos ?? []).includes("licencias")) {
    return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
  }
  const supabase = createClient();
  const { data: items, error } = await supabase.from("vencimientos")
    .select("id, tipo, host").in("tipo", ["certificado", "dominio"]).eq("activo", true).not("host", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const resultados = await Promise.all((items ?? []).map(async (it: any) => {
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
