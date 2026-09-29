"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import type { EstadoVirt } from "@/components/PuenteVirtualizacion";
import { hace } from "@/lib/monitoreo";
import { SEV, tamano, pctUsado, colorUso, type Hallazgo, type Proyeccion } from "@/lib/virtualizacion";

type Sistema = { nombre: string | null; producto: string | null; version: string | null; capacidad_gb: number | null; libre_gb: number | null; actualizado: string | null };
type Pool = { nombre: string; estado: string | null; capacidad_gb: number | null; libre_gb: number | null; usado_gb: number | null; asignado_gb: number | null };
type Disco = { id: string; estado: string | null; uso: string | null; capacidad_gb: number | null; tecnologia: string | null; gabinete: string | null; bahia: string | null; arreglo: string | null };
type Componente = { tipo: string; id: string; estado: string | null; detalle: string | null };
type Volumen = { nombre: string; estado: string | null; capacidad_gb: number | null; pool: string | null };
type Evento = { secuencia: string; fecha: string | null; objeto: string | null; codigo: string | null; evento: string | null; descripcion: string | null };

const USO: Record<string, string> = { member: "En uso", spare: "Repuesto (spare)", candidate: "Disponible", failed: "Fallado", unused: "Sin usar" };
const TIPO_COMP: Record<string, string> = { nodo: "Controladora", gabinete: "Gabinete", fuente: "Fuente", bateria: "Batería", arreglo: "Arreglo (RAID)" };
const ok = (e: string | null) => e === "online";
const pillEstado = (e: string | null) => (ok(e) ? "bg-emerald-50 text-emerald-700" : e === "degraded" ? "bg-amber-500/15 text-amber-700" : "bg-red-600 text-white");
const textoEstado = (e: string | null) => (e === "online" ? "OK" : e === "degraded" ? "Degradado" : e === "offline" ? "Fuera de línea" : e ?? "Sin estado");

function Barra({ v, etiqueta, limite }: { v: number | null; etiqueta: string; limite: number }) {
  const p = Math.max(0, Math.min(100, v ?? 0));
  return (
    <div>
      <div className="flex justify-between text-xs text-ink/55 gap-2"><span>{etiqueta}</span><span className="tabular-nums">{v == null ? "—" : `${Math.round(p)}%`}</span></div>
      <div className="h-1.5 rounded-full bg-line/[0.08] mt-1 overflow-hidden"><div className={`h-full ${colorUso(v, limite)}`} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

export default function Storage() {
  const { esAdmin } = usePerfil();
  const [estado, setEstado] = useState<EstadoVirt | null>(null);
  const [sis, setSis] = useState<Sistema | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [discos, setDiscos] = useState<Disco[]>([]);
  const [comps, setComps] = useState<Componente[]>([]);
  const [vols, setVols] = useState<Volumen[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [proy, setProy] = useState<Proyeccion[]>([]);
  const [hallazgos, setHallazgos] = useState<Hallazgo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ahora, setAhora] = useState(Date.now());
  const [texto, setTexto] = useState("");

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, s, p, d, c, v, ev, pr, hz] = await Promise.all([
      sb.rpc("virt_estado"), sb.from("sto_sistema").select("*").maybeSingle(), sb.from("sto_pools").select("*").order("nombre"),
      sb.from("sto_discos").select("*"), sb.from("sto_componentes").select("*").order("tipo").order("id"),
      sb.from("sto_volumenes").select("*").order("nombre"), sb.from("sto_eventos").select("*").order("fecha", { ascending: false }),
      sb.from("virt_proyeccion").select("*").eq("tipo", "pool"), sb.from("virt_hallazgos").select("*").in("ambito", ["storage", "pool"]),
    ]);
    const err = e.error ?? s.error;
    setError(err ? (/virt_|sto_/.test(err.message) ? "Falta ejecutar supabase/virtualizacion.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoVirt) ?? null); setSis((s.data as Sistema) ?? null);
    setPools((p.data ?? []) as Pool[]); setComps((c.data ?? []) as Componente[]); setVols((v.data ?? []) as Volumen[]);
    setEventos((ev.data ?? []) as Evento[]); setProy((pr.data ?? []) as Proyeccion[]); setHallazgos((hz.data ?? []) as Hallazgo[]);
    const num = (x: string | null) => Number(x ?? "0") || 0;
    setDiscos(((d.data ?? []) as Disco[]).sort((a, b) => num(a.gabinete) - num(b.gabinete) || num(a.bahia) - num(b.bahia) || num(a.id) - num(b.id)));
    setAhora(Date.now()); setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 120000); return () => clearInterval(t); }, [cargar]);

  const limite = estado?.pct_lleno ?? 85;
  const q = texto.trim().toLowerCase();
  const coincide = (...x: (string | null | undefined)[]) => !q || x.some((y) => y?.toLowerCase().includes(q));
  const pSis = pctUsado(sis?.capacidad_gb ?? null, sis?.libre_gb ?? null);
  const discosMal = discos.filter((d) => !ok(d.estado) || d.uso === "failed");
  const spares = discos.filter((d) => d.uso === "spare").length;
  const compMal = comps.filter((c) => !ok(c.estado));
  const tarjetas = [
    { t: "Capacidad usada", n: pSis != null ? `${pSis}%` : "—", c: pSis != null && pSis >= limite ? "text-red-600" : "text-ink" },
    { t: "Discos con problemas", n: discos.length ? `${discosMal.length} de ${discos.length}` : "—", c: discosMal.length ? "text-red-600" : "text-ink" },
    { t: "Discos de repuesto", n: discos.length ? spares : "—", c: discos.length && !spares ? "text-amber-700" : "text-ink" },
    { t: "Componentes con fallas", n: comps.length ? compMal.length : "—", c: compMal.length ? "text-red-600" : "text-ink" },
    { t: "Eventos sin resolver", n: eventos.length, c: eventos.length ? "text-amber-700" : "text-ink" },
  ];
  const vacio = (cols: number, t: string) => <tr><td colSpan={cols} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : t}</td></tr>;
  const reporteViejo = estado?.ultimo_reporte ? ahora - Date.parse(estado.ultimo_reporte) > (estado.minutos_sin_reporte ?? 45) * 60000 : false;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Storage</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Estado del storage IBM: pools y su tendencia de llenado, discos por bahía, controladoras, fuentes y baterías, volúmenes y eventos abiertos.
            Lo reporta el mismo puente que vCenter.
          </p>
        </div>
        {esAdmin && <Link href="/servidores/virtualizacion" className="btn-secondary">Configurar (en Virtualización)</Link>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {estado && !estado.configurado && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está instalado el puente. Se genera desde <Link href="/servidores/virtualizacion" className="text-brand-600 hover:underline">Servidores → Virtualización → Configurar</Link>.
        </div>
      )}
      {estado?.configurado && (
        <div className={`card p-3 text-sm space-y-1 ${reporteViejo || estado.error_storage ? "bg-amber-500/10" : ""}`}>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className={reporteViejo ? "text-red-600" : ""}><b>Último reporte:</b> {estado.ultimo_reporte ? hace(estado.ultimo_reporte, ahora) : "todavía no reportó"}</span>
            {sis?.producto && <span><b>Equipo:</b> {sis.nombre} · {sis.producto} · código {sis.version}</span>}
            {sis?.actualizado && <span className="text-ink/55">Datos del storage de {hace(sis.actualizado, ahora)}</span>}
          </div>
          {estado.error_storage && <div className="text-red-600"><b>No se pudo leer el storage:</b> {estado.error_storage} (se muestran los últimos datos conocidos)</div>}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {tarjetas.map((t) => (
          <div key={t.t} className="card p-5">
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </div>
        ))}
      </div>

      {hallazgos.length > 0 && (
        <div className="card overflow-x-auto">
          <div className="px-4 pt-4 font-medium text-ink">Hallazgos</div>
          <table className="data w-full">
            <tbody>
              {[...hallazgos].sort((a, b) => (SEV[a.severidad]?.o ?? 9) - (SEV[b.severidad]?.o ?? 9) || a.titulo.localeCompare(b.titulo)).map((h) => (
                <tr key={`${h.ambito}:${h.tipo}:${h.clave}`}>
                  <td className="w-28"><span className={`pill ${SEV[h.severidad]?.c ?? ""}`}>{SEV[h.severidad]?.t ?? h.severidad}</span></td>
                  <td className="text-sm"><div className="font-medium text-ink">{h.titulo}</div><div className="text-ink/60">{h.detalle}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pools */}
      <div className="grid lg:grid-cols-2 gap-4">
        {!pools.length && <div className="card p-8 text-center text-ink/40 lg:col-span-2">{cargando ? "Cargando…" : "Sin pools reportados todavía."}</div>}
        {pools.map((p) => {
          const pct = pctUsado(p.capacidad_gb, p.libre_gb);
          const pr = proy.find((x) => x.nombre === p.nombre);
          const sobre = p.asignado_gb != null && p.capacidad_gb ? Math.round((100 * p.asignado_gb) / p.capacidad_gb) : null;
          return (
            <div key={p.nombre} className="card p-5 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-ink">Pool {p.nombre}</div>
                <span className={`pill ${pillEstado(p.estado)}`}>{textoEstado(p.estado)}</span>
              </div>
              <Barra v={pct} limite={limite} etiqueta={`${tamano(p.usado_gb ?? (p.capacidad_gb != null && p.libre_gb != null ? p.capacidad_gb - p.libre_gb : null))} usados de ${tamano(p.capacidad_gb)} · libres ${tamano(p.libre_gb)}`} />
              <div className="text-xs text-ink/55 space-y-0.5">
                {sobre != null && <div className={sobre > 100 ? "text-amber-700" : ""}>Asignado a volúmenes: {tamano(p.asignado_gb)} ({sobre}% de la capacidad{sobre > 100 ? ", sobreasignado" : ""})</div>}
                <div>
                  {pr?.crecimiento_gb_dia != null ? <>Crece {pr.crecimiento_gb_dia.toLocaleString("es-AR")} GB por día{pr.dias_para_llenarse != null
                    ? <span className={pr.dias_para_llenarse < 45 ? "text-red-600 font-medium" : ""}> · se llena en ~{pr.dias_para_llenarse} días</span> : " · sin riesgo de llenarse por ahora"}</>
                    : "La tendencia aparece después de una semana de datos."}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Discos y componentes */}
      <div className="grid xl:grid-cols-3 gap-4">
        <div className="card overflow-x-auto xl:col-span-2">
          <div className="px-4 pt-4 font-medium text-ink">Discos ({discos.length})</div>
          <table className="data w-full">
            <thead><tr><th>Gabinete / bahía</th><th>Disco</th><th>Estado</th><th>Uso</th><th>Tamaño</th><th>Arreglo</th></tr></thead>
            <tbody>
              {!discos.length && vacio(6, "Sin datos todavía.")}
              {discos.map((d) => (
                <tr key={d.id} className={!ok(d.estado) || d.uso === "failed" ? "bg-red-50/60" : ""}>
                  <td className="text-sm tabular-nums">{d.gabinete ?? "—"} / {d.bahia ?? "—"}</td>
                  <td className="text-sm">#{d.id}<div className="text-xs text-ink/45">{d.tecnologia ?? ""}</div></td>
                  <td><span className={`pill ${pillEstado(d.estado)}`}>{textoEstado(d.estado)}</span></td>
                  <td className={`text-sm ${d.uso === "failed" ? "text-red-600 font-medium" : d.uso === "spare" ? "text-emerald-700" : "text-ink/70"}`}>{USO[d.uso ?? ""] ?? d.uso ?? "—"}</td>
                  <td className="text-sm tabular-nums">{tamano(d.capacidad_gb)}</td>
                  <td className="text-sm text-ink/70">{d.arreglo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-x-auto">
          <div className="px-4 pt-4 font-medium text-ink">Controladoras y hardware</div>
          <table className="data w-full">
            <tbody>
              {!comps.length && vacio(2, "Sin datos todavía.")}
              {comps.map((c) => (
                <tr key={`${c.tipo}:${c.id}`}>
                  <td className="text-sm"><div className="font-medium">{TIPO_COMP[c.tipo] ?? c.tipo} {c.id}</div>{c.detalle && <div className="text-xs text-ink/50">{c.detalle}</div>}</td>
                  <td className="text-right"><span className={`pill ${pillEstado(c.estado)}`}>{textoEstado(c.estado)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Eventos y volúmenes */}
      <div className="flex justify-end"><input type="search" className="input max-w-xs" placeholder="Buscar volumen o evento…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" /></div>
      <div className="grid xl:grid-cols-2 gap-4">
        <div className="card overflow-x-auto">
          <div className="px-4 pt-4 font-medium text-ink">Eventos sin resolver</div>
          <table className="data w-full">
            <tbody>
              {!eventos.length && vacio(2, "Sin eventos abiertos.")}
              {eventos.filter((e) => coincide(e.descripcion, e.objeto, e.codigo, e.evento)).map((e) => (
                <tr key={e.secuencia}>
                  <td className="text-sm"><div className="font-medium">{e.descripcion ?? e.evento}</div>
                    <div className="text-xs text-ink/50">{[e.objeto, e.codigo && `código ${e.codigo}`, e.evento && `evento ${e.evento}`].filter(Boolean).join(" · ")}</div></td>
                  <td className="text-sm text-ink/60 whitespace-nowrap">{e.fecha ? hace(e.fecha, ahora) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-x-auto">
          <div className="px-4 pt-4 font-medium text-ink">Volúmenes ({vols.length})</div>
          <table className="data w-full">
            <thead><tr><th>Volumen</th><th>Pool</th><th>Tamaño</th><th>Estado</th></tr></thead>
            <tbody>
              {!vols.length && vacio(4, "Sin datos todavía.")}
              {vols.filter((v) => coincide(v.nombre, v.pool)).map((v) => (
                <tr key={v.nombre}>
                  <td className="text-sm font-medium">{v.nombre}</td>
                  <td className="text-sm text-ink/70">{v.pool ?? "—"}</td>
                  <td className="text-sm tabular-nums">{tamano(v.capacidad_gb)}</td>
                  <td><span className={`pill ${pillEstado(v.estado)}`}>{textoEstado(v.estado)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
