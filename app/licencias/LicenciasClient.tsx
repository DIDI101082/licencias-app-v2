"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Licencia = {
  id: string;
  nombre: string;
  proveedor: string;
  tipo: string | null;
  costo_unitario: number;
  periodicidad: "mensual" | "anual" | "unica";
  seats_totales: number;
  fecha_inicio: string | null;
  fecha_vencimiento: string | null;
  notas: string | null;
};

type Ocupacion = {
  licencia_id: string;
  seats_ocupados: number;
  seats_libres: number;
};

const vacio: {
  nombre: string;
  proveedor: string;
  tipo: string;
  costo_unitario: number;
  periodicidad: "mensual" | "anual" | "unica";
  seats_totales: number;
  fecha_inicio: string;
  fecha_vencimiento: string;
  notas: string;
} = {
  nombre: "",
  proveedor: "",
  tipo: "",
  costo_unitario: 0,
  periodicidad: "mensual",
  seats_totales: 1,
  fecha_inicio: "",
  fecha_vencimiento: "",
  notas: "",
};

export default function LicenciasClient({
  licencias,
  ocupacion,
  esRRHH,
}: {
  licencias: Licencia[];
  ocupacion: Ocupacion[];
  esRRHH: boolean;
}) {
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editando, setEditando] = useState<Licencia | null>(null);
  const [form, setForm] = useState(vacio);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  function ocupacionDe(id: string) {
    return ocupacion.find((o) => o.licencia_id === id);
  }

  function abrirNuevo() {
    setEditando(null);
    setForm(vacio);
    setMostrarForm(true);
  }

  function abrirEditar(l: Licencia) {
    setEditando(l);
    setForm({
      nombre: l.nombre,
      proveedor: l.proveedor,
      tipo: l.tipo ?? "",
      costo_unitario: l.costo_unitario,
      periodicidad: l.periodicidad,
      seats_totales: l.seats_totales,
      fecha_inicio: l.fecha_inicio ?? "",
      fecha_vencimiento: l.fecha_vencimiento ?? "",
      notas: l.notas ?? "",
    });
    setMostrarForm(true);
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload = {
      ...form,
      fecha_inicio: form.fecha_inicio || null,
      fecha_vencimiento: form.fecha_vencimiento || null,
    };

    const { error } = editando
      ? await supabase.from("licencias").update(payload).eq("id", editando.id)
      : await supabase.from("licencias").insert(payload);

    if (error) {
      setError(error.message);
      return;
    }

    setMostrarForm(false);
    router.refresh();
  }

  async function eliminar(l: Licencia) {
    if (!confirm(`¿Eliminar la licencia "${l.nombre}"? Esto borra también su historial de asignaciones.`))
      return;
    await supabase.from("licencias").delete().eq("id", l.id);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Licencias</h1>
        {esRRHH && (
          <button className="btn-primary" onClick={abrirNuevo}>
            + Nueva licencia
          </button>
        )}
      </div>

      {mostrarForm && (
        <form onSubmit={guardar} className="card p-5 grid md:grid-cols-3 gap-4">
          <div>
            <label className="label">Nombre</label>
            <input
              required
              className="input"
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              placeholder="Microsoft 365 E3"
            />
          </div>
          <div>
            <label className="label">Proveedor</label>
            <input
              required
              className="input"
              value={form.proveedor}
              onChange={(e) => setForm({ ...form, proveedor: e.target.value })}
              placeholder="Microsoft"
            />
          </div>
          <div>
            <label className="label">Tipo</label>
            <input
              className="input"
              value={form.tipo}
              onChange={(e) => setForm({ ...form, tipo: e.target.value })}
              placeholder="Productividad"
            />
          </div>
          <div>
            <label className="label">Costo por seat</label>
            <input
              type="number"
              step="0.01"
              min="0"
              required
              className="input"
              value={form.costo_unitario}
              onChange={(e) =>
                setForm({ ...form, costo_unitario: parseFloat(e.target.value) || 0 })
              }
            />
          </div>
          <div>
            <label className="label">Periodicidad</label>
            <select
              className="input"
              value={form.periodicidad}
              onChange={(e) =>
                setForm({ ...form, periodicidad: e.target.value as any })
              }
            >
              <option value="mensual">Mensual</option>
              <option value="anual">Anual</option>
              <option value="unica">Pago único</option>
            </select>
          </div>
          <div>
            <label className="label">Seats totales</label>
            <input
              type="number"
              min="1"
              required
              className="input"
              value={form.seats_totales}
              onChange={(e) =>
                setForm({ ...form, seats_totales: parseInt(e.target.value) || 1 })
              }
            />
          </div>
          <div>
            <label className="label">Fecha de inicio</label>
            <input
              type="date"
              className="input"
              value={form.fecha_inicio}
              onChange={(e) => setForm({ ...form, fecha_inicio: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Vencimiento / renovación</label>
            <input
              type="date"
              className="input"
              value={form.fecha_vencimiento}
              onChange={(e) => setForm({ ...form, fecha_vencimiento: e.target.value })}
            />
          </div>
          <div className="md:col-span-1">
            <label className="label">Notas</label>
            <input
              className="input"
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
            />
          </div>

          {error && (
            <p className="md:col-span-3 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <div className="md:col-span-3 flex gap-2">
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
              <th>Licencia</th>
              <th>Proveedor</th>
              <th>Costo</th>
              <th>Seats</th>
              <th>Vencimiento</th>
              {esRRHH && <th></th>}
            </tr>
          </thead>
          <tbody>
            {licencias.map((l) => {
              const ocup = ocupacionDe(l.id);
              return (
                <tr key={l.id}>
                  <td>
                    <div className="font-medium text-ink">{l.nombre}</div>
                    {l.tipo && <div className="text-xs text-ink/40">{l.tipo}</div>}
                  </td>
                  <td className="text-ink/60">{l.proveedor}</td>
                  <td className="text-ink/60">
                    {l.costo_unitario.toLocaleString("es-AR", {
                      style: "currency",
                      currency: "ARS",
                    })}{" "}
                    <span className="text-xs text-ink/40">
                      /{l.periodicidad === "unica" ? "única vez" : l.periodicidad}
                    </span>
                  </td>
                  <td className="text-ink/60">
                    {ocup?.seats_ocupados ?? 0} / {l.seats_totales}
                  </td>
                  <td className="text-ink/60">
                    {l.fecha_vencimiento
                      ? new Date(l.fecha_vencimiento).toLocaleDateString("es-AR")
                      : "—"}
                  </td>
                  {esRRHH && (
                    <td className="text-right space-x-3">
                      <button
                        className="text-brand-600 hover:underline text-sm"
                        onClick={() => abrirEditar(l)}
                      >
                        Editar
                      </button>
                      <button
                        className="text-red-600 hover:underline text-sm"
                        onClick={() => eliminar(l)}
                      >
                        Eliminar
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {licencias.length === 0 && (
              <tr>
                <td colSpan={esRRHH ? 6 : 5} className="text-center text-ink/40 py-8">
                  Todavía no hay licencias cargadas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
