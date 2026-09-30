"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { claseCodigo } from "@/lib/inventario";
import { hace, tipoEquipo, TIPOS_EQUIPO } from "@/lib/monitoreo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dispositivo = Record<string, any>;
type Empleado = { id: string; nombre: string; apellido: string; area: string; email: string };

// Días en los que un equipo se marca como "Nuevo"
const DIAS_NUEVO = 7;

// "ACCUSYS\dcreta", "dcreta@accusys.com.ar" o "dcreta" → "dcreta"
function usuarioBase(u?: string | null) {
  if (!u) return "";
  return u.split("\\").pop()!.split("@")[0].trim().toLowerCase();
}

// Busca al empleado cuyo mail coincide con el usuario que tiene sesión iniciada en el equipo
function sugerido(d: Dispositivo, empleados: Empleado[]) {
  const u = usuarioBase(d.usuario);
  if (!u) return null;
  return empleados.find((p) => usuarioBase(p.email) === u) ?? null;
}

// Equipos de usuario (notebooks y PCs) aprobados que todavía no tienen a nadie asignado:
//  * no están cargados en el inventario, o
//  * están cargados pero siguen "En stock".
export function necesitaAsignacion(d: Dispositivo) {
  if (d.estado_registro !== "aprobado" || d.asignacion_omitida) return false;
  const t = tipoEquipo(d);
  if (t !== "notebook" && t !== "pc") return false;
  if (!d.inv_equipos) return true;
  return d.inv_equipos.estado === "en_stock" && !d.inv_equipos.empleado_id;
}

export default function EquiposParaAsignar({
  dispositivos,
  ahora,
  crearEnInventario,
  alCambiar,
}: {
  dispositivos: Dispositivo[];
  ahora: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  crearEnInventario: (d: any) => Promise<string | null>;
  alCambiar: () => void;
}) {
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [eleccion, setEleccion] = useState<Record<string, string>>({});
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    createClient().from("empleados").select("id,nombre,apellido,area,email").eq("activo", true).order("apellido")
      .then(({ data }) => setEmpleados((data ?? []) as Empleado[]));
  }, []);

  const pendientes = useMemo(
    () => dispositivos.filter(necesitaAsignacion)
      .sort((a, b) => new Date(b.primer_reporte).getTime() - new Date(a.primer_reporte).getTime()),
    [dispositivos],
  );

  if (pendientes.length === 0) return null;

  async function asignar(d: Dispositivo) {
    const empleadoId = eleccion[d.id] ?? sugerido(d, empleados)?.id;
    if (!empleadoId) return;
    setError(null); setOk(null); setTrabajando(d.id);
    try {
      // Si el equipo todavía no está en el inventario, se carga primero
      const equipoId = d.inv_equipos?.id ?? (await crearEnInventario(d));
      if (!equipoId) return;
      const { error } = await createClient().rpc("inv_asignar_equipo", { p_equipo: equipoId, p_empleado: empleadoId });
      if (error) {
        setError(error.message.includes("row-level security") ? "No tenés permiso sobre equipos o empleados de esa área." : error.message);
        return;
      }
      const p = empleados.find((x) => x.id === empleadoId);
      alCambiar();
      setOk(`${d.hostname} quedó asignado a ${p ? `${p.nombre} ${p.apellido}` : "la persona elegida"}.`);
    } finally {
      setTrabajando(null);
    }
  }

  async function omitir(d: Dispositivo) {
    if (!confirm(`¿Sacar ${d.hostname} de esta lista? Usalo para equipos que no se entregan a una persona (sala de reuniones, recepción, pruebas).`)) return;
    setError(null); setOk(null);
    const { error } = await createClient().from("inv_dispositivos").update({ asignacion_omitida: true }).eq("id", d.id);
    if (error) setError(/asignacion_omitida/.test(error.message) ? "Falta ejecutar supabase/asignacion-monitoreo.sql en Supabase." : error.message);
  }

  return (
    <div className="card p-5 border-2 border-brand-500/40 space-y-3" role="region" aria-label="Equipos para asignar">
      <div>
        <h2 className="font-medium text-ink">Equipos para asignar ({pendientes.length})</h2>
        <p className="text-sm text-ink/60 mt-1">
          Notebooks y PCs que ya reportan pero no tienen a nadie asignado en el inventario. Los más nuevos aparecen primero.
          Si la sesión iniciada coincide con el mail de un empleado, ya viene sugerido.
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {ok && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-md px-3 py-2">{ok}</p>}

      <ul className="divide-y divide-line/[0.06]">
        {pendientes.map((d) => {
          const sug = sugerido(d, empleados);
          const valor = eleccion[d.id] ?? sug?.id ?? "";
          const nuevo = ahora - new Date(d.primer_reporte).getTime() < DIAS_NUEVO * 86400000;
          return (
            <li key={d.id} className="py-3 flex items-center justify-between gap-4 flex-wrap">
              <div className="text-sm min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-ink">{d.hostname}</span>
                  {d.inv_equipos
                    ? <Link href={`/inventario/equipos/${d.inv_equipos.id}`} className={claseCodigo(d.inv_equipos.codigo)}>{d.inv_equipos.codigo}</Link>
                    : <span className="pill bg-line/[0.05] text-ink/55">Sin cargar en inventario</span>}
                  <span className="pill bg-line/[0.05] text-ink/55">{TIPOS_EQUIPO[tipoEquipo(d)].uno}</span>
                  {nuevo && <span className="pill bg-brand-50 text-brand-700">Nuevo</span>}
                </div>
                <div className="text-ink/60">
                  {[d.fabricante, d.modelo].filter(Boolean).join(" ") || "Modelo desconocido"}
                  {d.numero_serie ? ` · S/N ${d.numero_serie}` : ""}
                </div>
                <div className="text-xs text-ink/50">
                  Sesión: {d.usuario ?? "ninguna"} · reporta desde {new Date(d.primer_reporte).toLocaleDateString("es-AR")} · último reporte {hace(d.ultimo_reporte, ahora)}
                </div>
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <select className="input w-auto max-w-[18rem]" value={valor} aria-label={`Asignar ${d.hostname} a`}
                  onChange={(e) => setEleccion({ ...eleccion, [d.id]: e.target.value })}>
                  <option value="">Elegí a quién se entrega</option>
                  {empleados.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.apellido}, {p.nombre} · {p.area}{sug?.id === p.id ? " (sugerido)" : ""}
                    </option>
                  ))}
                </select>
                <button className="btn-primary" disabled={!valor || trabajando === d.id} onClick={() => asignar(d)}>
                  {trabajando === d.id ? "Asignando…" : "Asignar"}
                </button>
                <button className="text-sm text-ink/50 hover:text-ink hover:underline" onClick={() => omitir(d)}>No se asigna</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
