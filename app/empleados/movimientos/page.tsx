"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { fecha } from "@/lib/inventario";

type Mov = {
  id: number; empleado_id: string; tipo: "alta" | "baja"; estado: "abierto" | "completo" | "descartado"; origen: string;
  fecha: string; creado: string; cerrado: string | null; nombre: string; apellido: string; email: string; area: string | null;
  tareas: number; hechas: number; licencias_activas: number; equipos_asignados: number;
};
type Plantilla = { id: number; tipo: "alta" | "baja"; orden: number; descripcion: string; responsable: string; activo: boolean };

const RESPONSABLES = ["RRHH", "CAU", "Ciberseguridad"];

export default function Movimientos() {
  const { esAdmin } = usePerfil();
  const [movs, setMovs] = useState<Mov[]>([]);
  const [estado, setEstado] = useState<"abierto" | "cerrados">("abierto");
  const [tipo, setTipo] = useState("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verPlantilla, setVerPlantilla] = useState(false);

  const cargar = () =>
    createClient().from("empleados_v_movimientos").select("*").order("creado", { ascending: false }).limit(500)
      .then(({ data, error }) => {
        if (error) setError(error.message.includes("empleados_v_movimientos") ? "Falta ejecutar altas-bajas.sql en Supabase." : error.message);
        setMovs((data ?? []) as Mov[]); setCargando(false);
      });
  useEffect(() => { cargar(); }, []);

  const lista = useMemo(() => movs
    .filter((m) => (estado === "abierto" ? m.estado === "abierto" : m.estado !== "abierto"))
    .filter((m) => !tipo || m.tipo === tipo), [movs, estado, tipo]);

  const abiertas = movs.filter((m) => m.estado === "abierto");
  const altasViejas = abiertas.filter((m) => m.tipo === "alta").length;

  async function descartarAltas() {
    const hasta = prompt("Se descartan las altas abiertas hasta esta fecha (AAAA-MM-DD). Útil después de la carga inicial de empleados.",
      new Date().toISOString().slice(0, 10));
    if (!hasta) return;
    const { data, error } = await createClient().rpc("empleados_descartar_altas", { p_antes: hasta });
    if (error) return setError(error.message);
    alert(`${data} altas descartadas.`);
    cargar();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Altas y bajas</h1>
          <p className="text-ink/60 text-sm mt-1">
            Cuando ingresa o se desactiva un empleado se abre su checklist: cuentas, licencias, equipos y accesos, con responsable por tarea.
          </p>
        </div>
        {esAdmin && (
          <div className="flex gap-2">
            {altasViejas > 0 && <button className="btn-secondary" onClick={descartarAltas}>Descartar altas viejas</button>}
            <button className="btn-secondary" onClick={() => setVerPlantilla(!verPlantilla)}>{verPlantilla ? "Cerrar tareas modelo" : "Tareas modelo"}</button>
          </div>
        )}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}
      {verPlantilla && <EditorPlantilla />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tarjeta titulo="Altas en curso" valor={abiertas.filter((m) => m.tipo === "alta").length} />
        <Tarjeta titulo="Bajas en curso" valor={abiertas.filter((m) => m.tipo === "baja").length} />
        <Tarjeta titulo="Bajas con equipos sin devolver" valor={abiertas.filter((m) => m.tipo === "baja" && m.equipos_asignados > 0).length} alerta />
        <Tarjeta titulo="Bajas con licencias sin liberar" valor={abiertas.filter((m) => m.tipo === "baja" && m.licencias_activas > 0).length} alerta />
      </div>

      <div className="flex gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-line/10 bg-surface p-0.5">
          {(["abierto", "cerrados"] as const).map((v) => (
            <button key={v} onClick={() => setEstado(v)}
              className={`px-3 py-1.5 text-sm rounded-md ${estado === v ? "bg-brand-600 text-white" : "text-ink/60 hover:text-ink"}`}>
              {v === "abierto" ? `En curso (${abiertas.length})` : "Cerrados"}
            </button>
          ))}
        </div>
        <select className="input w-auto" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo">
          <option value="">Altas y bajas</option><option value="alta">Solo altas</option><option value="baja">Solo bajas</option>
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Persona</th><th>Tipo</th><th>Desde</th><th>Avance</th><th>Pendiente</th>{estado === "cerrados" && <th>Cierre</th>}</tr></thead>
          <tbody>
            {lista.map((m) => {
              const pct = m.tareas ? Math.round((m.hechas / m.tareas) * 100) : 0;
              return (
                <tr key={m.id}>
                  <td>
                    <Link href={`/empleados/movimientos/${m.id}`} className="text-ink font-medium hover:text-brand-700">{m.nombre} {m.apellido}</Link>
                    <div className="text-xs text-ink/50">{m.email}{m.area ? ` · ${m.area}` : ""}</div>
                  </td>
                  <td><span className={`pill ${m.tipo === "alta" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{m.tipo === "alta" ? "Alta" : "Baja"}</span></td>
                  <td className="text-ink/70 whitespace-nowrap">{fecha(m.fecha)}</td>
                  <td className="min-w-[140px]">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-full bg-line/[0.06] overflow-hidden"><div className="h-full bg-brand-600" style={{ width: `${pct}%` }} /></div>
                      <span className="text-xs text-ink/60 tabular-nums">{m.hechas}/{m.tareas}</span>
                    </div>
                  </td>
                  <td className="text-xs">
                    {m.tipo === "baja" && m.equipos_asignados > 0 && <span className="pill bg-red-50 text-red-600 mr-1">{m.equipos_asignados} equipo{m.equipos_asignados > 1 ? "s" : ""}</span>}
                    {m.tipo === "baja" && m.licencias_activas > 0 && <span className="pill bg-amber-500/10 text-amber-700">{m.licencias_activas} licencia{m.licencias_activas > 1 ? "s" : ""}</span>}
                  </td>
                  {estado === "cerrados" && (
                    <td className="text-xs text-ink/60 whitespace-nowrap">{m.estado === "completo" ? "Completo" : "Descartado"} · {fecha(m.cerrado)}</td>
                  )}
                </tr>
              );
            })}
            {!cargando && lista.length === 0 && <tr><td colSpan={6} className="text-center text-ink/40 py-10">Nada por acá.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Los checklists se abren solos al dar de alta o desactivar a alguien (a mano, por Excel o al sincronizar con Entra ID).
        También se pueden iniciar desde la ficha del empleado.
      </p>
    </div>
  );
}

function Tarjeta({ titulo, valor, alerta }: { titulo: string; valor: number; alerta?: boolean }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-ink/50">{titulo}</div>
      <div className={`font-display text-3xl mt-1 ${alerta && valor ? "text-red-600" : "text-ink"}`}>{valor}</div>
    </div>
  );
}

function EditorPlantilla() {
  const [items, setItems] = useState<Plantilla[]>([]);
  const [nuevo, setNuevo] = useState({ tipo: "alta" as "alta" | "baja", descripcion: "", responsable: "CAU" });
  const [error, setError] = useState<string | null>(null);
  const sb = createClient();

  const cargar = () => sb.from("empleados_plantilla").select("*").order("tipo").order("orden").order("id")
    .then(({ data }) => setItems((data ?? []) as Plantilla[]));
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function cambiar(id: number, cambios: Partial<Plantilla>) {
    const { error } = await sb.from("empleados_plantilla").update(cambios).eq("id", id);
    if (error) setError(error.message); else cargar();
  }
  async function agregar(e: React.FormEvent) {
    e.preventDefault();
    if (!nuevo.descripcion.trim()) return;
    const orden = Math.max(0, ...items.filter((i) => i.tipo === nuevo.tipo).map((i) => i.orden)) + 10;
    const { error } = await sb.from("empleados_plantilla").insert({ ...nuevo, descripcion: nuevo.descripcion.trim(), orden });
    if (error) return setError(error.message);
    setNuevo({ ...nuevo, descripcion: "" }); cargar();
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-display text-lg text-ink">Tareas modelo</h2>
        <p className="text-sm text-ink/60">Se copian a cada alta o baja nueva. Los cambios no afectan los checklists ya abiertos.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {(["alta", "baja"] as const).map((t) => (
        <div key={t}>
          <div className="text-xs uppercase tracking-wide text-ink/50 mb-1">{t === "alta" ? "Alta" : "Baja"}</div>
          <ul className="divide-y divide-line/[0.05]">
            {items.filter((i) => i.tipo === t).map((i) => (
              <li key={i.id} className={`flex items-center gap-3 py-2 text-sm ${i.activo ? "" : "opacity-50"}`}>
                <span className="flex-1">{i.descripcion}</span>
                <select className="input w-auto py-1" value={i.responsable} onChange={(e) => cambiar(i.id, { responsable: e.target.value })} aria-label="Responsable">
                  {RESPONSABLES.map((r) => <option key={r}>{r}</option>)}
                </select>
                <button className="text-xs text-brand-600 hover:underline" onClick={() => cambiar(i.id, { activo: !i.activo })}>{i.activo ? "Desactivar" : "Activar"}</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form onSubmit={agregar} className="flex gap-2 flex-wrap">
        <select className="input w-auto" value={nuevo.tipo} onChange={(e) => setNuevo({ ...nuevo, tipo: e.target.value as "alta" | "baja" })} aria-label="Tipo">
          <option value="alta">Alta</option><option value="baja">Baja</option>
        </select>
        <input className="input flex-1 min-w-[220px]" placeholder="Nueva tarea" value={nuevo.descripcion} onChange={(e) => setNuevo({ ...nuevo, descripcion: e.target.value })} />
        <select className="input w-auto" value={nuevo.responsable} onChange={(e) => setNuevo({ ...nuevo, responsable: e.target.value })} aria-label="Responsable">
          {RESPONSABLES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <button className="btn-primary">Agregar</button>
      </form>
    </div>
  );
}
