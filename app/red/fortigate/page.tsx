"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteFortiGate, { type EstadoFortiGate } from "@/components/PuenteFortiGate";
import { hace } from "@/lib/monitoreo";

type Cve = { id: string; cvss: number | null; severidad: string; kev: boolean; descripcion: string | null; accion: string | null };
type Equipo = {
  nombre: string; serial: string | null; hostname: string | null; modelo: string | null; version: string | null; build: string | null;
  cpu: number | null; mem: number | null; sesiones: number | null; ha_modo: string | null;
  ha_miembros: { serial: string; primario: boolean; checksum: string }[] | null; ha_peers: { serial: string; hostname: string; prioridad: number | null }[] | null;
  ha_sincronizado: boolean | null; responde: boolean | null; ultimo_ok: string | null; ultimo_error: string | null; avisos: string[];
  origen_logs: string | null; vuln_estado: string | null; vuln_consultado: string | null; vuln_total: number | null; vuln_criticas: number | null;
  vuln_altas: number | null; vuln_kev: number | null; vuln_max_cvss: number | null; vuln_cves: Cve[] | null;
};
type Hallazgo = { equipo: string; tipo: string; clave: string; severidad: string; titulo: string; detalle: string };
type Politica = {
  equipo: string; id: number; nombre: string | null; desde: string | null; hacia: string | null; origen: string | null; destino: string | null;
  servicio: string | null; accion: string | null; estado: string | null; log: string | null; hits: number | null; ultimo_uso: string | null;
};
type Cambio = { id: number; equipo: string; fecha: string; inicial: boolean; agregadas: number | null; quitadas: number | null; detalle: { ruta: string; linea: string; signo: string }[] };
type Vpn = { equipo: string; tipo: string; usuario: string; ip_publica: string; ip_tunel: string | null; desde: string | null; pais_codigo: string | null; pais: string | null; ciudad: string | null; isp: string | null };
type Fallo = { equipo: string; fecha: string; usuario: string; ip: string; motivo: string | null; accion: string | null };
type Amenaza = { equipo: string; fecha: string; tipo: string; severidad: string | null; nombre: string; accion: string | null; origen: string; destino: string; usuario: string | null };
type Licencia = { equipo: string; servicio: string; estado: string | null; vence: string | null };
type Certificado = { equipo: string; nombre: string; tipo: string | null; vence: string | null };
type Sdwan = { equipo: string; chequeo: string; enlace: string; estado: string | null; latencia: number | null; jitter: number | null; perdida: number | null };

type Vista = "resumen" | "configuracion" | "cambios" | "vpn" | "amenazas" | "licencias" | "sdwan";
const VISTAS: [Vista, string][] = [
  ["resumen", "Resumen"], ["configuracion", "Configuración"], ["cambios", "Cambios"], ["vpn", "VPN"],
  ["amenazas", "Amenazas"], ["licencias", "Licencias y certificados"], ["sdwan", "Enlaces"],
];

const SEV: Record<string, { t: string; c: string; o: number }> = {
  critica: { t: "Crítica", c: "bg-red-600 text-white", o: 0 },
  alta: { t: "Alta", c: "bg-orange-500/15 text-orange-700", o: 1 },
  media: { t: "Media", c: "bg-amber-500/15 text-amber-700", o: 2 },
  baja: { t: "Baja", c: "bg-line/[0.05] text-ink/60", o: 3 },
};
const SEV_CVE: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white", HIGH: "bg-orange-500/15 text-orange-700", MEDIUM: "bg-amber-500/15 text-amber-700", LOW: "bg-line/[0.05] text-ink/60",
};
const SEV_CVE_ES: Record<string, string> = { CRITICAL: "Crítica", HIGH: "Alta", MEDIUM: "Media", LOW: "Baja" };
const SEV_AMENAZA: Record<string, string> = {
  critical: "bg-red-600 text-white", high: "bg-orange-500/15 text-orange-700", medium: "bg-amber-500/15 text-amber-700",
  low: "bg-line/[0.05] text-ink/60", info: "bg-line/[0.05] text-ink/60",
};
const BLOQUEADO = ["blocked", "dropped", "reset", "clear_session", "block", "deny", "quarantine"];
const ORIGEN_LOGS: Record<string, string> = { fortianalyzer: "FortiAnalyzer", disk: "disco del equipo", memory: "memoria del equipo" };

const fecha = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "—");
const dia = (f: string | null) => (f ? new Date(f).toLocaleDateString("es-AR") : "—");
const dias = (f: string | null, ahora: number) => (f ? Math.floor((Date.parse(f) - ahora) / 86400000) : null);
const num = (n: number | null) => (n == null ? "—" : n.toLocaleString("es-AR"));
const bandera = (c: string | null) => (c && /^[A-Z]{2}$/i.test(c) ? String.fromCodePoint(...[...c.toUpperCase()].map((x) => 0x1f1a5 + x.charCodeAt(0))) : "");

function Barra({ v, etiqueta }: { v: number | null; etiqueta: string }) {
  const p = Math.max(0, Math.min(100, v ?? 0));
  const c = p >= 90 ? "bg-red-500" : p >= 75 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex justify-between text-xs text-ink/55"><span>{etiqueta}</span><span className="tabular-nums">{v == null ? "—" : `${Math.round(p)}%`}</span></div>
      <div className="h-1.5 rounded-full bg-line/[0.08] mt-1 overflow-hidden"><div className={`h-full ${c}`} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

function Contenido() {
  const { esAdmin } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (VISTAS.some(([k]) => k === params.get("vista")) ? params.get("vista") : "resumen") as Vista;
  const ir = (q: string) => router.replace(`/red/fortigate${q ? `?${q}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<EstadoFortiGate | null>(null);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [hallazgos, setHallazgos] = useState<Hallazgo[]>([]);
  const [politicas, setPoliticas] = useState<Politica[]>([]);
  const [cambios, setCambios] = useState<Cambio[]>([]);
  const [vpn, setVpn] = useState<Vpn[]>([]);
  const [fallos, setFallos] = useState<Fallo[]>([]);
  const [amenazas, setAmenazas] = useState<Amenaza[]>([]);
  const [licencias, setLicencias] = useState<Licencia[]>([]);
  const [certificados, setCertificados] = useState<Certificado[]>([]);
  const [sdwan, setSdwan] = useState<Sdwan[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const [filtroEquipo, setFiltroEquipo] = useState("");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [verPoliticas, setVerPoliticas] = useState(false);
  const [fv, setFv] = useState({ texto: "", tipo: "", pais: "", soloFuera: false });

  const cargar = useCallback(async () => {
    const sb = createClient();
    const desde = new Date(Date.now() - 7 * 86400000).toISOString();
    const [e, q, h, p, c, v, f, a, l, ce, s] = await Promise.all([
      sb.rpc("fg_estado"),
      sb.from("fg_equipos_vista").select("*").order("nombre"),
      sb.from("fg_hallazgos").select("*"),
      sb.from("fg_politicas").select("equipo,id,nombre,desde,hacia,origen,destino,servicio,accion,estado,log,hits,ultimo_uso").order("id"),
      sb.from("fg_cambios").select("*").order("fecha", { ascending: false }).limit(100),
      sb.from("fg_vpn").select("*").order("desde", { ascending: false }),
      sb.from("fg_vpn_fallos").select("*").gte("fecha", desde).order("fecha", { ascending: false }).limit(3000),
      sb.from("fg_amenazas").select("*").gte("fecha", desde).order("fecha", { ascending: false }).limit(1000),
      sb.from("fg_licencias").select("*").order("vence"),
      sb.from("fg_certificados").select("*").order("vence"),
      sb.from("fg_sdwan").select("*").order("chequeo"),
    ]);
    const err = e.error ?? q.error;
    setError(err ? (/fg_/.test(err.message) ? "Falta ejecutar supabase/fortigate.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoFortiGate) ?? null);
    setEquipos((q.data ?? []) as Equipo[]);
    setHallazgos((h.data ?? []) as Hallazgo[]);
    setPoliticas((p.data ?? []) as Politica[]);
    setCambios((c.data ?? []) as Cambio[]);
    setVpn((v.data ?? []) as Vpn[]);
    setFallos((f.data ?? []) as Fallo[]);
    setAmenazas((a.data ?? []) as Amenaza[]);
    setLicencias((l.data ?? []) as Licencia[]);
    setCertificados((ce.data ?? []) as Certificado[]);
    setSdwan((s.data ?? []) as Sdwan[]);
    setAhora(Date.now());
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 60000); return () => clearInterval(t); }, [cargar]);

  const q = texto.trim().toLowerCase();
  const coincide = (...v: (string | null | undefined)[]) => !q || v.some((x) => x?.toLowerCase().includes(q));
  const deEquipo = (n: string) => !filtroEquipo || n === filtroEquipo;

  const responden = equipos.filter((e) => e.responde).length;
  const kev = equipos.reduce((s, e) => s + (e.vuln_kev ?? 0), 0);
  const graves = hallazgos.filter((h) => h.severidad === "critica" || h.severidad === "alta");
  const fallos24 = fallos.filter((f) => Date.parse(f.fecha) > ahora - 86400000);
  const noBloqueadas = amenazas.filter((a) => Date.parse(a.fecha) > ahora - 86400000 && !BLOQUEADO.includes((a.accion ?? "").toLowerCase()));
  const porVencer = [...licencias, ...certificados].filter((x) => { const d = dias(x.vence, ahora); return d != null && d <= (estado?.dias_aviso ?? 30); });
  const enlacesMal = sdwan.filter((s) => s.estado !== "up" || (s.perdida ?? 0) > 5 || (s.latencia ?? 0) > 250);
  const reporteViejo = estado?.ultimo_reporte ? ahora - Date.parse(estado.ultimo_reporte) > (estado.minutos_sin_reporte ?? 20) * 60000 : false;
  const paisOk = (c: string | null) => !c || (estado?.paises_vpn ?? ["AR"]).includes(c.toUpperCase());

  const tarjetas = [
    { t: "FortiGate que responden", n: equipos.length ? `${responden} de ${equipos.length}` : "—", c: responden < equipos.length ? "text-red-600" : "text-ink", ir: "" },
    { t: "Vulnerabilidades explotadas (KEV)", n: kev, c: kev ? "text-red-600" : "text-ink", ir: "" },
    { t: "Configuración riesgosa (crítica o alta)", n: graves.length, c: graves.length ? "text-red-600" : "text-ink", ir: "vista=configuracion" },
    { t: "Intentos fallidos de VPN (24 h)", n: fallos24.length, c: fallos24.length >= (estado?.umbral_fallos ?? 10) ? "text-amber-700" : "text-ink", ir: "vista=vpn" },
    { t: "Amenazas no bloqueadas (24 h)", n: noBloqueadas.length, c: noBloqueadas.length ? "text-red-600" : "text-ink", ir: "vista=amenazas" },
    { t: "Licencias y certificados por vencer", n: porVencer.length, c: porVencer.length ? "text-amber-700" : "text-ink", ir: "vista=licencias" },
  ];

  const topIp = useMemo(() => {
    const m = new Map<string, { n: number; usuarios: Set<string>; ultima: string }>();
    fallos.filter((f) => deEquipo(f.equipo) && f.ip).forEach((f) => {
      const x = m.get(f.ip) ?? { n: 0, usuarios: new Set<string>(), ultima: f.fecha };
      x.n++; if (f.usuario) x.usuarios.add(f.usuario); if (f.fecha > x.ultima) x.ultima = f.fecha;
      m.set(f.ip, x);
    });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallos, filtroEquipo]);
  const topUsuario = useMemo(() => {
    const m = new Map<string, { n: number; ips: Set<string> }>();
    fallos.filter((f) => deEquipo(f.equipo) && f.usuario).forEach((f) => {
      const x = m.get(f.usuario) ?? { n: 0, ips: new Set<string>() };
      x.n++; if (f.ip) x.ips.add(f.ip);
      m.set(f.usuario, x);
    });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallos, filtroEquipo]);

  // Filtro de "Conectados ahora"
  const vpnEquipo = vpn.filter((v) => deEquipo(v.equipo));
  const tiposVpn = [...new Set(vpnEquipo.map((v) => v.tipo))].sort();
  const paisesVpn = [...new Map(vpnEquipo.filter((v) => v.pais_codigo).map((v) => [v.pais_codigo!.toUpperCase(), v.pais ?? v.pais_codigo!])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const fq = fv.texto.trim().toLowerCase();
  const vpnFiltrada = vpnEquipo.filter((v) =>
    coincide(v.usuario, v.ip_publica, v.pais, v.ciudad, v.isp) &&
    (!fq || [v.usuario, v.ip_publica, v.ip_tunel, v.pais, v.ciudad, v.isp].some((x) => x?.toLowerCase().includes(fq))) &&
    (!fv.tipo || v.tipo === fv.tipo) &&
    (!fv.pais || (fv.pais === "?" ? !v.pais_codigo : v.pais_codigo?.toUpperCase() === fv.pais)) &&
    (!fv.soloFuera || (!!v.pais_codigo && !paisOk(v.pais_codigo)))
  );

  async function quitarEquipo(n: string) {
    const { error } = await createClient().rpc("fg_quitar_equipo", { p_nombre: n });
    if (error) setError(error.message); else cargar();
  }

  const vacio = (cols: number, t: string) => <tr><td colSpan={cols} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : t}</td></tr>;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">FortiGate</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Estado de los firewalls y su cluster, versión de FortiOS contra vulnerabilidades conocidas, configuración riesgosa, conexiones e intentos
            fallidos de VPN, amenazas de IPS y antivirus, licencias y enlaces.
          </p>
        </div>
        {esAdmin && estado && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {estado && !estado.configurado && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está instalado el puente de FortiGate. {esAdmin ? "Tocá “Configurar” para ver cómo crear el usuario de API y generar el puente." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <PuenteFortiGate estado={estado} alCambiar={cargar} />}

      {estado?.configurado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${reporteViejo || !estado.ultimo_reporte ? "bg-amber-500/10" : ""}`}>
          <span className={reporteViejo ? "text-red-600" : ""}>
            <b>Último reporte del puente:</b> {estado.ultimo_reporte ? hace(estado.ultimo_reporte, ahora) : "todavía no reportó (¿instalaste el puente?)"}
          </span>
          <span className={estado.alertas ? "text-emerald-700" : "text-ink/50"}><b>Alertas:</b> {estado.alertas ? "activadas" : "apagadas"}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
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
            <button key={k} role="tab" aria-selected={vista === k} onClick={() => ir(k === "resumen" ? "" : `vista=${k}`)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${vista === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {equipos.length > 1 && (
            <select className="input max-w-[12rem]" value={filtroEquipo} onChange={(e) => setFiltroEquipo(e.target.value)} aria-label="Equipo">
              <option value="">Todos los equipos</option>
              {equipos.map((e) => <option key={e.nombre} value={e.nombre}>{e.nombre}</option>)}
            </select>
          )}
          {vista !== "resumen" && <input type="search" className="input max-w-xs" placeholder="Buscar…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />}
        </div>
      </div>

      {/* Resumen */}
      {vista === "resumen" && (
        <div className="grid lg:grid-cols-2 gap-4">
          {!equipos.length && <div className="card p-8 text-center text-ink/40 lg:col-span-2">{cargando ? "Cargando…" : "Sin datos todavía."}</div>}
          {equipos.filter((e) => deEquipo(e.nombre)).map((e) => {
            const ha = e.ha_modo && e.ha_modo !== "standalone";
            const miembros = e.ha_miembros ?? [];
            const verCves = abierto === `cve:${e.nombre}`;
            return (
              <div key={e.nombre} className="card p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-xl text-ink">{e.nombre}</h2>
                    <p className="text-sm text-ink/60">{[e.modelo, e.hostname, e.serial].filter(Boolean).join(" · ") || "—"}</p>
                  </div>
                  <div className="text-right">
                    {e.responde ? <span className="pill bg-emerald-50 text-emerald-700">Responde</span> : e.responde === false ? <span className="pill bg-red-600 text-white">Sin respuesta</span> : <span className="pill bg-line/[0.05] text-ink/50">Sin datos</span>}
                    {e.ultimo_ok && <div className="text-xs text-ink/45 mt-1">{hace(e.ultimo_ok, ahora)}</div>}
                  </div>
                </div>
                {e.ultimo_error && <p className="text-sm text-red-600">{e.ultimo_error}</p>}

                <div className="grid sm:grid-cols-3 gap-4">
                  <Barra v={e.cpu} etiqueta="CPU" />
                  <Barra v={e.mem} etiqueta="Memoria" />
                  <div>
                    <div className="text-xs text-ink/55">Sesiones</div>
                    <div className="font-display text-lg tabular-nums">{num(e.sesiones)}</div>
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">FortiOS</div>
                    <div className="font-medium">{e.version ? `v${e.version}` : "—"}{e.build ? <span className="text-ink/50 font-normal"> build {e.build}</span> : null}</div>
                    {e.vuln_estado === "ok" ? (
                      <div className="mt-1 space-y-1">
                        <div className="flex flex-wrap gap-1">
                          {(e.vuln_kev ?? 0) > 0 && <span className="pill bg-red-600 text-white">{e.vuln_kev} explotadas</span>}
                          {(e.vuln_criticas ?? 0) > 0 && <span className="pill bg-red-50 text-red-700">{e.vuln_criticas} críticas</span>}
                          {(e.vuln_altas ?? 0) > 0 && <span className="pill bg-orange-500/15 text-orange-700">{e.vuln_altas} altas</span>}
                          <span className="pill bg-line/[0.05] text-ink/60">{e.vuln_total} en total</span>
                        </div>
                        <button className="text-xs text-brand-600 hover:underline" onClick={() => setAbierto(verCves ? null : `cve:${e.nombre}`)}>
                          {verCves ? "Ocultar detalle" : "Ver vulnerabilidades"}
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs text-ink/50 mt-1">
                        {e.vuln_estado === "sin_datos" ? "Sin vulnerabilidades registradas en NVD para esta versión." : e.vuln_estado === "error" ? "No se pudo consultar NVD (se reintenta sola)." : e.version ? "Consultando vulnerabilidades (se revisa una vez por hora)…" : ""}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">Alta disponibilidad</div>
                    {!ha ? <div className="text-ink/60">{e.ha_modo === "standalone" ? "Sin cluster (standalone)" : "—"}</div> : (
                      <div className="space-y-1">
                        <div className="flex flex-wrap gap-1">
                          <span className="pill bg-line/[0.05] text-ink/70">{e.ha_modo === "a-p" ? "Activo-pasivo" : e.ha_modo === "a-a" ? "Activo-activo" : e.ha_modo}</span>
                          {miembros.length < 2 ? <span className="pill bg-red-600 text-white">Un solo miembro</span>
                            : e.ha_sincronizado === false ? <span className="pill bg-red-50 text-red-700">Desincronizado</span>
                            : <span className="pill bg-emerald-50 text-emerald-700">Sincronizado</span>}
                        </div>
                        <ul className="text-xs text-ink/60">
                          {miembros.map((m) => {
                            const peer = (e.ha_peers ?? []).find((p) => p.serial === m.serial);
                            return <li key={m.serial}>{m.primario ? "Primario" : "Secundario"}: {peer?.hostname || m.serial}{peer?.hostname ? <span className="text-ink/40"> ({m.serial})</span> : null}</li>;
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>

                {verCves && (
                  <ul className="space-y-2 border-t border-line/[0.06] pt-3 max-h-96 overflow-y-auto">
                    {(e.vuln_cves ?? []).map((c) => (
                      <li key={c.id} className="text-sm">
                        <a href={`https://nvd.nist.gov/vuln/detail/${c.id}`} target="_blank" rel="noopener noreferrer" className="font-mono text-brand-700 hover:underline">{c.id}</a>{" "}
                        {c.kev && <span className="pill bg-red-600 text-white">Explotada</span>}{" "}
                        <span className={`pill ${SEV_CVE[c.severidad] ?? "bg-line/[0.05] text-ink/60"}`}>{SEV_CVE_ES[c.severidad] ?? "Sin puntaje"}{c.cvss != null ? ` ${c.cvss}` : ""}</span>
                        <div className="text-xs text-ink/60 mt-0.5">{c.descripcion}</div>
                        {c.kev && c.accion && <div className="text-xs text-red-700 mt-0.5">CISA: {c.accion}</div>}
                      </li>
                    ))}
                    <li className="text-xs text-ink/50">
                      Revisá la versión recomendada en el <a className="text-brand-600 hover:underline" href="https://docs.fortinet.com/upgrade-tool" target="_blank" rel="noopener noreferrer">Upgrade Path de Fortinet</a> y
                      los avisos en <a className="text-brand-600 hover:underline" href="https://www.fortiguard.com/psirt" target="_blank" rel="noopener noreferrer">FortiGuard PSIRT</a>.
                    </li>
                  </ul>
                )}

                <div className="text-xs text-ink/50 space-y-0.5">
                  {e.origen_logs && <div>Registros leídos de: {ORIGEN_LOGS[e.origen_logs] ?? e.origen_logs}</div>}
                  {(e.avisos ?? []).length > 0 && <div className="text-amber-700">Sin datos de: {e.avisos.join(" · ")}</div>}
                </div>
                {esAdmin && e.responde === false && (
                  <button className="text-sm text-ink/40 hover:text-red-600" onClick={() => quitarEquipo(e.nombre)}>Quitar de la lista</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Configuración */}
      {vista === "configuracion" && (
        <div className="space-y-4">
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Severidad</th><th>Equipo</th><th>Hallazgo</th></tr></thead>
              <tbody>
                {!hallazgos.length && vacio(3, "No se encontró configuración riesgosa.")}
                {hallazgos.filter((h) => deEquipo(h.equipo) && coincide(h.titulo, h.detalle, h.equipo))
                  .sort((a, b) => (SEV[a.severidad]?.o ?? 9) - (SEV[b.severidad]?.o ?? 9) || a.equipo.localeCompare(b.equipo))
                  .map((h) => (
                    <tr key={`${h.equipo}:${h.tipo}:${h.clave}`}>
                      <td><span className={`pill ${SEV[h.severidad]?.c ?? ""}`}>{SEV[h.severidad]?.t ?? h.severidad}</span></td>
                      <td className="text-sm whitespace-nowrap">{h.equipo}</td>
                      <td className="text-sm"><div className="font-medium text-ink">{h.titulo}</div><div className="text-ink/60">{h.detalle}</div></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div>
            <button className="btn-secondary" onClick={() => setVerPoliticas(!verPoliticas)}>{verPoliticas ? "Ocultar políticas" : `Ver todas las políticas (${politicas.filter((p) => deEquipo(p.equipo)).length})`}</button>
          </div>
          {verPoliticas && (
            <div className="card overflow-x-auto">
              <table className="data w-full">
                <thead><tr><th>Equipo</th><th>ID</th><th>Nombre</th><th>De → a</th><th>Origen / destino</th><th>Servicio</th><th>Acción</th><th>Usos</th><th>Último uso</th></tr></thead>
                <tbody>
                  {politicas.filter((p) => deEquipo(p.equipo) && coincide(p.nombre, p.origen, p.destino, p.servicio, p.desde, p.hacia, String(p.id))).map((p) => (
                    <tr key={`${p.equipo}:${p.id}`} className={p.estado === "disable" ? "opacity-50" : ""}>
                      <td className="text-sm whitespace-nowrap">{p.equipo}</td>
                      <td className="text-sm tabular-nums">{p.id}</td>
                      <td className="text-sm">{p.nombre || "—"}{p.estado === "disable" && <span className="pill bg-line/[0.05] text-ink/50 ml-1">Deshabilitada</span>}{p.log === "disable" && <span className="pill bg-amber-500/15 text-amber-700 ml-1">Sin log</span>}</td>
                      <td className="text-xs text-ink/70">{p.desde} → {p.hacia}</td>
                      <td className="text-xs text-ink/70 max-w-xs">{p.origen} → {p.destino}</td>
                      <td className="text-xs text-ink/70 max-w-[12rem]">{p.servicio}</td>
                      <td><span className={`pill ${p.accion === "accept" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{p.accion === "accept" ? "Permite" : p.accion === "deny" ? "Bloquea" : p.accion}</span></td>
                      <td className="text-sm tabular-nums">{num(p.hits)}</td>
                      <td className="text-sm text-ink/70 whitespace-nowrap">{dia(p.ultimo_uso)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Cambios de configuración */}
      {vista === "cambios" && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Fecha</th><th>Equipo</th><th>Cambio</th></tr></thead>
            <tbody>
              {!cambios.length && vacio(3, "Sin cambios registrados. Para detectarlos hay que activar “Backup y cambios” al generar el puente.")}
              {cambios.filter((c) => deEquipo(c.equipo) && coincide(c.equipo, ...c.detalle.map((d) => d.ruta + " " + d.linea))).map((c) => {
                const ver = abierto === `cambio:${c.id}`;
                return (
                  <tr key={c.id} className="align-top">
                    <td className="text-sm text-ink/70 whitespace-nowrap">{fecha(c.fecha)}</td>
                    <td className="text-sm whitespace-nowrap">{c.equipo}</td>
                    <td className="text-sm">
                      {c.inicial ? <span className="text-ink/60">Primer backup guardado (punto de partida para comparar)</span> : (
                        <>
                          <button className="text-brand-600 hover:underline" onClick={() => setAbierto(ver ? null : `cambio:${c.id}`)}>
                            {c.agregadas ?? 0} líneas nuevas y {c.quitadas ?? 0} quitadas
                          </button>
                          {ver && (
                            <div className="mt-2 font-mono text-xs space-y-0.5 max-h-96 overflow-y-auto">
                              {c.detalle.map((d, i) => (
                                <div key={i} className={d.signo === "+" ? "text-emerald-700" : "text-red-700"}>
                                  <span className="text-ink/40">{d.ruta} ›</span> {d.signo} {d.linea}
                                </div>
                              ))}
                              {(c.agregadas ?? 0) + (c.quitadas ?? 0) > c.detalle.length && <div className="text-ink/50 font-sans">Se muestran las primeras {c.detalle.length}. El backup completo está en el servidor del puente.</div>}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-ink/50 px-4 py-3">Contraseñas, claves y communities se muestran como ****. El archivo completo queda solo en el servidor del puente (C:\ProgramData\AccusysPuenteFortiGate\backups).</p>
        </div>
      )}

      {/* VPN */}
      {vista === "vpn" && (
        <div className="space-y-4">
          <div className="card overflow-x-auto">
            <div className="px-4 pt-4 flex flex-wrap items-end justify-between gap-3">
              <div className="font-medium text-ink">
                Conectados ahora{" "}
                <span className="text-sm font-normal text-ink/50">
                  {vpnFiltrada.length === vpnEquipo.length ? `(${vpnEquipo.length})` : `(${vpnFiltrada.length} de ${vpnEquipo.length})`}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input type="search" className="input w-52" placeholder="Usuario, IP, ciudad, proveedor…" aria-label="Filtrar conectados"
                  value={fv.texto} onChange={(e) => setFv({ ...fv, texto: e.target.value })} />
                <select className="input w-auto" aria-label="Tipo de VPN" value={fv.tipo} onChange={(e) => setFv({ ...fv, tipo: e.target.value })}>
                  <option value="">SSL e IPsec</option>
                  {tiposVpn.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="input w-auto" aria-label="País" value={fv.pais} onChange={(e) => setFv({ ...fv, pais: e.target.value })}>
                  <option value="">Todos los países</option>
                  {paisesVpn.map(([c, n]) => <option key={c} value={c}>{bandera(c)} {n}</option>)}
                  {vpnEquipo.some((v) => !v.pais_codigo) && <option value="?">Sin ubicar todavía</option>}
                </select>
                <label className="flex items-center gap-1.5 text-sm text-ink/70">
                  <input type="checkbox" checked={fv.soloFuera} onChange={(e) => setFv({ ...fv, soloFuera: e.target.checked })} />
                  Solo desde países no permitidos
                </label>
                {(fv.texto || fv.tipo || fv.pais || fv.soloFuera) && (
                  <button type="button" className="text-sm text-brand-600 hover:underline" onClick={() => setFv({ texto: "", tipo: "", pais: "", soloFuera: false })}>Limpiar</button>
                )}
              </div>
            </div>
            <table className="data w-full">
              <thead><tr><th>Usuario</th><th>Tipo</th><th>Desde</th><th>IP pública</th><th>IP del túnel</th><th>Conectado</th><th>Equipo</th></tr></thead>
              <tbody>
                {!vpnEquipo.length && vacio(7, "No hay nadie conectado por VPN.")}
                {vpnEquipo.length > 0 && !vpnFiltrada.length && vacio(7, "Nadie coincide con el filtro.")}
                {vpnFiltrada.map((v) => (
                  <tr key={`${v.equipo}:${v.tipo}:${v.usuario}:${v.ip_publica}`}>
                    <td className="text-sm font-medium">{v.usuario}</td>
                    <td className="text-sm">{v.tipo}</td>
                    <td className="text-sm">
                      {v.pais_codigo ? <span className={paisOk(v.pais_codigo) ? "" : "pill bg-red-600 text-white"}>{bandera(v.pais_codigo)} {v.pais ?? v.pais_codigo}</span> : "—"}
                      {v.ciudad && <span className="text-ink/50"> · {v.ciudad}</span>}
                      {v.isp && <div className="text-xs text-ink/45">{v.isp}</div>}
                    </td>
                    <td className="text-sm font-mono">{v.ip_publica || "—"}</td>
                    <td className="text-sm font-mono text-ink/60">{v.ip_tunel ?? "—"}</td>
                    <td className="text-sm text-ink/70 whitespace-nowrap">{v.desde ? hace(v.desde, ahora) : "—"}</td>
                    <td className="text-sm">{v.equipo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="card overflow-x-auto">
              <div className="px-4 pt-4 font-medium text-ink">Intentos fallidos por IP (7 días)</div>
              <table className="data w-full">
                <thead><tr><th>IP</th><th>Intentos</th><th>Usuarios probados</th><th>Último</th></tr></thead>
                <tbody>
                  {!topIp.length && vacio(4, "Sin intentos fallidos.")}
                  {topIp.filter(([ip, x]) => coincide(ip, ...x.usuarios)).map(([ip, x]) => (
                    <tr key={ip}>
                      <td className="text-sm font-mono">{ip}</td>
                      <td className={`text-sm tabular-nums ${x.n >= (estado?.umbral_fallos ?? 10) ? "text-red-600 font-medium" : ""}`}>{x.n}</td>
                      <td className="text-xs text-ink/70 max-w-xs">{[...x.usuarios].slice(0, 8).join(", ") || "—"}{x.usuarios.size > 8 ? ` y ${x.usuarios.size - 8} más` : ""}</td>
                      <td className="text-sm text-ink/70 whitespace-nowrap">{hace(x.ultima, ahora)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card overflow-x-auto">
              <div className="px-4 pt-4 font-medium text-ink">Intentos fallidos por usuario (7 días)</div>
              <table className="data w-full">
                <thead><tr><th>Usuario</th><th>Intentos</th><th>Desde</th></tr></thead>
                <tbody>
                  {!topUsuario.length && vacio(3, "Sin intentos fallidos.")}
                  {topUsuario.filter(([u]) => coincide(u)).map(([u, x]) => (
                    <tr key={u}>
                      <td className="text-sm font-medium">{u}</td>
                      <td className={`text-sm tabular-nums ${x.n >= (estado?.umbral_fallos ?? 10) ? "text-red-600 font-medium" : ""}`}>{x.n}</td>
                      <td className="text-sm text-ink/70">{x.ips.size} {x.ips.size === 1 ? "IP" : "IP distintas"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-ink/50">
            Muchos intentos desde una misma IP con usuarios distintos es un ataque de diccionario: conviene bloquearla (o limitar la VPN por país con
            una política de geolocalización) y exigir doble factor en la VPN.
          </p>
        </div>
      )}

      {/* Amenazas */}
      {vista === "amenazas" && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Severidad</th><th>Amenaza</th><th>Acción</th><th>Origen → destino</th><th>Equipo</th></tr></thead>
            <tbody>
              {!amenazas.length && vacio(7, "Sin amenazas registradas en los últimos 7 días.")}
              {amenazas.filter((a) => deEquipo(a.equipo) && coincide(a.nombre, a.origen, a.destino, a.usuario, a.tipo)).map((a, i) => {
                const bloqueada = BLOQUEADO.includes((a.accion ?? "").toLowerCase());
                return (
                  <tr key={i}>
                    <td className="text-sm text-ink/70 whitespace-nowrap">{fecha(a.fecha)}</td>
                    <td className="text-sm">{a.tipo}</td>
                    <td>{a.severidad ? <span className={`pill ${SEV_AMENAZA[a.severidad] ?? "bg-line/[0.05] text-ink/60"}`}>{a.severidad}</span> : "—"}</td>
                    <td className="text-sm">
                      {a.tipo === "IPS" && a.nombre ? <a className="text-brand-700 hover:underline" href={`https://www.fortiguard.com/search?q=${encodeURIComponent(a.nombre)}&engine=1`} target="_blank" rel="noopener noreferrer">{a.nombre}</a> : a.nombre || "—"}
                      {a.usuario && <div className="text-xs text-ink/50">Usuario: {a.usuario}</div>}
                    </td>
                    <td><span className={`pill ${bloqueada ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{bloqueada ? "Bloqueada" : `No bloqueada (${a.accion ?? "—"})`}</span></td>
                    <td className="text-sm font-mono text-ink/70 whitespace-nowrap">{a.origen || "—"} → {a.destino || "—"}</td>
                    <td className="text-sm">{a.equipo}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Licencias y certificados */}
      {vista === "licencias" && (
        <div className="grid lg:grid-cols-2 gap-4">
          {([["Licencias y soporte (FortiGuard / FortiCare)", licencias.map((l) => ({ k: `${l.equipo}:${l.servicio}`, equipo: l.equipo, nombre: l.servicio, extra: l.estado, vence: l.vence }))],
             ["Certificados propios", certificados.map((c) => ({ k: `${c.equipo}:${c.nombre}`, equipo: c.equipo, nombre: c.nombre, extra: c.tipo, vence: c.vence }))]] as const).map(([titulo, filas]) => (
            <div key={titulo} className="card overflow-x-auto">
              <div className="px-4 pt-4 font-medium text-ink">{titulo}</div>
              <table className="data w-full">
                <thead><tr><th>Equipo</th><th>Nombre</th><th>Vence</th></tr></thead>
                <tbody>
                  {!filas.length && vacio(3, "Sin datos.")}
                  {filas.filter((f) => deEquipo(f.equipo) && coincide(f.nombre, f.equipo)).map((f) => {
                    const d = dias(f.vence, ahora);
                    const vencida = (d != null && d < 0) || /expired/i.test(f.extra ?? "");
                    const pronto = d != null && d <= (estado?.dias_aviso ?? 30);
                    return (
                      <tr key={f.k}>
                        <td className="text-sm whitespace-nowrap">{f.equipo}</td>
                        <td className="text-sm">{f.nombre}{f.extra && <span className="text-xs text-ink/45"> · {f.extra}</span>}</td>
                        <td className="text-sm whitespace-nowrap">
                          {dia(f.vence)}{" "}
                          {vencida ? <span className="pill bg-red-600 text-white">Vencida</span> : pronto ? <span className="pill bg-amber-500/15 text-amber-700">en {d} días</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {/* SD-WAN */}
      {vista === "sdwan" && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Equipo</th><th>Enlace</th><th>Chequeo</th><th>Estado</th><th>Latencia</th><th>Jitter</th><th>Pérdida</th></tr></thead>
            <tbody>
              {!sdwan.length && vacio(7, "Sin datos de SD-WAN (el equipo no tiene chequeos de salud configurados o el usuario de API no tiene permiso).")}
              {sdwan.filter((s) => deEquipo(s.equipo) && coincide(s.enlace, s.chequeo, s.equipo)).map((s) => {
                const mal = enlacesMal.includes(s);
                return (
                  <tr key={`${s.equipo}:${s.chequeo}:${s.enlace}`}>
                    <td className="text-sm">{s.equipo}</td>
                    <td className="text-sm font-medium">{s.enlace}</td>
                    <td className="text-sm text-ink/70">{s.chequeo}</td>
                    <td><span className={`pill ${s.estado !== "up" ? "bg-red-600 text-white" : mal ? "bg-amber-500/15 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>{s.estado !== "up" ? "Caído" : mal ? "Degradado" : "OK"}</span></td>
                    <td className="text-sm tabular-nums">{s.estado === "up" && s.latencia != null ? `${Math.round(s.latencia)} ms` : "—"}</td>
                    <td className="text-sm tabular-nums">{s.estado === "up" && s.jitter != null ? `${Math.round(s.jitter)} ms` : "—"}</td>
                    <td className="text-sm tabular-nums">{s.perdida != null ? `${Math.round(s.perdida)}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function FortiGate() {
  return <Suspense><Contenido /></Suspense>;
}
