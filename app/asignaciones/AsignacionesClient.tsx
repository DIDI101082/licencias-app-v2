"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Asignacion = {
  id: string;
  fecha_asignacion: string;
  fecha_liberacion: string | null;
  notas: string | null;
  licencias: { id: string; nombre: string } | null;
  empleados: { id: string; nombre: string; apellido: string; area: string } | null;
};

type Licencia = { id: string; nombre: string; seats_totales: number };
type Empleado = { id: string; nombre: string; apellido: string };
type Ocupacion = { licencia_id: string; seats_libres: number };

export default function AsignacionesClient({
  asignaciones,
  licencias,
  empleados,
  ocupacion,
  puedeEditar,
}: {
  asignaciones: Asignacion[];
  licencias: Licencia[];
  empleados: Empleado[];
  ocupacion: Ocupacion[];
  puedeEditar: boolean;
}) {
  const [mostrarForm, setMostrarForm] = useState(false);
  const [filtro, setFiltro] = useState<"activas" | "todas">("activas");
  const [form, setForm] = useState({ licencia_id: "", empleado_id: "", notas: "" });
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  function seatsLibres(licenciaId: string) {
    return ocupacion.find((o) => o.licencia_id === licenciaId)?.seats_libres ?? 0;
  }

  async function asignar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error } = await supabase.from("asignaciones").insert({
      licencia_id: form.licencia_id,
      empleado_id: form.empleado_id,
      notas: form.notas || null,
      asignado_por: user?.id,
    });

    if (error) {
      setError(error.message);
      return;
    }

    setForm({ licencia_id: "", empleado_id: "", notas: "" });
    setMostrarForm(false);
    router.refresh();
  }

  async function liberar(a: Asignacion) {
    if (!confirm("¿Marcar esta licencia como liberada/desasignada?")) return;
    await supabase
      .from("asignaciones")
      .update({ fecha_liberacion: new Date().toISOString().slice(0, 10) })
      .eq("id", a.id);
    router.refresh();
  }

  const visibles = asignaciones.filter((a) =>
    filtro === "activas" ? !a.fecha_liberacion : true
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Asignaciones</h1>
        {puedeEditar && (
          <button className="btn-primary" onClick={() => setMostrarForm(!mostrarForm)}>
            + Asignar licencia
          </button>
        )}
      </div>

      {mostrarForm && (
        <form onSubmit={asignar} className="card p-5 grid md:grid-cols-3 gap-4">
          <div>
            <label className="label">Licencia</label>
            <select
              required
              className="input"
              value={form.licencia_id}
              onChange={(e) => setForm({ ...form, licencia_id: e.target.value })}
            >
              <option value="">Seleccionar…</option>
              {licencias.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nombre} ({seatsLibres(l.id)} libres)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Empleado</label>
            <select
              required
              className="input"
              value={form.empleado_id}
              onChange={(e) => setForm({ ...form, empleado_id: e.target.value })}
            >
              <option value="">Seleccionar…</option>
              {empleados.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.nombre} {emp.apellido}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Notas (opcional)</label>
            <input
              className="input"
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
            />
          </div>

          {form.licencia_id && seatsLibres(form.licencia_id) <= 0 && (
            <p className="md:col-span-3 text-sm text-amber-600 bg-amber-500/10 rounded-md px-3 py-2">
              Esta licencia no tiene seats libres. Podés igual asignarla, pero
              vas a superar el total comprado.
            </p>
          )}

          {error && (
            <p className="md:col-span-3 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <div className="md:col-span-3 flex gap-2">
            <button type="submit" className="btn-primary">
              Asignar
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setMostrarForm(false)}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      <div className="flex gap-1">
        {(["activas", "todas"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFiltro(f)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${
              filtro === f
                ? "bg-brand-50 text-brand-700"
                : "text-ink/50 hover:bg-line/[0.03]"
            }`}
          >
            {f === "activas" ? "Activas" : "Historial completo"}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Empleado</th>
              <th>Área</th>
              <th>Licencia</th>
              <th>Asignada</th>
              <th>Liberada</th>
              {puedeEditar && <th></th>}
            </tr>
          </thead>
          <tbody>
            {visibles.map((a) => (
              <tr key={a.id}>
                <td className="font-medium text-ink">
                  {a.empleados?.nombre} {a.empleados?.apellido}
                </td>
                <td className="text-ink/60">{a.empleados?.area}</td>
                <td className="text-ink/60">{a.licencias?.nombre}</td>
                <td className="text-ink/60">
                  {new Date(a.fecha_asignacion).toLocaleDateString("es-AR")}
                </td>
                <td className="text-ink/60">
                  {a.fecha_liberacion
                    ? new Date(a.fecha_liberacion).toLocaleDateString("es-AR")
                    : "—"}
                </td>
                {puedeEditar && (
                  <td className="text-right">
                    {!a.fecha_liberacion && (
                      <button
                        className="text-red-600 hover:underline text-sm"
                        onClick={() => liberar(a)}
                      >
                        Liberar
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {visibles.length === 0 && (
              <tr>
                <td colSpan={puedeEditar ? 6 : 5} className="text-center text-ink/40 py-8">
                  No hay asignaciones para mostrar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
