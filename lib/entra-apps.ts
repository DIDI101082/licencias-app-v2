// Solo servidor: aplicaciones del tenant de Entra ID (aplicaciones empresariales) y su uso real.
// Usa la misma app registrada que el resto (AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET). Solo lee.
// Permisos de aplicación (con consentimiento de administrador):
//   - Application.Read.All   → aplicaciones, secretos/certificados y permisos de aplicación
//   - Directory.Read.All     → permisos delegados consentidos (por un usuario o por un administrador)
//   - AuditLog.Read.All      → último uso de cada aplicación (requiere licencia Entra ID P1 o P2)
//   - Reports.Read.All       → cantidad de inicios de sesión de los últimos 30 días
// Si falta un permiso o la licencia, esa parte se muestra como "no disponible" y el resto funciona.
import "server-only";
import { token } from "./entra";

export type Origen = "propia" | "microsoft" | "terceros" | "identidad_administrada";

export type AppEntra = {
  id: string;                    // id del objeto (aplicación empresarial)
  app_id: string;
  nombre: string;
  origen: Origen;
  editor: string | null;         // editor verificado, si lo tiene
  habilitada: boolean;
  ultimo_uso: string | null;     // null = nunca se usó (o no disponible, ver "disponibles")
  ingresos_ok: number | null;    // últimos 30 días
  ingresos_fallidos: number | null;
  delegados: string[];           // permisos delegados (actúa en nombre del usuario)
  de_aplicacion: string[];       // permisos de aplicación sobre Microsoft Graph (actúa sola, sin usuario)
  sensibles: string[];           // los de las dos listas que dan acceso amplio a datos o al directorio
  consentimiento_usuario: boolean; // algún permiso lo aceptó un usuario común, no un administrador
  credenciales: { tipo: "secreto" | "certificado"; nombre: string | null; vence: string | null }[];
  vence: string | null;          // el vencimiento más cercano de las credenciales vigentes
  vencidas: number;
};

export type ResultadoApps = {
  apps: AppEntra[];
  avisos: string[];
  disponibles: { uso: boolean; ingresos: boolean; delegados: boolean; aplicacion: boolean; credenciales: boolean };
  consultado: string;
};

class ErrorGraph extends Error {
  constructor(public status: number, mensaje: string) { super(mensaje); }
}

async function pedir(t: string, url: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}`, ConsistencyLevel: "eventual" }, cache: "no-store", signal: AbortSignal.timeout(25000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErrorGraph(r.status, j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

async function paginar(t: string, url: string, max = 20000): Promise<any[]> {
  const out: any[] = [];
  let siguiente: string | null = url;
  while (siguiente && out.length < max) {
    const j = await pedir(t, siguiente);
    out.push(...(j.value ?? []));
    siguiente = j["@odata.nextLink"] ?? null;
  }
  return out;
}

function explicar(e: unknown, parte: string, permiso: string) {
  if (e instanceof ErrorGraph) {
    if (/premium|license|licen|P1|P2|B2C|tenant is not/i.test(e.message)) return `${parte}: requiere licencia Entra ID P1 o P2 en el tenant.`;
    if (e.status === 401 || e.status === 403) return `${parte}: a la app de Entra le falta el permiso ${permiso} (de aplicación, con consentimiento de administrador).`;
    return `${parte}: ${e.message}`;
  }
  return `${parte}: ${(e as Error)?.message ?? "error desconocido"}`;
}

// Tenants de Microsoft dueños de las aplicaciones propias de Microsoft (Office, Teams, Graph, etc.)
const TENANTS_MICROSOFT = new Set(["f8cdef31-a31e-4b4a-93e4-5f571e91255a", "72f988bf-86f1-41af-91ab-2d7cd011db47"]);
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";

// Permisos que dan acceso amplio a correo, archivos, directorio o a otros permisos
const SENSIBLE = /^(Mail\.(Read|ReadWrite|Send)|MailboxSettings\.ReadWrite|Files\.(Read|ReadWrite)\.All|Sites\.(Read|ReadWrite|Manage|FullControl)\.All|Directory\.(ReadWrite|AccessAsUser)\.All|User\.ReadWrite\.All|Group\.ReadWrite\.All|RoleManagement\.ReadWrite\.Directory|AppRoleAssignment\.ReadWrite\.All|Application\.ReadWrite\.(All|OwnedBy)|Chat\.(Read|ReadWrite)(\.All)?|Notes\.(Read|ReadWrite)\.All|Calendars\.(Read|ReadWrite)|Contacts\.(Read|ReadWrite)|EWS\.AccessAsUser\.All|IMAP\.AccessAsUser\.All|full_access_as_app|full_access_as_user|user_impersonation|offline_access_as_app)(\.Shared)?$/i;

export async function leerAppsEntra(): Promise<ResultadoApps> {
  const t = await token();
  const avisos: string[] = [];
  const G = "https://graph.microsoft.com";

  // 1) Aplicaciones empresariales: sin esto no hay nada que mostrar
  let sps: any[];
  try {
    sps = await paginar(t, `${G}/v1.0/servicePrincipals?$select=id,appId,displayName,appOwnerOrganizationId,servicePrincipalType,accountEnabled,verifiedPublisher&$top=999`);
  } catch (e) {
    throw new Error(explicar(e, "Aplicaciones", "Application.Read.All"));
  }

  const ok = <T,>(p: Promise<T>) => p.then((v) => ({ v, e: null as unknown }), (e) => ({ v: null as T | null, e }));
  const [regs, uso, resumen, grants, graph] = await Promise.all([
    ok(paginar(t, `${G}/v1.0/applications?$select=id,appId,passwordCredentials,keyCredentials&$top=999`)),
    ok(paginar(t, `${G}/beta/reports/servicePrincipalSignInActivities`)),
    ok(paginar(t, `${G}/beta/reports/getAzureADApplicationSignInSummary(period='D30')`)),
    ok(paginar(t, `${G}/v1.0/oauth2PermissionGrants?$top=999`)),
    ok(pedir(t, `${G}/v1.0/servicePrincipals(appId='${GRAPH_APP_ID}')?$select=id,appRoles`)),
  ]);
  if (regs.e) avisos.push(explicar(regs.e, "Secretos y certificados", "Application.Read.All"));
  if (uso.e) avisos.push(explicar(uso.e, "Último uso", "AuditLog.Read.All"));
  if (resumen.e) avisos.push(explicar(resumen.e, "Inicios de sesión de 30 días", "Reports.Read.All"));
  if (grants.e) avisos.push(explicar(grants.e, "Permisos delegados", "Directory.Read.All"));

  // Permisos de aplicación sobre Microsoft Graph (una sola consulta para todo el tenant)
  const deApp = new Map<string, string[]>();
  let aplicacion = !graph.e;
  if (graph.v) {
    try {
      const nombreRol = new Map<string, string>((graph.v.appRoles ?? []).map((r: any) => [String(r.id), String(r.value)]));
      for (const a of await paginar(t, `${G}/v1.0/servicePrincipals/${graph.v.id}/appRoleAssignedTo?$top=999`)) {
        const n = nombreRol.get(String(a.appRoleId));
        if (n) deApp.set(a.principalId, [...(deApp.get(a.principalId) ?? []), n]);
      }
    } catch (e) { aplicacion = false; avisos.push(explicar(e, "Permisos de aplicación", "Application.Read.All")); }
  } else avisos.push(explicar(graph.e, "Permisos de aplicación", "Application.Read.All"));

  const regPorApp = new Map<string, any>((regs.v ?? []).map((a) => [String(a.appId), a]));
  const usoPorApp = new Map<string, string | null>();
  for (const u of uso.v ?? []) {
    const fechas = [u.lastSignInActivity, u.delegatedClientSignInActivity, u.delegatedResourceSignInActivity, u.applicationAuthenticationClientSignInActivity, u.applicationAuthenticationResourceSignInActivity]
      .map((x: any) => x?.lastSignInDateTime).filter(Boolean).sort();
    usoPorApp.set(String(u.appId), fechas.length ? fechas[fechas.length - 1] : null);
  }
  const resPorApp = new Map<string, any>((resumen.v ?? []).map((r) => [String(r.id), r]));
  const delegados = new Map<string, { scopes: Set<string>; usuario: boolean }>();
  for (const g of grants.v ?? []) {
    const d = delegados.get(g.clientId) ?? { scopes: new Set<string>(), usuario: false };
    for (const s of String(g.scope ?? "").split(/\s+/).filter(Boolean)) d.scopes.add(s);
    if (g.consentType === "Principal") d.usuario = true;
    delegados.set(g.clientId, d);
  }

  const ahora = Date.now();
  const apps: AppEntra[] = sps.map((s) => {
    const reg = regPorApp.get(String(s.appId));
    const origen: Origen = s.servicePrincipalType === "ManagedIdentity" ? "identidad_administrada"
      : reg ? "propia" : TENANTS_MICROSOFT.has(String(s.appOwnerOrganizationId)) ? "microsoft" : "terceros";
    const cred = reg ? [
      ...(reg.passwordCredentials ?? []).map((c: any) => ({ tipo: "secreto" as const, nombre: c.displayName ?? null, vence: c.endDateTime ?? null })),
      ...(reg.keyCredentials ?? []).map((c: any) => ({ tipo: "certificado" as const, nombre: c.displayName ?? null, vence: c.endDateTime ?? null })),
    ] : [];
    const vigentes = cred.filter((c) => c.vence && Date.parse(c.vence) > ahora).map((c) => c.vence!).sort();
    const d = delegados.get(s.id);
    const del = d ? Array.from(d.scopes).sort() : [];
    const app = (deApp.get(s.id) ?? []).sort();
    const r = resPorApp.get(String(s.appId));
    return {
      id: s.id, app_id: String(s.appId), nombre: s.displayName ?? String(s.appId), origen,
      editor: s.verifiedPublisher?.displayName ?? null, habilitada: s.accountEnabled !== false,
      ultimo_uso: usoPorApp.get(String(s.appId)) ?? null,
      ingresos_ok: resumen.e ? null : Number(r?.successfulSignInCount ?? 0),
      ingresos_fallidos: resumen.e ? null : Number(r?.failedSignInCount ?? 0),
      delegados: del, de_aplicacion: app,
      sensibles: Array.from(new Set([...del, ...app].filter((p) => SENSIBLE.test(p)))),
      consentimiento_usuario: !!d?.usuario,
      credenciales: cred, vence: vigentes[0] ?? null,
      vencidas: cred.filter((c) => c.vence && Date.parse(c.vence) <= ahora).length,
    };
  });

  return {
    apps, avisos,
    disponibles: { uso: !uso.e, ingresos: !resumen.e, delegados: !grants.e, aplicacion, credenciales: !regs.e },
    consultado: new Date().toISOString(),
  };
}
