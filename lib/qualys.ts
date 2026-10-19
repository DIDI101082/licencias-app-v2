// Lectura de Qualys VMDR con un usuario de API de SOLO LECTURA (rol Reader).
// Variables en Vercel: QUALYS_API_URL (ej. https://qualysapi.qg2.apps.qualys.com), QUALYS_USUARIO y QUALYS_CLAVE.
// Solo se usan acciones "list" de la API: no se lanzan escaneos ni se cambia nada en Qualys.

const msj = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

export const qualysConfigurado = () => !!(process.env.QUALYS_API_URL && process.env.QUALYS_USUARIO && process.env.QUALYS_CLAVE);

function base() {
  let u = (process.env.QUALYS_API_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(u)) u = `https://${u}`;
  // Si cargaron la dirección de la consola (qualysguard...), se usa la de la API (qualysapi...)
  return u.replace("://qualysguard.", "://qualysapi.");
}

async function qualys(ruta: string, params: Record<string, string>, ms = 40000): Promise<string> {
  const auth = Buffer.from(`${process.env.QUALYS_USUARIO}:${process.env.QUALYS_CLAVE}`).toString("base64");
  // POST con los parámetros en el cuerpo (es la forma recomendada por Qualys para listas largas); action=list siempre
  const r = await fetch(`${base()}${ruta}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "X-Requested-With": "accusys-cyber", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "list", ...params }), cache: "no-store", signal: AbortSignal.timeout(ms),
  });
  const xml = await r.text();
  if (!r.ok || /<SIMPLE_RETURN>/.test(xml)) {
    const texto = valor(xml, "TEXT") ?? `HTTP ${r.status}`;
    const codigo = valor(xml, "CODE");
    if (r.status === 401 || codigo === "2002") throw new Error("Usuario o clave de Qualys incorrectos (o la cuenta no tiene acceso a la API)");
    if (r.status === 409 || codigo === "1960" || codigo === "1965") throw new Error(`Qualys limitó las consultas: ${texto}`);
    throw new Error(`Qualys: ${texto}`);
  }
  return xml;
}

// ---------------------------------------------------------------------------------------------
// XML mínimo: la salida de Qualys es regular (sin etiquetas del mismo nombre anidadas)
// ---------------------------------------------------------------------------------------------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const entidades = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);
// Texto de una etiqueta: saca el CDATA y decodifica entidades (Qualys a veces las manda escapadas dentro del CDATA)
function texto(s: string) {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return entidades(cdata ? cdata[1] : s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}
function bloques(xml: string, tag: string): { attrs: string; cuerpo: string }[] {
  const out: { attrs: string; cuerpo: string }[] = [];
  const re = new RegExp(`<${tag}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] ?? "", cuerpo: m[2] ?? "" });
  return out;
}
function valor(xml: string, tag: string): string | null {
  const b = bloques(xml, tag)[0];
  if (!b) return null;
  const v = texto(b.cuerpo);
  return v === "" ? null : v;
}
const entero = (s: string | null) => (s == null || s === "" || isNaN(Number(s)) ? null : Math.trunc(Number(s)));
const decimal = (s: string | null) => (s == null || s === "" || isNaN(parseFloat(s)) ? null : parseFloat(s));
const fechaIso = (s: string | null) => (s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
const atributo = (attrs: string, nombre: string) => attrs.match(new RegExp(`${nombre}="([^"]*)"`))?.[1] ?? null;

// URL de la página siguiente (WARNING con código 1980): devuelve el id_min a pedir
function siguiente(xml: string): string | null {
  for (const w of bloques(xml, "WARNING")) {
    const url = valor(w.cuerpo, "URL");
    if (url) { const id = url.match(/id_min=(\d+)/)?.[1]; if (id) return id; }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Tipos que se envían a la base
// ---------------------------------------------------------------------------------------------
export type HostQualys = {
  id: number; ip: string | null; dns: string | null; netbios: string | null; os: string | null; tracking: string | null;
  ultimo_escaneo: string | null; ultimo_escaneo_auth: string | null;
};
export type Deteccion = {
  clave: string; qid: number; tipo: string | null; severidad: number | null; puerto: number | null; protocolo: string | null;
  estado: string; primera: string | null; ultima: string | null; corregida: string | null; veces: number | null;
  qds: number | null; qds_nivel: string | null; deshabilitada: boolean; ignorada: boolean;
};
export type PaginaDetecciones = { hosts: (HostQualys & { detecciones: Deteccion[] })[]; siguiente: string | null };
export type Vuln = {
  qid: number; titulo: string | null; categoria: string | null; tipo: string | null; severidad: number | null; parcheable: boolean | null;
  publicada: string | null; cves: string[]; cvss: number | null; cvss3: number | null; amenazas: string[]; solucion: string | null;
};

// ---------------------------------------------------------------------------------------------
// Lista de hosts (para la cobertura de escaneo)
// ---------------------------------------------------------------------------------------------
function host(b: string): HostQualys {
  return {
    id: entero(valor(b, "ID"))!, ip: valor(b, "IP"), dns: valor(b, "DNS")?.toLowerCase() ?? null, netbios: valor(b, "NETBIOS")?.toLowerCase() ?? null,
    os: valor(b, "OS"), tracking: valor(b, "TRACKING_METHOD"),
    ultimo_escaneo: fechaIso(valor(b, "LAST_VM_SCANNED_DATE") ?? valor(b, "LAST_VULN_SCAN_DATETIME") ?? valor(b, "LAST_SCAN_DATETIME")),
    ultimo_escaneo_auth: fechaIso(valor(b, "LAST_VM_AUTH_SCANNED_DATE")),
  };
}

export async function leerHosts(limiteMs: number): Promise<HostQualys[]> {
  const t0 = Date.now();
  const out: HostQualys[] = [];
  let idMin: string | null = null;
  for (let i = 0; i < 50; i++) {
    const p: Record<string, string> = { details: "Basic", truncation_limit: "1000" };
    if (idMin) p.id_min = idMin;
    const xml = await qualys("/api/2.0/fo/asset/host/", p, 15000);
    for (const h of bloques(xml, "HOST")) { const x = host(h.cuerpo); if (x.id) out.push(x); }
    idMin = siguiente(xml);
    if (!idMin) return out;
    if (Date.now() - t0 > limiteMs) throw new Error("La lista de hosts de Qualys es muy grande para una sola corrida");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Detecciones (una página de hosts por llamada; se sigue en la próxima con id_min)
// ---------------------------------------------------------------------------------------------
export async function leerDetecciones(opc: { idMin: string | null; procesadoDesde: string | null; hostsPorPagina?: number }): Promise<PaginaDetecciones> {
  const p: Record<string, string> = {
    truncation_limit: String(opc.hostsPorPagina ?? 50),
    show_results: "0", show_qds: "1", severities: "3-5", include_vuln_type: "confirmed", filter_superseded_qids: "1",
    // Carga inicial: solo lo abierto. Después, lo procesado desde la última vuelta, incluidas las corregidas.
    status: opc.procesadoDesde ? "New,Active,Re-Opened,Fixed" : "New,Active,Re-Opened",
  };
  if (opc.idMin) p.id_min = opc.idMin;
  if (opc.procesadoDesde) p.vm_processed_after = opc.procesadoDesde.replace(/\.\d{3}Z$/, "Z");
  const xml = await qualys("/api/2.0/fo/asset/host/vm/detection/", p, 30000);
  const hosts = bloques(xml, "HOST").map((h) => {
    const x = host(h.cuerpo);
    const detecciones = bloques(h.cuerpo, "DETECTION").map((d): Deteccion => {
      const qid = entero(valor(d.cuerpo, "QID"))!;
      const puerto = entero(valor(d.cuerpo, "PORT"));
      const protocolo = valor(d.cuerpo, "PROTOCOL");
      const qds = bloques(d.cuerpo, "QDS")[0];
      return {
        clave: valor(d.cuerpo, "UNIQUE_VULN_ID") ?? `${x.id}:${qid}:${puerto ?? ""}:${protocolo ?? ""}`,
        qid, tipo: valor(d.cuerpo, "TYPE"), severidad: entero(valor(d.cuerpo, "SEVERITY")), puerto, protocolo,
        estado: valor(d.cuerpo, "STATUS") ?? "Active",
        primera: fechaIso(valor(d.cuerpo, "FIRST_FOUND_DATETIME")), ultima: fechaIso(valor(d.cuerpo, "LAST_FOUND_DATETIME")),
        corregida: fechaIso(valor(d.cuerpo, "LAST_FIXED_DATETIME")), veces: entero(valor(d.cuerpo, "TIMES_FOUND")),
        qds: qds ? entero(texto(qds.cuerpo)) : null, qds_nivel: qds ? atributo(qds.attrs, "severity") : null,
        deshabilitada: valor(d.cuerpo, "IS_DISABLED") === "1", ignorada: valor(d.cuerpo, "IS_IGNORED") === "1",
      };
    }).filter((d) => d.qid);
    return { ...x, detecciones };
  }).filter((h) => h.id);
  return { hosts, siguiente: siguiente(xml) };
}

// ---------------------------------------------------------------------------------------------
// Base de conocimiento (título, CVE, CVSS, inteligencia de amenazas y solución de cada QID)
// ---------------------------------------------------------------------------------------------
const sinHtml = (s: string | null) => (s ? entidades(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500) : null);

export async function leerKb(qids: number[]): Promise<Vuln[]> {
  if (!qids.length) return [];
  const xml = await qualys("/api/2.0/fo/knowledge_base/vuln/", { ids: qids.join(","), details: "All" }, 15000);
  return bloques(xml, "VULN").map((v): Vuln => {
    const cvss = bloques(v.cuerpo, "CVSS")[0]?.cuerpo ?? "";
    const cvss3 = bloques(v.cuerpo, "CVSS_V3")[0]?.cuerpo ?? "";
    return {
      qid: entero(valor(v.cuerpo, "QID"))!, titulo: valor(v.cuerpo, "TITLE"), categoria: valor(v.cuerpo, "CATEGORY"),
      tipo: valor(v.cuerpo, "VULN_TYPE"), severidad: entero(valor(v.cuerpo, "SEVERITY_LEVEL")),
      parcheable: valor(v.cuerpo, "PATCHABLE") == null ? null : valor(v.cuerpo, "PATCHABLE") === "1",
      publicada: fechaIso(valor(v.cuerpo, "PUBLISHED_DATETIME")),
      cves: bloques(bloques(v.cuerpo, "CVE_LIST")[0]?.cuerpo ?? "", "CVE").map((c) => valor(c.cuerpo, "ID")).filter((x): x is string => !!x).slice(0, 30),
      cvss: decimal(valor(cvss, "BASE")), cvss3: decimal(valor(cvss3, "BASE")),
      amenazas: bloques(bloques(v.cuerpo, "THREAT_INTELLIGENCE")[0]?.cuerpo ?? "", "THREAT_INTEL").map((t) => texto(t.cuerpo)).filter(Boolean),
      solucion: sinHtml(valor(v.cuerpo, "SOLUTION")),
    };
  }).filter((v) => v.qid);
}

export { msj as mensajeError };
