// Solo servidor: postura de identidad en Entra ID leída con Microsoft Graph.
// Usa la misma app registrada que la sincronización de empleados (AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET).
// Permisos de aplicación necesarios (con consentimiento de administrador):
//   - User.Read.All                    → usuarios e invitados (ya lo tenés para la sincronización)
//   - AuditLog.Read.All                → último inicio de sesión y registro de MFA
//   - RoleManagement.Read.Directory    → quién tiene roles de administrador
// El último inicio de sesión y el registro de MFA requieren licencia Entra ID P1 o P2
// (incluida en Microsoft 365 Business Premium / E3 / E5). Si no está, esa parte se muestra como "no disponible".
import "server-only";
import { token } from "./entra";

export type UsuarioIdentidad = {
  id: string;
  nombre: string;
  upn: string;
  email: string | null;
  area: string | null;
  habilitado: boolean;
  invitado: boolean;
  estado_invitacion: string | null; // PendingAcceptance | Accepted
  creado: string | null;
  ultimo_ingreso: string | null;    // interactivo o no interactivo, el más reciente
  mfa: boolean | null;              // null = no se pudo consultar
  metodos: string[];
  roles: string[];
};

export type ResultadoIdentidad = {
  usuarios: UsuarioIdentidad[];
  avisos: string[];                 // qué partes no se pudieron leer y por qué
  disponibles: { ingresos: boolean; mfa: boolean; roles: boolean };
  consultado: string;
};


class ErrorGraph extends Error {
  constructor(public status: number, public codigo: string, mensaje: string) { super(mensaje); }
}

async function paginar<T>(t: string, url: string): Promise<T[]> {
  const out: T[] = [];
  let siguiente: string | null = url;
  while (siguiente) {
    const r: Response = await fetch(siguiente, { headers: { Authorization: `Bearer ${t}`, ConsistencyLevel: "eventual" }, cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new ErrorGraph(r.status, j.error?.code ?? "", j.error?.message ?? `HTTP ${r.status}`);
    out.push(...(j.value ?? []));
    siguiente = j["@odata.nextLink"] ?? null;
  }
  return out;
}

function explicar(e: unknown, parte: string, permiso: string) {
  if (e instanceof ErrorGraph) {
    const licencia = /premium|license|licen|P1|P2|B2C|tenant is not/i.test(e.message);
    if (licencia) return `${parte}: requiere licencia Entra ID P1 o P2 en el tenant.`;
    if (e.status === 403 || e.status === 401) return `${parte}: a la app de Entra le falta el permiso ${permiso} (de aplicación, con consentimiento de administrador).`;
    return `${parte}: ${e.message}`;
  }
  return `${parte}: ${(e as Error)?.message ?? "error desconocido"}`;
}

export async function leerIdentidad(): Promise<ResultadoIdentidad> {
  const t = await token();
  const avisos: string[] = [];
  const base = "id,displayName,userPrincipalName,mail,department,accountEnabled,userType,createdDateTime,externalUserState";

  // 1) Usuarios (con último inicio de sesión si hay licencia y permiso)
  let crudos: any[];
  let ingresos = true;
  try {
    crudos = await paginar(t, `https://graph.microsoft.com/v1.0/users?$select=${base},signInActivity&$top=999`);
  } catch (e) {
    ingresos = false;
    avisos.push(explicar(e, "Último inicio de sesión", "AuditLog.Read.All"));
    crudos = await paginar(t, `https://graph.microsoft.com/v1.0/users?$select=${base}&$top=999`);
  }

  // 2) Registro de MFA
  const mfaPorId = new Map<string, { mfa: boolean; metodos: string[] }>();
  let mfa = true;
  try {
    const reg = await paginar<any>(t, "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails?$top=999");
    for (const r of reg) mfaPorId.set(r.id, { mfa: !!r.isMfaRegistered, metodos: r.methodsRegistered ?? [] });
  } catch (e) {
    mfa = false;
    avisos.push(explicar(e, "Registro de MFA", "AuditLog.Read.All"));
  }

  // 3) Roles de directorio activos y sus miembros
  const rolesPorId = new Map<string, string[]>();
  let roles = true;
  try {
    const rs = await paginar<any>(t, "https://graph.microsoft.com/v1.0/directoryRoles?$expand=members($select=id)");
    for (const r of rs) for (const m of r.members ?? []) {
      rolesPorId.set(m.id, [...(rolesPorId.get(m.id) ?? []), r.displayName]);
    }
  } catch (e) {
    roles = false;
    avisos.push(explicar(e, "Roles de administrador", "RoleManagement.Read.Directory"));
  }

  const usuarios: UsuarioIdentidad[] = crudos.map((u) => {
    const s = u.signInActivity ?? {};
    const fechas = [s.lastSignInDateTime, s.lastNonInteractiveSignInDateTime, s.lastSuccessfulSignInDateTime].filter(Boolean).sort();
    const m = mfaPorId.get(u.id);
    return {
      id: u.id,
      nombre: u.displayName ?? u.userPrincipalName,
      upn: u.userPrincipalName,
      email: u.mail ?? null,
      area: u.department ?? null,
      habilitado: !!u.accountEnabled,
      invitado: u.userType === "Guest",
      estado_invitacion: u.externalUserState ?? null,
      creado: u.createdDateTime ?? null,
      ultimo_ingreso: fechas.length ? fechas[fechas.length - 1] : null,
      mfa: mfa ? (m ? m.mfa : false) : null,
      metodos: m?.metodos ?? [],
      roles: rolesPorId.get(u.id) ?? [],
    };
  });

  return { usuarios, avisos, disponibles: { ingresos, mfa, roles }, consultado: new Date().toISOString() };
}

// Hallazgos a partir de la lista, con los criterios configurables
export function resumirIdentidad(r: ResultadoIdentidad, diasInactivo = 90) {
  const limite = Date.now() - diasInactivo * 86400000;
  const miembros = r.usuarios.filter((u) => !u.invitado && u.habilitado);
  const inactivo = (u: UsuarioIdentidad) =>
    r.disponibles.ingresos && (u.ultimo_ingreso ? Date.parse(u.ultimo_ingreso) < limite : (u.creado ? Date.parse(u.creado) < limite : true));
  return {
    miembros: miembros.length,
    sin_mfa: r.disponibles.mfa ? miembros.filter((u) => u.mfa === false).length : null,
    inactivos: r.disponibles.ingresos ? r.usuarios.filter((u) => u.habilitado && inactivo(u)).length : null,
    admins: r.disponibles.roles ? r.usuarios.filter((u) => u.roles.length).length : null,
    admins_sin_mfa: r.disponibles.roles && r.disponibles.mfa ? r.usuarios.filter((u) => u.roles.length && u.mfa === false).length : null,
    invitados: r.usuarios.filter((u) => u.invitado && u.habilitado).length,
    invitados_pendientes: r.usuarios.filter((u) => u.invitado && u.habilitado && u.estado_invitacion === "PendingAcceptance").length,
    esInactivo: inactivo,
  };
}

// Estado de una sola cuenta (para el checklist de baja)
export async function leerCuenta(email: string) {
  const t = await token();
  const h = { Authorization: `Bearer ${t}` };
  const get = async (url: string) => {
    const r = await fetch(url, { headers: h, cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new ErrorGraph(r.status, j.error?.code ?? "", j.error?.message ?? `HTTP ${r.status}`);
    return j;
  };
  const avisos: string[] = [];
  const base = "id,displayName,userPrincipalName,accountEnabled,userType";
  const filtro = encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}' or userPrincipalName eq '${email.replace(/'/g, "''")}'`);
  let u: any;
  let conIngresos = true;
  try {
    u = (await get(`https://graph.microsoft.com/v1.0/users?$filter=${filtro}&$select=${base},signInActivity`)).value?.[0];
  } catch (e) {
    conIngresos = false;
    avisos.push(explicar(e, "Último inicio de sesión", "AuditLog.Read.All"));
    u = (await get(`https://graph.microsoft.com/v1.0/users?$filter=${filtro}&$select=${base}`)).value?.[0];
  }
  if (!u) return { encontrada: false as const, avisos };

  let mfa: { registrado: boolean; metodos: string[] } | null = null;
  try {
    const r = await get(`https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails/${u.id}`);
    mfa = { registrado: !!r.isMfaRegistered, metodos: r.methodsRegistered ?? [] };
  } catch (e) { avisos.push(explicar(e, "Registro de MFA", "AuditLog.Read.All")); }

  let roles: string[] | null = null;
  try {
    const r = await paginar<any>(t, `https://graph.microsoft.com/v1.0/users/${u.id}/memberOf/microsoft.graph.directoryRole?$select=displayName`);
    roles = r.map((x) => x.displayName);
  } catch (e) { avisos.push(explicar(e, "Roles de administrador", "RoleManagement.Read.Directory")); }

  const s = u.signInActivity ?? {};
  const fechas = [s.lastSignInDateTime, s.lastNonInteractiveSignInDateTime].filter(Boolean).sort();
  return {
    encontrada: true as const,
    avisos,
    nombre: u.displayName as string,
    upn: u.userPrincipalName as string,
    habilitada: !!u.accountEnabled,
    ultimo_ingreso: (fechas.length ? fechas[fechas.length - 1] : null) as string | null,
    ingresos_disponible: conIngresos,
    mfa,
    roles,
  };
}
