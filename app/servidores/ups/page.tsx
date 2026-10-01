"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteUps, { type ConfigUps } from "@/components/PuenteUps";
import { hace } from "@/lib/monitoreo";

type Ups = {
  id: number; nombre: string; ip: string; ubicacion: string | null; activo: boolean; responde: boolean | null;
  ultimo_ok: string | null; ultimo_error: string | null; fabricante: string | null; modelo: string | null; firmware: string | null;
  estado_bateria: number | null; carga_bateria: number | null; autonomia_min: number | null; voltaje_bateria: number | null;
  temp_bateria: number | null; entrada_v: number | null; entrada_hz: number | null; salida_v: number | null; salida_hz: number | null;
  carga_pct: number | null; fuente_salida: number | null; alarmas: number[]; resultado_test: number | null;
  en_bateria: boolean | null; en_bateria_desde: string | null;
};
type Evento = { id: number; ups_id: number; tipo: string; detalle: string | null; fecha: string };
type Hora = { hora: string; carga_bateria: number | null; carga_pct: number | null; entrada_v: number | null; en_bateria: boolean };

// Alarmas estándar de la UPS-MIB (RFC 1628)
const ALARMAS: Record<number, string> = {
  1: "Batería defectuosa (reemplazar)", 2: "En batería", 3: "Batería baja", 4: "Batería agotada", 5: "Temperatura fuera de rango",
  6: "Entrada de red fuera de rango", 7: "Salida fuera de rango", 8: "Sobrecarga en la salida", 9: "En bypass", 10: "Falla de bypass",
  11: "Salida apagada a pedido", 12: "UPS apagada a pedido", 13: "Falla del cargador", 14: "Salida apagada", 15: "Sistema apagado",
  16: "Falla de ventilador", 17: "Fusible quemado", 18: "Falla general", 19: "Falló el test de diagnóstico", 20: "Comunicación perdida",
  21: "Esperando energía", 22: "Apagado pendiente", 23: "Apagado inminente", 24: "Test en curso",
};
const FUENTE: Record<number, string> = { 1: "Otra", 2: "Sin salida", 3: "Normal (inversor)", 4: "Bypass", 5: "Batería", 6: "Elevador de tensión", 7: "Reductor de tensión" };
const TEST: Record<number, string> = { 1: "Aprobado", 2: "Aprobado con advertencias", 3: "Con errores", 4: "Cancelado", 5: "En curso", 6: "Nunca se hizo" };
const EVENTO: Record<string, { t: string; c: string }> = {
  en_bateria: { t: "Pasó a batería", c: "bg-red-600 text-white" },
  vuelve_red: { t: "Volvió la red", c: "bg-emerald-50 text-emerald-700" },
  bateria_baja: { t: "Batería baja", c: "bg-red-50 text-red-600" },
  alarma: { t: "Alarma", c: "bg-amber-500/15 text-amber-800" },
  alarma_fin: { t: "Alarma resuelta", c: "bg-line/[0.06] text-ink/70" },
  sin_respuesta: { t: "Sin respuesta", c: "bg-red-50 text-red-600" },
  responde: { t: "Volvió a responder", c: "bg-emerald-50 text-emerald-700" },
};

const num = (v: number | null | undefined, dec = 0) => (v == null ? "—" : Number(v).toLocaleString("es-AR", { maximumFractionDigits: dec, minimumFractionDigits: dec }));
const fechaHora = (v: string) => new Date(v).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const duracion = (desde: string | null, ahora: number) => {
  if (!desde) return "";
  const m = Math.max(0, Math.round((ahora - new Date(desde).getTime()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

function estadoUps(u: Ups, ahora: number) {
  if (!u.activo) return { t: "Desactivada", c: "bg-line/[0.06] text-ink/50" };
  if (u.responde == null) return { t: "Esperando datos", c: "bg-line/[0.06] text-ink/50" };
  if (!u.responde) return { t: "Sin respuesta", c: "bg-red-600 text-white" };
  if (u.en_bateria) return { t: `En batería hace ${duracion(u.en_bateria_desde, ahora)}`, c: "bg-red-600 text-white" };
  if (u.fuente_salida === 4) return { t: "En bypass", c: "bg-red-50 text-red-700" };
  if (u.estado_bateria === 3 || u.estado_bateria === 4) return { t: "Batería baja", c: "bg-red-50 text-red-700" };
  if (u.alarmas.some((a) => a !== 24)) return { t: "Con alarmas", c: "bg-amber-500/15 text-amber-800" };
  return { t: "Normal", c: "bg-emerald-50 text-emerald-700" };
}

function Dato({ t, v, u, alerta }: { t: string; v: string; u?: string; alerta?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-line/[0.05] last:border-0">
      <span className="text-sm text-ink/60">{t}</span>
      <span className={`tabular-nums text-sm font-medium ${alerta ? "text-red-600" : "text-ink"}`}>{v}{u && v !== "—" ? ` ${u}` : ""}</span>
    </div>
  );
}

function Medidor({ t, valor, sufijo, malo }: { t: string; valor: number | null; sufijo: string; malo: boolean }) {
  const v = valor == null ? 0 : Math.max(0, Math.min(100, valor));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink/60">{t}</span>
        <span className={`font-display text-2xl tabular-nums ${malo ? "text-red-600" : "text-ink"}`}>{valor == null ? "—" : `${num(valor)}${sufijo}`}</span>
      </div>
      <div className="h-2 rounded-full bg-line/[0.06] overflow-hidden" role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={t}>
        <div className={`h-full rounded-full ${malo ? "bg-red-500" : "bg-brand-500"}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

// Carga de batería y carga de salida de los últimos 30 días, por hora. Las franjas marcan cuándo estuvo en batería.
function Grafico({ datos, cargaMax }: { datos: Hora[]; cargaMax: number }) {
  const pts = datos.filter((d) => d.carga_bateria != null || d.carga_pct != null);
  if (pts.length < 2) return <p className="text-xs text-ink/50 py-4 text-center">El gráfico aparece cuando haya algunas horas de datos.</p>;
  const W = 520, H = 130, PL = 30, PB = 18, PT = 6;
  const t0 = new Date(pts[0].hora).getTime(), t1 = new Date(pts[pts.length - 1].hora).getTime();
  const x = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (W - PL - 6);
  const y = (v: number) => PT + (1 - v / 100) * (H - PT - PB);
  const linea = (k: "carga_bateria" | "carga_pct") =>
    pts.filter((d) => d[k] != null).map((d, i) => `${i ? "L" : "M"}${x(new Date(d.hora).getTime()).toFixed(1)},${y(d[k]!).toFixed(1)}`).join(" ");
  return (
    <figure className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Batería y carga de los últimos 30 días">
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={PL} x2={W - 6} y1={y(v)} y2={y(v)} className="stroke-line/10" strokeWidth={1} />
            <text x={PL - 5} y={y(v) + 3} textAnchor="end" className="fill-ink/45" fontSize={9}>{v}%</text>
          </g>
        ))}
        {datos.filter((d) => d.en_bateria).map((d) => (
          <rect key={d.hora} x={x(new Date(d.hora).getTime())} y={PT} width={Math.max(2, (W - PL) / Math.max(24, datos.length))} height={H - PT - PB} className="fill-red-500/20" />
        ))}
        <line x1={PL} x2={W - 6} y1={y(cargaMax)} y2={y(cargaMax)} className="stroke-amber-500/70" strokeDasharray="3 3" strokeWidth={1} />
        <path d={linea("carga_bateria")} fill="none" className="stroke-brand-600" strokeWidth={1.8} />
        <path d={linea("carga_pct")} fill="none" className="stroke-amber-600" strokeWidth={1.8} />
        <text x={PL} y={H - 4} className="fill-ink/45" fontSize={9}>{new Date(t0).toLocaleDateString("es-AR")}</text>
        <text x={W - 6} y={H - 4} textAnchor="end" className="fill-ink/45" fontSize={9}>hoy</text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 text-xs text-ink/55">
        <span><span className="inline-block w-3 h-0.5 bg-brand-600 align-middle mr-1" />Batería</span>
        <span><span className="inline-block w-3 h-0.5 bg-amber-600 align-middle mr-1" />Carga de salida</span>
        <span><span className="inline-block w-3 h-2 bg-red-500/30 align-middle mr-1" />En batería</span>
      </figcaption>
    </figure>
  );
}

export default function UpsPagina() {
  const { esAdmin } = usePerfil();
  const [config, setConfig] = useState<ConfigUps | null>(null);
  const [lista, setLista] = useState<Ups[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [historial, setHistorial] = useState<Record<number, Hora[]>>({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verConfig, setVerConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [c, u, ev] = await Promise.all([
      sb.rpc("ups_config_ver"),
      sb.from("ups_equipos").select("*").order("nombre"),
      sb.from("ups_eventos").select("*").order("fecha", { ascending: false }).limit(60),
    ]);
    if (c.error) setError(/ups_config_ver/.test(c.error.message) ? "Falta ejecutar supabase/ups.sql en Supabase." : c.error.message);
    const equipos = (u.data as Ups[]) ?? [];
    const hs = await Promise.all(equipos.map((x) => sb.rpc("ups_historial", { p_ups: x.id, p_dias: 30 })));
    setConfig((c.data as ConfigUps) ?? null);
    setLista(equipos);
    setEventos((ev.data as Evento[]) ?? []);
    setHistorial(Object.fromEntries(equipos.map((x, i) => [x.id, (hs[i].data as Hora[]) ?? []])));
    setAhora(Date.now());
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  async function cambiarActiva(u: Ups) {
    await createClient().from("ups_equipos").update({ activo: !u.activo }).eq("id", u.id);
    cargar();
  }
  async function quitar(u: Ups) {
    // Confirmación en dos clics (la app no usa diálogos del navegador)
    await createClient().from("ups_equipos").delete().eq("id", u.id);
    cargar();
  }
  const [quitando, setQuitando] = useState<number | null>(null);

  if (cargando) return <p className="text-ink/50 text-sm">Cargando…</p>;
  if (error) return <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>;
  if (!config) return <p className="text-sm text-ink/60">No tenés acceso a esta pantalla.</p>;

  const nombreUps = (id: number) => lista.find((u) => u.id === id)?.nombre ?? `UPS ${id}`;
  const enBateria = lista.filter((u) => u.activo && u.responde && u.en_bateria).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">UPS</h1>
          <p className="text-ink/60 text-sm mt-1">
            Estado de las UPS leído por SNMP en modo solo lectura (MIB estándar de UPS).
            {config.ultimo_reporte ? ` Último reporte del puente ${hace(config.ultimo_reporte, ahora)}.` : ""}
          </p>
        </div>
        {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)}>{verConfig ? "Ocultar configuración" : "Configuración"}</button>}
      </div>

      {(verConfig || ((!config.configurado || lista.length === 0) && esAdmin)) && esAdmin && <PuenteUps config={config} alCambiar={cargar} />}

      {enBateria > 0 && (
        <p role="alert" className="text-sm text-white bg-red-600 rounded-md px-3 py-2">
          {enBateria === 1 ? "Hay una UPS funcionando con batería." : `Hay ${enBateria} UPS funcionando con batería.`} Revisá la red eléctrica y el grupo electrógeno.
        </p>
      )}

      {lista.length === 0 ? (
        <div className="card p-6 text-sm text-ink/60">
          {esAdmin ? "Todavía no hay UPS cargadas. Agregalas desde la configuración de arriba." : "Todavía no hay UPS cargadas."}
        </div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {lista.map((u) => {
            const est = estadoUps(u, ahora);
            const alarmas = u.alarmas.filter((a) => a !== 2);
            const batBaja = u.estado_bateria === 3 || u.estado_bateria === 4 || (u.autonomia_min != null && u.autonomia_min < config.autonomia_minima);
            return (
              <article key={u.id} className={`card p-5 space-y-4 ${u.activo ? "" : "opacity-60"}`}>
                <header className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h2 className="font-display text-lg text-ink">{u.nombre}</h2>
                    <p className="text-xs text-ink/50">
                      {[u.ubicacion, u.ip, [u.fabricante, u.modelo].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <span className={`pill ${est.c}`}>{est.t}</span>
                </header>

                {u.responde === false && (
                  <p className="text-sm text-red-700 bg-red-50 rounded-md px-3 py-2">
                    {u.ultimo_error ?? "Sin respuesta"}{u.ultimo_ok ? `. Último dato: ${fechaHora(u.ultimo_ok)}.` : ""}
                  </p>
                )}

                {u.ultimo_ok && (
                  <>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Medidor t="Batería" valor={u.carga_bateria} sufijo="%" malo={batBaja} />
                      <Medidor t="Carga de salida" valor={u.carga_pct} sufijo="%" malo={u.carga_pct != null && u.carga_pct >= config.carga_maxima} />
                    </div>
                    <div className="grid sm:grid-cols-2 gap-x-6">
                      <div>
                        <Dato t="Autonomía" v={num(u.autonomia_min)} u="min" alerta={batBaja} />
                        <Dato t="Voltaje de batería" v={num(u.voltaje_bateria, 1)} u="V" />
                        <Dato t="Temperatura" v={num(u.temp_bateria)} u="°C" alerta={u.temp_bateria != null && u.temp_bateria >= config.temp_maxima} />
                        <Dato t="Último test" v={u.resultado_test != null ? TEST[u.resultado_test] ?? String(u.resultado_test) : "—"} alerta={u.resultado_test === 3} />
                      </div>
                      <div>
                        <Dato t="Entrada" v={u.entrada_v != null ? `${num(u.entrada_v)} V · ${num(u.entrada_hz, 1)} Hz` : "—"} alerta={!!u.en_bateria} />
                        <Dato t="Salida" v={u.salida_v != null ? `${num(u.salida_v)} V · ${num(u.salida_hz, 1)} Hz` : "—"} />
                        <Dato t="Alimentando desde" v={u.fuente_salida != null ? FUENTE[u.fuente_salida] ?? String(u.fuente_salida) : "—"} alerta={u.fuente_salida === 4 || u.fuente_salida === 5} />
                        <Dato t="Último dato" v={u.ultimo_ok ? hace(u.ultimo_ok, ahora) : "—"} />
                      </div>
                    </div>
                    {alarmas.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {alarmas.map((a) => <span key={a} className="pill bg-amber-500/15 text-amber-800">{ALARMAS[a] ?? `Alarma ${a}`}</span>)}
                      </div>
                    )}
                    <Grafico datos={historial[u.id] ?? []} cargaMax={config.carga_maxima} />
                  </>
                )}

                {esAdmin && (
                  <footer className="flex flex-wrap gap-3 text-sm border-t border-line/[0.06] pt-3">
                    <button className="text-brand-600 hover:underline" onClick={() => cambiarActiva(u)}>{u.activo ? "Desactivar" : "Activar"}</button>
                    {quitando === u.id ? (
                      <span className="flex gap-3">
                        <button className="text-red-600 hover:underline" onClick={() => { setQuitando(null); quitar(u); }}>Sí, quitar con su historial</button>
                        <button className="text-ink/50 hover:underline" onClick={() => setQuitando(null)}>Cancelar</button>
                      </span>
                    ) : (
                      <button className="text-ink/50 hover:text-red-600 hover:underline" onClick={() => setQuitando(u.id)}>Quitar</button>
                    )}
                    {u.firmware && <span className="text-xs text-ink/40 ml-auto self-center">Firmware {u.firmware}</span>}
                  </footer>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Fecha</th><th>UPS</th><th>Evento</th><th>Detalle</th></tr></thead>
          <tbody>
            {eventos.map((ev) => (
              <tr key={ev.id}>
                <td className="whitespace-nowrap tabular-nums">{fechaHora(ev.fecha)}</td>
                <td className="whitespace-nowrap">{nombreUps(ev.ups_id)}</td>
                <td><span className={`pill ${EVENTO[ev.tipo]?.c ?? "bg-line/[0.05] text-ink/60"}`}>{EVENTO[ev.tipo]?.t ?? ev.tipo}</span></td>
                <td className="text-sm text-ink/70">{ev.detalle ?? ""}</td>
              </tr>
            ))}
            {eventos.length === 0 && <tr><td colSpan={4} className="text-center text-ink/40 py-8">Sin eventos todavía. Acá van a aparecer los pasos a batería, alarmas y cortes de comunicación.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
