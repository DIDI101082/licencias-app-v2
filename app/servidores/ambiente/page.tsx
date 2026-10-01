"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteAmbiente, { type ConfigAmbiente } from "@/components/PuenteAmbiente";
import { hace } from "@/lib/monitoreo";

type Sensor = {
  id: number; nombre: string; ip: string; ubicacion: string | null; activo: boolean;
  oid_temp: string | null; escala_temp: number; oid_hum: string | null; escala_hum: number;
  responde: boolean | null; ultimo_ok: string | null; ultimo_error: string | null; sys_descr: string | null; version_snmp: string | null;
  valores: Record<string, string> | null; temperatura: number | null; humedad: number | null;
  temp_estado: string | null; hum_estado: string | null; temp_fuera_desde: string | null;
};
type Evento = { id: number; sensor_id: number; tipo: string; detalle: string | null; fecha: string };
type Hora = { hora: string; temp_prom: number | null; temp_max: number | null; humedad: number | null };

const EVENTO: Record<string, { t: string; c: string }> = {
  temp_alta: { t: "Temperatura alta", c: "bg-amber-500/15 text-amber-800" },
  temp_critica: { t: "Temperatura crítica", c: "bg-red-600 text-white" },
  temp_baja: { t: "Temperatura baja", c: "bg-brand-50 text-brand-700" },
  temp_normal: { t: "Temperatura normal", c: "bg-emerald-50 text-emerald-700" },
  hum_fuera: { t: "Humedad fuera de rango", c: "bg-amber-500/15 text-amber-800" },
  hum_normal: { t: "Humedad normal", c: "bg-emerald-50 text-emerald-700" },
  sin_respuesta: { t: "Sin respuesta", c: "bg-red-50 text-red-600" },
  responde: { t: "Volvió a responder", c: "bg-emerald-50 text-emerald-700" },
};

const num = (v: number | null | undefined, dec = 1) => (v == null ? "—" : Number(v).toLocaleString("es-AR", { maximumFractionDigits: dec, minimumFractionDigits: dec }));
const fechaHora = (v: string) => new Date(v).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// Mismo cálculo que amb_valor() en Supabase: primer número del texto dividido por la escala
const valor = (t: string | undefined, escala: number) => {
  const m = (t ?? "").match(/-?\d+(?:[.,]\d+)?/);
  return m ? Math.round((parseFloat(m[0].replace(",", ".")) / escala) * 10) / 10 : null;
};
const colorTemp = (e: string | null) => (e === "critica" ? "text-red-600" : e === "alta" ? "text-amber-600" : e === "baja" ? "text-brand-600" : "text-ink");

function estado(s: Sensor) {
  if (!s.activo) return { t: "Desactivado", c: "bg-line/[0.06] text-ink/50" };
  if (s.responde == null) return { t: "Esperando la primera lectura", c: "bg-line/[0.06] text-ink/50" };
  if (!s.responde) return { t: "Sin respuesta", c: "bg-red-600 text-white" };
  if (!s.oid_temp && !s.oid_hum) return { t: "Falta elegir los valores", c: "bg-amber-500/15 text-amber-800" };
  if (s.temp_estado === "critica") return { t: "Temperatura crítica", c: "bg-red-600 text-white" };
  if (s.temp_estado === "alta") return { t: "Temperatura alta", c: "bg-amber-500/15 text-amber-800" };
  if (s.temp_estado === "baja") return { t: "Temperatura baja", c: "bg-brand-50 text-brand-700" };
  if (s.hum_estado && s.hum_estado !== "normal") return { t: "Humedad fuera de rango", c: "bg-amber-500/15 text-amber-800" };
  return { t: "Normal", c: "bg-emerald-50 text-emerald-700" };
}

// Termómetro horizontal: la franja verde es el rango aceptado, la marca es la temperatura actual
function Escala({ t, c }: { t: number | null; c: ConfigAmbiente }) {
  const lo = Math.min(c.temp_min - 5, t ?? 99), hi = Math.max(c.temp_critica + 5, t ?? -99);
  const pos = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="space-y-1" aria-hidden>
      <div className="relative h-2.5 rounded-full bg-red-500/25 overflow-hidden">
        <div className="absolute inset-y-0 bg-amber-500/40" style={{ left: pos(c.temp_min), right: `calc(100% - ${pos(c.temp_critica)})` }} />
        <div className="absolute inset-y-0 bg-emerald-500/50" style={{ left: pos(c.temp_min), right: `calc(100% - ${pos(c.temp_max)})` }} />
      </div>
      {t != null && <div className="relative h-0"><div className="absolute -top-4 h-4 w-1 rounded bg-ink" style={{ left: `calc(${pos(t)} - 2px)` }} /></div>}
      <div className="flex justify-between text-[11px] text-ink/45 tabular-nums">
        <span>{c.temp_min} °C</span><span>máx. {c.temp_max} °C · crítica {c.temp_critica} °C</span>
      </div>
    </div>
  );
}

function Grafico({ datos, c }: { datos: Hora[]; c: ConfigAmbiente }) {
  const pts = datos.filter((d) => d.temp_prom != null || d.humedad != null);
  if (pts.length < 2) return <p className="text-xs text-ink/50 py-4 text-center">El gráfico aparece cuando haya algunas horas de datos.</p>;
  const W = 560, H = 150, PL = 30, PR = 30, PB = 18, PT = 6;
  const t0 = new Date(pts[0].hora).getTime(), t1 = new Date(pts[pts.length - 1].hora).getTime();
  const temps = pts.flatMap((d) => [d.temp_prom, d.temp_max]).filter((v): v is number => v != null);
  const tmin = Math.floor(Math.min(c.temp_min, ...temps) - 1), tmax = Math.ceil(Math.max(c.temp_critica, ...temps) + 1);
  const x = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (W - PL - PR);
  const yT = (v: number) => PT + (1 - (v - tmin) / (tmax - tmin)) * (H - PT - PB);
  const yH = (v: number) => PT + (1 - v / 100) * (H - PT - PB);
  const linea = (k: "temp_prom" | "humedad", y: (v: number) => number) =>
    pts.filter((d) => d[k] != null).map((d, i) => `${i ? "L" : "M"}${x(new Date(d.hora).getTime()).toFixed(1)},${y(d[k]!).toFixed(1)}`).join(" ");
  return (
    <figure className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Temperatura y humedad de los últimos 30 días">
        {[tmin, Math.round((tmin + tmax) / 2), tmax].map((v) => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={yT(v)} y2={yT(v)} className="stroke-line/10" strokeWidth={1} />
            <text x={PL - 5} y={yT(v) + 3} textAnchor="end" className="fill-ink/45" fontSize={9}>{v}°</text>
          </g>
        ))}
        {[0, 50, 100].map((v) => <text key={v} x={W - PR + 5} y={yH(v) + 3} className="fill-ink/40" fontSize={9}>{v}%</text>)}
        <line x1={PL} x2={W - PR} y1={yT(c.temp_max)} y2={yT(c.temp_max)} className="stroke-amber-500/70" strokeDasharray="3 3" strokeWidth={1} />
        <line x1={PL} x2={W - PR} y1={yT(c.temp_critica)} y2={yT(c.temp_critica)} className="stroke-red-500/70" strokeDasharray="3 3" strokeWidth={1} />
        <path d={linea("humedad", yH)} fill="none" className="stroke-brand-300" strokeWidth={1.5} />
        <path d={linea("temp_prom", yT)} fill="none" className="stroke-red-500" strokeWidth={2} />
        <text x={PL} y={H - 4} className="fill-ink/45" fontSize={9}>{new Date(t0).toLocaleDateString("es-AR")}</text>
        <text x={W - PR} y={H - 4} textAnchor="end" className="fill-ink/45" fontSize={9}>hoy</text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 text-xs text-ink/55">
        <span><span className="inline-block w-3 h-0.5 bg-red-500 align-middle mr-1" />Temperatura (°C, eje izquierdo)</span>
        <span><span className="inline-block w-3 h-0.5 bg-brand-300 align-middle mr-1" />Humedad (%, eje derecho)</span>
        <span>Líneas punteadas: máxima y crítica</span>
      </figcaption>
    </figure>
  );
}

// Elegir qué valor SNMP es la temperatura y cuál la humedad, comparando con la web del sensor
function ElegirValores({ s, alGuardar, alCerrar }: { s: Sensor; alGuardar: () => void; alCerrar: () => void }) {
  const [temp, setTemp] = useState(s.oid_temp ?? "");
  const [escT, setEscT] = useState(s.escala_temp ?? 1);
  const [hum, setHum] = useState(s.oid_hum ?? "");
  const [escH, setEscH] = useState(s.escala_hum ?? 1);
  const [error, setError] = useState<string | null>(null);
  const filas = Object.entries(s.valores ?? {});

  async function guardar() {
    setError(null);
    const { error } = await createClient().rpc("amb_elegir", { p_sensor: s.id, p_oid_temp: temp || null, p_escala_temp: escT, p_oid_hum: hum || null, p_escala_hum: escH });
    if (error) return setError(error.message);
    alGuardar();
  }

  if (filas.length === 0) return <p className="text-sm text-ink/60">Todavía no hay valores leídos. Esperá la primera lectura del puente.</p>;
  return (
    <div className="space-y-3 border-t border-line/[0.06] pt-3">
      <p className="text-sm text-ink/70">
        Abrí la página web del sensor y buscá en esta lista el número que coincide con la temperatura y el de la humedad. Si el sensor
        informa 235 para 23,5 °C, elegí “÷ 10”.
      </p>
      <div className="overflow-x-auto max-h-72 overflow-y-auto rounded-md border border-line/[0.08]">
        <table className="data w-full text-sm">
          <thead><tr><th>Valor</th><th>Identificador SNMP</th><th className="text-center">Temperatura</th><th className="text-center">Humedad</th></tr></thead>
          <tbody>
            {filas.map(([oid, v]) => (
              <tr key={oid} className={oid === temp || oid === hum ? "bg-brand-50/60" : ""}>
                <td className="tabular-nums font-medium whitespace-nowrap">{v}</td>
                <td className="text-xs text-ink/50 font-mono break-all">{oid}</td>
                <td className="text-center"><input type="radio" name={`t-${s.id}`} aria-label={`Usar ${v} como temperatura`} checked={temp === oid} onChange={() => setTemp(oid)} /></td>
                <td className="text-center"><input type="radio" name={`h-${s.id}`} aria-label={`Usar ${v} como humedad`} checked={hum === oid} onChange={() => setHum(oid)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block text-sm">Temperatura
          <select className="input mt-1" value={escT} onChange={(e) => setEscT(Number(e.target.value))}>
            <option value={1}>Tal cual</option><option value={10}>÷ 10</option><option value={100}>÷ 100</option>
          </select>
          <span className="text-xs text-ink/55">Quedaría en {temp ? `${num(valor(s.valores?.[temp], escT))} °C` : "—"}</span>
        </label>
        <label className="block text-sm">Humedad
          <select className="input mt-1" value={escH} onChange={(e) => setEscH(Number(e.target.value))}>
            <option value={1}>Tal cual</option><option value={10}>÷ 10</option><option value={100}>÷ 100</option>
          </select>
          <span className="text-xs text-ink/55">Quedaría en {hum ? `${num(valor(s.valores?.[hum], escH))} %` : "—"}</span>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" onClick={guardar}>Guardar</button>
        <button className="btn-secondary" onClick={() => { setTemp(""); setHum(""); }}>Desmarcar</button>
        <button className="btn-secondary" onClick={alCerrar}>Cancelar</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export default function Ambiente() {
  const { esAdmin } = usePerfil();
  const [config, setConfig] = useState<ConfigAmbiente | null>(null);
  const [lista, setLista] = useState<Sensor[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [historial, setHistorial] = useState<Record<number, Hora[]>>({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verConfig, setVerConfig] = useState(false);
  const [eligiendo, setEligiendo] = useState<number | null>(null);
  const [quitando, setQuitando] = useState<number | null>(null);
  const [ahora, setAhora] = useState(Date.now());

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [c, s, ev] = await Promise.all([
      sb.rpc("amb_config_ver"),
      sb.from("amb_sensores").select("*").order("nombre"),
      sb.from("amb_eventos").select("*").order("fecha", { ascending: false }).limit(60),
    ]);
    if (c.error) setError(/amb_config_ver/.test(c.error.message) ? "Falta ejecutar supabase/ambiente.sql en Supabase." : c.error.message);
    const sensores = (s.data as Sensor[]) ?? [];
    const hs = await Promise.all(sensores.map((x) => sb.rpc("amb_historial", { p_sensor: x.id, p_dias: 30 })));
    setConfig((c.data as ConfigAmbiente) ?? null);
    setLista(sensores);
    setEventos((ev.data as Evento[]) ?? []);
    setHistorial(Object.fromEntries(sensores.map((x, i) => [x.id, (hs[i].data as Hora[]) ?? []])));
    setAhora(Date.now());
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  async function cambiarActivo(s: Sensor) {
    await createClient().from("amb_sensores").update({ activo: !s.activo }).eq("id", s.id);
    cargar();
  }
  async function quitar(s: Sensor) {
    await createClient().from("amb_sensores").delete().eq("id", s.id);
    setQuitando(null);
    cargar();
  }

  if (cargando) return <p className="text-ink/50 text-sm">Cargando…</p>;
  if (error) return <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>;
  if (!config) return <p className="text-sm text-ink/60">No tenés acceso a esta pantalla.</p>;

  const nombre = (id: number) => lista.find((s) => s.id === id)?.nombre ?? `Sensor ${id}`;
  const criticos = lista.filter((s) => s.activo && s.responde && s.temp_estado === "critica");

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Temperatura y humedad</h1>
          <p className="text-ink/60 text-sm mt-1">
            Sensores de ambiente de la sala de servidores, leídos por SNMP en modo solo lectura.
            {config.ultimo_reporte ? ` Último reporte del puente ${hace(config.ultimo_reporte, ahora)}.` : ""}
          </p>
        </div>
        {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)}>{verConfig ? "Ocultar configuración" : "Configuración"}</button>}
      </div>

      {(verConfig || ((!config.configurado || lista.length === 0) && esAdmin)) && esAdmin && <PuenteAmbiente config={config} alCambiar={cargar} />}

      {criticos.length > 0 && (
        <p role="alert" className="text-sm text-white bg-red-600 rounded-md px-3 py-2">
          Temperatura crítica en {criticos.map((s) => `${s.nombre} (${num(s.temperatura)} °C)`).join(", ")}. Revisá el aire acondicionado de la sala.
        </p>
      )}

      {lista.length === 0 ? (
        <div className="card p-6 text-sm text-ink/60">
          {esAdmin ? "Todavía no hay sensores cargados. Agregá el de la sala desde la configuración de arriba." : "Todavía no hay sensores cargados."}
        </div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {lista.map((s) => {
            const est = estado(s);
            return (
              <article key={s.id} className={`card p-5 space-y-4 ${s.activo ? "" : "opacity-60"}`}>
                <header className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h2 className="font-display text-lg text-ink">{s.nombre}</h2>
                    <p className="text-xs text-ink/50">{[s.ubicacion, s.ip, s.sys_descr, s.version_snmp && `SNMP v${s.version_snmp}`].filter(Boolean).join(" · ")}</p>
                  </div>
                  <span className={`pill ${est.c}`}>{est.t}</span>
                </header>

                {s.responde === false && (
                  <p className="text-sm text-red-700 bg-red-50 rounded-md px-3 py-2">
                    {s.ultimo_error ?? "Sin respuesta"}{s.ultimo_ok ? `. Último dato: ${fechaHora(s.ultimo_ok)}.` : ""}
                  </p>
                )}

                {(s.oid_temp || s.oid_hum) && s.ultimo_ok && (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-ink/50 font-medium">Temperatura</div>
                        <div className={`font-display text-4xl tabular-nums ${colorTemp(s.temp_estado)}`}>{s.temperatura != null ? `${num(s.temperatura)} °C` : "—"}</div>
                        {s.temp_fuera_desde && <div className="text-xs text-ink/50">Fuera de rango desde {fechaHora(s.temp_fuera_desde)}</div>}
                      </div>
                      <div>
                        <div className="text-xs text-ink/50 font-medium">Humedad</div>
                        <div className={`font-display text-4xl tabular-nums ${s.hum_estado && s.hum_estado !== "normal" ? "text-amber-600" : "text-ink"}`}>{s.humedad != null ? `${num(s.humedad, 0)} %` : "—"}</div>
                        <div className="text-xs text-ink/50">Rango aceptado {config.hum_min} a {config.hum_max} %</div>
                      </div>
                    </div>
                    <Escala t={s.temperatura} c={config} />
                    <Grafico datos={historial[s.id] ?? []} c={config} />
                  </>
                )}

                {!s.oid_temp && !s.oid_hum && s.ultimo_ok && eligiendo !== s.id && (
                  <p className="text-sm text-ink/70">
                    El puente ya lee el sensor. Falta indicar qué valor es la temperatura y cuál la humedad
                    {esAdmin ? ": tocá “Elegir valores”." : "; lo hace un administrador."}
                  </p>
                )}

                {eligiendo === s.id && <ElegirValores s={s} alCerrar={() => setEligiendo(null)} alGuardar={() => { setEligiendo(null); cargar(); }} />}

                {esAdmin && (
                  <footer className="flex flex-wrap gap-3 text-sm border-t border-line/[0.06] pt-3">
                    {eligiendo !== s.id && <button className="text-brand-600 hover:underline" onClick={() => setEligiendo(s.id)}>Elegir valores</button>}
                    <button className="text-brand-600 hover:underline" onClick={() => cambiarActivo(s)}>{s.activo ? "Desactivar" : "Activar"}</button>
                    {quitando === s.id ? (
                      <span className="flex gap-3">
                        <button className="text-red-600 hover:underline" onClick={() => quitar(s)}>Sí, quitar con su historial</button>
                        <button className="text-ink/50 hover:underline" onClick={() => setQuitando(null)}>Cancelar</button>
                      </span>
                    ) : (
                      <button className="text-ink/50 hover:text-red-600 hover:underline" onClick={() => setQuitando(s.id)}>Quitar</button>
                    )}
                  </footer>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Fecha</th><th>Sensor</th><th>Evento</th><th>Detalle</th></tr></thead>
          <tbody>
            {eventos.map((ev) => (
              <tr key={ev.id}>
                <td className="whitespace-nowrap tabular-nums">{fechaHora(ev.fecha)}</td>
                <td className="whitespace-nowrap">{nombre(ev.sensor_id)}</td>
                <td><span className={`pill ${EVENTO[ev.tipo]?.c ?? "bg-line/[0.05] text-ink/60"}`}>{EVENTO[ev.tipo]?.t ?? ev.tipo}</span></td>
                <td className="text-sm text-ink/70">{ev.detalle ?? ""}</td>
              </tr>
            ))}
            {eventos.length === 0 && <tr><td colSpan={4} className="text-center text-ink/40 py-8">Sin eventos todavía. Acá van a aparecer las subidas de temperatura, la humedad fuera de rango y los cortes de comunicación.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
