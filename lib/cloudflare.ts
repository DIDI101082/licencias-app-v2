// Lectura de Cloudflare con un token de API de SOLO LECTURA (variable CLOUDFLARE_API_TOKEN en Vercel).
// Nunca se llama a un método que no sea GET (salvo la consulta de analíticas por GraphQL, que es de lectura).
// Cada parte se lee por separado: si una falla (por permisos o por el plan de la zona), las demás siguen.

const API = "https://api.cloudflare.com/client/v4";
const msj = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

export const cloudflareConfigurado = () => !!process.env.CLOUDFLARE_API_TOKEN;

async function cf<T = any>(ruta: string, ms = 15000): Promise<{ result: T; result_info?: any }> {
  const r = await fetch(`${API}${ruta}`, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, Accept: "application/json" },
    cache: "no-store", signal: AbortSignal.timeout(ms),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const e = j?.errors?.[0];
    const m = e?.message ?? `HTTP ${r.status}`;
    throw new Error(r.status === 403 || /authentication|permission|unauthorized/i.test(m) ? `Sin permiso (${m})` : m);
  }
  return j;
}

async function graphql(query: string, variables: Record<string, unknown>) {
  const r = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }), cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.errors?.[0]?.message ?? `HTTP ${r.status}`);
  if (j?.errors?.length) {
    const m = String(j.errors[0].message ?? "Error de GraphQL");
    throw new Error(/does not have access|not authorized|plan|not available/i.test(m) ? `No disponible para esta zona (${m})` : m);
  }
  return j.data;
}

// ---------------------------------------------------------------------------------------------
// Tipos que se envían a la base (cf_auto_aplicar)
// ---------------------------------------------------------------------------------------------
export type Hsts = { enabled: boolean; max_age: number; include_subdomains: boolean; preload: boolean };
export type Ajustes = {
  ssl: string | null; min_tls: string | null; tls13: string | null; siempre_https: string | null;
  hsts: Hsts | null; reescritura_https: string | null; nivel_seguridad: string | null;
};
export type Certificado = { vence: string | null; emisor: string | null; estado: string | null; tipo: string | null; hosts: string[] };
export type RegistroDns = {
  id: string; nombre: string; tipo: string; contenido: string; proxied: boolean; proxiable: boolean;
  ttl: number | null; comentario: string | null; modificado: string | null;
};
export type DiaTrafico = { dia: string; solicitudes: number; cacheadas: number; amenazas: number; bytes: number; visitantes: number };
export type Cuenta = { k: string; n: number };
export type Eventos = {
  total: number; mitigados: number; por_accion: Cuenta[]; paises: Cuenta[]; ips: (Cuenta & { pais: string | null })[];
  fuentes: Cuenta[]; rutas: Cuenta[]; por_hora: { h: string; n: number }[];
};
export type Zona = {
  id: string; nombre: string; estado: string | null; pausada: boolean; plan: string | null; ns: string[];
  ajustes: Ajustes | null; dnssec: string | null; cert: Certificado | null;
  registros: RegistroDns[] | null; trafico: DiaTrafico[] | null; eventos: Eventos | null;
  errores: Record<string, string>;
};
export type EventoAuditoria = {
  id: string; fecha: string; actor: string | null; actor_tipo: string | null; ip: string | null; contexto: string | null;
  accion: string; resultado: string | null; producto: string | null; recurso_tipo: string | null; recurso_id: string | null;
  zona: string | null; categoria: string; descripcion: string | null; detalle: string | null;
};

// Acciones del firewall que frenan o desafían la solicitud
export const MITIGADAS = ["block", "challenge", "jschallenge", "managed_challenge", "connection_close", "force_connection_close"];

// ---------------------------------------------------------------------------------------------
// Zonas y su configuración
// ---------------------------------------------------------------------------------------------
async function zonas() {
  const todas: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const j = await cf<any[]>(`/zones?per_page=50&page=${page}`);
    todas.push(...j.result);
    if (page >= (j.result_info?.total_pages ?? 1)) break;
  }
  return todas;
}

async function ajustes(id: string): Promise<Ajustes> {
  const { result } = await cf<{ id: string; value: any }[]>(`/zones/${id}/settings`);
  const v = (k: string) => result.find((s) => s.id === k)?.value ?? null;
  const sh = v("security_header")?.strict_transport_security;
  return {
    ssl: v("ssl"), min_tls: v("min_tls_version"), tls13: v("tls_1_3"), siempre_https: v("always_use_https"),
    hsts: sh ? { enabled: !!sh.enabled, max_age: Number(sh.max_age ?? 0), include_subdomains: !!sh.include_subdomains, preload: !!sh.preload } : null,
    reescritura_https: v("automatic_https_rewrites"), nivel_seguridad: v("security_level"),
  };
}

async function dnssec(id: string): Promise<string | null> {
  const { result } = await cf<{ status?: string }>(`/zones/${id}/dnssec`);
  return result?.status ?? null;
}

// El certificado de borde que vence primero entre los activos
async function certificado(id: string): Promise<Certificado | null> {
  const { result } = await cf<any[]>(`/zones/${id}/ssl/certificate_packs?status=all&per_page=50`);
  let mejor: Certificado | null = null;
  for (const p of result ?? []) {
    if (p.status && !/active/i.test(p.status)) continue;
    for (const c of p.certificates ?? []) {
      if (!c.expires_on) continue;
      if (!mejor?.vence || Date.parse(c.expires_on) < Date.parse(mejor.vence)) {
        mejor = { vence: c.expires_on, emisor: c.issuer ?? p.certificate_authority ?? null, estado: p.status ?? c.status ?? null, tipo: p.type ?? null, hosts: (p.hosts ?? []).slice(0, 20) };
      }
    }
  }
  return mejor;
}

async function registros(id: string): Promise<RegistroDns[]> {
  const out: RegistroDns[] = [];
  for (let page = 1; page <= 20; page++) {
    const j = await cf<any[]>(`/zones/${id}/dns_records?per_page=500&page=${page}`);
    for (const r of j.result) {
      out.push({
        id: r.id, nombre: r.name, tipo: r.type, contenido: String(r.content ?? "").slice(0, 500),
        proxied: !!r.proxied, proxiable: !!r.proxiable, ttl: r.ttl ?? null, comentario: r.comment ?? null, modificado: r.modified_on ?? null,
      });
    }
    if (page >= (j.result_info?.total_pages ?? 1)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Analíticas (GraphQL): tráfico de 7 días y eventos del firewall de las últimas 24 horas
// ---------------------------------------------------------------------------------------------
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function trafico(id: string): Promise<DiaTrafico[]> {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - 7 * 86400000);
  const d = await graphql(`query($z: string!, $d: Date!, $h: Date!) { viewer { zones(filter: { zoneTag: $z }) {
      httpRequests1dGroups(limit: 10, filter: { date_geq: $d, date_leq: $h }, orderBy: [date_ASC]) {
        dimensions { date } sum { requests cachedRequests threats bytes } uniq { uniques } } } } }`,
    { z: id, d: ymd(desde), h: ymd(hasta) });
  return (d?.viewer?.zones?.[0]?.httpRequests1dGroups ?? []).map((g: any) => ({
    dia: g.dimensions.date, solicitudes: g.sum.requests ?? 0, cacheadas: g.sum.cachedRequests ?? 0,
    amenazas: g.sum.threats ?? 0, bytes: g.sum.bytes ?? 0, visitantes: g.uniq?.uniques ?? 0,
  }));
}

async function eventos(id: string): Promise<Eventos> {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - 24 * 3600000);
  const f = "{ datetime_geq: $d, datetime_leq: $h }";
  const fm = "{ datetime_geq: $d, datetime_leq: $h, action_in: $m }";
  const d = await graphql(`query($z: string!, $d: Time!, $h: Time!, $m: [string!]) { viewer { zones(filter: { zoneTag: $z }) {
      acciones: firewallEventsAdaptiveGroups(limit: 20, filter: ${f}, orderBy: [count_DESC]) { count dimensions { action } }
      paises: firewallEventsAdaptiveGroups(limit: 10, filter: ${fm}, orderBy: [count_DESC]) { count dimensions { clientCountryName } }
      ips: firewallEventsAdaptiveGroups(limit: 10, filter: ${fm}, orderBy: [count_DESC]) { count dimensions { clientIP clientCountryName } }
      fuentes: firewallEventsAdaptiveGroups(limit: 10, filter: ${fm}, orderBy: [count_DESC]) { count dimensions { source } }
      rutas: firewallEventsAdaptiveGroups(limit: 10, filter: ${fm}, orderBy: [count_DESC]) { count dimensions { clientRequestPath } }
      horas: firewallEventsAdaptiveGroups(limit: 30, filter: ${fm}, orderBy: [datetimeHour_ASC]) { count dimensions { datetimeHour } } } } }`,
    { z: id, d: desde.toISOString(), h: hasta.toISOString(), m: MITIGADAS });
  const z = d?.viewer?.zones?.[0] ?? {};
  const grupos = (k: string, dim: string): Cuenta[] => (z[k] ?? []).map((g: any) => ({ k: String(g.dimensions?.[dim] ?? "—"), n: g.count ?? 0 }));
  const por_accion = grupos("acciones", "action");
  return {
    total: por_accion.reduce((s, x) => s + x.n, 0),
    mitigados: por_accion.filter((x) => MITIGADAS.includes(x.k)).reduce((s, x) => s + x.n, 0),
    por_accion, paises: grupos("paises", "clientCountryName"),
    ips: (z.ips ?? []).map((g: any) => ({ k: g.dimensions.clientIP, n: g.count, pais: g.dimensions.clientCountryName ?? null })),
    fuentes: grupos("fuentes", "source"), rutas: grupos("rutas", "clientRequestPath"),
    por_hora: (z.horas ?? []).map((g: any) => ({ h: g.dimensions.datetimeHour, n: g.count })),
  };
}

// ---------------------------------------------------------------------------------------------
// Auditoría de la cuenta: quién cambió qué (v2) e inicios de sesión (v1)
// ---------------------------------------------------------------------------------------------
function categoria(texto: string, accion: string): string {
  const t = texto.toLowerCase();
  if (accion === "login" || /login|session|sign.?in/.test(t)) return "acceso";
  if (/member|api.?token|token|role|user|sso|two.?factor|2fa/.test(t)) return "permisos";
  if (/dns|record|dnssec/.test(t)) return "dns";
  if (/firewall|waf|ruleset|rule|rate.?limit|access|ddos|bot|ip.?list/.test(t)) return "seguridad";
  if (/ssl|tls|certificate|hsts|setting|https/.test(t)) return "configuracion";
  if (/zone/.test(t)) return "zona";
  return "otro";
}

// Resumen legible de lo que se mandó (para DNS: tipo, nombre y a dónde apunta)
function resumen(req: any): string | null {
  if (!req || typeof req !== "object") return null;
  const r = req.result ?? req;
  if (r.type && r.name) return `${r.type} ${r.name}${r.content ? ` → ${r.content}` : ""}${r.proxied === false ? " (solo DNS)" : r.proxied ? " (con proxy)" : ""}`;
  if (r.id && "value" in r) return `${r.id} = ${typeof r.value === "object" ? JSON.stringify(r.value).slice(0, 120) : r.value}`;
  if ("value" in r) return `valor: ${typeof r.value === "object" ? JSON.stringify(r.value).slice(0, 120) : r.value}`;
  return null;
}

async function auditoriaV2(cuenta: string, desde: Date, hasta: Date): Promise<EventoAuditoria[]> {
  const out: EventoAuditoria[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ since: desde.toISOString(), before: hasta.toISOString(), limit: "1000", direction: "desc" });
    if (cursor) q.set("cursor", cursor);
    const j: { result: any[]; result_info?: any } = await cf<any[]>(`/accounts/${cuenta}/logs/audit?${q}`, 20000);
    for (const e of j.result ?? []) {
      const accion = String(e.action?.type ?? "").toLowerCase();
      if (accion === "view") continue;
      const texto = [e.resource?.product, e.resource?.type, e.action?.description, e.raw?.uri].filter(Boolean).join(" ");
      out.push({
        id: `v2:${e.id}`, fecha: e.action?.time, actor: e.actor?.email ?? e.actor?.token_name ?? null, actor_tipo: e.actor?.type ?? null,
        ip: e.actor?.ip_address ?? null, contexto: e.actor?.context ?? null, accion: accion || "otro",
        resultado: e.action?.result ?? null, producto: e.resource?.product ?? null, recurso_tipo: e.resource?.type ?? null,
        recurso_id: e.resource?.id ?? null, zona: e.zone?.name ?? null, categoria: categoria(texto, accion),
        descripcion: e.action?.description ?? null,
        detalle: resumen(e.resource?.request) ?? resumen(e.resource?.response) ?? (e.raw?.method && e.raw?.uri ? `${e.raw.method} ${e.raw.uri}` : null),
      });
    }
    cursor = j.result_info?.cursor || null;
    if (!cursor || (j.result ?? []).length < 1000) break;
  }
  return out;
}

async function inicios(cuenta: string, desde: Date, hasta: Date): Promise<EventoAuditoria[]> {
  const q = new URLSearchParams({ "action.type": "login", since: desde.toISOString(), before: hasta.toISOString(), per_page: "1000", direction: "desc" });
  const { result } = await cf<any[]>(`/accounts/${cuenta}/audit_logs?${q}`, 20000);
  return (result ?? []).map((e) => ({
    id: `v1:${e.id}`, fecha: e.when, actor: e.actor?.email ?? null, actor_tipo: e.actor?.type ?? null, ip: e.actor?.ip ?? null,
    contexto: e.interface ?? null, accion: "login", resultado: e.action?.result === false ? "failure" : "success",
    producto: "login", recurso_tipo: e.resource?.type ?? null, recurso_id: e.resource?.id ?? null, zona: e.metadata?.zone_name ?? null,
    categoria: "acceso", descripcion: e.action?.result === false ? "Inicio de sesión fallido" : "Inicio de sesión", detalle: null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Lectura completa
// ---------------------------------------------------------------------------------------------
export async function leerCloudflare(opciones: { auditoriaDesde: Date | null }) {
  const t0 = Date.now();
  const avisos: string[] = [];

  // Las zonas primero: sirve para tokens de usuario y para tokens de la cuenta (account-owned)
  const lista = await zonas().catch((e) => {
    const m = msj(e);
    throw new Error(/invalid api token|authentication|sin permiso/i.test(m)
      ? `Cloudflare rechazó el token (${m}). Revisá que en Vercel esté copiado completo, sin espacios ni comillas, y que tenga Zone → Read sobre todos los dominios`
      : `No se pudieron leer los dominios de Cloudflare: ${m}`);
  });
  if (!lista.length) throw new Error("El token no ve ningún dominio: revisá que tenga Zone → Read con alcance «Todos los dominios»");

  const cuentaId = process.env.CLOUDFLARE_ACCOUNT_ID || lista[0]?.account?.id || null;
  const cuentaNombre = lista.find((z) => z.account?.id === cuentaId)?.account?.name ?? null;

  // Vencimiento del token: los de la cuenta se verifican en /accounts/{id}/tokens/verify y los de usuario en /user/tokens/verify
  const verif = await (cuentaId ? cf<{ status: string; expires_on?: string }>(`/accounts/${cuentaId}/tokens/verify`) : Promise.reject())
    .catch(() => cf<{ status: string; expires_on?: string }>(`/user/tokens/verify`)).catch(() => null);
  if (verif?.result?.status && verif.result.status !== "active") throw new Error(`El token de Cloudflare está ${verif.result.status}`);
  if (verif?.result?.expires_on) avisos.push(`El token vence el ${verif.result.expires_on.slice(0, 10)}`);

  const leidas: Zona[] = [];
  // De a 3 zonas por vez para no pasar el límite de la API (1200 solicitudes cada 5 minutos)
  for (let i = 0; i < lista.length; i += 3) {
    leidas.push(...await Promise.all(lista.slice(i, i + 3).map(async (z): Promise<Zona> => {
      const errores: Record<string, string> = {};
      const parte = async <T,>(k: string, fn: () => Promise<T>): Promise<T | null> => {
        try { return await fn(); } catch (e) { errores[k] = msj(e); return null; }
      };
      const [aj, ds, ce, rg, tr, ev] = await Promise.all([
        parte("ajustes", () => ajustes(z.id)), parte("dnssec", () => dnssec(z.id)), parte("certificado", () => certificado(z.id)),
        parte("registros", () => registros(z.id)), parte("trafico", () => trafico(z.id)), parte("eventos", () => eventos(z.id)),
      ]);
      return {
        id: z.id, nombre: z.name, estado: z.status ?? null, pausada: !!z.paused, plan: z.plan?.name ?? null, ns: z.name_servers ?? [],
        ajustes: aj, dnssec: ds, cert: ce, registros: rg, trafico: tr, eventos: ev, errores,
      };
    })));
  }

  // Auditoría: desde la última lectura (con 10 min de margen) y como máximo 30 días atrás
  const hasta = new Date();
  const base = opciones.auditoriaDesde ?? new Date(hasta.getTime() - 30 * 86400000);
  const desde = new Date(Math.max(base.getTime() - 10 * 60000, hasta.getTime() - 30 * 86400000));
  let auditoria: EventoAuditoria[] = [];
  let auditoria_error: string | null = null;
  if (!cuentaId) auditoria_error = "No se pudo determinar la cuenta de Cloudflare (cargá CLOUDFLARE_ACCOUNT_ID en Vercel)";
  else {
    const [v2, v1] = await Promise.allSettled([auditoriaV2(cuentaId, desde, hasta), inicios(cuentaId, desde, hasta)]);
    if (v2.status === "fulfilled") auditoria.push(...v2.value); else auditoria_error = `Cambios: ${msj(v2.reason)}`;
    if (v1.status === "fulfilled") {
      // Si la v2 también trae los inicios de sesión, quedan los de la v1 (traen el resultado del intento)
      auditoria = auditoria.filter((e) => e.categoria !== "acceso");
      auditoria.push(...v1.value);
    } else avisos.push(`No se pudieron leer los inicios de sesión: ${msj(v1.reason)}`);
  }

  return {
    cuenta: cuentaId ? { id: cuentaId, nombre: cuentaNombre } : null,
    zonas: leidas, auditoria, auditoria_error, auditoria_hasta: hasta.toISOString(), avisos,
    duracion_s: Math.round((Date.now() - t0) / 1000),
  };
}
