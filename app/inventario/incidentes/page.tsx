"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { SEVERIDAD, ESTADO } from "@/lib/incidentes";

type Incidente = {
  id: number; numero: number; tipo: string; tipo_nombre: string; titulo: string; severidad: string; estado: string;
  empleado: string | null; detectado: string; cerrado: string | null; tareas: number; hechas: number;
};

const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—");

export default function Incidentes() {
  const { puedeEditar } = usePerfil();
  const [filas, setFilas] = useState<Incidente[]>([]);
  const [filtro, setFiltro] = useState<"activos" | "cerrados" | "todos">("activos");
  const [error, setError] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState(false);

  useEffect(() => {
    createClient().from("incidentes_v").select("*").order("detectado", { ascending: false }).then(({ data, error }) => {
      if (error) setError(error.message.includes("incidentes") ? "Falta ejecutar incidentes.sql en Supabase." : error.message);
      setFilas((data ?? []) as Incidente[]);
    });
  }, []);

  const lista = useMemo(() => filas.filter((f) => filtro === "todos" || (filtro === "cerrados" ? f.estado === "cerrado" : f.estado !== "cerrado")), [filas, filtro]);
  const abiertos = filas.filter((f) => f.estado === "abierto").length;
  const contenidos = filas.filter((f) => f.estado === "contenido").length;
  const criticos = filas.filter((f) => f.estado !== "cerrado" && (f.severidad === "critica" || f.severidad === "alta")).length;
  const cerrados90 = filas.filter((f) => f.cerrado && Date.now() - Date.parse(f.cerrado) < 90 * 86400000);
  const horasProm = cerrados90.length
    ? Math.round(cerrados90.reduce((s, f) => s + (Date.parse(f.cerrado!) - Date.parse(f.detectado)), 0) / cerrados90.length / 3600000)
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Incidentes</h1>
          <p className="text-ink/60 text-sm mt-1">
            Registro de incidentes de seguridad. Cada tipo trae su playbook: los pasos a seguir, en orden, y quién hizo cada uno.
          </p>
        </div>
        {puedeEditar && <button className="btn-primary" onClick={() => setNuevo(true)}>Registrar incidente</button>}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-4"><div className="text-xs text-ink/50">Abiertos</div><div className={`font-display text-3xl mt-1 ${abiertos ? "text-red-600" : "text-ink"}`}>{abiertos}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Contenidos, sin cerrar</div><div className="font-display text-3xl mt-1 text-ink">{contenidos}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Activos de severidad alta o crítica</div><div className={`font-display text-3xl mt-1 ${criticos ? "text-red-600" : "text-ink"}`}>{criticos}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Tiempo promedio de cierre (90 días)</div><div className="font-display text-3xl mt-1 text-ink">{horasProm == null ? "—" : horasProm < 48 ? `${horasProm} h` : `${Math.round(horasProm / 24)} d`}</div></div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex gap-1 p-3 border-b border-line/[0.08] text-sm">
          {([["activos", "Activos"], ["cerrados", "Cerrados"], ["todos", "Todos"]] as const).map(([k, t]) => (
            <button key={k} onClick={() => setFiltro(k)} className={`px-3 py-1 rounded-full ${filtro === k ? "bg-brand-600 text-white" : "text-ink/60 hover:bg-line/[0.05]"}`}>{t}</button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>N°</th><th>Incidente</th><th>Severidad</th><th>Estado</th><th>Avance</th><th>Detectado</th></tr></thead>
            <tbody>
              {!lista.length && <tr><td colSpan={6} className="text-center text-ink/50 py-6">{filtro === "activos" ? "No hay incidentes activos." : "Sin incidentes."}</td></tr>}
              {lista.map((f) => (
                <tr key={f.id}>
                  <td className="font-mono text-sm text-ink/60">INC-{String(f.numero).padStart(4, "0")}</td>
                  <td>
                    <Link href={`/inventario/incidentes/${f.id}`} className="font-medium text-ink hover:text-brand-700">{f.titulo}</Link>
                    <div className="text-xs text-ink/50">{f.tipo_nombre}{f.empleado ? ` · ${f.empleado}` : ""}</div>
                  </td>
                  <td><span className={`pill ${SEVERIDAD[f.severidad]?.c}`}>{SEVERIDAD[f.severidad]?.t}</span></td>
                  <td><span className={`pill ${ESTADO[f.estado]?.c}`}>{ESTADO[f.estado]?.t}</span></td>
                  <td className="text-sm text-ink/70 tabular-nums">{f.hechas}/{f.tareas}</td>
                  <td className="text-sm text-ink/70">{fh(f.detectado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {nuevo && <NuevoIncidente onCerrar={() => setNuevo(false)} />}
    </div>
  );
}

function NuevoIncidente({ onCerrar }: { onCerrar: () => void }) {
  const router = useRouter();
  const [tipos, setTipos] = useState<{ id: string; nombre: string }[]>([]);
  const [empleados, setEmpleados] = useState<{ id: string; nombre: string; apellido: string }[]>([]);
  const [equipos, setEquipos] = useState<{ id: string; codigo: string; marca: string | null; modelo: string | null; empleado_id: string | null }[]>([]);
  const [v, setV] = useState({ tipo: "equipo_perdido", titulo: "", descripcion: "", severidad: "alta", empleado: "", equipo: "", detectado: "" });
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    const sb = createClient();
    sb.from("incidentes_tipos").select("id, nombre").order("orden").then(({ data }) => setTipos(data ?? []));
    sb.from("empleados").select("id, nombre, apellido").eq("activo", true).order("apellido").then(({ data }) => setEmpleados(data ?? []));
    sb.from("inv_v_equipos").select("id, codigo, marca, modelo, empleado_id").order("codigo").then(({ data }) => setEquipos((data ?? []) as any));
  }, []);

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  // Primero los equipos de la persona elegida
  const equiposOrden = useMemo(() => [...equipos].sort((a, b) => Number(b.empleado_id === v.empleado) - Number(a.empleado_id === v.empleado)), [equipos, v.empleado]);
  const conEquipo = v.tipo === "equipo_perdido" || v.tipo === "malware";

  async function guardar() {
    setError(null); setGuardando(true);
    const { data, error } = await createClient().rpc("incidentes_crear", {
      p_tipo: v.tipo, p_titulo: v.titulo, p_descripcion: v.descripcion || null, p_severidad: v.severidad,
      p_empleado: v.empleado || null, p_equipo: conEquipo && v.equipo ? v.equipo : null,
      p_detectado: v.detectado ? new Date(v.detectado).toISOString() : new Date().toISOString(),
    });
    setGuardando(false);
    if (error) return setError(error.message);
    router.push(`/inventario/incidentes/${data}`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onCerrar}>
      <div className="card p-6 w-full max-w-lg mt-10 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-xl text-ink">Registrar incidente</h2>
        <label className="block text-sm">Tipo
          <select className="input mt-1" value={v.tipo} onChange={set("tipo")}>{tipos.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}</select>
        </label>
        <label className="block text-sm">Título
          <input className="input mt-1" value={v.titulo} onChange={set("titulo")} placeholder="Ej.: Notebook robada en la vía pública" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">Severidad
            <select className="input mt-1" value={v.severidad} onChange={set("severidad")}>
              <option value="critica">Crítica</option><option value="alta">Alta</option><option value="media">Media</option><option value="baja">Baja</option>
            </select>
          </label>
          <label className="block text-sm">Detectado
            <input type="datetime-local" className="input mt-1" value={v.detectado} onChange={set("detectado")} />
          </label>
        </div>
        <label className="block text-sm">Persona involucrada
          <select className="input mt-1" value={v.empleado} onChange={set("empleado")}>
            <option value="">—</option>
            {empleados.map((e) => <option key={e.id} value={e.id}>{e.apellido}, {e.nombre}</option>)}
          </select>
        </label>
        {conEquipo && (
          <label className="block text-sm">Equipo
            <select className="input mt-1" value={v.equipo} onChange={set("equipo")}>
              <option value="">—</option>
              {equiposOrden.map((e) => <option key={e.id} value={e.id}>{e.codigo} · {[e.marca, e.modelo].filter(Boolean).join(" ")}{v.empleado && e.empleado_id === v.empleado ? " (asignado)" : ""}</option>)}
            </select>
          </label>
        )}
        <label className="block text-sm">Descripción
          <textarea className="input mt-1 min-h-[80px]" value={v.descripcion} onChange={set("descripcion")} placeholder="Qué pasó, cuándo y cómo se detectó" />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onCerrar}>Cancelar</button>
          <button className="btn-primary" disabled={guardando || !v.titulo.trim()} onClick={guardar}>{guardando ? "Guardando…" : "Registrar y abrir playbook"}</button>
        </div>
      </div>
    </div>
  );
}
