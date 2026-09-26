"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { hace } from "@/lib/monitoreo";
import PuentePrtg from "./PuentePrtg";
import DiagramaRed from "./DiagramaRed";
import { crearUbicador } from "@/lib/topologia";

type Equipo = { objid: number; nombre: string; host: string; padre: number; grupo: string; sonda: string; estado: string; ok: number; advertencia: number; caido: number; inusual: number; pausado: number; total: number; ubicacion: string };
type Sensor = { objid: number; nombre: string; dispositivo: number; estado: string; mensaje: string; valor: string; desde: string };
type Datos = { prtg?: string; sondas?: { objid: number; nombre: string }[]; grupos?: { objid: number; nombre: string; padre: number }[]; dispositivos?: Equipo[]; sensores?: Sensor[] };

const ESTADO: Record<string, { texto: string; barra: string; pill: string; orden: number }> = {
  caido: { texto: "Caído", barra: "bg-red-500", pill: "bg-red-50 text-red-600", orden: 0 },
  caido_reconocido: { texto: "Caído (reconocido)", barra: "bg-red-300", pill: "bg-red-50 text-red-500", orden: 1 },
  advertencia: { texto: "Advertencia", barra: "bg-amber-500", pill: "bg-amber-500/10 text-amber-700", orden: 2 },
  inusual: { texto: "Inusual", barra: "bg-orange-500", pill: "bg-orange-50 text-orange-700", orden: 3 },
  desconocido: { texto: "Sin datos", barra: "bg-line/20", pill: "bg-line/[0.05] text-ink/50", orden: 4 },
  ok: { texto: "OK", barra: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700", orden: 5 },
  pausado: { texto: "Pausado", barra: "bg-sky-300", pill: "bg-sky-50 text-sky-700", orden: 6 },
};
const est = (e: string) => ESTADO[e] ?? ESTADO.desconocido;
const MINUTOS_VIEJO = 10;

function Contadores({ e }: { e: Equipo }) {
  return (
    <span className="flex gap-1 flex-wrap">
      {e.caido > 0 && <span className="pill bg-red-50 text-red-600">✗ {e.caido}</span>}
      {e.advertencia > 0 && <span className="pill bg-amber-500/10 text-amber-700">W {e.advertencia}</span>}
      {e.inusual > 0 && <span className="pill bg-orange-50 text-orange-700">U {e.inusual}</span>}
      {e.ok > 0 && <span className="pill bg-emerald-50 text-emerald-700">✓ {e.ok}</span>}
      {e.pausado > 0 && <span className="pill bg-sky-50 text-sky-700">❚❚ {e.pausado}</span>}
    </span>
  );
}

export default function MapaAutomatico() {
  const { esAdmin } = usePerfil();
  const [datos, setDatos] = useState<Datos>({});
  const [actualizado, setActualizado] = useState<string | null>(null);
  const [prtgUrl, setPrtgUrl] = useState<string | null>(null);
  const [eventos, setEventos] = useState<any[]>([]);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [soloProblemas, setSoloProblemas] = useState(false);
  const [texto, setTexto] = useState("");
  const [verPuente, setVerPuente] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const [vista, setVista] = useState<"diagrama" | "sedes">("diagrama");
  const [conexiones, setConexiones] = useState<Record<number, number>>({});
  const cargarConexiones = () => createClient().from("red_conexiones").select("objid, conecta_a")
    .then(({ data }) => setConexiones(Object.fromEntries((data ?? []).map((c: any) => [c.objid, c.conecta_a]))));
  useEffect(() => { cargarConexiones(); }, []);

  useEffect(() => {
    const sb = createClient();
    const cargar = () => Promise.all([
      sb.from("red_prtg_estado").select("datos, actualizado, prtg_url").eq("id", 1).maybeSingle(),
      sb.from("red_prtg_eventos").select("*").order("fecha", { ascending: false }).limit(30),
    ]).then(([e, ev]) => {
      setDatos((e.data?.datos ?? {}) as Datos); setActualizado(e.data?.actualizado ?? null); setPrtgUrl(e.data?.prtg_url ?? null);
      setEventos(ev.data ?? []); setCargando(false);
    });
    cargar();
    const canal = sb.channel("red-prtg").on("postgres_changes", { event: "*", schema: "public", table: "red_prtg_estado" }, () => cargar()).subscribe();
    const reloj = setInterval(() => setAhora(Date.now()), 30000);
    return () => { sb.removeChannel(canal); clearInterval(reloj); };
  }, []);

  const equipos = datos.dispositivos ?? [];
  const sensores = datos.sensores ?? [];
  const base = (prtgUrl ?? datos.prtg ?? "").replace(/\/$/, "");

  // Zona = grupo de primer nivel (la sede); subzona = grupos intermedios (piso, sector)
  const zonas = useMemo(() => {
    const grupos = new Map((datos.grupos ?? []).map((g) => [g.objid, g]));
    const sondas = new Map((datos.sondas ?? []).map((s) => [s.objid, s.nombre]));
    const ubicar = (padre: number) => {
      const cadena: string[] = [];
      let id = padre;
      for (let i = 0; i < 20 && id !== 0 && grupos.has(id) && !sondas.has(id); i++) {
        const g = grupos.get(id)!;
        cadena.unshift(g.nombre);
        id = g.padre;
      }
      if (!cadena.length) return { zona: sondas.get(padre) ?? "Sin grupo", sub: "" };
      return { zona: cadena[0], sub: cadena.slice(1).join(" › ") };
    };
    const q = texto.trim().toLowerCase();
    const mapa = new Map<string, { nombre: string; equipos: (Equipo & { sub: string })[] }>();
    for (const e of equipos) {
      if (soloProblemas && ["ok", "pausado"].includes(e.estado)) continue;
      if (q && ![e.nombre, e.host, e.grupo, e.ubicacion].some((v) => v?.toLowerCase().includes(q))) continue;
      const { zona, sub } = ubicar(e.padre);
      if (!mapa.has(zona)) mapa.set(zona, { nombre: zona, equipos: [] });
      mapa.get(zona)!.equipos.push({ ...e, sub });
    }
    return Array.from(mapa.values()).map((z) => {
      z.equipos.sort((a, b) => a.sub.localeCompare(b.sub) || est(a.estado).orden - est(b.estado).orden || a.nombre.localeCompare(b.nombre));
      const peor = z.equipos.reduce((m, e) => Math.min(m, est(e.estado).orden), 99);
      return { ...z, peor };
    }).sort((a, b) => a.peor - b.peor || a.nombre.localeCompare(b.nombre));
  }, [datos, equipos, soloProblemas, texto]);

  const equiposConZona = useMemo(() => {
    const ubicar = crearUbicador(datos.grupos ?? [], datos.sondas ?? []);
    return equipos.map((e) => ({ ...e, ...ubicar(e.padre) }));
  }, [datos, equipos]);

  const cuenta = (estados: string[]) => equipos.filter((e) => estados.includes(e.estado)).length;
  const viejo = actualizado && ahora - new Date(actualizado).getTime() > MINUTOS_VIEJO * 60000;

  if (!cargando && !actualizado) {
    return esAdmin ? <PuentePrtg alTerminar={() => {}} /> : (
      <div className="card p-6 text-sm text-ink/60">Todavía no está conectado PRTG. Un administrador lo configura desde esta solapa.</div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className={`text-sm ${viejo ? "text-red-600" : "text-ink/60"}`}>
          {actualizado ? (viejo
            ? `El puente de PRTG no reporta desde ${hace(actualizado, ahora)}: los estados pueden no estar al día.`
            : `Actualizado ${hace(actualizado, ahora)} · se refresca solo`) : "Cargando…"}
        </p>
        {esAdmin && <button className="btn-secondary" onClick={() => setVerPuente(!verPuente)} aria-expanded={verPuente}>Conexión con PRTG</button>}
      </div>

      {esAdmin && verPuente && <PuentePrtg alTerminar={() => setVerPuente(false)} />}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="card p-4"><div className="text-xs text-ink/50">Equipos</div><div className="font-display text-3xl mt-1 text-ink">{equipos.length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">OK</div><div className="font-display text-3xl mt-1 text-emerald-600">{cuenta(["ok"])}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Caídos</div><div className={`font-display text-3xl mt-1 ${cuenta(["caido", "caido_reconocido"]) ? "text-red-600" : "text-ink"}`}>{cuenta(["caido", "caido_reconocido"])}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Advertencias</div><div className={`font-display text-3xl mt-1 ${cuenta(["advertencia"]) ? "text-amber-600" : "text-ink"}`}>{cuenta(["advertencia"])}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Inusuales</div><div className="font-display text-3xl mt-1 text-ink">{cuenta(["inusual"])}</div></div>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        <div role="tablist" className="flex rounded-lg border border-line/[0.08] overflow-hidden text-sm">
          {([["diagrama", "Diagrama"], ["sedes", "Por sede"]] as const).map(([k, t]) => (
            <button key={k} role="tab" aria-selected={vista === k} onClick={() => setVista(k)}
              className={`px-3 py-1.5 font-medium ${vista === k ? "bg-brand-600 text-white" : "bg-surface text-ink/70 hover:text-ink"}`}>{t}</button>
          ))}
        </div>
        <input type="search" className="input flex-1 min-w-[220px]" placeholder="Buscar equipo, IP o sede" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
        <label className={`text-sm text-ink/70 flex items-center gap-2 ${vista === "diagrama" ? "hidden" : ""}`}>
          <input type="checkbox" checked={soloProblemas} onChange={(e) => setSoloProblemas(e.target.checked)} /> Solo con problemas
        </label>
      </div>

      <div className="grid lg:grid-cols-[1fr_280px] gap-5 items-start">
        {vista === "diagrama" ? (
          <DiagramaRed equipos={equiposConZona} sensores={sensores} guardadas={conexiones} base={base} texto={texto} alGuardar={cargarConexiones} />
        ) : (
        <div className="grid md:grid-cols-2 gap-5 items-start">
          {zonas.map((z) => (
            <section key={z.nombre} className="card overflow-hidden" aria-label={`Sede ${z.nombre}`}>
              <div className={`h-1 ${est(Object.keys(ESTADO).find((k) => ESTADO[k].orden === z.peor) ?? "ok").barra}`} />
              <div className="p-4">
                <div className="flex items-baseline justify-between gap-2 mb-3">
                  <h2 className="font-display font-bold text-ink flex items-center gap-2">
                    <span className="w-1 h-4 bg-[#F2C230] inline-block" aria-hidden />{z.nombre}
                  </h2>
                  <span className="text-xs text-ink/50">{z.equipos.length} {z.equipos.length === 1 ? "equipo" : "equipos"}</span>
                </div>
                <ul className="space-y-2">
                  {z.equipos.map((e, i) => {
                    const s = est(e.estado);
                    const propios = sensores.filter((x) => x.dispositivo === e.objid);
                    const nuevoSub = e.sub && (i === 0 || z.equipos[i - 1].sub !== e.sub);
                    return (
                      <li key={e.objid}>
                        {nuevoSub && <div className="text-[11px] uppercase tracking-wide text-ink/40 font-semibold mt-3 mb-1">{e.sub}</div>}
                        <button type="button" onClick={() => setAbierto(abierto === e.objid ? null : e.objid)} aria-expanded={abierto === e.objid}
                          className="w-full text-left flex items-stretch gap-3 rounded-lg border border-line/[0.06] hover:border-brand-300 bg-surface overflow-hidden">
                          <span className={`w-1.5 shrink-0 ${s.barra}`} aria-hidden />
                          <span className="flex-1 min-w-0 py-2 pr-3">
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-medium text-ink truncate">{e.nombre}</span>
                              <span className={`pill ${s.pill} shrink-0`}>{s.texto}</span>
                            </span>
                            <span className="flex items-center justify-between gap-2 mt-1">
                              <span className="text-xs text-ink/50 font-mono truncate">{e.host}</span>
                              <Contadores e={e} />
                            </span>
                          </span>
                        </button>
                        {abierto === e.objid && (
                          <div className="mx-2 mt-1 mb-2 rounded-b-lg bg-canvas px-3 py-2 text-sm space-y-1.5">
                            {propios.length === 0 ? <p className="text-ink/50 text-xs">Ningún sensor con problemas.</p> : propios.map((x) => (
                              <div key={x.objid}>
                                <span className={`pill ${est(x.estado).pill} mr-1.5`}>{est(x.estado).texto}</span>
                                <b className="text-ink">{x.nombre}</b>
                                {x.valor && x.valor !== "-" && <span className="text-ink/60"> · {x.valor}</span>}
                                {x.mensaje && <div className="text-xs text-ink/60">{x.mensaje}{x.desde ? ` · hace ${x.desde}` : ""}</div>}
                              </div>
                            ))}
                            {e.ubicacion && <p className="text-xs text-ink/50">Ubicación: {e.ubicacion}</p>}
                            {base && <a href={`${base}/device.htm?id=${e.objid}`} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-600 hover:underline">Abrir en PRTG</a>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ))}
          {!cargando && zonas.length === 0 && <div className="card p-6 text-sm text-ink/50 md:col-span-2">{soloProblemas ? "Ningún equipo con problemas. 👍" : "Ningún equipo coincide con la búsqueda."}</div>}
        </div>
        )}

        <aside className="card p-4">
          <h2 className="font-medium text-ink mb-3">Últimos cambios</h2>
          {eventos.length === 0 ? <p className="text-sm text-ink/50">Sin cambios registrados todavía.</p> : (
            <ul className="space-y-2.5">
              {eventos.map((ev) => (
                <li key={ev.id} className="text-sm">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${est(ev.estado_nuevo).barra}`} aria-hidden />
                    <span className="text-ink font-medium truncate">{ev.equipo}</span>
                  </div>
                  <div className="text-xs text-ink/50 pl-3.5">
                    {ev.estado_anterior ? `${est(ev.estado_anterior).texto} → ` : ""}{est(ev.estado_nuevo).texto} · {hace(ev.fecha, ahora)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
