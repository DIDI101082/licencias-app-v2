// Solo servidor: registro de MFA de cada cuenta de Entra ID, para detectar quién se queda sin segundo factor.
// SOLO LECTURA (un GET a Microsoft Graph). Requiere AuditLog.Read.All y licencia Entra ID P1 o P2.
import "server-only";
import { token } from "./entra";

export type RegistroMfa = { id: string; upn: string; nombre: string; mfa: boolean; metodos: string[]; admin: boolean };

export async function leerRegistroMfa(): Promise<RegistroMfa[]> {
  const t = await token();
  const out: RegistroMfa[] = [];
  let url: string | null = "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails?$top=999";
  while (url) {
    const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = String(j.error?.message ?? r.status);
      throw new Error(/premium|licen|P1|P2/i.test(m) ? "El registro de MFA requiere licencia Entra ID P1 o P2."
        : r.status === 403 ? "A la app de Entra le falta el permiso AuditLog.Read.All para leer el registro de MFA."
        : `Error de Microsoft Graph: ${m}`);
    }
    for (const u of j.value ?? []) {
      if (String(u.userType ?? "").toLowerCase() === "guest") continue;   // los invitados validan MFA en su propia organización
      out.push({
        id: u.id, upn: String(u.userPrincipalName ?? "").toLowerCase(), nombre: u.userDisplayName ?? u.userPrincipalName ?? u.id,
        mfa: !!u.isMfaRegistered, metodos: u.methodsRegistered ?? [], admin: !!u.isAdmin,
      });
    }
    url = j["@odata.nextLink"] ?? null;
  }
  return out;
}
