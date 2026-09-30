// Solo servidor: lee los registros de auditoría de Entra ID para saber QUIÉN creó,
// deshabilitó, habilitó o eliminó cada cuenta.
// Requiere, además de User.Read.All, el permiso de aplicación AuditLog.Read.All
// (con consentimiento de administrador) en la misma app registrada en Entra.
import "server-only";
import { token } from "./entra";

export type EventoAuditoria = {
  entra_id: string;
  tipo: "alta" | "baja" | "reactivacion" | "eliminado";
  actor: string;
  sincronizacion: boolean; // el cambio lo hizo Entra Connect (la cuenta viene del AD local)
  fecha: string;
};

// Cuenta de servicio de Entra Connect / Cloud Sync
const ES_SYNC = /^(Sync_|ADToAADSyncServiceAccount)|Directory Synchroni[sz]ation|Entra Connect|AD Connect|Azure AD Cloud Sync/i;

function tipoDe(r: any): EventoAuditoria["tipo"] | null {
  switch (r.activityDisplayName) {
    case "Add user": return "alta";
    case "Disable account": return "baja";
    case "Enable account":
    case "Restore user": return "reactivacion";
    case "Delete user": return "eliminado";
    case "Update user": {
      // A veces la deshabilitación llega como "Update user" con la propiedad AccountEnabled
      const props = (r.targetResources ?? []).flatMap((t: any) => t.modifiedProperties ?? []);
      const p = props.find((x: any) => x.displayName === "AccountEnabled");
      if (!p) return null;
      if (/false/i.test(p.newValue ?? "")) return "baja";
      if (/true/i.test(p.newValue ?? "")) return "reactivacion";
      return null;
    }
    default: return null;
  }
}

export async function leerAuditoriaEntra(desde: Date): Promise<EventoAuditoria[]> {
  const t = await token();
  const filtro = `category eq 'UserManagement' and activityDateTime ge ${desde.toISOString()}`;
  let url: string | null = `https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$filter=${encodeURIComponent(filtro)}&$top=500`;
  const salida: EventoAuditoria[] = [];
  let paginas = 0;

  while (url && paginas < 10) {
    paginas++;
    const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(r.status === 403
        ? "Falta el permiso AuditLog.Read.All (de aplicación, con consentimiento de administrador) para saber quién hizo cada cambio."
        : `Auditoría de Entra: ${j.error?.message ?? r.status}`);
    }
    for (const x of j.value ?? []) {
      if (x.result && x.result !== "success") continue;
      const tipo = tipoDe(x);
      if (!tipo) continue;
      const destino = (x.targetResources ?? []).find((z: any) => z.type === "User");
      if (!destino?.id) continue;
      const u = x.initiatedBy?.user;
      const app = x.initiatedBy?.app;
      const actor: string = u?.userPrincipalName || u?.displayName || (app?.displayName ? `App: ${app.displayName}` : "") || "Desconocido";
      salida.push({
        entra_id: destino.id,
        tipo,
        actor,
        sincronizacion: ES_SYNC.test(u?.userPrincipalName ?? "") || ES_SYNC.test(u?.displayName ?? "") || ES_SYNC.test(app?.displayName ?? ""),
        fecha: x.activityDateTime,
      });
    }
    url = j["@odata.nextLink"] ?? null;
  }
  // Más viejo primero: así se completa primero el movimiento más antiguo de cada cuenta
  return salida.sort((a, b) => a.fecha.localeCompare(b.fecha));
}
