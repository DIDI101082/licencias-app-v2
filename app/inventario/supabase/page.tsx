"use client";

import { useEffect, useState } from "react";

type Project = { id: string; name: string; region: string; status: string };
type Issue = {
  name: string;
  title: string;
  level: string;
  detail?: string;
  remediation?: string;
  metadata?: Record<string, any>;
};
type Result = { project: Project; issues: Issue[]; error?: boolean };

const LEVEL_CFG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  ERROR: { label: "Crítico",     color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.25)" },
  WARN:  { label: "Advertencia", color: "#facc15", bg: "rgba(250,204,21,0.08)",  border: "rgba(250,204,21,0.25)"  },
  INFO:  { label: "Info",        color: "#60a5fa", bg: "rgba(96,165,250,0.08)",  border: "rgba(96,165,250,0.2)"   },
};

function nivelNum(level: string) { return level === "ERROR" ? 0 : level === "WARN" ? 1 : 2; }

const IcoRefresh = ({ spin }: { spin: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    style={{ flexShrink: 0, animation: spin ? "spin 1s linear infinite" : "none" }}>
    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);
const IcoCheck = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}>
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const IcoExternal = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);
const IcoDown = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);
const IcoRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

export default function SupabaseSaludPage() {
  const [data, setData]             = useState<Result[] | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [abiertos, setAbiertos]     = useState<Set<string>>(new Set());

  const cargar = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/supabase-advisor");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Error al cargar");
      }
      const json: Result[] = await res.json();
      setData(json);
      setLastUpdate(new Date());
      setAbiertos(new Set(json.filter((r) => r.issues.length > 0).map((r) => r.project.id)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { cargar(); }, []);

  const toggle = (id: string) => setAbiertos((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const totalIssues   = data?.reduce((a, r) => a + r.issues.length, 0) ?? 0;
  const totalCriticos = data?.reduce((a, r) => a + r.issues.filter((i) => i.level === "ERROR").length, 0) ?? 0;
  const limpios       = data?.filter((r) => r.issues.length === 0).length ?? 0;

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif", color: "#e2e8f0", maxWidth: 900 }}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:.6}50%{opacity:1}}`}</style>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px" }}>Salud de Supabase</h1>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,.35)", margin: 0 }}>
            Security Advisor · todos los proyectos
            {lastUpdate && <> · Actualizado {lastUpdate.toLocaleTimeString("es-AR")}</>}
          </p>
        </div>
        <button onClick={cargar} disabled={loading} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px",
          background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)",
          borderRadius: 8, color: "rgba(255,255,255,.7)", fontSize: 13,
          cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1,
        }}>
          <IcoRefresh spin={loading} />
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 10, marginBottom: 20, fontSize: 13, color: "#f87171" }}>
          ⚠ {error}
          {error.includes("SUPABASE_MGMT_TOKEN") && (
            <span style={{ display: "block", marginTop: 4, color: "rgba(255,255,255,.4)" }}>
              Agregá <code>SUPABASE_MGMT_TOKEN</code> en las variables de entorno de Vercel.
            </span>
          )}
        </div>
      )}

      {data && (
        <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { num: data.length,   lbl: "Proyectos",     color: "rgba(255,255,255,.8)" },
            { num: totalCriticos, lbl: "Críticos",       color: totalCriticos > 0 ? "#f87171" : "#4ade80" },
            { num: totalIssues,   lbl: "Issues totales", color: totalIssues   > 0 ? "#facc15" : "#4ade80" },
            { num: limpios,       lbl: "Sin issues",     color: "#4ade80" },
          ].map(({ num, lbl, color }) => (
            <div key={lbl} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "12px 18px", minWidth: 90 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color, margin: "0 0 2px" }}>{num}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>{lbl}</div>
            </div>
          ))}
        </div>
      )}

      {loading && !data && [1,2,3].map((i) => (
        <div key={i} style={{ height: 56, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, marginBottom: 8, animation: "pulse 1.5s ease-in-out infinite" }} />
      ))}

      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.map(({ project, issues, error: projError }) => {
            const abierto  = abiertos.has(project.id);
            const criticos = issues.filter((i) => i.level === "ERROR").length;
            const warns    = issues.filter((i) => i.level === "WARN").length;
            const sorted   = [...issues].sort((a, b) => nivelNum(a.level) - nivelNum(b.level));
            const bc       = issues.length === 0 ? "rgba(255,255,255,.07)" : criticos > 0 ? "rgba(248,113,113,0.2)" : "rgba(250,204,21,0.2)";

            return (
              <div key={project.id} style={{ background: "rgba(255,255,255,.04)", border: `1px solid ${bc}`, borderRadius: 10, overflow: "hidden" }}>
                <div onClick={() => toggle(project.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", cursor: "pointer", userSelect: "none" }}>
                  <span style={{ color: "rgba(255,255,255,.3)" }}>{abierto ? <IcoDown /> : <IcoRight />}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,.85)" }}>{project.name}</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)" }}>{project.id} · {project.region}</div>
                  </div>
                  {projError && <span style={{ fontSize: 11, color: "#f87171" }}>Error al cargar</span>}
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    {issues.length === 0 ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "#4ade80" }}>
                        <IcoCheck /> Sin issues
                      </span>
                    ) : (
                      <>
                        {criticos > 0 && <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 5, background: "rgba(248,113,113,0.15)", color: "#f87171" }}>{criticos} crítico{criticos !== 1 ? "s" : ""}</span>}
                        {warns    > 0 && <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 5, background: "rgba(250,204,21,0.12)",   color: "#facc15" }}>{warns} advertencia{warns !== 1 ? "s" : ""}</span>}
                      </>
                    )}
                    <a href={`https://supabase.com/dashboard/project/${project.id}/advisors/security`}
                      target="_blank" rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: "rgba(255,255,255,.25)", display: "inline-flex", padding: 2 }}
                      title="Ver en Supabase">
                      <IcoExternal />
                    </a>
                  </div>
                </div>

                {abierto && issues.length > 0 && (
                  <div style={{ borderTop: "1px solid rgba(255,255,255,.06)", padding: "10px 16px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {sorted.map((issue, idx) => {
                      const cfg = LEVEL_CFG[issue.level] ?? LEVEL_CFG.INFO;
                      return (
                        <div key={idx} style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 8, padding: "10px 12px" }}>
                          <div>
                            <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color, marginRight: 8 }}>{cfg.label}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,.8)" }}>{issue.title}</span>
                          </div>
                          {issue.detail && <p style={{ margin: "4px 0 0", fontSize: 12, color: "rgba(255,255,255,.45)", lineHeight: 1.5 }}>{issue.detail}</p>}
                          {issue.remediation && (
                            <p style={{ margin: "6px 0 0", fontSize: 12, color: "rgba(255,255,255,.35)", lineHeight: 1.5 }}>
                              <strong style={{ color: "rgba(255,255,255,.5)" }}>Solución:</strong> {issue.remediation}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {abierto && issues.length === 0 && (
                  <div style={{ borderTop: "1px solid rgba(255,255,255,.06)", padding: "14px 16px", fontSize: 13, color: "rgba(255,255,255,.3)", textAlign: "center" }}>
                    ✓ Este proyecto no tiene issues de seguridad
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
