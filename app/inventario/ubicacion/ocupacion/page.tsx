"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Fila = { fecha: string; hora: number; zona: string; empresa: number; invitados: number; con_agente: number };
type Ahora = { zona: string; con_agente: number; otros: number; invitados: number };

// Lunes a domingo (getDay: 0 = domingo)
const DIAS = [
  { d: 1, t: "Lun" }, { d: 2, t: "Mar" }, { d: 3, t: "Mié" }, { d: 4, t: "Jue" }, { d: 5, t: "Vie" }, { d: 6, t: "Sáb" }, { d: 0, t: "Dom" },
];
const diaSemana = (f: string) => new Date(f + "T12:00:00").getDay();

export default function Ocupacion() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [ahora, setAhora] = useState<Ahora[]>([]);
  const [dias, setDias] = useState(28);
  const [zona, setZona] = useState("todas");
  const [medida, setMedida] = useState<"empresa" | "con_agente">("empresa");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sb = createClient();
    setCargando(true);
    Promise.all([sb.rpc("unifi_ocupacion_datos", { p_dias: dias }), sb.rpc("unifi_ubicacion")]).then(([o, u]) => {
      if (o.error) setError(/unifi_ocupacion_datos/.test(o.error.message) ? "Falta ejecutar supabase/unifi-extra.sql en Supabase." : o.error.message);
      else setError(null);
      setFilas((o.data ?? []) as Fila[]);
      setAhora(((u.data as { zonas?: Ahora[] } | null)?.zonas ?? []) as Ahora[]);
      setCargando(false);
    });
  }, [dias]);

  const listaZonas = useMemo(() => Array.from(new Set(filas.map((f) => f.zona))).sort(), [filas]);
  const elegidas = useMemo(() => filas.filter((f) => zona === "todas" || f.zona === zona), [filas, zona]);

  // Por fecha y hora se suman las zonas elegidas; después se promedia por día de la semana
  const matriz = useMemo(() => {
    const porFechaHora = new Map<string, number>();
    elegidas.forEach((f) => {
      const k = `${f.fecha}|${f.hora}`;
      porFechaHora.set(k, (porFechaHora.get(k) ?? 0) + f[medida]);
    });
    const suma = new Map<string, number>();
    const fechasPorDia = new Map<number, Set<string>>();
    porFechaHora.forEach((v, k) => {
      const [fecha, hora] = k.split("|");
      const d = diaSemana(fecha);
      suma.set(`${d}|${hora}`, (suma.get(`${d}|${hora}`) ?? 0) + v);
      if (!fechasPorDia.has(d)) fechasPorDia.set(d, new Set());
      fechasPorDia.get(d)!.add(fecha);
    });
    const valor = (d: number, h: number) => {
      const n = fechasPorDia.get(d)?.size ?? 0;
      return n ? Math.round((suma.get(`${d}|${h}`) ?? 0) / n) : null;
    };
    return { valor, fechasPorDia };
  }, [elegidas, medida]);

  // Horas a mostrar: de la primera a la última con actividad (mínimo 8 a 19)
  const horas = useMemo(() => {
    const conDatos = elegidas.filter((f) => f[medida] > 0).map((f) => f.hora);
    const desde = Math.min(8, ...conDatos);
    const hasta = Math.max(19, ...conDatos);
    return Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);
  }, [elegidas, medida]);
  const diasVisibles = DIAS.filter((x) => x.d !== 0 && x.d !== 6 || horas.some((h) => (matriz.valor(x.d, h) ?? 0) > 0));
  const maximo = Math.max(1, ...diasVisibles.flatMap((x) => horas.map((h) => matriz.valor(x.d, h) ?? 0)));

  // Resumen por zona: pico promedio en días hábiles y pico máximo del período
  const resumen = useMemo(() => listaZonas.map((z) => {
    const deZona = filas.filter((f) => f.zona === z);
    const picoPorFecha = new Map<string, number>();
    deZona.forEach((f) => picoPorFecha.set(f.fecha, Math.max(picoPorFecha.get(f.fecha) ?? 0, f[medida])));
    const habiles = Array.from(picoPorFecha.entries()).filter(([f]) => ![0, 6].includes(diaSemana(f)));
    const promedio = habiles.length ? Math.round(habiles.reduce((a, [, v]) => a + v, 0) / habiles.length) : 0;
    let max = 0; let fechaMax = "";
    picoPorFecha.forEach((v, f) => { if (v > max) { max = v; fechaMax = f; } });
    const porDia = DIAS.slice(0, 5).map((x) => {
      const vals = habiles.filter(([f]) => diaSemana(f) === x.d).map(([, v]) => v);
      return { t: x.t, v: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0 };
    });
    const masConcurrido = porDia.reduce((a, b) => (b.v > a.v ? b : a), porDia[0]);
    return { zona: z, promedio, max, fechaMax, dia: masConcurrido.v > 0 ? masConcurrido.t : "—" };
  }), [filas, listaZonas, medida]);

  const color = (v: number | null) => {
    if (!v) return undefined;
    const a = 0.12 + 0.88 * (v / maximo);
    return { backgroundColor: `rgb(47 92 240 / ${a.toFixed(2)})`, color: a > 0.55 ? "#fff" : undefined };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Ocupación por piso</h1>
        <p className="text-ink/60 text-sm mt-1 max-w-3xl">
          Cuántos dispositivos hay conectados a las antenas WiFi de cada zona, hora por hora. Sirve para ver qué días y horarios se llena
          cada piso. La zona de cada antena se configura en{" "}
          <Link href="/inventario/wifi?vista=equipos" className="text-brand-600 hover:underline">Seguridad → WiFi → Equipos</Link>.
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {ahora.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {ahora.map((z) => (
            <div key={z.zona} className="card p-5">
              <div className="text-xs text-ink/50 font-medium">{z.zona} · ahora</div>
              <div className="font-display text-3xl mt-1 tabular-nums">{z.con_agente + z.otros}</div>
              <div className="text-xs text-ink/50 mt-0.5">{z.con_agente} con agente · {z.otros} otros{z.invitados ? ` · ${z.invitados} invitados` : ""}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-end">
        <label className="block text-sm"><span className="label">Zona</span>
          <select className="input w-auto" value={zona} onChange={(e) => setZona(e.target.value)}>
            <option value="todas">Todas las zonas</option>
            {listaZonas.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        <label className="block text-sm"><span className="label">Contar</span>
          <select className="input w-auto" value={medida} onChange={(e) => setMedida(e.target.value as "empresa" | "con_agente")}>
            <option value="empresa">Todos los dispositivos (WiFi de la empresa)</option>
            <option value="con_agente">Solo equipos con agente (≈ personas con notebook)</option>
          </select>
        </label>
        <label className="block text-sm"><span className="label">Período</span>
          <select className="input w-auto" value={dias} onChange={(e) => setDias(Number(e.target.value))}>
            <option value={14}>Últimas 2 semanas</option><option value={28}>Últimas 4 semanas</option><option value={56}>Últimas 8 semanas</option>
          </select>
        </label>
      </div>

      <div className="card p-5">
        <h2 className="font-medium text-ink">Promedio por día de la semana y hora</h2>
        <p className="text-xs text-ink/50 mt-0.5">Promedio del máximo de dispositivos conectados en cada hora. Pasá el mouse por una celda para ver el detalle.</p>
        {cargando ? <p className="text-sm text-ink/50 py-8">Cargando…</p> : !filas.length ? (
          <p className="text-sm text-ink/50 py-8">
            Todavía no hay datos. La ocupación se empieza a registrar cuando el puente de UniFi está funcionando y se completa con el paso de
            los días.
          </p>
        ) : (
          <div className="overflow-x-auto mt-4">
            <table className="border-separate" style={{ borderSpacing: 2 }} aria-label="Ocupación promedio por día y hora">
              <thead>
                <tr>
                  <th className="w-10" />
                  {horas.map((h) => <th key={h} className="text-[11px] font-normal text-ink/50 tabular-nums px-0.5">{h}h</th>)}
                </tr>
              </thead>
              <tbody>
                {diasVisibles.map((x) => (
                  <tr key={x.d}>
                    <th className="text-xs font-medium text-ink/60 text-left pr-2">{x.t}</th>
                    {horas.map((h) => {
                      const v = matriz.valor(x.d, h);
                      return (
                        <td key={h} title={`${x.t} ${h}:00 a ${h + 1}:00 · promedio ${v ?? 0} dispositivos (${matriz.fechasPorDia.get(x.d)?.size ?? 0} días con datos)`}
                          className="h-8 min-w-[2.25rem] rounded text-center text-[11px] tabular-nums bg-line/[0.04] text-ink/70" style={color(v)}>
                          {v || ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-2 mt-3 text-[11px] text-ink/50">
              <span>Menos</span>
              {[0.12, 0.34, 0.56, 0.78, 1].map((a) => <span key={a} className="h-3 w-6 rounded-sm" style={{ backgroundColor: `rgb(47 92 240 / ${a})` }} />)}
              <span>Más (máximo {maximo})</span>
            </div>
          </div>
        )}
      </div>

      {resumen.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Zona</th><th>Pico promedio (días hábiles)</th><th>Día más concurrido</th><th>Pico máximo del período</th></tr></thead>
            <tbody>
              {resumen.map((r) => (
                <tr key={r.zona}>
                  <td className="text-ink font-medium">{r.zona}</td>
                  <td className="tabular-nums">{r.promedio}</td>
                  <td>{r.dia}</td>
                  <td className="tabular-nums">{r.max}{r.fechaMax && <span className="text-xs text-ink/50"> · {r.fechaMax.split("-").reverse().join("/")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-ink/50">
        Se cuentan dispositivos, no personas: una persona con notebook y celular suma dos. Para aproximar personas, elegí “Solo equipos con
        agente”. Los datos se guardan 120 días.
      </p>
    </div>
  );
}
