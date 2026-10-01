"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteGrupo, { type ConfigGrupo } from "@/components/PuenteGrupo";
import { hace } from "@/lib/monitoreo";

type Estado = {
  responde: boolean | null; ultimo_ok: string | null; ultimo_error: string | null; modo: number | null;
  combustible_pct: number | null; bateria_v: number | null; alternador_v: number | null; rpm: number | null;
  temp_refrigerante: number | null; presion_aceite: number | null; gen_hz: number | null;
  gen_v1: number | null; gen_v2: number | null; gen_v3: number | null; red_hz: number | null;
  red_v1: number | null; red_v2: number | null; red_v3: number | null; kw: number | null;
  horas_motor: number | null; arranques: number | null; en_marcha: boolean | null; red_ok: boolean | null;
  en_marcha_desde: string | null; red_cortada_desde: string | null;
};
type Evento = { id: number; tipo: string; detalle: string | null; fecha: string };
type Hora = { hora: string; combustible: number | null; bateria: number | null; en_marcha: boolean; sin_red: boolean };

const MODOS = ["Stop", "Automático", "Manual", "Prueba con carga", "Automático con restauración manual", "Configuración", "Prueba sin carga", "Off"];
const EVENTO: Record<string, { t: string; c: string }> = {
  corte_red: { t: "Corte de luz", c: "bg-red-600 text-white" },
  vuelve_red: { t: "Volvió la luz", c: "bg-emerald-50 text-emerald-700" },
  arranque: { t: "Arrancó el grupo", c: "bg-amber-500/15 text-amber-800" },
  parada: { t: "Paró el grupo", c: "bg-line/[0.06] text-ink/70" },
  modo: { t: "Cambio de modo", c: "bg-brand-50 text-brand-700" },
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

function Dato({ t, v, u, alerta }: { t: string; v: string; u?: string; alerta?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-line/[0.05] last:border-0">
      <span className="text-sm text-ink/60">{t}</span>
      <span className={`tabular-nums text-sm font-medium ${alerta ? "text-red-600" : "text-ink"}`}>{v}{u && v !== "—" ? ` ${u}` : ""}</span>
    </div>
  );
}

// Combustible de los últimos 30 días, por hora. Las franjas marcan cuándo funcionó el grupo.
function GraficoCombustible({ datos, minimo }: { datos: Hora[]; minimo: number }) {
  const puntos = datos.filter((d) => d.combustible != null);
  if (puntos.length < 2) return <p className="text-sm text-ink/50 py-6 text-center">El gráfico aparece cuando haya algunas horas de datos.</p>;
  const W = 720, H = 180, PL = 34, PB = 22, PT = 8;
  const t0 = new Date(puntos[0].hora).getTime(), t1 = new Date(puntos[puntos.length - 1].hora).getTime();
  const x = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (W - PL - 8);
  const y = (v: number) => PT + (1 - v / 100) * (H - PT - PB);
  const linea = puntos.map((d, i) => `${i ? "L" : "M"}${x(new Date(d.hora).getTime()).toFixed(1)},${y(d.combustible!).toFixed(1)}`).join(" ");
  const area = `${linea} L${x(t1).toFixed(1)},${y(0)} L${x(t0).toFixed(1)},${y(0)} Z`;
  const ultimo = puntos[puntos.length - 1];
  const dias = Math.round((t1 - t0) / 86400000);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Combustible de los últimos ${dias} días; ahora ${ultimo.combustible}%`}>
      {[0, 25, 50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={PL} x2={W - 8} y1={y(v)} y2={y(v)} className="stroke-line/10" strokeWidth={1} />
          <text x={PL - 6} y={y(v) + 4} textAnchor="end" className="fill-ink/45" fontSize={10}>{v}%</text>
        </g>
      ))}
      {datos.filter((d) => d.en_marcha).map((d) => (
        <rect key={d.hora} x={x(new Date(d.hora).getTime())} y={PT} width={Math.max(2, (W - PL) / Math.max(24, datos.length))} height={H - PT - PB} className="fill-amber-500/20" />
      ))}
      <line x1={PL} x2={W - 8} y1={y(minimo)} y2={y(minimo)} className="stroke-red-500/70" strokeDasharray="4 4" strokeWidth={1} />
      <text x={W - 10} y={y(minimo) - 4} textAnchor="end" className="fill-red-600" fontSize={10}>mínimo {minimo}%</text>
      <path d={area} className="fill-brand-500/10" />
      <path d={linea} fill="none" className="stroke-brand-600" strokeWidth={2} />
      <circle cx={x(t1)} cy={y(ultimo.combustible!)} r={3.5} className="fill-brand-600" />
      <text x={PL} y={H - 6} className="fill-ink/45" fontSize={10}>{new Date(t0).toLocaleDateString("es-AR")}</text>
      <text x={W - 8} y={H - 6} textAnchor="end" className="fill-ink/45" fontSize={10}>hoy</text>
    </svg>
  );
}

export default function GrupoElectrogeno() {
  const { esAdmin } = usePerfil();
  const [config, setConfig] = useState<ConfigGrupo | null>(null);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [historial, setHistorial] = useState<Hora[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verConfig, setVerConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [c, e, ev, h] = await Promise.all([
      sb.rpc("ge_config_ver"),
      sb.from("ge_estado").select("*").eq("id", 1).maybeSingle(),
      sb.from("ge_eventos").select("*").order("fecha", { ascending: false }).limit(50),
      sb.rpc("ge_historial", { p_dias: 30 }),
    ]);
    if (c.error) setError(/ge_config_ver/.test(c.error.message) ? "Falta ejecutar supabase/grupo-electrogeno.sql en Supabase." : c.error.message);
    setConfig((c.data as ConfigGrupo) ?? null);
    setEstado((e.data as Estado) ?? null);
    setEventos((ev.data as Evento[]) ?? []);
    setHistorial((h.data as Hora[]) ?? []);
    setAhora(Date.now());
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  if (cargando) return <p className="text-ink/50 text-sm">Cargando…</p>;
  if (error) return <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>;
  if (!config) return <p className="text-sm text-ink/60">No tenés acceso a esta pantalla.</p>;

  const sinDatos = !config.configurado || !estado?.ultimo_ok;
  const e = estado;
  const enAuto = e?.modo === 1 || e?.modo === 4;
  const combBajo = e?.combustible_pct != null && e.combustible_pct < config.combustible_minimo;
  const litros = config.litros_tanque && e?.combustible_pct != null ? Math.round((config.litros_tanque * e.combustible_pct) / 100) : null;

  const tarjetas = e && !sinDatos ? [
    e.en_marcha
      ? { t: "Grupo", v: "En marcha", s: `Hace ${duracion(e.en_marcha_desde, ahora)}${e.kw != null ? ` · ${num(e.kw, 1)} kW` : ""}`, c: "text-amber-600" }
      : { t: "Grupo", v: "En reposo", s: "Listo para arrancar si se corta la luz", c: "text-ink" },
    e.red_ok
      ? { t: "Red eléctrica", v: "Normal", s: `${num(e.red_v1, 1)} V · ${num(e.red_hz, 1)} Hz`, c: "text-emerald-600" }
      : { t: "Red eléctrica", v: "Cortada", s: `Hace ${duracion(e.red_cortada_desde, ahora)}`, c: "text-red-600" },
    { t: "Modo", v: e.modo != null ? MODOS[e.modo] ?? `Modo ${e.modo}` : "—", s: enAuto ? "Arranca solo ante un corte" : "Ante un corte NO arranca solo", c: enAuto ? "text-ink" : "text-red-600" },
    { t: "Combustible", v: e.combustible_pct != null ? `${num(e.combustible_pct)}%` : "—", s: litros != null ? `Unos ${litros} L de ${config.litros_tanque}` : `Mínimo ${config.combustible_minimo}%`, c: combBajo ? "text-red-600" : "text-ink" },
  ] : [];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">{config.nombre}</h1>
          <p className="text-ink/60 text-sm mt-1">
            Deep Sea DSE4520 MKII vía DSE855{config.ip ? ` (${config.ip})` : ""}, leído por Modbus TCP en modo solo lectura.
            {estado?.ultimo_ok ? ` Último dato ${hace(estado.ultimo_ok, ahora)}.` : ""}
          </p>
        </div>
        {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)}>{verConfig ? "Ocultar configuración" : "Configuración"}</button>}
      </div>

      {(verConfig || (sinDatos && esAdmin)) && esAdmin && <PuenteGrupo config={config} alCambiar={cargar} />}

      {sinDatos ? (
        <div className="card p-6 text-sm text-ink/60">
          {config.configurado
            ? "El puente está generado pero todavía no envió datos. Revisá que esté instalado y que llegue al DSE855."
            : esAdmin ? "Todavía no hay datos. Instalá el puente desde la configuración de arriba." : "Todavía no hay datos del grupo electrógeno."}
        </div>
      ) : (
        <>
          {e!.responde === false && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-md px-3 py-2">
              El grupo no responde desde {fechaHora(e!.ultimo_ok!)}: {e!.ultimo_error ?? "sin detalle"}. Los valores de abajo son del último dato recibido.
            </p>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {tarjetas.map((t) => (
              <div key={t.t} className="card p-5">
                <div className="text-xs text-ink/50 font-medium">{t.t}</div>
                <div className={`font-display text-2xl mt-1 ${t.c}`}>{t.v}</div>
                <div className="text-xs text-ink/50 mt-1">{t.s}</div>
              </div>
            ))}
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-5">
              <h2 className="font-medium text-ink mb-2">Red</h2>
              <Dato t="L1" v={num(e!.red_v1, 1)} u="V" /><Dato t="L2" v={num(e!.red_v2, 1)} u="V" /><Dato t="L3" v={num(e!.red_v3, 1)} u="V" />
              <Dato t="Frecuencia" v={num(e!.red_hz, 1)} u="Hz" />
            </div>
            <div className="card p-5">
              <h2 className="font-medium text-ink mb-2">Generador</h2>
              <Dato t="L1" v={num(e!.gen_v1, 1)} u="V" /><Dato t="L2" v={num(e!.gen_v2, 1)} u="V" /><Dato t="L3" v={num(e!.gen_v3, 1)} u="V" />
              <Dato t="Frecuencia" v={num(e!.gen_hz, 1)} u="Hz" /><Dato t="Potencia" v={num(e!.kw, 1)} u="kW" />
            </div>
            <div className="card p-5">
              <h2 className="font-medium text-ink mb-2">Motor</h2>
              <Dato t="Velocidad" v={num(e!.rpm)} u="RPM" />
              <Dato t="Temperatura" v={num(e!.temp_refrigerante)} u="°C" />
              <Dato t="Presión de aceite" v={num(e!.presion_aceite)} u="kPa" />
              <Dato t="Batería" v={num(e!.bateria_v, 1)} u="V" alerta={e!.bateria_v != null && !e!.en_marcha && e!.bateria_v < config.bateria_minima} />
              <Dato t="Alternador de carga" v={num(e!.alternador_v, 1)} u="V" />
            </div>
            <div className="card p-5">
              <h2 className="font-medium text-ink mb-2">Acumulados</h2>
              <Dato t="Horas de motor" v={num(e!.horas_motor, 1)} u="h" />
              <Dato t="Arranques" v={num(e!.arranques)} />
              <Dato t="Combustible" v={e!.combustible_pct != null ? `${num(e!.combustible_pct)}%` : "—"} alerta={combBajo} />
            </div>
          </div>

          <div className="card p-5 space-y-2">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h2 className="font-medium text-ink">Combustible, últimos 30 días</h2>
              <span className="text-xs text-ink/50">Las franjas marcan las horas en que funcionó el grupo</span>
            </div>
            <GraficoCombustible datos={historial} minimo={config.combustible_minimo} />
          </div>
        </>
      )}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Fecha</th><th>Evento</th><th>Detalle</th></tr></thead>
          <tbody>
            {eventos.map((ev) => (
              <tr key={ev.id}>
                <td className="whitespace-nowrap tabular-nums">{fechaHora(ev.fecha)}</td>
                <td><span className={`pill ${EVENTO[ev.tipo]?.c ?? "bg-line/[0.05] text-ink/60"}`}>{EVENTO[ev.tipo]?.t ?? ev.tipo}</span></td>
                <td className="text-sm text-ink/70">{ev.detalle ?? ""}</td>
              </tr>
            ))}
            {eventos.length === 0 && <tr><td colSpan={3} className="text-center text-ink/40 py-8">Sin eventos todavía. Acá van a aparecer los cortes de luz, arranques y cambios de modo.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
