import { NextResponse } from "next/server";
import { getPerfil } from "@/lib/supabase/server";

function extraerIssues(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const k of ["checks", "results", "data", "issues", "lint"]) {
      if (Array.isArray(raw[k])) return raw[k];
    }
  }
  return [];
}

async function fetchJson(url: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
        const base = `https://api.supabase.com/v1/projects/${p.id}`;

        const [securityRaw, performanceRaw, authRaw, networkRaw] = await Promise.all([
          fetchJson(`${base}/advisors/security`, token),
          fetchJson(`${base}/advisors/performance`, token),
          fetchJson(`${base}/config/auth`, token),
          fetchJson(`${base}/network-restrictions`, token),
        ]);

        const securityIssues = extraerIssues(securityRaw);
        const performanceIssues = extraerIssues(performanceRaw);

        const auth = authRaw
          ? {
              mfa_enabled: (authRaw.mfa_max_enrolled_factors ?? 0) > 0,
              signup_enabled: authRaw.enable_signup ?? true,
              jwt_exp: authRaw.jwt_exp ?? 3600,
              password_min_length: authRaw.password_min_length ?? 6,
              captcha_enabled: authRaw.security_captcha_enabled ?? false,
              require_reauth_to_update_password:
                authRaw.security_update_password_require_reauthentication ?? false,
            }
          : null;

        const network = networkRaw
          ? {
              restricted: networkRaw.allowed_ipv4_cidrs_enforced === true,
              cidrs: networkRaw.allowed_ipv4_cidrs ?? [],
            }
          : null;

        return {
          project: { id: p.id, name: p.name, region: p.region, status: p.status },
          securityIssues,
          performanceIssues,
          auth,
          network,
        };
      })
    );

    results.sort((a, b) => {
      const score = (r: any) => {
        const err = Array.isArray(r.securityIssues)
          ? r.securityIssues.filter((i: any) => i.level === "ERROR").length
          : 0;
        const warn = Array.isArray(r.securityIssues)
          ? r.securityIssues.filter((i: any) => i.level === "WARN").length
          : 0;
        return err * 10 + warn;
      };
      return score(b) - score(a);
    });

    return NextResponse.json(results);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Error interno: ${e?.message ?? "desconocido"}` },
      { status: 500 }
    );
  }
}
