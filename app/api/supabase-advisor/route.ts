import { NextResponse } from "next/server";
import { getPerfil } from "@/lib/supabase/server";

function extraerIssues(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    // La API puede devolver { checks: [...] }, { results: [...] }, { data: [...] }, etc.
    const posibles = ["checks", "results", "data", "issues", "lint"];
    for (const k of posibles) {
      if (Array.isArray(raw[k])) return raw[k];
    }
  }
  return [];
}

export async function GET() {
  try {
    const { perfil } = await getPerfil();
    if (!perfil) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

    const token = process.env.SUPABASE_MGMT_TOKEN;
    if (!token) return NextResponse.json({ error: "SUPABASE_MGMT_TOKEN no configurado" }, { status: 500 });

    const projectsRes = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    if (!projectsRes.ok) {
      const body = await projectsRes.text().catch(() => "");
      return NextResponse.json(
        { error: `Error Supabase API (${projectsRes.status}): ${body.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const projects: any[] = await projectsRes.json();

    const results = await Promise.all(
      projects.map(async (p) => {
        try {
          const res = await fetch(
            `https://api.supabase.com/v1/projects/${p.id}/advisors/security`,
            { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
          );
          const raw = res.ok ? await res.json() : [];
          const issues = extraerIssues(raw);
          return { project: { id: p.id, name: p.name, region: p.region, status: p.status }, issues };
        } catch {
          return { project: { id: p.id, name: p.name, region: p.region, status: p.status }, issues: [], error: true };
        }
      })
    );

    results.sort((a, b) => {
      const criticos = (r: any) =>
        Array.isArray(r.issues) ? r.issues.filter((i: any) => i.level === "ERROR").length : 0;
      return criticos(b) - criticos(a);
    });

    return NextResponse.json(results);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Error interno: ${e?.message ?? "desconocido"}` },
      { status: 500 }
    );
  }
}
