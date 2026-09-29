// Solo servidor: verificación de certificados SSL (leyendo el certificado que presenta el sitio)
// y del vencimiento de dominios (RDAP). La usan "Verificar" en Vencimientos y la tarea diaria.
import "server-only";
import tls from "node:tls";

// Solo nombres de dominio públicos (nada de IPs, localhost ni nombres internos)
export const HOST_OK = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function separar(host: string) {
  const [h, p] = host.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":");
  return { host: h, puerto: Number(p) || 443 };
}

// Lee el certificado que presenta el servidor (aunque esté vencido, para informar la fecha)
export function certificado(host: string, puerto: number): Promise<{ vence: Date; emisor: string }> {
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
export async function dominio(host: string): Promise<{ vence: Date; emisor: string }> {
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

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

