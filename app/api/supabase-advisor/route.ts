import { NextResponse } from "next/server";
import { getPerfil } from "@/lib/supabase/server";

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
          const issues: any[] = res.ok ? await res.json() : [];
          return { project: { id: p.id, name: p.name, region: p.region, status: p.status }, issues };
        } catch {
          return { project: { id: p.id, name: p.name, region: p.region, status: p.status }, issues: [], error: true };
        }
      })
    );

    results.sort((a, b) => {
      const criticos = (r: any) => r.issues.filter((i: any) => i.level === "ERROR").length;
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
