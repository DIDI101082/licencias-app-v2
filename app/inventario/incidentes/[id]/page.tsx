"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { SEVERIDAD, ESTADO } from "@/lib/incidentes";
import { textoUbicacion } from "@/lib/geo";

type Tarea = { id: number; fase: string; orden: number; descripcion: string; hecha: boolean; hecha_en: string | null; hecha_por_nombre: string | null };
type Evento = { id: number; tipo: string; texto: string; autor_nombre: string | null; fecha: string };
const FASES = ["Contención", "Investigación", "Recuperación", "Cierre"];
const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—");

export default function Incidente({ params }: { params: { id: string } }) {
  const { puedeEditar } = usePerfil();
  const [inc, setInc] = useState<any>(null);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [nota, setNota] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [cerrando, setCerrando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = async () => {
    const sb = createClient();
    const [i, t, e] = await Promise.all([
      sb.from("incidentes_v").select("*").eq("id", params.id).maybeSingle(),
      sb.from("incidentes_tareas").select("*").eq("incidente_id", params.id).order("orden").order("id"),
      sb.from("incidentes_eventos").select("*").eq("incidente_id", params.id).order("fecha", { ascending: false }),
    ]);
    if (!i.data) { setError("No se encontró el incidente o no tenés permiso para verlo."); return; }
    setInc(i.data); setTareas((t.data ?? []) as Tarea[]); setEventos((e.data ?? []) as Evento[]);
  };
  useEffect(() => { cargar(); }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rpc = async (fn: string, args: Record<string, any>) => {
    setError(null);
    const { error } = await createClient().rpc(fn, args);
    if (error) { setError(error.message); return false; }
    await cargar();
    return true;
  };

  if (error && !inc) return <p className="text-sm text-ink/60">{error}</p>;
  if (!inc) return <p className="text-sm text-ink/50">Cargando…</p>;

  const activo = inc.estado !== "cerrado";
  const editable = activo && puedeEditar;
  const hechas = tareas.filter((t) => t.hecha).length;

  return (
    <div className="space-y-6">
      <Link href="/inventario/incidentes" className="text-sm text-brand-600 hover:underline">← Incidentes</Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-ink/50">INC-{String(inc.numero).padStart(4, "0")}</span>
            <span className={`pill ${SEVERIDAD[inc.severidad]?.c}`}>{SEVERIDAD[inc.severidad]?.t}</span>
            <span className={`pill ${ESTADO[inc.estado]?.c}`}>{ESTADO[inc.estado]?.t}</span>
            <span className="pill bg-line/[0.05] text-ink/60">{inc.tipo_nombre}</span>
          </div>
          <h1 className="font-display text-2xl text-ink mt-2">{inc.titulo}</h1>
          <p className="text-sm text-ink/60 mt-1">
            Detectado {fh(inc.detectado)}
            {inc.empleado && <> · <Link href={`/empleados/${inc.empleado_id}`} className="hover:text-brand-700">{inc.empleado}</Link></>}
            {inc.creado_por_nombre && <> · registrado por {inc.creado_por_nombre}</>}
          </p>
          {inc.descripcion && <p className="text-sm text-ink/80 mt-3 whitespace-pre-wrap max-w-3xl">{inc.descripcion}</p>}
        </div>
        {puedeEditar && (
          <div className="flex gap-2 flex-wrap">
            {inc.estado === "abierto" && <button className="btn-secondary" onClick={() => rpc("incidentes_estado", { p_incidente: inc.id, p_estado: "contenido" })}>Marcar como contenido</button>}
            {activo && <button className="btn-primary" onClick={() => setCerrando(true)}>Cerrar incidente</button>}
            {!activo && <button className="btn-secondary" onClick={() => rpc("incidentes_estado", { p_incidente: inc.id, p_estado: "abierto" })}>Reabrir</button>}
          </div>
        )}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}

      {cerrando && (
        <div className="card p-4 space-y-2">
          <label className="block text-sm font-medium text-ink">Conclusión: causa, impacto y qué se hizo</label>
          <textarea className="input min-h-[80px]" value={conclusion} onChange={(e) => setConclusion(e.target.value)} />
          {hechas < tareas.length && <p className="text-xs text-amber-700">Quedan {tareas.length - hechas} pasos del playbook sin marcar. Podés cerrar igual si no aplican, explicándolo en la conclusión.</p>}
          <div className="flex gap-2 justify-end">
            <button className="btn-secondary" onClick={() => setCerrando(false)}>Cancelar</button>
            <button className="btn-primary" disabled={!conclusion.trim()} onClick={async () => {
              if (await rpc("incidentes_estado", { p_incidente: inc.id, p_estado: "cerrado", p_conclusion: conclusion })) setCerrando(false);
            }}>Cerrar</button>
          </div>
        </div>
      )}
      {!activo && inc.conclusion && (
        <div className="card p-4 bg-emerald-50/50"><div className="text-xs text-ink/50 mb-1">Conclusión · cerrado {fh(inc.cerrado)}</div><p className="text-sm text-ink whitespace-pre-wrap">{inc.conclusion}</p></div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="h-2.5 flex-1 rounded-full bg-line/[0.06] overflow-hidden">
                <div className="h-full bg-brand-600 transition-all" style={{ width: `${tareas.length ? (hechas / tareas.length) * 100 : 0}%` }} />
              </div>
              <span className="text-sm text-ink/70 tabular-nums">{hechas} de {tareas.length} pasos</span>
            </div>
          </div>
          {FASES.filter((f) => tareas.some((t) => t.fase === f)).map((f) => (
            <div key={f} className="card p-5">
              <h2 className="font-medium text-ink mb-2">{f}</h2>
              <ul className="divide-y divide-line/[0.05]">
                {tareas.filter((t) => t.fase === f).map((t) => (
                  <li key={t.id} className="py-2.5">
                    <label className={`flex items-start gap-3 text-sm ${editable ? "cursor-pointer" : ""}`}>
                      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={t.hecha} disabled={!editable}
                        onChange={(e) => rpc("incidentes_tarea_marcar", { p_tarea: t.id, p_hecha: e.target.checked })} />
                      <span className="flex-1">
                        <span className={t.hecha ? "text-ink/50 line-through" : "text-ink"}>{t.descripcion}</span>
                        {t.hecha && <span className="block text-xs text-ink/50">Hecho por {t.hecha_por_nombre ?? "—"} · {fh(t.hecha_en)}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="space-y-4">
          {inc.equipo_id && <RastroEquipo equipoId={inc.equipo_id} desde={inc.detectado} />}
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-2">Línea de tiempo</h2>
            {puedeEditar && (
              <div className="mb-3 space-y-2">
                <textarea className="input min-h-[60px] text-sm" placeholder="Agregar nota: hallazgos, N° de denuncia, contactos…" value={nota} onChange={(e) => setNota(e.target.value)} />
                <button className="btn-secondary text-xs w-full" disabled={!nota.trim()} onClick={async () => {
                  if (await rpc("incidentes_nota", { p_incidente: inc.id, p_texto: nota })) setNota("");
                }}>Agregar nota</button>
              </div>
            )}
            <ol className="space-y-3">
              {eventos.map((e) => (
                <li key={e.id} className="text-sm border-l-2 border-line/[0.1] pl-3">
                  <div className={e.tipo === "nota" ? "text-ink whitespace-pre-wrap" : "text-ink/60"}>{e.texto}</div>
                  <div className="text-xs text-ink/40">{e.autor_nombre ?? "—"} · {fh(e.fecha)}</div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

// Último rastro del equipo según lo que reporta el agente: IP pública, ciudad, red Wi-Fi
function RastroEquipo({ equipoId, desde }: { equipoId: string; desde: string }) {
  const [eq, setEq] = useState<any>(null);
  const [disp, setDisp] = useState<any[]>([]);
  const [hist, setHist] = useState<any[]>([]);

  useEffect(() => {
    const sb = createClient();
    (async () => {
      const [e, d] = await Promise.all([
        sb.from("inv_v_equipos").select("id, codigo, marca, modelo, numero_serie").eq("id", equipoId).maybeSingle(),
        sb.from("inv_dispositivos").select("*").eq("equipo_id", equipoId).order("ultimo_reporte", { ascending: false }),
      ]);
      setEq(e.data); setDisp(d.data ?? []);
      const ids = (d.data ?? []).map((x: any) => x.id);
      if (ids.length) {
        const { data } = await sb.from("inv_geo_historial").select("*").in("dispositivo_id", ids).order("ultima", { ascending: false }).limit(10);
        setHist(data ?? []);
      }
    })();
  }, [equipoId]);

  const d = disp[0];
  const despues = d && d.ultimo_reporte > desde;
  return (
    <div className="card p-5">
      <h2 className="font-medium text-ink mb-1">Rastro del equipo</h2>
      {eq && <p className="text-sm mb-3"><Link href={`/inventario/equipos/${eq.id}`} className="text-brand-600 hover:underline">{eq.codigo}</Link> <span className="text-ink/60">{[eq.marca, eq.modelo].filter(Boolean).join(" ")}{eq.numero_serie ? ` · S/N ${eq.numero_serie}` : ""}</span></p>}
      {!d ? <p className="text-sm text-ink/50">El equipo no tiene el agente instalado, no hay datos de conexión.</p> : (
        <div className="space-y-3 text-sm">
          <div className={`rounded-lg p-3 ${despues ? "bg-red-50" : "bg-line/[0.03]"}`}>
            <div className={`font-medium ${despues ? "text-red-700" : "text-ink"}`}>
              {despues ? "⚠ Se conectó después del incidente" : "Sin conexiones después del incidente"}
            </div>
            <div className="text-xs text-ink/60 mt-0.5">Último reporte: {fh(d.ultimo_reporte)}</div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink/50">Ubicación</dt><dd className="text-ink/80">{textoUbicacion(d) ?? "—"}</dd>
            <dt className="text-ink/50">IP pública</dt><dd className="font-mono text-xs text-ink/80">{d.ip_publica ?? d.geo_ip ?? "—"}</dd>
            <dt className="text-ink/50">Red Wi-Fi</dt><dd className="text-ink/80">{d.ssid ?? "—"}</dd>
            <dt className="text-ink/50">Usuario</dt><dd className="text-ink/80">{d.usuario ?? "—"}</dd>
            <dt className="text-ink/50">Equipo</dt><dd className="text-ink/80">{d.hostname ?? "—"}</dd>
          </dl>
          {hist.length > 0 && (
            <div>
              <div className="text-xs text-ink/50 mb-1">Ciudades recientes</div>
              <ul className="space-y-1 text-xs">
                {hist.map((h) => (
                  <li key={h.id} className={h.ultima > desde ? "text-red-700" : "text-ink/60"}>
                    {fh(h.ultima)} · {[h.ciudad, h.region].filter(Boolean).join(", ") || h.pais} {h.isp ? `· ${h.isp}` : ""} <span className="font-mono">{h.ip}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-ink/40">La ubicación por IP es aproximada (ciudad o zona). Pasale estos datos a la policía; no conviene ir a buscar el equipo personalmente.</p>
        </div>
      )}
    </div>
  );
}
