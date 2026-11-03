import { NextResponse } from "next/server";
import { getPerfil } from "@/lib/supabase/server";

export async function GET() {
  // Solo admins o usuarios autenticados
  const { perfil } = await getPerfil();
  if (!perfil) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const token = process.env.SUPABASE_MGMT_TOKEN;
  if (!token) return NextResponse.json({ error: "SUPABASE_MGMT_TOKEN no configurado" }, { status: 500 });

  // 1. Listar todos los proyectos
  const projectsRes = await fetch("https://api.supabase.com/v1/projects", {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 0 },
  });

  if (!projectsRes.ok) {
    return NextResponse.json({ error: "Error al obtener proyectos de Supabase" }, { status: 502 });
  }

  const projects: any[] = await projectsRes.json();

  // 2. Para cada proyecto, obtener issues de seguridad en paralelo
  const results = await Promise.all(
    projects.map(async (p) => {
      try {
        const res = await fetch(
          `https://api.supabase.com/v1/projects/${p.id}/advisors/security`,
          { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 0 } }
        );
        const issues: any[] = res.ok ? await res.json() : [];
        return {
          project: { id: p.id, name: p.name, region: p.region, status: p.status },
          issues,
        };
      } catch {
        return {
          project: { id: p.id, name: p.name, region: p.region, status: p.status },
          issues: [],
          error: true,
        };
      }
    })
  );

  // Ordenar: proyectos con más issues críticos primero
  results.sort((a, b) => {
    const criticos = (r: any) => r.issues.filter((i: any) => i.level === "ERROR").length;
    return criticos(b) - criticos(a);
  });

  return NextResponse.json(results);
}
