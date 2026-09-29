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

// Piso de una zona a partir de su nombre: "Piso 4 - AP1" -> "Piso 4", "CBA-AP2" -> "CBA". Sin patrón, la zona es su propio piso.
function pisoDe(zona: string) {
  const p = zona.match(/^\s*piso\s*(\d+)/i);
  if (p) return `Piso ${p[1]}`;
  const q = zona.match(/^\s*([^\s\-_]+?)\s*[-_]\s*\S/);
  return q ? q[1] : zona;
}

export default function Ocupacion() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [ahora, setAhora] = useState<Ahora[]>([]);
  const [dias, setDias] = useState(28);
  const [zona, setZona] = useState("todas");   // "todas", "piso:<nombre>" o una zona
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

  const listaZonas = useMemo(() => Array.from(new Set(filas.map((f) => f.zona))).sort((a, b) => a.localeCompare(b, "es", { numeric: true })), [filas]);
  const listaPisos = useMemo(() => Array.from(new Set([...filas.map((f) => pisoDe(f.zona)), ...ahora.map((z) => pisoDe(z.zona))]))
    .sort((a, b) => a.localeCompare(b, "es", { numeric: true })), [filas, ahora]);
  const enSeleccion = (z: string) => zona === "todas" || (zona.startsWith("piso:") ? pisoDe(z) === zona.slice(5) : z === zona);
  const elegidas = useMemo(() => filas.filter((f) => enSeleccion(f.zona)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filas, zona]);

  // Totales de ahora por piso
  const pisosAhora = useMemo(() => {
    const m = new Map<string, { piso: string; total: number; con_agente: number; otros: number; invitados: number; antenas: number }>();
    for (const z of ahora) {
      const k = pisoDe(z.zona);
      const g = m.get(k) ?? { piso: k, total: 0, con_agente: 0, otros: 0, invitados: 0, antenas: 0 };
      g.total += z.con_agente + z.otros; g.con_agente += z.con_agente; g.otros += z.otros; g.invitados += z.invitados; g.antenas += 1;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => a.piso.localeCompare(b.piso, "es", { numeric: true }));
  }, [ahora]);
  const totalAhora = pisosAhora.reduce((a, g) => a + g.total, 0);

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

  // Resumen: pico promedio en días hábiles y pico máximo del período, por piso (suma de sus zonas) y por zona
  const resumen = useMemo(() => {
    const calcular = (nombre: string, esPiso: boolean, incluye: (z: string) => boolean) => {
      const porFechaHora = new Map<string, number>();
      filas.filter((f) => incluye(f.zona)).forEach((f) => {
        const k = `${f.fecha}|${f.hora}`;
        porFechaHora.set(k, (porFechaHora.get(k) ?? 0) + f[medida]);
      });
      const picoPorFecha = new Map<string, number>();
      porFechaHora.forEach((v, k) => { const fecha = k.split("|")[0]; picoPorFecha.set(fecha, Math.max(picoPorFecha.get(fecha) ?? 0, v)); });
      const habiles = Array.from(picoPorFecha.entries()).filter(([f]) => ![0, 6].includes(diaSemana(f)));
      const promedio = habiles.length ? Math.round(habiles.reduce((a, [, v]) => a + v, 0) / habiles.length) : 0;
      let max = 0; let fechaMax = "";
      picoPorFecha.forEach((v, f) => { if (v > max) { max = v; fechaMax = f; } });
      const porDia = DIAS.slice(0, 5).map((x) => {
        const vals = habiles.filter(([f]) => diaSemana(f) === x.d).map(([, v]) => v);
        return { t: x.t, v: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0 };
      });
      const masConcurrido = porDia.reduce((a, b) => (b.v > a.v ? b : a), porDia[0]);
      return { zona: nombre, esPiso, promedio, max, fechaMax, dia: masConcurrido.v > 0 ? masConcurrido.t : "—" };
    };
    const filasResumen: ReturnType<typeof calcular>[] = [];
    for (const p of listaPisos) {
      const zonas = listaZonas.filter((z) => pisoDe(z) === p);
      if (!zonas.length) continue;
      if (zonas.length > 1 || zonas[0] !== p) filasResumen.push(calcular(p, true, (z) => pisoDe(z) === p));
      zonas.forEach((z) => filasResumen.push(calcular(z, false, (x) => x === z)));
    }
    return filasResumen;
  }, [filas, listaZonas, listaPisos, medida]);

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

      {pisosAhora.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <h2 className="text-sm font-medium text-ink">Total por piso · ahora</h2>
            <span className="text-xs text-ink/50">{totalAhora} dispositivos en total</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {pisosAhora.map((g) => {
              const activo = zona === `piso:${g.piso}`;
              return (
                <button key={g.piso} onClick={() => setZona(activo ? "todas" : `piso:${g.piso}`)} aria-pressed={activo}
                  className={`card p-5 text-left transition-colors ${activo ? "border-brand-400 bg-brand-500/10" : "hover:border-brand-300"}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink">{g.piso}</span>
                    <span className="text-xs text-ink/45">{g.antenas} {g.antenas === 1 ? "antena" : "antenas"}</span>
                  </div>
                  <div className="font-display text-4xl mt-1 tabular-nums text-ink">{g.total}</div>
                  <div className="text-xs text-ink/50 mt-0.5">{g.con_agente} con agente · {g.otros} otros{g.invitados ? ` · ${g.invitados} invitados` : ""}</div>
                  <div className="h-1.5 rounded-full bg-line/[0.08] overflow-hidden mt-3">
                    <div className="h-full bg-[#2a78d6] dark:bg-[#3987e5]" style={{ width: `${totalAhora ? Math.max(2, (g.total / totalAhora) * 100) : 0}%` }} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {ahora.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <h2 className="text-sm font-medium text-ink">Por antena · ahora{zona.startsWith("piso:") ? ` · ${zona.slice(5)}` : ""}</h2>
            {zona !== "todas" && <button className="text-xs text-brand-600 hover:underline" onClick={() => setZona("todas")}>Ver todas</button>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {ahora.filter((z) => enSeleccion(z.zona)).map((z) => (
              <div key={z.zona} className="card p-5">
                <div className="text-xs text-ink/50 font-medium">{z.zona} · ahora</div>
                <div className="font-display text-3xl mt-1 tabular-nums">{z.con_agente + z.otros}</div>
                <div className="text-xs text-ink/50 mt-0.5">{z.con_agente} con agente · {z.otros} otros{z.invitados ? ` · ${z.invitados} invitados` : ""}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-end">
        <label className="block text-sm"><span className="label">Zona</span>
          <select className="input w-auto" value={zona} onChange={(e) => setZona(e.target.value)}>
            <option value="todas">Todas las zonas</option>
            {listaPisos.length > 0 && (
              <optgroup label="Pisos (suma de sus antenas)">
                {listaPisos.map((p) => <option key={p} value={`piso:${p}`}>{p}</option>)}
              </optgroup>
            )}
            <optgroup label="Antenas">
              {listaZonas.map((z) => <option key={z} value={z}>{z}</option>)}
            </optgroup>
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
                <tr key={(r.esPiso ? "p:" : "z:") + r.zona} className={r.esPiso ? "bg-line/[0.03]" : ""}>
                  <td className={r.esPiso ? "text-ink font-semibold" : "text-ink/80 pl-6"}>{r.zona}{r.esPiso && <span className="text-xs font-normal text-ink/50"> · total</span>}</td>
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
