"use client";
import { useEffect, useState, useCallback } from "react";

type Proyecto = { id: string; name: string; region: string; status: string };
type Issue = { name: string; title: string; level: string; description?: string; detail?: string };
type Auth = {
  mfa_enabled: boolean;
  signup_enabled: boolean;
  jwt_exp: number;
  password_min_length: number;
  captcha_enabled: boolean;
  require_reauth_to_update_password: boolean;
} | null;
type Network = { restricted: boolean; cidrs: string[] } | null;
type ProyectoData = {
  project: Proyecto;
  securityIssues: Issue[];
  performanceIssues: Issue[];
  auth: Auth;
  network: Network;
};

function IcoRefresh({ spin }: { spin?: boolean }) {
  return (
    <svg className={`w-4 h-4 ${spin ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
    </svg>
  );
}
function IcoCheck() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}
function IcoX() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
function IcoChevron({ open }: { open: boolean }) {
  return (
    <svg className="w-3.5 h-3.5 ml-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {open ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
    </svg>
  );
}

function formatJwt(s: number) {
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
      ok
        ? "bg-emerald-950/50 text-emerald-400 border-emerald-800/40"
        : "bg-red-950/50 text-red-400 border-red-800/40"
    }`}>
      {ok ? <IcoCheck/> : <IcoX/>}
      {label}
    </span>
  );
}

function ChipNeutro({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-zinc-800/60 text-zinc-400 border-zinc-700/50">
      {label}
    </span>
  );
}

function SeccionExpandible({
  titulo,
  icono,
  count,
  countLabel,
  color,
  children,
}: {
  titulo: string;
  icono: React.ReactNode;
  count: number;
  countLabel: string;
  color: "red" | "amber" | "blue";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const colors = {
    red: "text-red-400",
    amber: "text-amber-400",
    blue: "text-blue-400",
  };
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-semibold text-zinc-400 uppercase tracking-wide w-full text-left hover:text-zinc-200 transition-colors py-1"
      >
        {icono}
        {titulo}
        <span className={`${colors[color]} font-medium`}>{count} {countLabel}</span>
        <IcoChevron open={open}/>
      </button>
      {open && <div className="mt-2 space-y-1">{children}</div>}
    </div>
  );
}

function IssueLine({ issue, color }: { issue: Issue; color: string }) {
  const styles: Record<string, string> = {
    red: "bg-red-950/30 border-red-800/30 text-red-300",
    amber: "bg-amber-950/30 border-amber-800/30 text-amber-300",
    blue: "bg-blue-950/20 border-blue-800/20 text-blue-300",
  };
  return (
    <div className={`text-xs px-3 py-2 rounded-lg border ${styles[color]}`}>
      <p className="font-medium">{issue.title || issue.name}</p>
      {issue.detail && (
        <p className="opacity-70 mt-0.5 leading-relaxed">
          {issue.detail.length > 140 ? issue.detail.slice(0, 140) + "…" : issue.detail}
        </p>
      )}
    </div>
  );
}

function ProyectoCard({ data }: { data: ProyectoData }) {
  const { project, securityIssues, performanceIssues, auth, network } = data;
  const errors = securityIssues.filter(i => i.level === "ERROR").length;
  const warnings = securityIssues.filter(i => i.level === "WARN").length;
  const isActive = ["ACTIVE_HEALTHY", "ACTIVE"].includes(project.status);

  const borderColor =
    errors > 0 ? "border-red-800/50" :
    warnings > 0 ? "border-amber-700/40" :
    "border-white/[0.08]";

  return (
    <div className={`rounded-xl border ${borderColor} bg-white/[0.025] overflow-hidden`}>
      {/* Header */}
      <div className="px-5 py-4 flex items-start justify-between gap-4 border-b border-white/[0.06]">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-white">{project.name}</h3>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${
              isActive
                ? "bg-emerald-950/60 text-emerald-400 border-emerald-800/40"
                : "bg-zinc-800/60 text-zinc-400 border-zinc-700"
            }`}>
              {isActive ? "activo" : project.status.toLowerCase().replace(/_/g, " ")}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">{project.region.replace(/-/g, " ")}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {errors > 0 && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-red-400 bg-red-950/40 border border-red-800/40 px-2.5 py-1 rounded-lg">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0"/>
              {errors} error{errors !== 1 ? "es" : ""}
            </span>
          )}
          {warnings > 0 && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-400 bg-amber-950/40 border border-amber-800/40 px-2.5 py-1 rounded-lg">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"/>
              {warnings} aviso{warnings !== 1 ? "s" : ""}
            </span>
          )}
          {errors === 0 && warnings === 0 && performanceIssues.length === 0 && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded-lg">
              <IcoCheck/>
              todo bien
            </span>
          )}
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Security issues */}
        {securityIssues.length > 0 && (
          <SeccionExpandible
            titulo="Seguridad"
            icono={
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            }
            count={securityIssues.length}
            countLabel={`problema${securityIssues.length !== 1 ? "s" : ""}`}
            color={errors > 0 ? "red" : "amber"}
          >
            {securityIssues.map((issue, i) => (
              <IssueLine key={i} issue={issue} color={issue.level === "ERROR" ? "red" : "amber"}/>
            ))}
          </SeccionExpandible>
        )}

        {/* Auth */}
        {auth && (
          <div>
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Auth</p>
            <div className="flex flex-wrap gap-1.5">
              <Chip ok={auth.mfa_enabled} label="MFA"/>
              <Chip ok={!auth.signup_enabled} label="Registro cerrado"/>
              <Chip ok={auth.captcha_enabled} label="Captcha"/>
              <Chip ok={auth.require_reauth_to_update_password} label="Reauth al cambiar pass"/>
              <Chip ok={auth.password_min_length >= 8} label={`Pass ${auth.password_min_length}+ car.`}/>
              <ChipNeutro label={`JWT ${formatJwt(auth.jwt_exp)}`}/>
            </div>
          </div>
        )}

        {/* Network */}
        {network && (
          <div>
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Red</p>
            <div className="flex flex-wrap gap-1.5 items-center">
              <Chip ok={network.restricted} label="Restricción de IPs"/>
              {network.restricted && network.cidrs.length > 0 && (
                <span className="text-xs text-zinc-500 font-mono">{network.cidrs.join(", ")}</span>
              )}
            </div>
          </div>
        )}

        {/* Performance */}
        {performanceIssues.length > 0 && (
          <SeccionExpandible
            titulo="Rendimiento"
            icono={
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
            }
            count={performanceIssues.length}
            countLabel={`problema${performanceIssues.length !== 1 ? "s" : ""}`}
            color="blue"
          >
            {performanceIssues.map((issue, i) => (
              <IssueLine key={i} issue={issue} color="blue"/>
            ))}
          </SeccionExpandible>
        )}

        {securityIssues.length === 0 && !auth && !network && performanceIssues.length === 0 && (
          <p className="text-xs text-zinc-600">Sin datos disponibles para este proyecto.</p>
        )}
      </div>
    </div>
  );
}

export default function SupabasePage() {
  const [data, setData] = useState<ProyectoData[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/supabase-advisor");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Error al cargar");
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const totalErrors = data?.reduce((a, d) => a + d.securityIssues.filter(i => i.level === "ERROR").length, 0) ?? 0;
  const totalWarnings = data?.reduce((a, d) => a + d.securityIssues.filter(i => i.level === "WARN").length, 0) ?? 0;
  const totalPerf = data?.reduce((a, d) => a + d.performanceIssues.length, 0) ?? 0;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">Salud de Supabase</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Security Advisor · todos los proyectos</p>
        </div>
        <button
          onClick={cargar}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          <IcoRefresh spin={loading}/>
          Actualizar
        </button>
      </div>

      {/* Summary tiles */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Proyectos", value: data.length, color: "default" },
            { label: "Errores críticos", value: totalErrors, color: totalErrors > 0 ? "red" : "ok" },
            { label: "Advertencias", value: totalWarnings, color: totalWarnings > 0 ? "amber" : "ok" },
            { label: "Rendimiento", value: totalPerf, color: totalPerf > 0 ? "blue" : "ok" },
          ].map(({ label, value, color }) => {
            const styles: Record<string, string> = {
              default: "border-white/10 bg-white/[0.03]",
              red: "border-red-800/50 bg-red-950/20",
              amber: "border-amber-700/40 bg-amber-950/20",
              blue: "border-blue-800/40 bg-blue-950/20",
              ok: "border-white/10 bg-white/[0.03]",
            };
            const textStyles: Record<string, string> = {
              default: "text-white",
              red: "text-red-400",
              amber: "text-amber-400",
              blue: "text-blue-400",
              ok: "text-emerald-400",
            };
            return (
              <div key={label} className={`rounded-xl border px-4 py-3 ${styles[color]}`}>
                <p className="text-xs text-zinc-500">{label}</p>
                <p className={`text-2xl font-bold mt-1 ${textStyles[color]}`}>{value}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-800/50 bg-red-950/20 px-5 py-4">
          <p className="text-sm text-red-400">⚠ {error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="text-center py-16 text-zinc-500 text-sm">Cargando proyectos…</div>
      )}

      {/* Project cards */}
      {data && (
        <div className="space-y-4">
          {data.map((d) => (
            <ProyectoCard key={d.project.id} data={d}/>
          ))}
        </div>
      )}
    </div>
  );
}
