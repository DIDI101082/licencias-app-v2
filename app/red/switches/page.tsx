"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteSwitches, { type EstadoSwitches } from "@/components/PuenteSwitches";
import { hace } from "@/lib/monitoreo";

type Switch = {
  id: number; nombre: string; ip: string; zona: string | null; notas: string | null; activo: boolean; responde: boolean | null;
  sys_nombre: string | null; sys_descr: string | null; uptime_seg: number | null; poe_total: number | null; poe_uso: number | null;
  ultimo_ok: string | null; ultimo_error: string | null; reinicio_en: string | null;
};
type Puerto = {
  switch_id: number; ifindex: number; nombre: string | null; descr: string | null; alias: string | null; admin_up: boolean | null;
  oper_up: boolean | null; velocidad_mbps: number | null; in_bps: number | null; out_bps: number | null; uso_pct: number | null;
  err_delta: number | null; ultimo_cambio: string | null; cambios_1h: number; troncal: boolean | null; troncal_detectado: boolean;
  es_troncal: boolean; vecino: string | null; vecino_puerto: string | null; vecino_protocolo: string | null; macs: number;
};
type Disp = {
  mac: string; vlan: number; switch_id: number; switch_nombre: string; zona: string | null; ifindex: number; puerto: string | null;
  puerto_alias: string | null; primera_vez: string; ultima_vez: string; mac_aleatoria: boolean; agente_hostname: string | null;
  inventario_codigo: string | null; inventario_id: string | null; unifi_nombre: string | null; conocido_descripcion: string | null;
  unifi_hostname: string | null; fabricante: string | null; conocido: boolean;
};
type Evento = { id: number; switch_id: number; ifindex: number | null; tipo: string; detalle: string | null; fecha: string };

type Vista = "switches" | "dispositivos" | "eventos";
const EVENTO: Record<string, { t: string; c: string }> = {
  caido: { t: "Puerto caído", c: "bg-red-50 text-red-600" },
  activo: { t: "Puerto activo", c: "bg-emerald-50 text-emerald-700" },
  reinicio: { t: "Reinicio", c: "bg-amber-500/10 text-amber-700" },
  sin_respuesta: { t: "Sin respuesta", c: "bg-red-600 text-white" },
  responde: { t: "Volvió a responder", c: "bg-emerald-50 text-emerald-700" },
};

const bps = (v: number | null) => {
  if (v == null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace(".", ",")} Gbps`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(".", ",")} Mbps`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} kbps`;
  return `${Math.round(v)} bps`;
};
const velocidad = (m: number | null) => (m == null ? "—" : m >= 1000 ? `${m / 1000} Gbps` : `${m} Mbps`);
const encendido = (s: number | null) => {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d} ${d === 1 ? "día" : "días"}`;
  const h = Math.floor(s / 3600);
  return h >= 1 ? `${h} h` : `${Math.max(1, Math.floor(s / 60))} min`;
};
const corto = (n: string | null, i: number) => {
  const t = n ?? String(i);
  const m = t.match(/(\d+(?:\/\d+)*)$/);
  return m ? m[1] : t.slice(-6);
};
// Estado de un puerto para la vista de bocas
function estadoPuerto(p: Puerto) {
  if (p.admin_up === false) return { t: "Deshabilitado", c: "border-dashed border-line/30 bg-transparent text-ink/35" };
  if (!p.oper_up) return p.es_troncal ? { t: "Troncal caído", c: "bg-red-600 text-white border-red-700" } : { t: "Sin conexión", c: "bg-line/[0.06] text-ink/45 border-line/10" };
  if ((p.err_delta ?? 0) > 0 || p.cambios_1h >= 4) return { t: "Con errores o inestable", c: "bg-red-50 text-red-700 border-red-300" };
  if (p.velocidad_mbps != null && p.velocidad_mbps < 1000) return { t: `Conectado a ${velocidad(p.velocidad_mbps)}`, c: "bg-amber-500/15 text-amber-800 border-amber-500/40" };
  return { t: `Conectado a ${velocidad(p.velocidad_mbps)}`, c: "bg-emerald-500/15 text-emerald-800 border-emerald-500/40" };
}
const identidad = (d: Disp) => d.agente_hostname ?? (d.inventario_codigo ? `Inventario ${d.inventario_codigo}` : null) ?? d.unifi_nombre ?? d.conocido_descripcion ?? d.unifi_hostname;

function Contenido() {
  const { esAdmin, puedeEditar } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (["switches", "dispositivos", "eventos"].includes(params.get("vista") ?? "") ? params.get("vista") : "switches") as Vista;
  const elegido = params.get("switch") ? Number(params.get("switch")) : null;
  const ir = (q: string) => router.replace(`/red/switches${q ? `?${q}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<EstadoSwitches | null>(null);
  const [switches, setSwitches] = useState<Switch[]>([]);
  const [puertos, setPuertos] = useState<Puerto[]>([]);
  const [disp, setDisp] = useState<Disp[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const [texto, setTexto] = useState("");
  const [soloDesconocidos, setSoloDesconocidos] = useState(false);
  const [aprobando, setAprobando] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState("");

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, s, p, d, v] = await Promise.all([
      sb.rpc("sw_estado"),
      sb.from("sw_switches").select("*").order("nombre"),
      sb.from("sw_puertos_vista").select("*").order("ifindex"),
      sb.from("sw_dispositivos_vista").select("*"),
      sb.from("sw_eventos").select("*").order("fecha", { ascending: false }).limit(300),
    ]);
    const err = e.error ?? s.error;
    setError(err ? (/sw_/.test(err.message) ? "Falta ejecutar supabase/switches.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoSwitches) ?? null);
    setSwitches((s.data ?? []) as Switch[]);
    setPuertos((p.data ?? []) as Puerto[]);
    setDisp((d.data ?? []) as Disp[]);
    setEventos((v.data ?? []) as Evento[]);
    setAhora(Date.now());
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 60000); return () => clearInterval(t); }, [cargar]);

  const activos = switches.filter((s) => s.activo);
  const responden = activos.filter((s) => s.responde).length;
  const troncalesCaidos = puertos.filter((p) => p.es_troncal && p.admin_up && !p.oper_up && activos.some((s) => s.id === p.switch_id && s.responde));
  const conProblemas = puertos.filter((p) => (p.err_delta ?? 0) > 0 || p.cambios_1h >= 4 || (p.uso_pct ?? 0) >= (estado?.umbral_uso ?? 85));
  const desconocidos = disp.filter((d) => !d.conocido);
  const nombreSw = (id: number) => switches.find((s) => s.id === id)?.nombre ?? `#${id}`;
  const reporteViejo = estado?.ultimo_reporte ? ahora - Date.parse(estado.ultimo_reporte) > (estado.minutos_sin_reporte ?? 20) * 60000 : false;
  const q = texto.trim().toLowerCase();
  const coincide = (...v: (string | null | undefined)[]) => !q || v.some((x) => x?.toLowerCase().includes(q));

  async function aprobar(mac: string) {
    if (!descripcion.trim()) return;
    const { error } = await createClient().from("unifi_conocidos").upsert({ mac, descripcion: descripcion.trim() });
    if (error) return setError(error.message.includes("row-level") ? "Para aprobar dispositivos hace falta acceso a la solapa Seguridad." : error.message);
    setAprobando(null); setDescripcion(""); cargar();
  }
  async function cambiarSwitch(s: Switch, cambios: Partial<Switch>) {
    const { error } = await createClient().from("sw_switches").update(cambios).eq("id", s.id);
    if (error) setError(error.message); else cargar();
  }
  async function quitarSwitch(s: Switch) {
    const { error } = await createClient().from("sw_switches").delete().eq("id", s.id);
    if (error) setError(error.message); else { ir(""); cargar(); }
  }
  async function troncal(p: Puerto, valor: string) {
    const { error } = await createClient().rpc("sw_troncal_guardar", { p_switch: p.switch_id, p_ifindex: p.ifindex, p_valor: valor === "" ? null : valor === "si" });
    if (error) setError(error.message); else cargar();
  }

  const tarjetas = [
    { t: "Switches que responden", n: activos.length ? `${responden} de ${activos.length}` : "—", c: responden < activos.length ? "text-red-600" : "text-ink", ir: "" },
    { t: "Enlaces troncales caídos", n: troncalesCaidos.length, c: troncalesCaidos.length ? "text-red-600" : "text-ink", ir: "" },
    { t: "Puertos con errores, inestables o saturados", n: conProblemas.length, c: conProblemas.length ? "text-amber-700" : "text-ink", ir: "" },
    { t: "Dispositivos desconocidos por cable", n: desconocidos.length, c: desconocidos.length ? "text-red-600" : "text-ink", ir: "vista=dispositivos" },
  ];

  const sw = elegido ? switches.find((s) => s.id === elegido) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Switches</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Estado de cada switch y de cada puerto por SNMP: qué está conectado en cada boca, enlaces troncales, errores y tráfico. Se actualiza
            cada pocos minutos.
          </p>
        </div>
        {esAdmin && estado && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {estado && !estado.configurado && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está instalado el puente de switches. {esAdmin ? "Tocá “Configurar” para cargar los switches y generar el puente." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <PuenteSwitches estado={estado} alCambiar={cargar} />}

      {estado?.configurado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${reporteViejo || !estado.ultimo_reporte ? "bg-amber-500/10" : ""}`}>
          <span className={reporteViejo ? "text-red-600" : ""}>
            <b>Último reporte del puente:</b> {estado.ultimo_reporte ? hace(estado.ultimo_reporte, ahora) : "todavía no reportó (¿instalaste el puente?)"}
          </span>
          <span className={estado.alertas ? "text-emerald-700" : "text-ink/50"}><b>Alertas:</b> {estado.alertas ? "activadas" : "apagadas"}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {tarjetas.map((t) => (
          <button key={t.t} onClick={() => ir(t.ir)} className="card p-5 text-left hover:border-brand-300 transition-colors">
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div role="tablist" aria-label="Vistas" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1">
          {([["switches", "Switches"], ["dispositivos", "Dispositivos por cable"], ["eventos", "Eventos"]] as [Vista, string][]).map(([k, t]) => (
            <button key={k} role="tab" aria-selected={vista === k && !sw} onClick={() => ir(k === "switches" ? "" : `vista=${k}`)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${vista === k && !sw ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
        <input type="search" className="input max-w-xs" placeholder="Buscar switch, puerto, MAC, equipo…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
      </div>

      {/* Detalle de un switch */}
      {sw && (() => {
        const ps = puertos.filter((p) => p.switch_id === sw.id);
        const porPuerto = (i: number) => disp.filter((d) => d.switch_id === sw.id && d.ifindex === i);
        return (
          <div className="space-y-4">
            <div className="card p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <button className="text-sm text-brand-600 hover:underline" onClick={() => ir("")}>← Todos los switches</button>
                  <h2 className="font-display text-xl text-ink mt-1">{sw.nombre}</h2>
                  <p className="text-sm text-ink/60">{[sw.ip, sw.zona, sw.sys_nombre].filter(Boolean).join(" · ")}</p>
                  {sw.sys_descr && <p className="text-xs text-ink/45 mt-1 max-w-3xl">{sw.sys_descr}</p>}
                </div>
                <div className="text-sm text-right space-y-0.5">
                  <div>{sw.responde ? <span className="pill bg-emerald-50 text-emerald-700">Responde</span> : sw.responde === false ? <span className="pill bg-red-600 text-white">Sin respuesta</span> : <span className="pill bg-line/[0.05] text-ink/50">Sin datos</span>}</div>
                  <div className="text-ink/60">Encendido hace {encendido(sw.uptime_seg)}</div>
                  {sw.poe_total ? <div className="text-ink/60">PoE {Math.round(sw.poe_uso ?? 0)} de {Math.round(sw.poe_total)} W</div> : null}
                </div>
              </div>
              {sw.ultimo_error && <p className="text-sm text-red-600">{sw.ultimo_error}</p>}

              {ps.length > 0 && (
                <div>
                  <div className="flex flex-wrap gap-1.5" aria-label="Puertos del switch">
                    {ps.map((p) => {
                      const e = estadoPuerto(p);
                      return (
                        <a key={p.ifindex} href={`#puerto-${p.ifindex}`}
                          title={`${p.nombre ?? p.ifindex}${p.alias ? ` · ${p.alias}` : ""} · ${e.t}${p.es_troncal ? " · troncal" : ""}`}
                          className={`relative h-10 min-w-[2.75rem] px-1.5 rounded-md border text-[11px] font-medium tabular-nums flex items-center justify-center ${e.c} ${p.es_troncal ? "ring-2 ring-brand-500/60" : ""}`}>
                          {corto(p.nombre, p.ifindex)}
                        </a>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-ink/55">
                    <span className="flex items-center gap-1"><i className="h-3 w-3 rounded-sm bg-emerald-500/40 inline-block" /> 1 Gbps o más</span>
                    <span className="flex items-center gap-1"><i className="h-3 w-3 rounded-sm bg-amber-500/40 inline-block" /> Menos de 1 Gbps</span>
                    <span className="flex items-center gap-1"><i className="h-3 w-3 rounded-sm bg-line/20 inline-block" /> Sin conexión</span>
                    <span className="flex items-center gap-1"><i className="h-3 w-3 rounded-sm bg-red-300 inline-block" /> Errores o inestable</span>
                    <span className="flex items-center gap-1"><i className="h-3 w-3 rounded-sm ring-2 ring-brand-500/60 inline-block" /> Troncal</span>
                  </div>
                </div>
              )}

              {esAdmin && (
                <div className="flex flex-wrap gap-3 text-sm pt-1">
                  <button className="text-ink/60 hover:text-ink" onClick={() => cambiarSwitch(sw, { activo: !sw.activo })}>{sw.activo ? "Dejar de consultar" : "Volver a consultar"}</button>
                  <button className="text-ink/40 hover:text-red-600" onClick={() => quitarSwitch(sw)}>Quitar switch</button>
                </div>
              )}
            </div>

            <div className="card overflow-x-auto">
              <table className="data w-full">
                <thead><tr><th>Puerto</th><th>Estado</th><th>Tráfico (entrada / salida)</th><th>Errores</th><th>Conectado</th><th>Troncal</th></tr></thead>
                <tbody>
                  {!ps.length && <tr><td colSpan={6} className="text-center text-ink/40 py-6">Sin datos de puertos todavía.</td></tr>}
                  {ps.filter((p) => coincide(p.nombre, p.alias, p.vecino, ...porPuerto(p.ifindex).map((d) => identidad(d) ?? d.mac))).map((p) => {
                    const e = estadoPuerto(p);
                    const ds = porPuerto(p.ifindex);
                    return (
                      <tr key={p.ifindex} id={`puerto-${p.ifindex}`}>
                        <td><div className="font-medium text-ink">{p.nombre ?? p.ifindex}</div>{p.alias && <div className="text-xs text-ink/50">{p.alias}</div>}</td>
                        <td className="text-sm">
                          <span className={`pill border ${e.c}`}>{e.t}</span>
                          {p.ultimo_cambio && <div className="text-xs text-ink/45 mt-0.5">{hace(p.ultimo_cambio, ahora)}</div>}
                          {p.cambios_1h >= 2 && <div className="text-xs text-red-600">{p.cambios_1h} cambios en la última hora</div>}
                        </td>
                        <td className="text-sm tabular-nums whitespace-nowrap">
                          {p.oper_up ? <>{bps(p.in_bps)} / {bps(p.out_bps)}{p.uso_pct != null && <div className={`text-xs ${(p.uso_pct ?? 0) >= (estado?.umbral_uso ?? 85) ? "text-red-600 font-medium" : "text-ink/50"}`}>{p.uso_pct}% de uso</div>}</> : "—"}
                        </td>
                        <td className={`text-sm tabular-nums ${(p.err_delta ?? 0) > 0 ? "text-red-600 font-medium" : "text-ink/50"}`}>{p.err_delta ?? "—"}</td>
                        <td className="text-sm">
                          {p.vecino ? (
                            <span><span className="text-ink">{p.vecino}</span><span className="text-xs text-ink/50"> · {p.vecino_puerto} ({p.vecino_protocolo})</span></span>
                          ) : p.es_troncal ? (
                            <span className="text-ink/50">{p.macs} dispositivos detrás</span>
                          ) : ds.length ? (
                            <ul className="space-y-0.5">
                              {ds.slice(0, 3).map((d) => (
                                <li key={d.mac}>
                                  {identidad(d) ? <span className="text-ink">{identidad(d)}</span> : <span className="text-red-600">Desconocido</span>}
                                  <span className="text-xs text-ink/45 font-mono"> {d.mac}</span>
                                </li>
                              ))}
                              {ds.length > 3 && <li className="text-xs text-ink/45">y {ds.length - 3} más</li>}
                            </ul>
                          ) : <span className="text-ink/40">—</span>}
                        </td>
                        <td className="text-sm">
                          {esAdmin ? (
                            <select className="input py-1 w-auto" value={p.troncal == null ? "" : p.troncal ? "si" : "no"} onChange={(e) => troncal(p, e.target.value)} aria-label={`Troncal ${p.nombre}`}>
                              <option value="">Automático ({p.troncal_detectado ? "sí" : "no"})</option>
                              <option value="si">Sí</option>
                              <option value="no">No</option>
                            </select>
                          ) : p.es_troncal ? "Sí" : "No"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Lista de switches */}
      {!sw && vista === "switches" && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Switch</th><th>Estado</th><th>Puertos conectados</th><th>Problemas</th><th>PoE</th><th>Encendido</th></tr></thead>
            <tbody>
              {cargando && <tr><td colSpan={6} className="text-center text-ink/40 py-10">Cargando…</td></tr>}
              {!cargando && !switches.length && <tr><td colSpan={6} className="text-center text-ink/40 py-10">{esAdmin ? "Todavía no hay switches. Tocá “Configurar” para agregarlos." : "Todavía no hay switches cargados."}</td></tr>}
              {switches.filter((s) => coincide(s.nombre, s.ip, s.zona, s.sys_nombre, s.sys_descr)).map((s) => {
                const ps = puertos.filter((p) => p.switch_id === s.id);
                const conectados = ps.filter((p) => p.oper_up).length;
                const tc = ps.filter((p) => p.es_troncal && p.admin_up && !p.oper_up).length;
                const prob = ps.filter((p) => (p.err_delta ?? 0) > 0 || p.cambios_1h >= 4).length;
                const reinicioReciente = s.reinicio_en && ahora - Date.parse(s.reinicio_en) < 2 * 3600000;
                return (
                  <tr key={s.id} className={`cursor-pointer hover:bg-line/[0.02] ${s.activo ? "" : "opacity-50"}`} onClick={() => ir(`switch=${s.id}`)}>
                    <td>
                      <div className="font-medium text-ink">{s.nombre}{!s.activo && <span className="text-xs text-ink/50 font-normal"> · sin consultar</span>}</div>
                      <div className="text-xs text-ink/50">{[s.ip, s.zona, s.sys_descr?.split(/[,;]/)[0]].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="text-sm">
                      {s.responde ? <span className="pill bg-emerald-50 text-emerald-700">Responde</span> : s.responde === false ? <span className="pill bg-red-600 text-white">Sin respuesta</span> : <span className="pill bg-line/[0.05] text-ink/50">Sin datos</span>}
                      {reinicioReciente && <div className="text-xs text-amber-700 mt-0.5">Se reinició {hace(s.reinicio_en!, ahora)}</div>}
                      {s.responde === false && s.ultimo_ok && <div className="text-xs text-ink/50 mt-0.5">Último dato {hace(s.ultimo_ok, ahora)}</div>}
                    </td>
                    <td className="text-sm tabular-nums">{ps.length ? `${conectados} de ${ps.length}` : "—"}</td>
                    <td className="text-sm">
                      {tc > 0 && <div className="text-red-600 font-medium">{tc} troncal caído{tc > 1 ? "s" : ""}</div>}
                      {prob > 0 && <div className="text-amber-700">{prob} con errores o inestables</div>}
                      {!tc && !prob && <span className="text-ink/40">—</span>}
                    </td>
                    <td className="text-sm tabular-nums">{s.poe_total ? <span className={(s.poe_uso ?? 0) >= s.poe_total * 0.9 ? "text-red-600 font-medium" : "text-ink/70"}>{Math.round(s.poe_uso ?? 0)} / {Math.round(s.poe_total)} W</span> : <span className="text-ink/40">—</span>}</td>
                    <td className="text-sm text-ink/60">{encendido(s.uptime_seg)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Dispositivos conectados por cable */}
      {!sw && vista === "dispositivos" && (() => {
        const filas = disp
          .filter((d) => !soloDesconocidos || !d.conocido)
          .filter((d) => coincide(d.mac, identidad(d), d.switch_nombre, d.puerto, d.puerto_alias, d.fabricante))
          .sort((a, b) => Number(a.conocido) - Number(b.conocido) || a.switch_nombre.localeCompare(b.switch_nombre) || a.ifindex - b.ifindex);
        return (
          <>
            <div className="flex flex-wrap gap-3 items-center justify-between">
              <p className="text-sm text-ink/60 max-w-3xl">
                Equipos conectados ahora en puertos de acceso (no troncales), según la tabla de direcciones MAC de cada switch. Se identifican con
                el agente, el inventario, UniFi y la lista de aprobados. Si reconocés un desconocido, marcalo como conocido.
              </p>
              <label className="flex items-center gap-2 text-sm text-ink/60">
                <input type="checkbox" checked={soloDesconocidos} onChange={(e) => setSoloDesconocidos(e.target.checked)} /> Solo desconocidos
              </label>
            </div>
            <div className="card overflow-x-auto">
              <table className="data w-full">
                <thead><tr><th>Dispositivo</th><th>MAC</th><th>Switch · puerto</th><th>VLAN</th><th>Visto</th><th></th></tr></thead>
                <tbody>
                  {!filas.length && <tr><td colSpan={6} className="text-center text-ink/40 py-10">{cargando ? "Cargando…" : soloDesconocidos ? "No hay dispositivos desconocidos conectados por cable." : "Sin datos todavía."}</td></tr>}
                  {filas.map((d) => (
                    <tr key={d.mac}>
                      <td>
                        {identidad(d) ? <div className="font-medium text-ink">{identidad(d)}</div> : <span className="pill bg-red-50 text-red-600">Desconocido</span>}
                        <div className="text-xs text-ink/50">
                          {d.agente_hostname ? "Equipo con agente" : d.inventario_codigo ? "Inventario" : d.unifi_nombre ? "Equipo UniFi" : d.conocido_descripcion ? "Aprobado" : d.fabricante ?? ""}
                        </div>
                      </td>
                      <td className="whitespace-nowrap"><span className="font-mono text-xs">{d.mac}</span>{d.mac_aleatoria && <div><span className="pill bg-line/[0.05] text-ink/60">MAC aleatoria</span></div>}</td>
                      <td className="text-sm">
                        <button className="text-brand-600 hover:underline text-left" onClick={() => ir(`switch=${d.switch_id}`)}>{d.switch_nombre}</button>
                        <span className="text-ink/70"> · {d.puerto ?? d.ifindex}</span>
                        {d.puerto_alias && <div className="text-xs text-ink/50">{d.puerto_alias}</div>}
                      </td>
                      <td className="text-sm text-ink/70 tabular-nums">{d.vlan || "—"}</td>
                      <td className="text-sm text-ink/60 whitespace-nowrap">desde {hace(d.primera_vez, ahora)}</td>
                      <td className="text-right">
                        {puedeEditar && !d.conocido && (aprobando === d.mac ? (
                          <form className="flex gap-1 justify-end" onSubmit={(e) => { e.preventDefault(); aprobar(d.mac); }}>
                            <input autoFocus className="input py-1 w-48" placeholder="Qué es (ej. Impresora piso 5)" value={descripcion}
                              onChange={(e) => setDescripcion(e.target.value)} aria-label={`Descripción de ${d.mac}`} />
                            <button className="btn-primary py-1" disabled={!descripcion.trim()}>Guardar</button>
                            <button type="button" className="btn-secondary py-1" onClick={() => { setAprobando(null); setDescripcion(""); }}>Cancelar</button>
                          </form>
                        ) : (
                          <button className="text-sm text-brand-600 hover:underline whitespace-nowrap" onClick={() => { setAprobando(d.mac); setDescripcion(""); }}>Marcar como conocido</button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-ink/50">
              La lista de aprobados es la misma que la de <Link href="/inventario/wifi?vista=conocidos" className="text-brand-600 hover:underline">Seguridad → WiFi</Link>:
              lo que apruebes acá cuenta también para WiFi, y al revés.
            </p>
          </>
        );
      })()}

      {/* Eventos */}
      {!sw && vista === "eventos" && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Cuándo</th><th>Switch</th><th>Evento</th><th>Detalle</th></tr></thead>
            <tbody>
              {!eventos.length && <tr><td colSpan={4} className="text-center text-ink/40 py-10">{cargando ? "Cargando…" : "Sin eventos registrados."}</td></tr>}
              {eventos.filter((e) => coincide(nombreSw(e.switch_id), e.detalle, EVENTO[e.tipo]?.t)).map((e) => (
                <tr key={e.id}>
                  <td className="text-sm text-ink/70 whitespace-nowrap">{new Date(e.fecha).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td className="text-sm"><button className="text-brand-600 hover:underline" onClick={() => ir(`switch=${e.switch_id}`)}>{nombreSw(e.switch_id)}</button></td>
                  <td><span className={`pill ${EVENTO[e.tipo]?.c ?? ""}`}>{EVENTO[e.tipo]?.t ?? e.tipo}</span></td>
                  <td className="text-sm text-ink/70">{e.detalle ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Switches() {
  return <Suspense><Contenido /></Suspense>;
}
