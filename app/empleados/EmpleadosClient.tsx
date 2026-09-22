"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Empleado = {
  id: string;
  nombre: string;
  apellido: string;
  email: string;
  area: string;
  puesto: string | null;
  activo: boolean;
};

export default function EmpleadosClient({
  empleados,
  soloArea,
  puedeEditar,
}: {
  empleados: Empleado[];
  soloArea: string | null;
  puedeEditar: boolean;
}) {
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editando, setEditando] = useState<Empleado | null>(null);
  const [form, setForm] = useState({
    nombre: "",
    apellido: "",
    email: "",
    area: soloArea ?? "",
    puesto: "",
  });
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  function abrirNuevo() {
    setEditando(null);
    setForm({ nombre: "", apellido: "", email: "", area: soloArea ?? "", puesto: "" });
    setMostrarForm(true);
  }

  function abrirEditar(emp: Empleado) {
    setEditando(emp);
    setForm({
      nombre: emp.nombre,
      apellido: emp.apellido,
      email: emp.email,
      area: emp.area,
      puesto: emp.puesto ?? "",
    });
    setMostrarForm(true);
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload = { ...form };
    const { error } = editando
      ? await supabase.from("empleados").update(payload).eq("id", editando.id)
      : await supabase.from("empleados").insert(payload);

    if (error) {
      setError(error.message);
      return;
    }

    setMostrarForm(false);
    router.refresh();
  }

  async function toggleActivo(emp: Empleado) {
    await supabase
      .from("empleados")
      .update({ activo: !emp.activo })
      .eq("id", emp.id);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Empleados</h1>
        {puedeEditar && (
          <button className="btn-primary" onClick={abrirNuevo}>
            + Nuevo empleado
          </button>
        )}
      </div>

      {mostrarForm && (
        <form onSubmit={guardar} className="card p-5 grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">Nombre</label>
            <input
              required
              className="input"
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Apellido</label>
            <input
              required
              className="input"
              value={form.apellido}
              onChange={(e) => setForm({ ...form, apellido: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              required
              className="input"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Área</label>
            <input
              required
              disabled={!!soloArea}
              className="input disabled:bg-black/[0.03]"
              value={form.area}
              onChange={(e) => setForm({ ...form, area: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Puesto</label>
            <input
              className="input"
              value={form.puesto}
              onChange={(e) => setForm({ ...form, puesto: e.target.value })}
            />
          </div>

          {error && (
            <p className="md:col-span-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <div className="md:col-span-2 flex gap-2">
            <button type="submit" className="btn-primary">
              Guardar
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

      <div className="card overflow-hidden">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>Área</th>
              <th>Puesto</th>
              <th>Estado</th>
              {puedeEditar && <th></th>}
            </tr>
          </thead>
          <tbody>
            {empleados.map((emp) => (
              <tr key={emp.id}>
                <td className="font-medium text-ink">
                  {emp.nombre} {emp.apellido}
                </td>
                <td className="text-ink/60">{emp.email}</td>
                <td className="text-ink/60">{emp.area}</td>
                <td className="text-ink/60">{emp.puesto || "—"}</td>
                <td>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      emp.activo
                        ? "bg-brand-50 text-brand-700"
                        : "bg-black/[0.05] text-ink/50"
                    }`}
                  >
                    {emp.activo ? "Activo" : "Inactivo"}
                  </span>
                </td>
                {puedeEditar && (
                  <td className="text-right space-x-3">
                    <button
                      className="text-brand-600 hover:underline text-sm"
                      onClick={() => abrirEditar(emp)}
                    >
                      Editar
                    </button>
                    <button
                      className="text-ink/50 hover:underline text-sm"
                      onClick={() => toggleActivo(emp)}
                    >
                      {emp.activo ? "Desactivar" : "Activar"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {empleados.length === 0 && (
              <tr>
                <td colSpan={puedeEditar ? 6 : 5} className="text-center text-ink/40 py-8">
                  Todavía no hay empleados cargados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
