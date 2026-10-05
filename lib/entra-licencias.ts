// Solo servidor: lee de Microsoft Graph las licencias de Microsoft 365 (compradas y asignadas por usuario).
// SOLO LECTURA: únicamente pedidos GET. Nunca asigna ni quita licencias.
// Permisos de aplicación (con consentimiento de administrador):
//   - User.Read.All                → licencias asignadas a cada usuario (ya lo usa la sincronización de empleados)
//   - LicenseAssignment.Read.All   → cantidades compradas y libres (también sirve Organization.Read.All o Directory.Read.All)
//   - AuditLog.Read.All            → último inicio de sesión (requiere Entra ID P1 o P2). Opcional.
import "server-only";
import { token } from "./entra";

// Nombres comerciales de los códigos de producto más habituales. Los que no están se muestran con su código;
// el nombre se puede corregir desde la pantalla Licencias y la sincronización no lo vuelve a pisar.
const NOMBRES: Record<string, string> = {
  O365_BUSINESS_ESSENTIALS: "Microsoft 365 Business Basic", O365_BUSINESS_PREMIUM: "Microsoft 365 Business Standard",
  SPB: "Microsoft 365 Business Premium", O365_BUSINESS: "Microsoft 365 Apps for business",
  OFFICESUBSCRIPTION: "Microsoft 365 Apps for enterprise", STANDARDPACK: "Office 365 E1", ENTERPRISEPACK: "Office 365 E3",
  ENTERPRISEPREMIUM: "Office 365 E5", SPE_E3: "Microsoft 365 E3", SPE_E5: "Microsoft 365 E5", SPE_F1: "Microsoft 365 F3",
  DESKLESSPACK: "Office 365 F3", EXCHANGESTANDARD: "Exchange Online (Plan 1)", EXCHANGEENTERPRISE: "Exchange Online (Plan 2)",
  EXCHANGEDESKLESS: "Exchange Online Kiosk", POWER_BI_PRO: "Power BI Pro", PBI_PREMIUM_PER_USER: "Power BI Premium por usuario",
  POWER_BI_STANDARD: "Power BI (gratuito)", PROJECT_P1: "Project Plan 1", PROJECTPROFESSIONAL: "Project Plan 3",
  PROJECTPREMIUM: "Project Plan 5", VISIOONLINE_PLAN1: "Visio Plan 1", VISIOCLIENT: "Visio Plan 2",
  EMS: "Enterprise Mobility + Security E3", EMSPREMIUM: "Enterprise Mobility + Security E5",
  AAD_PREMIUM: "Microsoft Entra ID P1", AAD_PREMIUM_P2: "Microsoft Entra ID P2", INTUNE_A: "Microsoft Intune Plan 1",
  ATP_ENTERPRISE: "Defender para Office 365 (Plan 1)", THREAT_INTELLIGENCE: "Defender para Office 365 (Plan 2)",
  WIN_DEF_ATP: "Defender para Endpoint", MDATP_XPLAT: "Defender para Endpoint (Plan 2)", DEFENDER_ENDPOINT_P1: "Defender para Endpoint (Plan 1)",
  MCOEV: "Teams Phone Standard", MCOMEETADV: "Audioconferencia de Teams", MICROSOFT_TEAMS_PREMIUM: "Teams Premium",
  MICROSOFT_TEAMS_ENTERPRISE_NEW: "Microsoft Teams Enterprise", MICROSOFT_365_COPILOT: "Microsoft 365 Copilot",
  FLOW_FREE: "Power Automate (gratuito)", POWERAPPS_VIRAL: "Power Apps (prueba)", POWERAPPS_DEV: "Power Apps para desarrolladores",
  TEAMS_EXPLORATORY: "Teams Exploratory", STREAM: "Microsoft Stream (prueba)", WINDOWS_STORE: "Microsoft Store para empresas",
  CCIBOTS_PRIVPREV_VIRAL: "Copilot Studio (prueba)", RIGHTSMANAGEMENT_ADHOC: "Rights Management Adhoc",
  MICROSOFT_BUSINESS_CENTER: "Microsoft Business Center", MCOPSTNC: "Créditos de comunicaciones",
  PHONESYSTEM_VIRTUALUSER: "Teams Phone (cuenta de recursos)",
};

// Productos sin costo o de prueba: se dejan afuera salvo que se pida incluirlos
const GRATUITAS = new Set([
  "FLOW_FREE", "POWER_BI_STANDARD", "POWERAPPS_VIRAL", "POWERAPPS_DEV", "TEAMS_EXPLORATORY", "STREAM", "WINDOWS_STORE",
  "CCIBOTS_PRIVPREV_VIRAL", "RIGHTSMANAGEMENT_ADHOC", "MICROSOFT_BUSINESS_CENTER", "MCOPSTNC", "PHONESYSTEM_VIRTUALUSER",
  "POWER_PAGES_VTRIAL_FOR_MAKERS", "DYN365_ENTERPRISE_P1_IW", "SPZA_IW", "TEAMS_COMMERCIAL_TRIAL", "POWERAUTOMATE_VIRAL",
]);

export type LicenciasM365 = {
  skus: { sku_id: string; codigo: string | null; nombre: string | null; compradas: number | null; consumidas: number }[];
  cuentas: {
    entra_id: string; email: string; nombre: string; habilitada: boolean; ultimo_ingreso: string | null;
    skus: string[]; desde: Record<string, string>;
  }[];
  avisos: string[];
  total: number;
  sin_totales: boolean;
  con_ingresos: boolean;
};

class ErrorGraph extends Error { constructor(public status: number, m: string) { super(m); } }

async function paginar(url: string, t: string) {
  const todos: any[] = [];
  let sig: string | null = url;
  while (sig) {
    const r: Response = await fetch(sig, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new ErrorGraph(r.status, j.error?.message ?? String(r.status));
    todos.push(...(j.value ?? []));
    sig = j["@odata.nextLink"] ?? null;
  }
  return todos;
}

const mayor = (a?: string | null, b?: string | null) => (!a ? b ?? null : !b ? a : a > b ? a : b);

export async function leerLicenciasM365(o: { incluirGratuitas: boolean }): Promise<LicenciasM365> {
  const t = await token();
  const avisos: string[] = [];
  const base = "id,displayName,mail,userPrincipalName,accountEnabled,assignedLicenses,licenseAssignmentStates";

  // 1. Usuarios con sus licencias. El último inicio de sesión es opcional (otro permiso y licencia P1)
  let usuarios: any[];
  let con_ingresos = true;
  try {
    usuarios = await paginar(`https://graph.microsoft.com/v1.0/users?$select=${base},signInActivity&$top=500`, t);
  } catch (e) {
    con_ingresos = false;
    try {
      usuarios = await paginar(`https://graph.microsoft.com/v1.0/users?$select=${base}&$top=999`, t);
    } catch (e2) {
      const x = e2 as ErrorGraph;
      throw new Error(x.status === 403
        ? "La app de Entra no tiene permiso para leer usuarios. Revisá que tenga User.Read.All (de aplicación) con consentimiento de administrador."
        : `Error de Microsoft Graph: ${x.message}`);
    }
    avisos.push("No se pudo leer el último inicio de sesión (hace falta AuditLog.Read.All y Entra ID P1 o P2): no se detectan las licencias sin uso.");
  }

  // 2. Productos comprados. Si falta el permiso, se resuelven los nombres con el detalle de un usuario por producto
  const productos = new Map<string, { codigo: string | null; compradas: number | null; consumidas: number | null }>();
  let sin_totales = false;
  try {
    for (const s of await paginar("https://graph.microsoft.com/v1.0/subscribedSkus", t)) {
      productos.set(s.skuId, { codigo: s.skuPartNumber ?? null, compradas: s.prepaidUnits?.enabled ?? 0, consumidas: s.consumedUnits ?? 0 });
    }
  } catch (e) {
    sin_totales = true;
    avisos.push("No se pudieron leer las cantidades compradas (falta LicenseAssignment.Read.All, Organization.Read.All o Directory.Read.All en la app de Entra): se muestran solo las asignadas.");
    const pendientes = new Map<string, string>();   // producto → un usuario que lo tiene
    for (const u of usuarios) for (const l of u.assignedLicenses ?? []) if (!pendientes.has(l.skuId)) pendientes.set(l.skuId, u.id);
    let intentos = 0;
    for (const [sku, uid] of pendientes) {
      if (productos.has(sku) || intentos >= 40) continue;
      intentos++;
      try {
        for (const d of await paginar(`https://graph.microsoft.com/v1.0/users/${uid}/licenseDetails?$select=skuId,skuPartNumber`, t)) {
          if (!productos.has(d.skuId)) productos.set(d.skuId, { codigo: d.skuPartNumber ?? null, compradas: null, consumidas: null });
        }
      } catch { /* queda sin nombre: se muestra con su identificador */ }
    }
    for (const sku of pendientes.keys()) if (!productos.has(sku)) productos.set(sku, { codigo: null, compradas: null, consumidas: null });
  }

  const gratuita = (sku: string) => {
    const p = productos.get(sku);
    return !!p && ((p.codigo != null && GRATUITAS.has(p.codigo.toUpperCase())) || (p.compradas ?? 0) >= 10000);
  };
  const incluido = (sku: string) => productos.has(sku) && (o.incluirGratuitas || !gratuita(sku));

  // 3. Cuentas con al menos una licencia incluida
  const cuentas: LicenciasM365["cuentas"] = [];
  const conteo = new Map<string, number>();
  for (const u of usuarios) {
    const skus = Array.from(new Set<string>((u.assignedLicenses ?? []).map((l: any) => l.skuId))).filter(incluido);
    if (!skus.length) continue;
    const desde: Record<string, string> = {};
    for (const s of u.licenseAssignmentStates ?? []) {
      if (s.lastUpdatedDateTime && skus.includes(s.skuId) && (!desde[s.skuId] || s.lastUpdatedDateTime < desde[s.skuId])) desde[s.skuId] = s.lastUpdatedDateTime;
    }
    for (const s of skus) conteo.set(s, (conteo.get(s) ?? 0) + 1);
    cuentas.push({
      entra_id: u.id,
      email: String(u.mail || u.userPrincipalName || "").toLowerCase(),
      nombre: u.displayName || u.userPrincipalName || u.id,
      habilitada: u.accountEnabled !== false,
      ultimo_ingreso: con_ingresos ? mayor(u.signInActivity?.lastSignInDateTime, u.signInActivity?.lastNonInteractiveSignInDateTime) : null,
      skus, desde,
    });
  }

  const skus: LicenciasM365["skus"] = [];
  for (const [sku_id, p] of productos) {
    if (!incluido(sku_id)) continue;
    const consumidas = p.consumidas ?? conteo.get(sku_id) ?? 0;
    if (!consumidas && !(p.compradas ?? 0)) continue;   // suscripción vencida y sin nadie asignado
    skus.push({
      sku_id, codigo: p.codigo, compradas: p.compradas, consumidas,
      nombre: p.codigo ? NOMBRES[p.codigo.toUpperCase()] ?? p.codigo.replace(/_/g, " ") : null,
    });
  }
  return { skus, cuentas, avisos, total: usuarios.length, sin_totales, con_ingresos };
}
