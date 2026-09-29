// Solo servidor: revisa la configuración de correo de un dominio (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT)
// consultando el DNS público por HTTPS (Cloudflare y, si falla, Google).
import "server-only";

type Hallazgo = { severidad: "alta" | "media" | "baja"; titulo: string; detalle: string };

async function doh(nombre: string, tipo: "TXT" | "MX" | "A"): Promise<string[]> {
  const codigo = { TXT: 16, MX: 15, A: 1 }[tipo];
  const urls = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(nombre)}&type=${tipo}`,
    `https://dns.google/resolve?name=${encodeURIComponent(nombre)}&type=${tipo}`,
  ];
  let ultimo: unknown = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Accept: "application/dns-json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!r.ok) { ultimo = new Error(`DNS respondió ${r.status}`); continue; }
      const j: any = await r.json();
      if (j.Status === 3) return []; // NXDOMAIN: no existe
      if (j.Status !== 0) { ultimo = new Error(`DNS devolvió el código ${j.Status}`); continue; }
      return (j.Answer ?? []).filter((a: any) => a.type === codigo).map((a: any) => String(a.data));
    } catch (e) { ultimo = e; }
  }
  throw ultimo instanceof Error ? ultimo : new Error("No se pudo consultar el DNS");
}

// TXT viene como "parte1" "parte2": se unen
const txt = (v: string) => (v.match(/"((?:[^"\\]|\\.)*)"/g) ?? [v]).map((p) => p.replace(/^"|"$/g, "").replace(/\\"/g, '"')).join("");
const txts = async (nombre: string) => (await doh(nombre, "TXT")).map(txt);

// Cuenta las consultas DNS que genera un SPF (el límite del estándar es 10)
async function consultasSpf(registro: string, visto = new Set<string>(), profundidad = 0): Promise<number> {
  if (profundidad > 8) return 99;
  let total = 0;
  for (const t of registro.split(/\s+/).slice(1)) {
    const m = t.replace(/^[+~?-]/, "").toLowerCase();
    const inc = m.match(/^(include:|redirect=)(.+)$/);
    if (inc) {
      total++;
      const dom = inc[2];
      if (visto.has(dom)) continue;
      visto.add(dom);
      const sub = (await txts(dom).catch(() => [])).find((x) => /^v=spf1(\s|$)/i.test(x));
      if (sub) total += await consultasSpf(sub, visto, profundidad + 1);
    } else if (/^(a|mx|ptr|exists)([:/]|$)/.test(m)) {
      total++;
    }
  }
  return total;
}

export async function revisarCorreo(dominio: string, selectores: string[]) {
  const h: Hallazgo[] = [];
  const [mxRaw, raiz, dmarcRaw, stsRaw, rptRaw] = await Promise.all([
    doh(dominio, "MX"), txts(dominio), txts(`_dmarc.${dominio}`),
    txts(`_mta-sts.${dominio}`).catch(() => []), txts(`_smtp._tls.${dominio}`).catch(() => []),
  ]);
  const mx = mxRaw.map((m) => m.split(/\s+/).pop()!.replace(/\.$/, "").toLowerCase()).sort();
  const recibe = mx.length > 0 && !(mx.length === 1 && mx[0] === "");

  // SPF
  const spfs = raiz.filter((x) => /^v=spf1(\s|$)/i.test(x));
  const spf = spfs[0] ?? null;
  if (!spf) h.push({ severidad: "alta", titulo: "No tiene SPF", detalle: "Cualquiera puede enviar correo en nombre del dominio sin que los receptores lo detecten." });
  else {
    if (spfs.length > 1) h.push({ severidad: "alta", titulo: "Tiene más de un registro SPF", detalle: "El estándar lo considera inválido (permerror): hay que unificarlos en uno." });
    const all = spf.toLowerCase().match(/(^|\s)([+~?-]?)all(\s|$)/);
    if (!all && !/redirect=/i.test(spf)) h.push({ severidad: "media", titulo: "El SPF no termina en “all”", detalle: "Agregar -all (o ~all) al final para indicar qué hacer con los servidores no listados." });
    else if (all && (all[2] === "+" || all[2] === "")) h.push({ severidad: "alta", titulo: "El SPF autoriza a cualquiera (+all)", detalle: "Con +all el SPF no protege nada. Cambiarlo por -all." });
    else if (all && all[2] === "?") h.push({ severidad: "media", titulo: "El SPF es neutral (?all)", detalle: "No indica rechazo. Usar -all o ~all." });
    const consultas = await consultasSpf(spf).catch(() => 0);
    if (consultas > 10) h.push({ severidad: "alta", titulo: `El SPF necesita ${consultas >= 99 ? "demasiadas" : consultas} consultas DNS`, detalle: "El límite es 10: los receptores lo dan por inválido y el correo legítimo puede fallar." });
    if (/(^|\s)[+]?ptr/i.test(spf)) h.push({ severidad: "baja", titulo: "El SPF usa el mecanismo ptr", detalle: "Está desaconsejado por lento y poco confiable." });
  }

  // DMARC
  const dmarc = dmarcRaw.find((x) => /^v=DMARC1/i.test(x)) ?? null;
  const tag = (k: string) => dmarc?.match(new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;]+)`, "i"))?.[1].trim() ?? null;
  const politica = tag("p")?.toLowerCase() ?? null;
  if (!dmarc) h.push({ severidad: "alta", titulo: "No tiene DMARC", detalle: "Sin DMARC, un correo que suplanta al dominio llega igual aunque falle SPF y DKIM." });
  else {
    if (politica === "none") h.push({ severidad: "alta", titulo: "DMARC solo monitorea (p=none)", detalle: "Los correos que suplantan al dominio se entregan igual. Pasar a p=quarantine y después a p=reject." });
    else if (politica === "quarantine") h.push({ severidad: "baja", titulo: "DMARC en cuarentena", detalle: "Protege, pero lo ideal es p=reject una vez confirmado que todo el correo legítimo pasa." });
    else if (politica !== "reject") h.push({ severidad: "alta", titulo: "DMARC con política inválida", detalle: `Valor p=${politica ?? "(falta)"}.` });
    const pct = Number(tag("pct") ?? 100);
    if (pct < 100) h.push({ severidad: "media", titulo: `DMARC se aplica solo al ${pct}% del correo`, detalle: "Subir pct a 100 (o quitarlo)." });
    const sp = tag("sp")?.toLowerCase();
    if (sp === "none" && politica !== "none") h.push({ severidad: "media", titulo: "Los subdominios no están protegidos (sp=none)", detalle: "Se puede suplantar cualquier subdominio. Quitar sp o ponerlo igual que p." });
    if (!tag("rua")) h.push({ severidad: "media", titulo: "DMARC sin reportes (rua)", detalle: "Sin rua no llegan los informes de quién envía correo con el dominio." });
  }

  // DKIM
  const dkim = await Promise.all(selectores.map(async (s) => {
    const v = (await txts(`${s}._domainkey.${dominio}`).catch(() => [])).find((x) => /(^|;)\s*(v=DKIM1|p=)/i.test(x)) ?? null;
    return { selector: s, valor: v ? v.replace(/p=([A-Za-z0-9+/=]{24})[A-Za-z0-9+/=]+/, "p=$1…") : null, revocada: !!v && /(^|;)\s*p=\s*(;|$)/.test(v) };
  }));
  const dkimOk = dkim.filter((d) => d.valor && !d.revocada);
  if (recibe && selectores.length && !dkimOk.length) {
    h.push({ severidad: "media", titulo: "No se encontró DKIM", detalle: `Con los selectores ${selectores.join(", ")}. En Microsoft 365 son selector1 y selector2 (hay que activarlo en Defender → Políticas → DKIM).` });
  }

  // MTA-STS y TLS-RPT (cifrado del correo entre servidores)
  const mtaSts = stsRaw.find((x) => /^v=STSv1/i.test(x)) ?? null;
  const tlsRpt = rptRaw.find((x) => /^v=TLSRPTv1/i.test(x)) ?? null;
  if (recibe && !mtaSts) h.push({ severidad: "baja", titulo: "Sin MTA-STS", detalle: "Obliga a otros servidores a usar TLS al enviarles correo; evita que lo intercepten degradando la conexión." });
  if (recibe && !tlsRpt) h.push({ severidad: "baja", titulo: "Sin TLS-RPT", detalle: "Informa fallas de cifrado en la entrega del correo." });
  if (!recibe) h.push({ severidad: "baja", titulo: "El dominio no recibe correo (sin MX)", detalle: "Si tampoco envía, conviene publicar “v=spf1 -all” y DMARC con p=reject para que no lo usen para suplantar." });

  const peso = { alta: 25, media: 10, baja: 3 };
  const puntaje = Math.max(0, 100 - h.reduce((s, x) => s + peso[x.severidad], 0));
  return {
    dominio, mx, spf, dmarc, dmarc_politica: politica, dkim: dkim.map(({ selector, valor }) => ({ selector, valor })),
    mta_sts: mtaSts, tls_rpt: tlsRpt, hallazgos: h, puntaje,
  };
}
