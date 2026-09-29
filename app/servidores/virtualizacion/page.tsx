"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteVirtualizacion, { type EstadoVirt } from "@/components/PuenteVirtualizacion";
import { hace } from "@/lib/monitoreo";
import { SEV, tamano, pctUsado, colorUso, fechaCorta, diasDesde, type Hallazgo, type Proyeccion } from "@/lib/virtualizacion";

type Cve = { id: string; cvss: number | null; severidad: string; kev: boolean; descripcion: string | null; accion: string | null };
type Host = {
  nombre: string; version: string | null; build: string | null; estado: string | null; energia: string | null; fabricante: string | null; modelo: string | null;
  cluster: string | null; salud: string | null; cpu_pct: number | null; mem_pct: number | null; mem_gb: number | null; arranque: string | null;
  lockdown: string | null; ssh_activo: boolean | null; shell_activo: boolean | null; cert_vence: string | null; sensores: { nombre: string; estado: string; tipo: string }[];
  vuln_estado: string | null; vuln_total: number | null; vuln_criticas: number | null; vuln_kev: number | null; vuln_cves: Cve[] | null; vms: number; vms_encendidas: number;
};
type Vm = { nombre: string; host: string | null; estado: string; so: string | null; cpus: number | null; mem_gb: number | null; disco_gb: number | null; usado_gb: number | null; tools: string | null; ip: string | null };
type Snap = { vm: string; nombre: string; creado: string; tamano_gb: number | null };
type Ds = { nombre: string; tipo: string | null; capacidad_gb: number | null; libre_gb: number | null; estado: string | null; hosts: number | null };
type Alarma = { id: number; alarma: string | null; entidad: string | null; estado: string | null; fecha: string | null; reconocida: boolean | null };
type Licencia = { producto: string; edicion: string; usado: number | null; total: number | null; vence: string | null };

type Vista = "hosts" | "vms" | "datastores" | "hallazgos" | "alarmas";
const VISTAS: [Vista, string][] = [["hosts", "Hosts"], ["vms", "Máquinas virtuales"], ["datastores", "Datastores"], ["hallazgos", "Hallazgos"], ["alarmas", "Alarmas y licencias"]];
const TOOLS: Record<string, { t: string; c: string }> = {
  guestToolsCurrent: { t: "Al día", c: "text-emerald-700" }, guestToolsNeedUpgrade: { t: "Desactualizadas", c: "text-amber-700" },
  guestToolsNotInstalled: { t: "No instaladas", c: "text-red-600" }, guestToolsUnmanaged: { t: "Del sistema (open-vm-tools)", c: "text-ink/60" },
  guestToolsSupportedOld: { t: "Viejas (soportadas)", c: "text-amber-700" }, guestToolsTooOld: { t: "Demasiado viejas", c: "text-red-600" },
};
const ESTADO_HOST: Record<string, { t: string; c: string }> = {
  Connected: { t: "Conectado", c: "bg-emerald-50 text-emerald-700" }, Maintenance: { t: "Mantenimiento", c: "bg-amber-500/15 text-amber-700" },
  Disconnected: { t: "Desconectado", c: "bg-red-600 text-white" }, NotResponding: { t: "No responde", c: "bg-red-600 text-white" },
};

function Barra({ v, etiqueta, limite = 85 }: { v: number | null; etiqueta: string; limite?: number }) {
  const p = Math.max(0, Math.min(100, v ?? 0));
  return (
    <div>
      <div className="flex justify-between text-xs text-ink/55"><span>{etiqueta}</span><span className="tabular-nums">{v == null ? "—" : `${Math.round(p)}%`}</span></div>
      <div className="h-1.5 rounded-full bg-line/[0.08] mt-1 overflow-hidden"><div className={`h-full ${colorUso(v, limite)}`} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

function Contenido() {
  const { esAdmin } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (VISTAS.some(([k]) => k === params.get("vista")) ? params.get("vista") : "hosts") as Vista;
  const ir = (q: string) => router.replace(`/servidores/virtualizacion${q ? `?${q}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<EstadoVirt | null>(null);
  const [vc, setVc] = useState<{ nombre: string | null; version: string | null; build: string | null } | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [vms, setVms] = useState<Vm[]>([]);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [ds, setDs] = useState<Ds[]>([]);
  const [proy, setProy] = useState<Proyeccion[]>([]);
  const [hallazgos, setHallazgos] = useState<Hallazgo[]>([]);
  const [alarmas, setAlarmas] = useState<Alarma[]>([]);
  const [licencias, setLicencias] = useState<Licencia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const [texto, setTexto] = useState("");
  const [filtroVm, setFiltroVm] = useState("todas");
  const [abierto, setAbierto] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, v, h, m, s, d, p, hz, a, l] = await Promise.all([
      sb.rpc("virt_estado"), sb.from("virt_vcenter").select("*").maybeSingle(), sb.from("virt_hosts_vista").select("*").order("nombre"),
      sb.from("virt_vms").select("*").order("nombre").limit(5000), sb.from("virt_snapshots").select("*").order("creado"),
      sb.from("virt_datastores").select("*").order("nombre"), sb.from("virt_proyeccion").select("*"),
      sb.from("virt_hallazgos").select("*").neq("ambito", "storage").neq("ambito", "pool"),
      sb.from("virt_alarmas").select("*").order("fecha", { ascending: false }), sb.from("virt_licencias").select("*").order("vence"),
    ]);
    const err = e.error ?? h.error;
    setError(err ? (/virt_/.test(err.message) ? "Falta ejecutar supabase/virtualizacion.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoVirt) ?? null);
    setVc((v.data as typeof vc) ?? null);
    setHosts((h.data ?? []) as Host[]); setVms((m.data ?? []) as Vm[]); setSnaps((s.data ?? []) as Snap[]); setDs((d.data ?? []) as Ds[]);
    setProy((p.data ?? []) as Proyeccion[]); setHallazgos((hz.data ?? []) as Hallazgo[]); setAlarmas((a.data ?? []) as Alarma[]); setLicencias((l.data ?? []) as Licencia[]);
    setAhora(Date.now()); setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 120000); return () => clearInterval(t); }, [cargar]);

  const q = texto.trim().toLowerCase();
  const coincide = (...v: (string | null | undefined)[]) => !q || v.some((x) => x?.toLowerCase().includes(q));
  const limite = estado?.pct_lleno ?? 85;
  const conectados = hosts.filter((h) => h.estado === "Connected").length;
  const graves = hallazgos.filter((h) => h.severidad === "critica" || h.severidad === "alta");
  const snapsViejos = snaps.filter((s) => (diasDesde(s.creado, ahora) ?? 0) > (estado?.dias_snapshot ?? 7));
  const dsMax = ds.reduce<{ n: string; p: number } | null>((m, d) => { const p = pctUsado(d.capacidad_gb, d.libre_gb); return p != null && (!m || p > m.p) ? { n: d.nombre, p } : m; }, null);
  const reporteViejo = estado?.ultimo_reporte ? ahora - Date.parse(estado.ultimo_reporte) > (estado.minutos_sin_reporte ?? 45) * 60000 : false;

  const tarjetas = [
    { t: "Hosts conectados", n: hosts.length ? `${conectados} de ${hosts.length}` : "—", c: conectados < hosts.length ? "text-amber-700" : "text-ink", ir: "" },
    { t: "VMs encendidas", n: vms.length ? `${vms.filter((v) => v.estado === "PoweredOn").length} de ${vms.length}` : "—", c: "text-ink", ir: "vista=vms" },
    { t: "Hallazgos críticos o altos", n: graves.length, c: graves.length ? "text-red-600" : "text-ink", ir: "vista=hallazgos" },
    { t: `Snapshots de más de ${estado?.dias_snapshot ?? 7} días`, n: snapsViejos.length, c: snapsViejos.length ? "text-amber-700" : "text-ink", ir: "vista=vms" },
    { t: "Datastore más lleno", n: dsMax ? `${dsMax.p}%` : "—", c: dsMax && dsMax.p >= limite ? "text-red-600" : "text-ink", ir: "vista=datastores" },
  ];
  const vacio = (cols: number, t: string) => <tr><td colSpan={cols} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : t}</td></tr>;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Virtualización</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Hosts ESXi, máquinas virtuales y datastores de vCenter: salud del hardware, configuración de seguridad, vulnerabilidades de la versión,
            snapshots y espacio. El storage está en <Link href="/servidores/storage" className="text-brand-600 hover:underline">Servidores → Storage</Link>.
          </p>
        </div>
        {esAdmin && estado && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {estado && !estado.configurado && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está instalado el puente de virtualización. {esAdmin ? "Tocá “Configurar” para generarlo." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <PuenteVirtualizacion estado={estado} alCambiar={cargar} />}

      {estado?.configurado && (
        <div className={`card p-3 text-sm space-y-1 ${reporteViejo || estado.error_vcenter ? "bg-amber-500/10" : ""}`}>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className={reporteViejo ? "text-red-600" : ""}><b>Último reporte:</b> {estado.ultimo_reporte ? hace(estado.ultimo_reporte, ahora) : "todavía no reportó (¿instalaste el puente?)"}</span>
            {vc?.version && <span><b>vCenter:</b> {vc.nombre} · {vc.version} build {vc.build}</span>}
            <span className={estado.alertas ? "text-emerald-700" : "text-ink/50"}><b>Alertas:</b> {estado.alertas ? "activadas" : "apagadas"}</span>
          </div>
          {estado.error_vcenter && <div className="text-red-600"><b>No se pudo leer vCenter:</b> {estado.error_vcenter} (se muestran los últimos datos conocidos)</div>}
          {(estado.avisos ?? []).length > 0 && <div className="text-amber-700 text-xs">Avisos: {estado.avisos.join(" · ")}</div>}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {tarjetas.map((t) => (
          <button key={t.t} onClick={() => ir(t.ir)} className="card p-5 text-left hover:border-brand-300 transition-colors">
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div role="tablist" aria-label="Vistas" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1">
          {VISTAS.map(([k, t]) => (
            <button key={k} role="tab" aria-selected={vista === k} onClick={() => ir(k === "hosts" ? "" : `vista=${k}`)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${vista === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>{t}</button>
          ))}
        </div>
        {vista !== "hosts" && <input type="search" className="input max-w-xs" placeholder="Buscar…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />}
      </div>

      {/* Hosts */}
      {vista === "hosts" && (
        <div className="grid lg:grid-cols-2 gap-4">
          {!hosts.length && <div className="card p-8 text-center text-ink/40 lg:col-span-2">{cargando ? "Cargando…" : "Sin datos todavía."}</div>}
          {hosts.map((h) => {
            const est = ESTADO_HOST[h.estado ?? ""] ?? { t: h.estado ?? "—", c: "bg-line/[0.05] text-ink/60" };
            const verCves = abierto === `cve:${h.nombre}`;
            return (
              <div key={h.nombre} className="card p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-lg text-ink">{h.nombre}</h2>
                    <p className="text-sm text-ink/60">{[h.fabricante, h.modelo, h.cluster].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="text-right space-y-1">
                    <span className={`pill ${est.c}`}>{est.t}</span>
                    {h.salud && h.salud !== "green" && <div><span className={`pill ${h.salud === "red" ? "bg-red-50 text-red-700" : "bg-amber-500/15 text-amber-700"}`}>Salud {h.salud === "red" ? "crítica" : "con advertencias"}</span></div>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Barra v={h.cpu_pct} etiqueta="CPU" />
                  <Barra v={h.mem_pct} etiqueta={`Memoria (${tamano(h.mem_gb)})`} />
                </div>
                <div className="grid sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">ESXi</div>
                    <div className="font-medium">{h.version ?? "—"} <span className="text-ink/50 font-normal">build {h.build ?? "—"}</span></div>
                    {h.vuln_estado === "ok" && (
                      <div className="mt-1 flex flex-wrap gap-1 items-center">
                        {(h.vuln_kev ?? 0) > 0 && <span className="pill bg-red-600 text-white">{h.vuln_kev} explotadas</span>}
                        {(h.vuln_criticas ?? 0) > 0 && <span className="pill bg-red-50 text-red-700">{h.vuln_criticas} críticas</span>}
                        <button className="text-xs text-brand-600 hover:underline" onClick={() => setAbierto(verCves ? null : `cve:${h.nombre}`)}>{verCves ? "Ocultar" : `Ver ${h.vuln_total}`}</button>
                      </div>
                    )}
                    <div className="text-xs text-ink/55 mt-1">{h.vms_encendidas} de {h.vms} VMs encendidas · encendido hace {diasDesde(h.arranque, ahora) ?? "—"} días</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">Seguridad</div>
                    <div className="flex flex-wrap gap-1">
                      <span className={`pill ${h.ssh_activo ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>SSH {h.ssh_activo ? "activo" : "apagado"}</span>
                      {h.shell_activo && <span className="pill bg-red-50 text-red-700">Shell activa</span>}
                      <span className={`pill ${h.lockdown && h.lockdown !== "lockdownDisabled" ? "bg-emerald-50 text-emerald-700" : "bg-amber-500/15 text-amber-700"}`}>
                        Lockdown {h.lockdown === "lockdownStrict" ? "estricto" : h.lockdown === "lockdownNormal" ? "normal" : "desactivado"}</span>
                    </div>
                    {h.cert_vence && <div className="text-xs text-ink/55 mt-1">Certificado vence el {fechaCorta(h.cert_vence)}</div>}
                  </div>
                </div>
                {h.sensores?.length > 0 && (
                  <div className="text-sm text-red-700">Hardware: {h.sensores.map((s) => `${s.nombre} (${s.estado === "red" ? "falla" : "advertencia"})`).join(" · ")}</div>
                )}
                {verCves && (
                  <ul className="space-y-2 border-t border-line/[0.06] pt-3 max-h-80 overflow-y-auto">
                    {(h.vuln_cves ?? []).map((c) => (
                      <li key={c.id} className="text-sm">
                        <a href={`https://nvd.nist.gov/vuln/detail/${c.id}`} target="_blank" rel="noopener noreferrer" className="font-mono text-brand-700 hover:underline">{c.id}</a>{" "}
                        {c.kev && <span className="pill bg-red-600 text-white">Explotada</span>} <span className="text-xs text-ink/50">CVSS {c.cvss ?? "—"}</span>
                        <div className="text-xs text-ink/60 mt-0.5">{c.descripcion}</div>
                      </li>
                    ))}
                    <li className="text-xs text-ink/50">Son las vulnerabilidades publicadas para {h.version}; si el build ya incluye el parche del aviso de Broadcom (VMSA), no aplican.</li>
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* VMs */}
      {vista === "vms" && (
        <div className="space-y-4">
          {snaps.length > 0 && (
            <div className="card overflow-x-auto">
              <div className="px-4 pt-4 font-medium text-ink">Snapshots ({snaps.length})</div>
              <table className="data w-full">
                <thead><tr><th>VM</th><th>Snapshot</th><th>Creado</th><th>Tamaño</th></tr></thead>
                <tbody>
                  {snaps.filter((s) => coincide(s.vm, s.nombre)).map((s) => {
                    const d = diasDesde(s.creado, ahora) ?? 0;
                    return (
                      <tr key={`${s.vm}:${s.nombre}:${s.creado}`}>
                        <td className="text-sm font-medium">{s.vm}</td><td className="text-sm">{s.nombre}</td>
                        <td className={`text-sm whitespace-nowrap ${d > (estado?.dias_snapshot ?? 7) ? "text-amber-700 font-medium" : "text-ink/70"}`}>{fechaCorta(s.creado)} (hace {d} días)</td>
                        <td className="text-sm tabular-nums">{tamano(s.tamano_gb)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <select className="input w-auto" value={filtroVm} onChange={(e) => setFiltroVm(e.target.value)} aria-label="Filtro">
            <option value="todas">Todas</option><option value="encendidas">Encendidas</option><option value="apagadas">Apagadas</option><option value="tools">Con VMware Tools para revisar</option>
          </select>
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>VM</th><th>Estado</th><th>Host</th><th>Sistema</th><th>Recursos</th><th>Disco</th><th>VMware Tools</th></tr></thead>
              <tbody>
                {(() => {
                  const lista = vms.filter((v) => (filtroVm === "todas" || (filtroVm === "encendidas" && v.estado === "PoweredOn") || (filtroVm === "apagadas" && v.estado !== "PoweredOn") ||
                    (filtroVm === "tools" && v.estado === "PoweredOn" && v.tools && v.tools !== "guestToolsCurrent" && v.tools !== "guestToolsUnmanaged")) && coincide(v.nombre, v.host, v.so, v.ip));
                  if (!lista.length) return vacio(7, "Sin máquinas virtuales con ese filtro.");
                  return lista.map((v) => (
                    <tr key={v.nombre} className={v.estado === "PoweredOn" ? "" : "opacity-60"}>
                      <td className="text-sm font-medium">{v.nombre}{v.ip && <div className="text-xs text-ink/45 font-normal">{v.ip}</div>}</td>
                      <td>{v.estado === "PoweredOn" ? <span className="pill bg-emerald-50 text-emerald-700">Encendida</span> : <span className="pill bg-line/[0.05] text-ink/55">{v.estado === "Suspended" ? "Suspendida" : "Apagada"}</span>}</td>
                      <td className="text-sm text-ink/70">{v.host?.split(".")[0] ?? "—"}</td>
                      <td className="text-sm text-ink/70">{v.so ?? "—"}</td>
                      <td className="text-sm text-ink/70 whitespace-nowrap">{v.cpus ?? "—"} vCPU · {tamano(v.mem_gb)}</td>
                      <td className="text-sm text-ink/70 whitespace-nowrap">{tamano(v.usado_gb)} de {tamano(v.disco_gb)}</td>
                      <td className={`text-sm ${TOOLS[v.tools ?? ""]?.c ?? "text-ink/60"}`}>{TOOLS[v.tools ?? ""]?.t ?? v.tools ?? "—"}</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Datastores */}
      {vista === "datastores" && (
        <div className="grid lg:grid-cols-2 gap-4">
          {!ds.length && <div className="card p-8 text-center text-ink/40 lg:col-span-2">{cargando ? "Cargando…" : "Sin datos todavía."}</div>}
          {ds.filter((d) => coincide(d.nombre, d.tipo)).map((d) => {
            const p = pctUsado(d.capacidad_gb, d.libre_gb);
            const pr = proy.find((x) => x.tipo === "datastore" && x.nombre === d.nombre);
            return (
              <div key={d.nombre} className="card p-5 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-ink">{d.nombre}</div>
                    <div className="text-xs text-ink/50">{[d.tipo, d.hosts != null ? `${d.hosts} hosts` : null].filter(Boolean).join(" · ")}</div>
                  </div>
                  {d.estado !== "Available" && <span className="pill bg-red-600 text-white">{d.estado ?? "Sin estado"}</span>}
                </div>
                <Barra v={p} etiqueta={`${tamano(d.capacidad_gb != null && d.libre_gb != null ? d.capacidad_gb - d.libre_gb : null)} usados de ${tamano(d.capacidad_gb)} · libres ${tamano(d.libre_gb)}`} limite={limite} />
                <div className="text-xs text-ink/55">
                  {pr?.crecimiento_gb_dia != null ? <>Crece {pr.crecimiento_gb_dia.toLocaleString("es-AR")} GB por día{pr.dias_para_llenarse != null
                    ? <span className={pr.dias_para_llenarse < 45 ? "text-red-600 font-medium" : ""}> · se llena en ~{pr.dias_para_llenarse} días</span> : " · sin riesgo de llenarse por ahora"}</>
                    : "La tendencia aparece después de una semana de datos."}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Hallazgos */}
      {vista === "hallazgos" && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Severidad</th><th>Hallazgo</th></tr></thead>
            <tbody>
              {!hallazgos.length && vacio(2, "Sin hallazgos.")}
              {hallazgos.filter((h) => coincide(h.titulo, h.detalle)).sort((a, b) => (SEV[a.severidad]?.o ?? 9) - (SEV[b.severidad]?.o ?? 9) || a.titulo.localeCompare(b.titulo)).map((h) => (
                <tr key={`${h.ambito}:${h.tipo}:${h.clave}`}>
                  <td><span className={`pill ${SEV[h.severidad]?.c ?? ""}`}>{SEV[h.severidad]?.t ?? h.severidad}</span></td>
                  <td className="text-sm"><div className="font-medium text-ink">{h.titulo}</div><div className="text-ink/60">{h.detalle}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Alarmas y licencias */}
      {vista === "alarmas" && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="card overflow-x-auto">
            <div className="px-4 pt-4 font-medium text-ink">Alarmas activas en vCenter</div>
            <table className="data w-full">
              <tbody>
                {!alarmas.length && vacio(3, "Sin alarmas activas.")}
                {alarmas.filter((a) => coincide(a.alarma, a.entidad)).map((a) => (
                  <tr key={a.id}>
                    <td><span className={`pill ${a.estado === "red" ? "bg-red-600 text-white" : "bg-amber-500/15 text-amber-700"}`}>{a.estado === "red" ? "Crítica" : "Advertencia"}</span></td>
                    <td className="text-sm"><div className="font-medium">{a.alarma}</div><div className="text-ink/55">{a.entidad}{a.reconocida ? " · reconocida" : ""}</div></td>
                    <td className="text-sm text-ink/60 whitespace-nowrap">{a.fecha ? hace(a.fecha, ahora) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card overflow-x-auto">
            <div className="px-4 pt-4 font-medium text-ink">Licencias</div>
            <table className="data w-full">
              <tbody>
                {!licencias.length && vacio(3, "Sin datos (el usuario de vCenter necesita el privilegio Global → Licencias).")}
                {licencias.map((l) => {
                  const d = l.vence ? Math.floor((Date.parse(l.vence) - ahora) / 86400000) : null;
                  return (
                    <tr key={`${l.producto}:${l.edicion}`}>
                      <td className="text-sm"><div className="font-medium">{l.producto}</div><div className="text-ink/50 text-xs">{l.edicion}</div></td>
                      <td className="text-sm text-ink/70 tabular-nums">{l.usado ?? "—"} de {l.total ?? "—"}</td>
                      <td className={`text-sm whitespace-nowrap ${d != null && d <= (estado?.dias_aviso ?? 30) ? "text-red-600 font-medium" : "text-ink/70"}`}>{l.vence ? `vence ${fechaCorta(l.vence)}` : "Perpetua"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Virtualizacion() {
  return <Suspense><Contenido /></Suspense>;
}
