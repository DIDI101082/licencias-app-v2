// Solo servidor: lee los usuarios de Entra ID con Microsoft Graph.
// Requiere una app registrada en Entra con el permiso de aplicación User.Read.All
// y estas variables en Vercel: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET.
// Opcional: ENTRA_DOMINIOS=accusys.com.ar (separados por coma) para tomar solo esos dominios.
import "server-only";
import type { EmpleadoFuente } from "./empleados-sync";

export function entraConfigurado() {
  return !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);
}

async function token() {
  const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AZURE_CLIENT_ID!,
      client_secret: process.env.AZURE_CLIENT_SECRET!,
      scope: "https://graph.microsoft.com/.default",
    }),
    cache: "no-store",
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Entra ID rechazó las credenciales: ${j.error_description?.split("\r\n")[0] ?? j.error ?? r.status}`);
  return j.access_token as string;
}

type UsuarioGraph = {
  id: string; givenName: string | null; surname: string | null; displayName: string | null;
  mail: string | null; userPrincipalName: string; department: string | null; jobTitle: string | null;
  accountEnabled: boolean; userType: string | null;
};

export type Descartes = { invitados: number; sinMail: number; sinArea: number; otroDominio: number };

export async function leerUsuariosEntra(opciones: { requerirArea: boolean }) {
  const t = await token();
  const campos = "id,givenName,surname,displayName,mail,userPrincipalName,department,jobTitle,accountEnabled,userType";
  let url: string | null = `https://graph.microsoft.com/v1.0/users?$select=${campos}&$top=999`;
  const todos: UsuarioGraph[] = [];
  while (url) {
    const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
    const j: any = await r.json();
    if (!r.ok) {
      const msg = j.error?.message ?? r.status;
      throw new Error(r.status === 403
        ? "La app de Entra no tiene permiso para leer usuarios. Revisá que tenga User.Read.All (de aplicación) con consentimiento de administrador."
        : `Error de Microsoft Graph: ${msg}`);
    }
    todos.push(...j.value);
    url = j["@odata.nextLink"] ?? null;
  }

  const dominios = (process.env.ENTRA_DOMINIOS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const descartes: Descartes = { invitados: 0, sinMail: 0, sinArea: 0, otroDominio: 0 };
  const usuarios: EmpleadoFuente[] = [];

  for (const u of todos) {
    if (u.userType && u.userType !== "Member") { descartes.invitados++; continue; }
    const email = (u.mail || (u.userPrincipalName.includes("#EXT#") ? "" : u.userPrincipalName)).toLowerCase();
    if (!email) { descartes.sinMail++; continue; }
    if (dominios.length && !dominios.includes(email.split("@")[1])) { descartes.otroDominio++; continue; }
    if (opciones.requerirArea && !u.department?.trim()) { descartes.sinArea++; continue; }

    const partes = (u.displayName ?? "").trim().split(/\s+/);
    usuarios.push({
      entra_id: u.id,
      nombre: u.givenName?.trim() || partes[0] || email.split("@")[0],
      apellido: u.surname?.trim() || partes.slice(1).join(" ") || "-",
      email,
      area: u.department?.trim() || "Sin área",
      puesto: u.jobTitle?.trim() || null,
      activo: u.accountEnabled,
    });
  }
  return { usuarios, descartes, total: todos.length };
}
