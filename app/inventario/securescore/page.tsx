"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import TareasProgramadas, { useEstadoProg } from "@/components/TareasProgramadas";

type Punto = { fecha: string; actual: number | null; maximo: number | null; promedio_similares: number | null };
type Categoria = { categoria: string; actual: number | null; maximo: number | null };
type Accion = { control: string; titulo: string | null; categoria: string | null; servicio: string | null; puntaje: number | null; maximo: number | null; estado: string; costo: string | null; impacto: string | null; rango: number | null; enlace: string | null };

const CAT: Record<string, string> = { Identity: "Identidad", Data: "Datos", Device: "Dispositivos", Apps: "Aplicaciones", Infrastructure: "Infraestructura" };
const NIVEL: Record<string, string> = { Low: "Bajo", Moderate: "Medio", High: "Alto" };
const pct = (a: number | null, b: number | null) => (a != null && b ? Math.round((100 * a) / b) : null);

// Evolución del puntaje (porcentaje) en SVG simple
function Evolucion({ puntos }: { puntos: Punto[] }) {
  const datos = puntos.filter((p) => p.maximo).map((p) => ({ f: p.fecha, v: (100 * (p.actual ?? 0)) / p.maximo!, prom: p.promedio_similares != null ? (100 * p.promedio_similares) / p.maximo! : null }));
  if (datos.length < 2) return <p className="text-sm text-ink/50">La evolución aparece con al menos dos días de datos.</p>;
  const W = 640, H = 160, M = { l: 32, r: 8, t: 8, b: 20 };
  const vals = datos.flatMap((d) => [d.v, d.prom ?? d.v]);
  const min = Math.max(0, Math.floor(Math.min(...vals) / 10) * 10 - 5), max = Math.min(100, Math.ceil(Math.max(...vals) / 10) * 10 + 5);
  const x = (i: number) => M.l + (i * (W - M.l - M.r)) / (datos.length - 1);
  const y = (v: number) => M.t + ((max - v) * (H - M.t - M.b)) / (max - min || 1);
  const linea = (f: (d: (typeof datos)[0]) => number | null) => datos.map((d, i) => (f(d) == null ? "" : `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(f(d)!).toFixed(1)}`)).join(" ");
  const marcas = [min, Math.round((min + max) / 2), max];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Evolución del Secure Score">
      {marcas.map((m) => (
        <g key={m}><line x1={M.l} x2={W - M.r} y1={y(m)} y2={y(m)} className="stroke-line/10" /><text x={M.l - 4} y={y(m) + 3} textAnchor="end" className="fill-ink/40 text-[10px]">{m}%</text></g>
      ))}
      {datos.some((d) => d.prom != null) && <path d={linea((d) => d.prom)} fill="none" stroke="#d97706" strokeWidth={1.5} strokeDasharray="4 3" />}
      <path d={linea((d) => d.v)} fill="none" stroke="#2563eb" strokeWidth={2} />
      <text x={M.l} y={H - 4} className="fill-ink/40 text-[10px]">{new Date(datos[0].f + "T12:00").toLocaleDateString("es-AR")}</text>
      <text x={W - M.r} y={H - 4} textAnchor="end" className="fill-ink/40 text-[10px]">{new Date(datos[datos.length - 1].f + "T12:00").toLocaleDateString("es-AR")}</text>
    </svg>
  );
}

export default function SecureScore() {
  const { esAdmin } = usePerfil();
  const { estado, guardar } = useEstadoProg();
  const [hist, setHist] = useState<Punto[]>([]);
  const [cats, setCats] = useState<Categoria[]>([]);
  const [acc, setAcc] = useState<Accion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [filtro, setFiltro] = useState("pendientes");
  const [al, setAl] = useState<{ alertas_securescore: boolean; securescore_min: number; securescore_caida: number } | null>(null);
  const [avisoAl, setAvisoAl] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [h, c, a] = await Promise.all([
      sb.from("ss_historial").select("*").order("fecha"), sb.from("ss_categorias").select("*"), sb.from("ss_acciones").select("*"),
    ]);
    setHist((h.data ?? []) as Punto[]); setCats((c.data ?? []) as Categoria[]); setAcc((a.data ?? []) as Accion[]); setCargando(false);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { if (estado && !al) setAl({ alertas_securescore: estado.alertas_securescore, securescore_min: estado.securescore_min, securescore_caida: estado.securescore_caida }); }, [estado, al]);

  const ult = hist[hist.length - 1];
  const hace30 = [...hist].reverse().find((p) => Date.parse(p.fecha) <= Date.parse(ult?.fecha ?? "") - 30 * 86400000);
  const p = pct(ult?.actual ?? null, ult?.maximo ?? null);
  const dif = ult && hace30 && ult.maximo ? Math.round(((ult.actual ?? 0) - (hace30.actual ?? 0)) * 10) / 10 : null;
  const lista = useMemo(() => acc
    .filter((a) => filtro === "todas" || (filtro === "pendientes" ? a.estado !== "completo" : a.estado === filtro))
    .sort((a, b) => ((b.maximo ?? 0) - (b.puntaje ?? 0)) - ((a.maximo ?? 0) - (a.puntaje ?? 0)) || (a.rango ?? 999) - (b.rango ?? 999)), [acc, filtro]);
  const ganancia = acc.reduce((s, a) => s + Math.max(0, (a.maximo ?? 0) - (a.puntaje ?? 0)), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Secure Score de Microsoft 365</h1>
        <p className="text-ink/60 text-sm mt-1 max-w-3xl">
          El puntaje de seguridad que calcula Microsoft para el tenant (identidad, correo, dispositivos, datos y aplicaciones), su evolución
          y las acciones que más suman. Se actualiza una vez por día.
        </p>
      </div>
      <TareasProgramadas parte="securescore" alTerminar={cargar} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-5"><div className="text-xs text-ink/50">Puntaje</div>
          <div className={`font-display text-3xl mt-1 ${p == null ? "text-ink/30" : p >= (estado?.securescore_min ?? 60) ? "text-emerald-700" : "text-amber-700"}`}>{p == null ? "—" : `${p}%`}</div>
          <div className="text-xs text-ink/50">{ult ? `${Math.round(ult.actual ?? 0)} de ${Math.round(ult.maximo ?? 0)} puntos` : cargando ? "Cargando…" : "Sin datos todavía"}</div></div>
        <div className="card p-5"><div className="text-xs text-ink/50">Organizaciones similares</div>
          <div className="font-display text-3xl mt-1 text-ink">{ult?.promedio_similares != null ? `${pct(ult.promedio_similares, ult.maximo)}%` : "—"}</div>
          <div className="text-xs text-ink/50">promedio de todos los tenants</div></div>
        <div className="card p-5"><div className="text-xs text-ink/50">Últimos 30 días</div>
          <div className={`font-display text-3xl mt-1 ${dif == null ? "text-ink/30" : dif < 0 ? "text-red-600" : "text-emerald-700"}`}>{dif == null ? "—" : `${dif > 0 ? "+" : ""}${dif}`}</div>
          <div className="text-xs text-ink/50">puntos</div></div>
        <div className="card p-5"><div className="text-xs text-ink/50">Se pueden sumar</div>
          <div className="font-display text-3xl mt-1 text-ink">{acc.length ? Math.round(ganancia) : "—"}</div>
          <div className="text-xs text-ink/50">puntos con las acciones pendientes</div></div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-5 lg:col-span-2">
          <div className="flex justify-between items-baseline mb-2">
            <h2 className="font-medium text-ink">Evolución</h2>
            <span className="text-xs text-ink/50"><span className="text-blue-600">━</span> Accusys · <span className="text-amber-600">┅</span> promedio</span>
          </div>
          <Evolucion puntos={hist} />
        </div>
        <div className="card p-5 space-y-3">
          <h2 className="font-medium text-ink">Por categoría</h2>
          {!cats.length && <p className="text-sm text-ink/50">Sin datos todavía.</p>}
          {[...cats].sort((a, b) => (b.maximo ?? 0) - (a.maximo ?? 0)).map((c) => {
            const v = pct(c.actual, c.maximo) ?? 0;
            return (
              <div key={c.categoria}>
                <div className="flex justify-between text-sm"><span>{CAT[c.categoria] ?? c.categoria}</span><span className="tabular-nums text-ink/60">{Math.round(c.actual ?? 0)} / {Math.round(c.maximo ?? 0)}</span></div>
                <div className="h-1.5 rounded-full bg-line/[0.08] mt-1 overflow-hidden"><div className={`h-full ${v >= 70 ? "bg-emerald-500" : v >= 40 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${v}%` }} /></div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg text-ink">Acciones de mejora</h2>
          <select className="input w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtro">
            <option value="pendientes">Pendientes y parciales</option><option value="pendiente">Solo pendientes</option><option value="parcial">Solo parciales</option>
            <option value="completo">Completas</option><option value="todas">Todas</option>
          </select>
        </div>
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Acción</th><th>Categoría</th><th>Puntos</th><th>Impacto en usuarios</th><th>Esfuerzo</th><th></th></tr></thead>
            <tbody>
              {!lista.length && <tr><td colSpan={6} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : "Nada para mostrar con este filtro."}</td></tr>}
              {lista.map((a) => (
                <tr key={a.control}>
                  <td className="text-sm"><div className="font-medium text-ink">{a.titulo ?? a.control}</div><div className="text-xs text-ink/45">{a.servicio}</div></td>
                  <td className="text-sm text-ink/70">{CAT[a.categoria ?? ""] ?? a.categoria}</td>
                  <td className="text-sm tabular-nums whitespace-nowrap">
                    <span className={a.estado === "completo" ? "text-emerald-700" : a.estado === "parcial" ? "text-amber-700" : "text-ink"}>{Math.round((a.puntaje ?? 0) * 10) / 10}</span>
                    <span className="text-ink/45"> / {a.maximo}</span></td>
                  <td className="text-sm text-ink/70">{NIVEL[a.impacto ?? ""] ?? a.impacto ?? "—"}</td>
                  <td className="text-sm text-ink/70">{NIVEL[a.costo ?? ""] ?? a.costo ?? "—"}</td>
                  <td className="text-right">{a.enlace && <a href={a.enlace} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-600 hover:underline whitespace-nowrap">Abrir en Microsoft</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {esAdmin && al && (
        <div className="card p-5 space-y-3">
          <h2 className="font-medium text-ink">Alertas</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={al.alertas_securescore} onChange={(e) => setAl({ ...al, alertas_securescore: e.target.checked })} />
            Avisar si el puntaje queda debajo de la meta o baja de golpe (por ejemplo, alguien desactivó una política)
          </label>
          <div className="grid sm:grid-cols-2 gap-3 max-w-xl">
            <label className="block text-sm">Meta (%)<input type="number" min={1} max={100} className="input mt-1" value={al.securescore_min} onChange={(e) => setAl({ ...al, securescore_min: Number(e.target.value) })} /></label>
            <label className="block text-sm">Avisar si baja en una semana (puntos %)<input type="number" min={1} max={50} className="input mt-1" value={al.securescore_caida} onChange={(e) => setAl({ ...al, securescore_caida: Number(e.target.value) })} /></label>
          </div>
          <button className="btn-secondary" onClick={async () => setAvisoAl((await guardar(al)) ?? "Guardado.")}>Guardar</button>
          {avisoAl && <p role="status" className="text-sm text-ink/70">{avisoAl}</p>}
        </div>
      )}
    </div>
  );
}
