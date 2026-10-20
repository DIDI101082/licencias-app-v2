"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteFortiEMS, { type EstadoEMS } from "@/components/PuenteFortiEMS";

// ── Tipos ──────────────────────────────────────────────────────────────────────
type Endpoint = {
  uid: string; hostname: string | null; usuario: string | null; ip: string | null;
  version_cliente: string | null; estado: string; os: string | null; so_version: string | null;
  dominio: string | null; sitio: string | null; grupo: string | null; politica: string | null;
  score_postura: number | null; ultimo_visto: string | null;
};
type Cumplimiento = {
  endpoint_uid: string; regla: string; estado: string; severidad: string; detalle: string | null;
};
type VpnActiva = {
  id: number; endpoint_uid: string | null; usuario: string | null; ip_publica: string | null;
  ip_tunel: string | null; desde: string | null; pais_codigo: string | null; pais: string | null;
  ciudad: string | null; isp: string | null;
};
type VpnHistorial = {
  id: number; fecha: string; usuario: string | null; endpoint_uid: string | null;
  hostname: string | null; ip_publica: string | null; accion: string; duracion_seg: number | null;
  pais_codigo: string | null; pais: string | null;
};
type Vuln = {
  id: number; endpoint_uid: string | null; cve_id: string | null; severidad: string;
  producto: string | null; version: string | null; descripcion: string | null;
};
type Acceso = {
  id: number; fecha: string; usuario: string | null; ip: string | null;
  accion: string; resultado: string | null; detalle: string | null;
};
type Licencia = {
  id: number; tipo: string; total: number | null; usadas: number | null;
  disponibles: number | null; vence: string | null; estado: string;
};
type Politica = {
  id: number; nombre: string; tipo: string | null;
  endpoints_asignados: number; endpoints_activos: number;
};

type Vista = "resumen" | "endpoints" | "cumplimiento" | "vpn" | "vulnerabilidades" | "accesos" | "licencias" | "politicas";
const VISTAS: [Vista, string][] = [
  ["resumen", "Resumen"], ["endpoints", "Endpoints"], ["cumplimiento", "Postura ZTNA"],
  ["vpn", "VPN"], ["vulnerabilidades", "Vulnerabilidades"], ["accesos", "Accesos al EMS"],
  ["licencias", "Licencias"], ["politicas", "Grupos y políticas"],
];

// ── Utilidades ─────────────────────────────────────────────────────────────────
const fecha = (f: string | null) =>
  f ? new Date(f).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "—";
const dia = (f: string | null) =>
  f ? new Date(f).toLocaleDateString("es-AR") : "—";
const diasRestantes = (f: string | null) =>
  f ? Math.floor((Date.parse(f) - Date.now()) / 86400000) : null;
const num = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("es-AR");
const bandera = (c: string | null) =>
  c && /^[A-Z]{2}$/i.test(c)
    ? String.fromCodePoint(...[...c.toUpperCase()].map((x) => 0x1f1a5 + x.charCodeAt(0)))
    : "";

const SEV: Record<string, { label: string; cls: string }> = {
  critical: { label: "Crítica", cls: "bg-red-600 text-white" },
  high:     { label: "Alta",   cls: "bg-orange-500/15 text-orange-700" },
  medium:   { label: "Media",  cls: "bg-amber-500/15 text-amber-700" },
  low:      { label: "Baja",   cls: "bg-line/[0.05] text-ink/60" },
  info:     { label: "Info",   cls: "bg-line/[0.05] text-ink/60" },
};
const SEV_CUMPL: Record<string, { label: string; cls: string }> = {
  pass:    { label: "OK",      cls: "bg-emerald-50 text-emerald-700" },
  fail:    { label: "Falla",   cls: "bg-red-50 text-red-700" },
  warning: { label: "Aviso",   cls: "bg-amber-50 text-amber-700" },
};
const ESTADO_EP: Record<string, { label: string; cls: string }> = {
  online:     { label: "Conectado",    cls: "bg-emerald-50 text-emerald-700" },
  offline:    { label: "Desconectado", cls: "bg-line/[0.05] text-ink/50" },
  quarantine: { label: "Cuarentena",   cls: "bg-red-50 text-red-700" },
};
const ESTADO_LIC: Record<string, { label: string; cls: string }> = {
  ok:         { label: "Vigente",      cls: "bg-emerald-50 text-emerald-700" },
  por_vencer: { label: "Por vencer",   cls: "bg-amber-50 text-amber-700" },
  vencida:    { label: "Vencida",      cls: "bg-red-50 text-red-700" },
};

function Pill({ estado }: { estado: string }) {
  const s = ESTADO_EP[estado] ?? { label: estado, cls: "bg-line/[0.05] text-ink/60" };
  return <span className={`pill ${s.cls}`}>{s.label}</span>;
}
function PillLic({ estado }: { estado: string }) {
  const s = ESTADO_LIC[estado] ?? { label: estado, cls: "bg-line/[0.05] text-ink/60" };
  return <span className={`pill ${s.cls}`}>{s.label}</span>;
}
function ScoreBar({ score }: { score: number | null }) {
  if (score == null) return <span className="text-ink/40">—</span>;
  const c = score >= 80 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-line/[0.08] overflow-hidden">
        <div className={`h-full ${c}`} style={{ width: `${score}%` }} />
      </div>
      <span className="tabular-nums text-xs text-ink/60">{score}</span>
    </div>
  );
}

// ── Contenido principal ────────────────────────────────────────────────────────
function Contenido() {
  const { esAdmin } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (VISTAS.some(([k]) => k === params.get("vista"))
    ? params.get("vista")
    : "resumen") as Vista;
  const ir = (v: string) =>
    router.replace(`/red/forti-ems${v ? `?vista=${v}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<EstadoEMS | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [cumplimiento, setCumplimiento] = useState<Cumplimiento[]>([]);
  const [vpn, setVpn] = useState<VpnActiva[]>([]);
  const [vpnHistorial, setVpnHistorial] = useState<VpnHistorial[]>([]);
  const [vulns, setVulns] = useState<Vuln[]>([]);
  const [accesos, setAccesos] = useState<Acceso[]>([]);
  const [licencias, setLicencias] = useState<Licencia[]>([]);
  const [politicas, setPoliticas] = useState<Politica[]>([]);

  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [texto, setTexto] = useState("");

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, ep, cu, vp, vh, vu, ac, li, po] = await Promise.all([
      sb.rpc("ems_estado"),
      sb.from("ems_endpoints").select("*").order("hostname"),
      sb.from("ems_cumplimiento").select("*").order("severidad"),
      sb.from("ems_vpn").select("*").order("desde", { ascending: false }),
      sb.from("ems_vpn_historial").select("*").order("fecha", { ascending: false }).limit(500),
      sb.from("ems_vulnerabilidades").select("*").order("severidad"),
      sb.from("ems_accesos").select("*").order("fecha", { ascending: false }).limit(300),
      sb.from("ems_licencias").select("*").order("vence"),
      sb.from("ems_politicas").select("*").order("nombre"),
    ]);
    const err = e.error ?? ep.error;
    setError(err ? (/ems_/.test(err.message) ? "Falta ejecutar supabase/forti-ems.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoEMS) ?? null);
    setEndpoints((ep.data ?? []) as Endpoint[]);
    setCumplimiento((cu.data ?? []) as Cumplimiento[]);
    setVpn((vp.data ?? []) as VpnActiva[]);
    setVpnHistorial((vh.data ?? []) as VpnHistorial[]);
    setVulns((vu.data ?? []) as Vuln[]);
    setAccesos((ac.data ?? []) as Acceso[]);
    setLicencias((li.data ?? []) as Licencia[]);
    setPoliticas((po.data ?? []) as Politica[]);
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  const q = texto.trim().toLowerCase();
  const coincide = (...vals: (string | null | undefined)[]) =>
    !q || vals.some((x) => x?.toLowerCase().includes(q));

  // KPIs para el resumen
  const online = endpoints.filter((e) => e.estado === "online").length;
  const offline = endpoints.filter((e) => e.estado === "offline").length;
  const sinPolitica = endpoints.filter((e) => !e.politica && e.estado !== "offline").length;
  const epConFallas = new Set(cumplimiento.filter((c) => c.estado === "fail").map((c) => c.endpoint_uid)).size;
  const vulnCriticas = vulns.filter((v) => v.severidad === "critical").length;
  const licVencer = licencias.filter((l) => l.estado === "por_vencer" || l.estado === "vencida").length;

  const estadoGlobal = !estado?.configurado
    ? null
    : offline > endpoints.length * 0.2 || vulnCriticas > 0 || sinPolitica > 0
    ? "riesgo"
    : epConFallas > 0 || licVencer > 0
    ? "aviso"
    : "ok";

  if (cargando) {
    return (
      <div className="p-8 text-ink/40 text-sm">Cargando FortiClient EMS…</div>
    );
  }

  // ── Panel de configuración ─────────────────────────────────────────────────
  if (config) {
    if (!estado) return null;
    return (
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center gap-3">
          <button
            className="btn-secondary"
            onClick={() => { setConfig(false); cargar(); }}
          >← Volver</button>
          <h1 className="font-display text-xl text-ink">Configuración de FortiClient EMS</h1>
        </div>
        <PuenteFortiEMS estado={estado} alCambiar={cargar} />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* ── Cabecera ── */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-xl text-ink">FortiClient EMS</h1>
            {estado && (
              <span className={`pill text-xs ${
                estadoGlobal === "ok" ? "bg-emerald-50 text-emerald-700" :
                estadoGlobal === "aviso" ? "bg-amber-50 text-amber-700" :
                estadoGlobal === "riesgo" ? "bg-red-50 text-red-700" :
                "bg-line/[0.05] text-ink/50"
              }`}>
                {estadoGlobal === "ok" ? "Sin alertas" :
                 estadoGlobal === "aviso" ? "Revisar" :
                 estadoGlobal === "riesgo" ? "Atención" :
                 "Sin configurar"}
              </span>
            )}
            {estado?.ultimo_reporte && (
              <span className="text-xs text-ink/40 hidden sm:inline">
                Actualizado {fecha(estado.ultimo_reporte)}
              </span>
            )}
          </div>
          {error && (
            <p className="mt-1 text-sm text-red-600">{error}</p>
          )}
          {!estado?.configurado && !error && (
            <p className="mt-1 text-sm text-ink/50">
              El puente no está configurado.{" "}
              {esAdmin && (
                <button className="underline text-ink/70" onClick={() => setConfig(true)}>
                  Configurar ahora
                </button>
              )}
            </p>
          )}
        </div>
        {esAdmin && (
          <button className="btn-secondary shrink-0" onClick={() => setConfig(true)}>
            Configuración
          </button>
        )}
      </div>

      {/* ── KPIs ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Conectados", val: online, cls: "text-emerald-600" },
          { label: "Desconectados", val: offline, cls: offline > 0 ? "text-red-600" : "text-ink/70" },
          { label: "Sin política", val: sinPolitica, cls: sinPolitica > 0 ? "text-amber-600" : "text-ink/70" },
          { label: "Fallas postura", val: epConFallas, cls: epConFallas > 0 ? "text-orange-600" : "text-ink/70" },
          { label: "Vulns. críticas", val: vulnCriticas, cls: vulnCriticas > 0 ? "text-red-600" : "text-ink/70" },
          { label: "VPN activas", val: vpn.length, cls: "text-ink/70" },
        ].map(({ label, val, cls }) => (
          <div key={label} className="card p-4">
            <div className={`text-2xl font-semibold tabular-nums ${cls}`}>{val}</div>
            <div className="text-xs text-ink/50 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* ── Tabs de vistas ── */}
      <div className="flex gap-1 flex-wrap border-b border-line/[0.06] -mb-1">
        {VISTAS.map(([k, l]) => (
          <button
            key={k}
            className={`px-3 py-2 text-sm rounded-t transition-colors ${
              vista === k
                ? "bg-white dark:bg-zinc-900 border border-b-white dark:border-b-zinc-900 border-line/[0.08] text-ink font-medium -mb-px"
                : "text-ink/50 hover:text-ink"
            }`}
            onClick={() => ir(k === "resumen" ? "" : k)}
          >
            {l}
          </button>
        ))}
      </div>

      {/* ── Vista: Resumen ── */}
      {vista === "resumen" && (
        <div className="space-y-4">
          {/* Endpoints por estado */}
          <div className="card p-5 space-y-3">
            <h2 className="font-display text-base text-ink">Estado de endpoints</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {(["online","offline","quarantine"] as const).map((est) => {
                const count = endpoints.filter((e) => e.estado === est).length;
                const { label, cls } = ESTADO_EP[est] ?? { label: est, cls: "" };
                return (
                  <button
                    key={est}
                    className="text-left rounded-lg bg-line/[0.03] p-3 hover:bg-line/[0.07] transition-colors"
                    onClick={() => ir("endpoints")}
                  >
                    <div className={`text-2xl font-semibold tabular-nums`}>{count}</div>
                    <span className={`pill text-xs mt-1 ${cls}`}>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Postura ZTNA */}
          <div className="card p-5 space-y-3">
            <h2 className="font-display text-base text-ink">Postura ZTNA</h2>
            {endpoints.length === 0 ? (
              <p className="text-sm text-ink/40">Sin datos.</p>
            ) : (
              <div className="space-y-2">
                {endpoints
                  .filter((e) => e.score_postura != null)
                  .sort((a, b) => (a.score_postura ?? 100) - (b.score_postura ?? 100))
                  .slice(0, 8)
                  .map((ep) => (
                    <div key={ep.uid} className="grid grid-cols-[1fr_180px] gap-3 items-center">
                      <div className="min-w-0">
                        <span className="text-sm text-ink truncate block">
                          {ep.hostname ?? ep.uid}
                        </span>
                        <span className="text-xs text-ink/40">{ep.usuario ?? "—"}</span>
                      </div>
                      <ScoreBar score={ep.score_postura} />
                    </div>
                  ))}
                {endpoints.filter((e) => e.score_postura != null).length === 0 && (
                  <p className="text-sm text-ink/40">El EMS no reportó scores de postura.</p>
                )}
              </div>
            )}
          </div>

          {/* VPN activas + Licencias */}
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="card p-5 space-y-2">
              <h2 className="font-display text-base text-ink">VPN activas</h2>
              {vpn.length === 0 ? (
                <p className="text-sm text-ink/40">Ninguna sesión VPN activa.</p>
              ) : (
                <ul className="space-y-1.5">
                  {vpn.slice(0, 6).map((v) => (
                    <li key={v.id} className="flex items-center gap-2 text-sm">
                      <span className="text-base">{bandera(v.pais_codigo)}</span>
                      <span className="font-medium text-ink">{v.usuario ?? "—"}</span>
                      <span className="text-ink/40">{v.ip_publica ?? ""}</span>
                    </li>
                  ))}
                  {vpn.length > 6 && (
                    <li className="text-xs text-ink/40">
                      + {vpn.length - 6} más —{" "}
                      <button className="underline" onClick={() => ir("vpn")}>ver todas</button>
                    </li>
                  )}
                </ul>
              )}
            </div>
            <div className="card p-5 space-y-2">
              <h2 className="font-display text-base text-ink">Licencias</h2>
              {licencias.length === 0 ? (
                <p className="text-sm text-ink/40">Sin datos de licencias.</p>
              ) : (
                <ul className="space-y-1.5">
                  {licencias.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-ink truncate">{l.tipo}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-ink/40 tabular-nums">{l.usadas}/{l.total}</span>
                        <PillLic estado={l.estado} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Vista: Endpoints ── */}
      {vista === "endpoints" && (
        <div className="space-y-3">
          <input
            className="input max-w-sm"
            placeholder="Buscar hostname, usuario, IP…"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
          <div className="card overflow-hidden">
            <table className="tabla w-full">
              <thead>
                <tr>
                  <th>Hostname</th>
                  <th>Usuario</th>
                  <th>IP</th>
                  <th>Estado</th>
                  <th>Versión</th>
                  <th>Grupo / Política</th>
                  <th>Postura</th>
                  <th>Último visto</th>
                </tr>
              </thead>
              <tbody>
                {endpoints
                  .filter((ep) =>
                    coincide(ep.hostname, ep.usuario, ep.ip, ep.grupo, ep.politica, ep.dominio)
                  )
                  .map((ep) => (
                    <tr key={ep.uid}>
                      <td className="font-medium">{ep.hostname ?? ep.uid}</td>
                      <td>{ep.usuario ?? "—"}</td>
                      <td className="tabular-nums text-ink/60">{ep.ip ?? "—"}</td>
                      <td><Pill estado={ep.estado} /></td>
                      <td className="text-ink/60 tabular-nums">{ep.version_cliente ?? "—"}</td>
                      <td>
                        <div className="text-xs text-ink/50">{ep.grupo ?? "—"}</div>
                        <div className="text-xs text-ink/70">{ep.politica ?? <span className="text-amber-600">Sin política</span>}</div>
                      </td>
                      <td><ScoreBar score={ep.score_postura} /></td>
                      <td className="text-ink/50 text-xs">{fecha(ep.ultimo_visto)}</td>
                    </tr>
                  ))}
                {endpoints.filter((ep) =>
                  coincide(ep.hostname, ep.usuario, ep.ip, ep.grupo, ep.politica)
                ).length === 0 && (
                  <tr><td colSpan={8} className="text-ink/40 text-sm">Sin resultados.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Vista: Postura ZTNA / Cumplimiento ── */}
      {vista === "cumplimiento" && (
        <div className="space-y-3">
          <input
            className="input max-w-sm"
            placeholder="Buscar regla, endpoint…"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
          {/* Resumen por endpoint */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {endpoints
              .filter((ep) => {
                const reg = cumplimiento.filter((c) => c.endpoint_uid === ep.uid);
                return reg.length > 0;
              })
              .sort((a, b) => (a.score_postura ?? 100) - (b.score_postura ?? 100))
              .map((ep) => {
                const regs = cumplimiento.filter((c) => c.endpoint_uid === ep.uid);
                const fallas = regs.filter((r) => r.estado === "fail").length;
                const avisos = regs.filter((r) => r.estado === "warning").length;
                return (
                  <div key={ep.uid} className="card p-4 space-y-2">
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <p className="font-medium text-ink text-sm">{ep.hostname ?? ep.uid}</p>
                        <p className="text-xs text-ink/40">{ep.usuario ?? "—"}</p>
                      </div>
                      <ScoreBar score={ep.score_postura} />
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {fallas > 0 && (
                        <span className="pill bg-red-50 text-red-700">{fallas} falla{fallas > 1 ? "s" : ""}</span>
                      )}
                      {avisos > 0 && (
                        <span className="pill bg-amber-50 text-amber-700">{avisos} aviso{avisos > 1 ? "s" : ""}</span>
                      )}
                      {fallas === 0 && avisos === 0 && (
                        <span className="pill bg-emerald-50 text-emerald-700">OK</span>
                      )}
                    </div>
                    {fallas > 0 && (
                      <ul className="space-y-1 mt-1">
                        {regs.filter((r) => r.estado === "fail").slice(0, 3).map((r, i) => (
                          <li key={i} className="text-xs text-red-700">• {r.regla}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
          </div>
          {/* Tabla completa de reglas */}
          <div className="card overflow-hidden">
            <table className="tabla w-full">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Regla</th>
                  <th>Estado</th>
                  <th>Severidad</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {cumplimiento
                  .filter((c) => {
                    const ep = endpoints.find((e) => e.uid === c.endpoint_uid);
                    return coincide(c.regla, c.detalle, ep?.hostname, ep?.usuario);
                  })
                  .map((c, i) => {
                    const ep = endpoints.find((e) => e.uid === c.endpoint_uid);
                    const sev = SEV[c.severidad] ?? SEV.info;
                    const cst = SEV_CUMPL[c.estado] ?? SEV_CUMPL.fail;
                    return (
                      <tr key={i}>
                        <td className="text-sm">
                          <p className="font-medium">{ep?.hostname ?? c.endpoint_uid}</p>
                          <p className="text-xs text-ink/40">{ep?.usuario ?? "—"}</p>
                        </td>
                        <td>{c.regla}</td>
                        <td><span className={`pill ${cst.cls}`}>{cst.label}</span></td>
                        <td><span className={`pill ${sev.cls}`}>{sev.label}</span></td>
                        <td className="text-ink/60 text-xs">{c.detalle ?? "—"}</td>
                      </tr>
                    );
                  })}
                {cumplimiento.length === 0 && (
                  <tr><td colSpan={5} className="text-ink/40 text-sm">Sin datos de postura. El puente necesita al menos un ciclo completo.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Vista: VPN ── */}
      {vista === "vpn" && (
        <div className="space-y-4">
          {/* Sesiones activas */}
          <div className="card p-5 space-y-3">
            <h2 className="font-display text-base text-ink">
              Sesiones VPN activas ({vpn.length})
            </h2>
            {vpn.length === 0 ? (
              <p className="text-sm text-ink/40">Ninguna sesión activa en este momento.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="tabla w-full">
                  <thead>
                    <tr>
                      <th>Usuario</th>
                      <th>Hostname</th>
                      <th>IP pública</th>
                      <th>IP túnel</th>
                      <th>País</th>
                      <th>ISP</th>
                      <th>Desde</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vpn.map((v) => {
                      const ep = endpoints.find((e) => e.uid === v.endpoint_uid);
                      return (
                        <tr key={v.id}>
                          <td className="font-medium">{v.usuario ?? "—"}</td>
                          <td className="text-ink/60">{ep?.hostname ?? "—"}</td>
                          <td className="tabular-nums text-ink/60">{v.ip_publica ?? "—"}</td>
                          <td className="tabular-nums text-ink/60">{v.ip_tunel ?? "—"}</td>
                          <td>
                            <span className="mr-1">{bandera(v.pais_codigo)}</span>
                            {v.ciudad ? `${v.ciudad}, ` : ""}{v.pais ?? "—"}
                          </td>
                          <td className="text-ink/60 text-xs">{v.isp ?? "—"}</td>
                          <td className="text-ink/50 text-xs">{fecha(v.desde)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Historial VPN */}
          <div className="card p-5 space-y-3">
            <h2 className="font-display text-base text-ink">Historial de sesiones (últimos 90 días)</h2>
            <input
              className="input max-w-sm"
              placeholder="Buscar usuario, hostname, IP…"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <div className="overflow-x-auto">
              <table className="tabla w-full">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Usuario</th>
                    <th>Hostname</th>
                    <th>IP pública</th>
                    <th>País</th>
                    <th>Acción</th>
                    <th>Duración</th>
                  </tr>
                </thead>
                <tbody>
                  {vpnHistorial
                    .filter((h) => coincide(h.usuario, h.hostname, h.ip_publica, h.pais))
                    .map((h) => (
                      <tr key={h.id}>
                        <td className="text-ink/50 text-xs">{fecha(h.fecha)}</td>
                        <td className="font-medium">{h.usuario ?? "—"}</td>
                        <td className="text-ink/60">{h.hostname ?? "—"}</td>
                        <td className="tabular-nums text-ink/60">{h.ip_publica ?? "—"}</td>
                        <td>
                          <span className="mr-1">{bandera(h.pais_codigo)}</span>
                          {h.pais ?? "—"}
                        </td>
                        <td>
                          <span className={`pill ${h.accion === "connect" ? "bg-emerald-50 text-emerald-700" : "bg-line/[0.05] text-ink/60"}`}>
                            {h.accion === "connect" ? "Conectó" : "Desconectó"}
                          </span>
                        </td>
                        <td className="tabular-nums text-ink/60 text-xs">
                          {h.duracion_seg != null
                            ? `${Math.floor(h.duracion_seg / 60)} min`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  {vpnHistorial.length === 0 && (
                    <tr><td colSpan={7} className="text-ink/40 text-sm">Sin historial.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Vista: Vulnerabilidades ── */}
      {vista === "vulnerabilidades" && (
        <div className="space-y-3">
          {/* Resumen */}
          <div className="flex flex-wrap gap-3">
            {(["critical","high","medium","low"] as const).map((sev) => {
              const count = vulns.filter((v) => v.severidad === sev).length;
              const s = SEV[sev];
              return (
                <div key={sev} className="card p-4 flex items-center gap-3">
                  <span className={`pill ${s.cls}`}>{s.label}</span>
                  <span className="text-2xl font-semibold tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
          <input
            className="input max-w-sm"
            placeholder="Buscar CVE, producto, endpoint…"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
          <div className="card overflow-hidden">
            <table className="tabla w-full">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>CVE</th>
                  <th>Severidad</th>
                  <th>Producto</th>
                  <th>Versión</th>
                  <th>Descripción</th>
                </tr>
              </thead>
              <tbody>
                {vulns
                  .filter((v) => {
                    const ep = endpoints.find((e) => e.uid === v.endpoint_uid);
                    return coincide(v.cve_id, v.producto, v.descripcion, ep?.hostname, ep?.usuario);
                  })
                  .map((v) => {
                    const ep = endpoints.find((e) => e.uid === v.endpoint_uid);
                    const s = SEV[v.severidad] ?? SEV.medium;
                    return (
                      <tr key={v.id}>
                        <td>
                          <p className="font-medium">{ep?.hostname ?? v.endpoint_uid ?? "—"}</p>
                          <p className="text-xs text-ink/40">{ep?.usuario ?? "—"}</p>
                        </td>
                        <td className="font-mono text-xs">{v.cve_id ?? "—"}</td>
                        <td><span className={`pill ${s.cls}`}>{s.label}</span></td>
                        <td>{v.producto ?? "—"}</td>
                        <td className="text-ink/60 tabular-nums text-xs">{v.version ?? "—"}</td>
                        <td className="text-ink/60 text-xs max-w-xs truncate">{v.descripcion ?? "—"}</td>
                      </tr>
                    );
                  })}
                {vulns.length === 0 && (
                  <tr><td colSpan={6} className="text-ink/40 text-sm">Sin vulnerabilidades reportadas.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Vista: Accesos al EMS ── */}
      {vista === "accesos" && (
        <div className="space-y-3">
          <input
            className="input max-w-sm"
            placeholder="Buscar usuario, IP…"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
          <div className="card overflow-hidden">
            <table className="tabla w-full">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Usuario</th>
                  <th>IP</th>
                  <th>Acción</th>
                  <th>Resultado</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {accesos
                  .filter((a) => coincide(a.usuario, a.ip, a.detalle))
                  .map((a) => (
                    <tr key={a.id}>
                      <td className="text-ink/50 text-xs">{fecha(a.fecha)}</td>
                      <td className="font-medium">{a.usuario ?? "—"}</td>
                      <td className="tabular-nums text-ink/60">{a.ip ?? "—"}</td>
                      <td>
                        <span className={`pill ${
                          a.accion === "login" ? "bg-emerald-50 text-emerald-700" :
                          a.accion === "failed" ? "bg-red-50 text-red-700" :
                          "bg-line/[0.05] text-ink/60"
                        }`}>
                          {a.accion === "login" ? "Ingresó" :
                           a.accion === "logout" ? "Salió" :
                           a.accion === "failed" ? "Falló" : a.accion}
                        </span>
                      </td>
                      <td className="text-ink/60 text-xs">{a.resultado ?? "—"}</td>
                      <td className="text-ink/60 text-xs">{a.detalle ?? "—"}</td>
                    </tr>
                  ))}
                {accesos.length === 0 && (
                  <tr><td colSpan={6} className="text-ink/40 text-sm">Sin registros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Vista: Licencias ── */}
      {vista === "licencias" && (
        <div className="space-y-3">
          {licencias.length === 0 ? (
            <p className="text-sm text-ink/40 p-4">Sin datos de licencias.</p>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {licencias.map((l) => {
                const dr = diasRestantes(l.vence);
                return (
                  <div key={l.id} className="card p-5 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-ink">{l.tipo}</p>
                      <PillLic estado={l.estado} />
                    </div>
                    {/* Barra de uso */}
                    <div>
                      <div className="flex justify-between text-xs text-ink/55 mb-1">
                        <span>Uso</span>
                        <span className="tabular-nums">{num(l.usadas)} / {num(l.total)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-line/[0.08] overflow-hidden">
                        <div
                          className={`h-full ${
                            l.total && l.usadas && l.usadas / l.total > 0.9
                              ? "bg-red-500"
                              : l.total && l.usadas && l.usadas / l.total > 0.75
                              ? "bg-amber-500"
                              : "bg-emerald-500"
                          }`}
                          style={{ width: `${l.total ? ((l.usadas ?? 0) / l.total) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-sm text-ink/60">
                      {l.vence ? (
                        <>
                          Vence {dia(l.vence)}
                          {dr != null && (
                            <span className={`ml-2 text-xs ${dr < 0 ? "text-red-600" : dr < 30 ? "text-amber-600" : "text-ink/40"}`}>
                              ({dr < 0 ? `hace ${Math.abs(dr)} días` : `en ${dr} días`})
                            </span>
                          )}
                        </>
                      ) : "Sin fecha de vencimiento"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Vista: Grupos y Políticas ── */}
      {vista === "politicas" && (
        <div className="space-y-4">
          {/* Endpoints sin política */}
          {sinPolitica > 0 && (
            <div className="card p-4 border border-amber-200 bg-amber-50/50 space-y-2">
              <p className="font-medium text-amber-800 text-sm">
                {sinPolitica} endpoint{sinPolitica > 1 ? "s" : ""} sin política asignada
              </p>
              <ul className="space-y-0.5">
                {endpoints
                  .filter((ep) => !ep.politica && ep.estado !== "offline")
                  .map((ep) => (
                    <li key={ep.uid} className="text-xs text-amber-700">
                      {ep.hostname ?? ep.uid} — {ep.usuario ?? "—"}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* Tabla de políticas */}
          <div className="card overflow-hidden">
            <table className="tabla w-full">
              <thead>
                <tr>
                  <th>Política / Perfil</th>
                  <th>Tipo</th>
                  <th>Endpoints asignados</th>
                  <th>Endpoints activos</th>
                  <th>Cobertura</th>
                </tr>
              </thead>
              <tbody>
                {politicas.map((p) => {
                  const cobertura = p.endpoints_asignados > 0
                    ? Math.round((p.endpoints_activos / p.endpoints_asignados) * 100)
                    : 0;
                  return (
                    <tr key={p.id}>
                      <td className="font-medium">{p.nombre}</td>
                      <td>
                        <span className="pill bg-line/[0.05] text-ink/60">{p.tipo ?? "—"}</span>
                      </td>
                      <td className="tabular-nums">{num(p.endpoints_asignados)}</td>
                      <td className="tabular-nums">{num(p.endpoints_activos)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-1.5 rounded-full bg-line/[0.08] overflow-hidden">
                            <div
                              className={`h-full ${cobertura < 50 ? "bg-red-500" : cobertura < 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                              style={{ width: `${cobertura}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-ink/50">{cobertura}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {politicas.length === 0 && (
                  <tr><td colSpan={5} className="text-ink/40 text-sm">Sin políticas reportadas.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Distribución por grupo */}
          {endpoints.length > 0 && (
            <div className="card p-5 space-y-3">
              <h2 className="font-display text-base text-ink">Distribución por grupo</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {Object.entries(
                  endpoints.reduce((acc, ep) => {
                    const g = ep.grupo ?? "(Sin grupo)";
                    acc[g] = (acc[g] ?? 0) + 1;
                    return acc;
                  }, {} as Record<string, number>)
                )
                  .sort((a, b) => b[1] - a[1])
                  .map(([grupo, count]) => (
                    <div key={grupo} className="flex items-center justify-between rounded-lg bg-line/[0.03] px-3 py-2">
                      <span className="text-sm text-ink truncate">{grupo}</span>
                      <span className="pill bg-line/[0.05] text-ink/60 shrink-0">{count}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FortiEMSPage() {
  return (
    <Suspense fallback={<div className="p-8 text-ink/40 text-sm">Cargando…</div>}>
      <Contenido />
    </Suspense>
  );
}
