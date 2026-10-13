// Solo servidor: lee la auditoría de Entra ID para saber qué aplicaciones se borraron,
// deshabilitaron, reactivaron o restauraron, quién lo hizo y desde dónde.
// Requiere el permiso de aplicación AuditLog.Read.All (el mismo que ya usa la sincronización de empleados).
// Entra conserva la auditoría 30 días (7 sin licencia P1/P2): por eso la tarea de cada 15 minutos
// la va guardando en Supabase (supabase/entra-apps-cambios.sql).
import "server-only";
import { token } from "./entra";

export type AccionApp = "borrada" | "borrada_definitiva" | "deshabilitada" | "reactivada" | "restaurada";

export type CambioApp = {
  evento_id: string;        // id del registro de auditoría (evita duplicados)
  fecha: string;
  accion: AccionApp;
  objeto: "registro" | "empresarial";   // registro de aplicación o aplicación empresarial (service principal)
  objeto_id: string | null;
  app_id: string | null;
  aplicacion: string;
  actor: string;
  ip: string | null;
};

function accionDe(r: any): AccionApp | null {
  switch (r.activityDisplayName) {
    case "Delete application":
    case "Delete service principal":
      return "borrada";
    case "Hard Delete application":
    case "Hard delete application":
    case "Hard Delete service principal":
    case "Hard delete service principal":
      return "borrada_definitiva";
    case "Restore application":
    case "Restore service principal":
      return "restaurada";
    case "Update service principal":
    case "Update application": {
      // Deshabilitar el inicio de sesión llega como un cambio de la propiedad AccountEnabled
      const props = (r.targetResources ?? []).flatMap((t: any) => t.modifiedProperties ?? []);
      const p = props.find((x: any) => x.displayName === "AccountEnabled");
      if (!p) return null;
      if (/false/i.test(p.newValue ?? "")) return "deshabilitada";
      if (/true/i.test(p.newValue ?? "")) return "reactivada";
      return null;
    }
    default:
      return null;
  }
}

const limpiar = (v: unknown) => (v == null ? null : String(v).replace(/^\[?"?|"?\]?$/g, "").trim() || null);

export async function leerCambiosAppsEntra(desde: Date): Promise<CambioApp[]> {
  const t = await token();
  const filtro = `category eq 'ApplicationManagement' and activityDateTime ge ${desde.toISOString()}`;
  let url: string | null = `https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$filter=${encodeURIComponent(filtro)}&$top=500`;
  const salida: CambioApp[] = [];
  let paginas = 0;

  while (url && paginas < 10) {
    paginas++;
    const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store", signal: AbortSignal.timeout(25000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(r.status === 403
        ? "Falta el permiso AuditLog.Read.All (de aplicación, con consentimiento de administrador) para leer los cambios de aplicaciones."
        : `Auditoría de aplicaciones: ${j.error?.message ?? r.status}`);
    }
    for (const x of j.value ?? []) {
      if (x.result && x.result !== "success") continue;
      const accion = accionDe(x);
      if (!accion) continue;
      const destino = (x.targetResources ?? []).find((z: any) => /Application|ServicePrincipal/i.test(z.type ?? "")) ?? x.targetResources?.[0];
      const props = (x.targetResources ?? []).flatMap((z: any) => z.modifiedProperties ?? []);
      const appId = limpiar(props.find((p: any) => /^AppId$/i.test(p.displayName))?.newValue ?? props.find((p: any) => /^AppId$/i.test(p.displayName))?.oldValue);
      const u = x.initiatedBy?.user;
      const app = x.initiatedBy?.app;
      salida.push({
        evento_id: String(x.id),
        fecha: x.activityDateTime,
        accion,
        objeto: /service\s*principal/i.test(x.activityDisplayName) || /ServicePrincipal/i.test(destino?.type ?? "") ? "empresarial" : "registro",
        objeto_id: destino?.id ?? null,
        app_id: appId,
        aplicacion: destino?.displayName || appId || destino?.id || "Sin nombre",
        actor: u?.userPrincipalName || u?.displayName || (app?.displayName ? `App: ${app.displayName}` : "") || "Desconocido",
        ip: u?.ipAddress || null,
      });
    }
    url = j["@odata.nextLink"] ?? null;
  }
  return salida.sort((a, b) => a.fecha.localeCompare(b.fecha));
}
