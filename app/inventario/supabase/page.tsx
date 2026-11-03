"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, RefreshCw, ExternalLink, Database, ChevronDown, ChevronRight } from "lucide-react";

type Project = { id: string; name: string; region: string; status: string };
type Issue = {
  name: string;
  title: string;
  level: string; // ERROR | WARN | INFO
  facing?: string;
  categories?: string[];
  description?: string;
  detail?: string;
  remediation?: string;
  metadata?: Record<string, any>;
};
type Result = { project: Project; issues: Issue[]; error?: boolean };

const LEVEL_CFG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  ERROR:   { label: "Crítico", color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.25)" },
  WARN:    { label: "Advertencia", color: "#facc15", bg: "rgba(250,204,21,0.08)", border: "rgba(250,204,21,0.25)" },
  INFO:    { label: "Info", color: "#60a5fa", bg: "rgba(96,165,250,0.08)", border: "rgba(96,165,250,0.2)" },
};

function nivelNumero(level: string) {
  return level === "ERROR" ? 0 : level === "WARN" ? 1 : 2;
}

export default function SupabaseSaludPage() {
  const [data, setData] = useState<Result[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());

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
      // Abrir automáticamente los proyectos con issues
      const conIssues = new Set(json.filter((r) => r.issues.length > 0).map((r) => r.project.id));
      setAbiertos(conIssues);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { cargar(); }, []);

  const toggleAbierto = (id: string) => {
    setAbiertos((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const totalIssues = data?.reduce((acc, r) => acc + r.issues.length, 0) ?? 0;
  const totalCriticos = data?.reduce((acc, r) => acc + r.issues.filter((i) => i.level === "ERROR").length, 0) ?? 0;
  const proyectosLimpios = data?.filter((r) => r.issues.length === 0).length ?? 0;

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif", color: "#e2e8f0", maxWidth: 900 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <Database size={20} style={{ color: "#38bdf8" }} />
            Salud de Supabase
          </h1>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,.35)", margin: 0 }}>
            Security Advisor de todos los proyectos de la organización
            {lastUpdate && <> · Actualizado {lastUpdate.toLocaleTimeString("es-AR")}</>}
          </p>
        </div>
        <button
          onClick={cargar}
          disabled={loading}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px",
            background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 8, color: "rgba(255,255,255,.7)", fontSize: 13, cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          <RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {error && (
        <div style={{ padding: "12px 16px", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 10, marginBottom: 20, fontSize: 13, color: "#f87171" }}>
          ⚠ {error}
          {error.includes("SUPABASE_MGMT_TOKEN") && (
            <span style={{ display: "block", marginTop: 4, color: "rgba(255,255,255,.4)" }}>
              Agregá <code>SUPABASE_MGMT_TOKEN=sbp_...</code> en las variables de entorno de Vercel.
            </span>
          )}
        </div>
      )}

      {/* Stats */}
      {data && (
        <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { num: data.length, lbl: "Proyectos", color: "rgba(255,255,255,.8)" },
            { num: totalCriticos, lbl: "Críticos", color: totalCriticos > 0 ? "#f87171" : "#4ade80" },
            { num: totalIssues, lbl: "Issues totales", color: totalIssues > 0 ? "#facc15" : "#4ade80" },
            { num: proyectosLimpios, lbl: "Sin issues", color: "#4ade80" },
          ].map(({ num, lbl, color }) => (
            <div key={lbl} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "12px 18px", minWidth: 90 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color, margin: "0 0 2px" }}>{num}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>{lbl}</div>
            </div>
          ))}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ height: 56, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
          <style>{`@keyframes pulse { 0%,100%{opacity:.6}50%{opacity:1} }`}</style>
        </div>
      )}

      {/* Project list */}
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.map(({ project, issues, error: projError }) => {
            const abierto = abiertos.has(project.id);
            const criticos = issues.filter((i) => i.level === "ERROR").length;
            const warns = issues.filter((i) => i.level === "WARN").length;
            const sorted = [...issues].sort((a, b) => nivelNumero(a.level) - nivelNumero(b.level));

            return (
              <div key={project.id} style={{
                background: "rgba(255,255,255,.04)", border: `1px solid ${issues.length === 0 ? "rgba(255,255,255,.07)" : criticos > 0 ? "rgba(248,113,113,0.2)" : "rgba(250,204,21,0.2)"}`,
                borderRadius: 10, overflow: "hidden",
              }}>
                {/* Row header */}
                <div
                  onClick={() => toggleAbierto(project.id)}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", cursor: "pointer", userSelect: "none" }}
                >
                  {abierto ? <ChevronDown size={14} style={{ color: "rgba(255,255,255,.3)", flexShrink: 0 }} /> : <ChevronRight size={14} style={{ color: "rgba(255,255,255,.3)", flexShrink: 0 }} />}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,.85)" }}>{project.name}</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)" }}>{project.id} · {project.region}</div>
                  </div>

                  {projError && <span style={{ fontSize: 11, color: "#f87171" }}>Error al cargar</span>}

                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    {issues.length === 0 ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "#4ade80" }}>
                        <CheckCircle size={12} /> Sin issues
                      </span>
                    ) : (
                      <>
                        {criticos > 0 && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 5, background: "rgba(248,113,113,0.15)", color: "#f87171" }}>
                            {criticos} crítico{criticos !== 1 ? "s" : ""}
                          </span>
                        )}
                        {warns > 0 && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 5, background: "rgba(250,204,21,0.12)", color: "#facc15" }}>
                            {warns} advertencia{warns !== 1 ? "s" : ""}
                          </span>
                        )}
                      </>
                    )}
                    <a
                      href={`https://supabase.com/dashboard/project/${project.id}/advisors/security`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: "rgba(255,255,255,.25)", display: "inline-flex", padding: 2 }}
                      title="Ver en Supabase"
                    >
                      <ExternalLink size={13} />
                    </a>
                  </div>
                </div>

                {/* Issues detail */}
                {abierto && issues.length > 0 && (
                  <div style={{ borderTop: "1px solid rgba(255,255,255,.06)", padding: "10px 16px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {sorted.map((issue, idx) => {
                      const cfg = LEVEL_CFG[issue.level] ?? LEVEL_CFG.INFO;
                      return (
                        <div key={idx} style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 8, padding: "10px 12px" }}>
                          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: issue.detail ? 6 : 0 }}>
                            <div>
                              <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color, marginRight: 8 }}>{cfg.label}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,.8)" }}>{issue.title}</span>
                            </div>
                          </div>
                          {issue.detail && (
                            <p style={{ margin: "4px 0 0", fontSize: 12, color: "rgba(255,255,255,.45)", lineHeight: 1.5 }}>{issue.detail}</p>
                          )}
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
