// Solo servidor: Secure Score de Microsoft 365 con Microsoft Graph.
// Usa la misma app de Entra que la sincronización (AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET)
// y necesita además el permiso de aplicación SecurityEvents.Read.All con consentimiento de administrador.
import "server-only";
import { token } from "./entra";

async function paginar(t: string, url: string, max = 2000) {
  const todos: any[] = [];
  let u: string | null = url;
  while (u && todos.length < max) {
    const r: Response = await fetch(u, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store", signal: AbortSignal.timeout(25000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        throw new Error("A la app de Entra le falta el permiso SecurityEvents.Read.All (de aplicación, con consentimiento de administrador).");
      }
      throw new Error(`Microsoft Graph respondió ${r.status}: ${j.error?.message ?? ""}`.trim());
    }
    todos.push(...(j.value ?? []));
    u = j["@odata.nextLink"] ?? null;
  }
  return todos;
}

const n = (v: any) => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : null);

export async function leerSecureScore() {
  const t = await token();
  const [puntajes, perfiles] = await Promise.all([
    paginar(t, "https://graph.microsoft.com/v1.0/security/secureScores?$top=90", 90),
    paginar(t, "https://graph.microsoft.com/v1.0/security/secureScoreControlProfiles?$top=500"),
  ]);
  if (!puntajes.length) throw new Error("Microsoft todavía no calculó el Secure Score de este tenant.");

  const historial = puntajes.map((p) => ({
    fecha: String(p.createdDateTime ?? "").slice(0, 10),
    actual: n(p.currentScore), maximo: n(p.maxScore),
    promedio: n((p.averageComparativeScores ?? []).find((a: any) => a.basis === "AllTenants")?.averageScore),
  })).filter((h) => h.fecha);

  const ultimo = [...puntajes].sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)))[0];
  const perfil = new Map<string, any>(perfiles.filter((p) => !p.deprecated).map((p) => [String(p.id), p]));
  const categorias = new Map<string, { actual: number; maximo: number }>();
  const acciones = [];
  for (const c of ultimo.controlScores ?? []) {
    const p = perfil.get(String(c.controlName));
    if (!p) continue;
    const max = Number(p.maxScore) || 0;
    const pts = Number(c.score) || 0;
    const cat = String(c.controlCategory ?? p.controlCategory ?? "Otros");
    const acc = categorias.get(cat) ?? { actual: 0, maximo: 0 };
    acc.actual += pts; acc.maximo += max; categorias.set(cat, acc);
    acciones.push({
      control: String(c.controlName), titulo: p.title ?? c.controlName, categoria: cat, servicio: p.service ?? null,
      puntaje: n(pts), maximo: n(max), estado: max > 0 && pts >= max ? "completo" : pts > 0 ? "parcial" : "pendiente",
      costo: p.implementationCost ?? null, impacto: p.userImpact ?? null, rango: typeof p.rank === "number" ? p.rank : null,
      enlace: typeof p.actionUrl === "string" && p.actionUrl.startsWith("https://") ? p.actionUrl : null,
    });
  }
  return {
    historial,
    categorias: Array.from(categorias, ([categoria, v]) => ({ categoria, actual: n(v.actual), maximo: n(v.maximo) })),
    acciones,
  };
}
