// Solo servidor: qué responde desde Internet en las IPs públicas de la empresa.
// 1) Intenta conectarse (TCP) a una lista de puertos comunes, como lo haría cualquiera desde afuera.
// 2) Suma lo que publica Shodan InternetDB (gratis, sin clave): puertos vistos y CVE conocidas.
// No envía nada más que el intento de conexión: no prueba contraseñas ni vulnerabilidades.
import "server-only";
import net from "node:net";

export const PUERTOS: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http", 110: "pop3", 135: "msrpc", 139: "netbios", 143: "imap",
  389: "ldap", 443: "https", 445: "smb", 465: "smtps", 541: "fortimanager", 587: "submission", 636: "ldaps", 993: "imaps", 995: "pop3s",
  1433: "sql server", 1521: "oracle", 1723: "pptp", 2049: "nfs", 3306: "mysql", 3389: "rdp", 4443: "https-alt", 5060: "sip",
  5432: "postgresql", 5900: "vnc", 5985: "winrm", 5986: "winrm-https", 6379: "redis", 8000: "http-alt", 8008: "http-alt",
  8080: "http-proxy", 8443: "https-alt", 8888: "http-alt", 9000: "http-alt", 9200: "elasticsearch", 9443: "https-alt",
  10443: "https-alt (vpn)", 11211: "memcached", 27017: "mongodb",
};

const PRIVADA = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^(22[4-9]|2[3-5]\d)\./];
const esIPv4 = (s: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split(".").every((x) => Number(x) <= 255);
const NOMBRE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

async function resolver(dir: string): Promise<string> {
  if (esIPv4(dir)) return dir;
  if (!NOMBRE.test(dir)) throw new Error("Dirección inválida: usá una IP pública (IPv4) o un nombre de dominio");
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(dir)}&type=A`, { headers: { Accept: "application/dns-json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
  const j: any = await r.json();
  const ip = (j.Answer ?? []).find((a: any) => a.type === 1)?.data;
  if (!ip) throw new Error("El nombre no resuelve a una IPv4");
  return ip;
}

function probar(ip: string, puerto: number, ms: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = new net.Socket();
    let listo = false;
    const fin = (v: boolean) => { if (!listo) { listo = true; s.destroy(); ok(v); } };
    s.setTimeout(ms);
    s.once("connect", () => fin(true));
    s.once("timeout", () => fin(false));
    s.once("error", () => fin(false));
    s.connect(puerto, ip);
  });
}

async function enParalelo<T, R>(items: T[], limite: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await f(items[k]); }
  }));
  return res;
}

export async function revisarObjetivos(objetivos: { id: number; direccion: string }[]) {
  const ips = await Promise.all(objetivos.map(async (o) => {
    try {
      const ip = await resolver(o.direccion.trim().toLowerCase());
      if (PRIVADA.some((r) => r.test(ip))) throw new Error(`${ip} es una IP privada o reservada: acá van solo IPs públicas`);
      return { ...o, ip, error: null as string | null };
    } catch (e: any) { return { ...o, ip: null, error: String(e?.message ?? e).slice(0, 200) }; }
  }));

  // Todas las conexiones juntas, con un tope para no saturar
  const pruebas = ips.filter((o) => o.ip).flatMap((o) => Object.keys(PUERTOS).map((p) => ({ id: o.id, ip: o.ip!, puerto: Number(p) })));
  const abiertos = await enParalelo(pruebas, 80, async (p) => ((await probar(p.ip, p.puerto, 3000)) ? p : null));

  return Promise.all(ips.map(async (o) => {
    if (!o.ip) return { id: o.id, ip: null, error: o.error, puertos: [], vulns: [], hostnames: [] };
    const puertos = abiertos.filter((a) => a && a.id === o.id).map((a) => ({ puerto: a!.puerto, servicio: PUERTOS[a!.puerto], fuente: "escaneo" }));
    let vulns: string[] = [], hostnames: string[] = [];
    try {
      const r = await fetch(`https://internetdb.shodan.io/${o.ip}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j: any = await r.json();
        for (const p of (j.ports ?? []) as number[]) {
          if (!puertos.some((x) => x.puerto === p)) puertos.push({ puerto: p, servicio: PUERTOS[p] ?? null as any, fuente: "shodan" });
        }
        vulns = (j.vulns ?? []).filter((v: string) => /^CVE-\d{4}-\d+$/.test(v)).slice(0, 200);
        hostnames = (j.hostnames ?? []).slice(0, 20);
      }
    } catch { /* Shodan es un complemento: si no responde, queda lo del escaneo */ }
    return { id: o.id, ip: o.ip, error: null, puertos, vulns, hostnames };
  }));
}
