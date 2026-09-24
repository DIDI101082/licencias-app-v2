"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import EmpleadosExcel, { exportarEmpleados } from "@/components/EmpleadosExcel";
import EntraSync from "@/components/EntraSync";
import { createClient } from "@/lib/supabase/client";
import { claseCodigo } from "@/lib/inventario";

type Empleado = {
  id: string;
  nombre: string;
  apellido: string;
  email: string;
  area: string;
  puesto: string | null;
  activo: boolean;
  entra_id?: string | null;
};

type EquipoAsignado = {
  id: string;
  codigo: string;
  categoria: string;
  marca: string | null;
  modelo: string | null;
  empleado_id: string;
};

export default function EmpleadosClient({
  empleados,
  equipos,
  soloArea,
  puedeEditar,
  esAdmin,
  ultimaSyncEntra,
}: {
  empleados: Empleado[];
  equipos: EquipoAsignado[];
  esAdmin: boolean;
  ultimaSyncEntra: string | null;
  soloArea: string | null;
  puedeEditar: boolean;
}) {
  const [mostrarForm, setMostrarForm] = useState(false);
  const [panel, setPanel] = useState<"excel" | "entra" | null>(null);
  const equiposPorEmpleado = equipos.reduce<Record<string, string[]>>((acc, e) => {
    (acc[e.empleado_id] ??= []).push(e.codigo);
    return acc;
  }, {});
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
    const suyos = equipos.filter((e) => e.empleado_id === emp.id);
    if (
      emp.activo &&
      suyos.length > 0 &&
      !confirm(
        `${emp.nombre} ${emp.apellido} todavía tiene ${suyos.length} ${suyos.length === 1 ? "equipo asignado" : "equipos asignados"} ` +
          `(${suyos.map((e) => e.codigo).join(", ")}). ¿Desactivarlo igual? Vas a poder ver qué recuperar en Inventario IT → Por persona.`
      )
    )
      return;
    await supabase
      .from("empleados")
      .update({ activo: !emp.activo })
      .eq("id", emp.id);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display text-2xl text-ink">Empleados</h1>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={() => exportarEmpleados(empleados, equiposPorEmpleado)} disabled={!empleados.length}>
            Exportar a Excel
          </button>
          {esAdmin && (
            <>
              <button className={`btn-secondary ${panel === "excel" ? "ring-2 ring-brand-500/30" : ""}`}
                onClick={() => setPanel(panel === "excel" ? null : "excel")} aria-expanded={panel === "excel"}>
                Importar desde Excel
              </button>
              <button className={`btn-secondary ${panel === "entra" ? "ring-2 ring-brand-500/30" : ""}`}
                onClick={() => setPanel(panel === "entra" ? null : "entra")} aria-expanded={panel === "entra"}>
                Sincronizar con Entra ID
              </button>
            </>
          )}
          {puedeEditar && (
            <button className="btn-primary" onClick={abrirNuevo}>
              + Nuevo empleado
            </button>
          )}
        </div>
      </div>

      {esAdmin && panel === "excel" && <EmpleadosExcel empleados={empleados as any} />}
      {esAdmin && panel === "entra" && <EntraSync ultima={ultimaSyncEntra} />}

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

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Área</th>
              <th>Puesto</th>
              <th>Equipos IT</th>
              <th>Estado</th>
              {puedeEditar && <th></th>}
            </tr>
          </thead>
          <tbody>
            {empleados.map((emp) => {
              const suyos = equipos.filter((e) => e.empleado_id === emp.id);
              return (
              <tr key={emp.id} className="align-top">
                <td>
                  <Link href={`/empleados/${emp.id}`} className="font-medium text-ink hover:text-brand-700 hover:underline">
                    {emp.nombre} {emp.apellido}
                  </Link>
                  <div className="text-xs text-ink/50">
                    {emp.email}
                    {emp.entra_id && <span className="ml-1.5 text-brand-600" title="Sincronizado con Entra ID">· Entra ID</span>}
                  </div>
                </td>
                <td className="text-ink/60">{emp.area}</td>
                <td className="text-ink/60">{emp.puesto || "—"}</td>
                <td>
                  {suyos.length === 0 ? (
                    <span className="text-ink/40">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {suyos.map((e) => (
                        <li key={e.id} className="flex items-center gap-2 whitespace-nowrap">
                          <Link href={`/inventario/equipos/${e.id}`} className={claseCodigo(e.codigo)}>
                            {e.codigo}
                          </Link>
                          <span className="text-ink/70 text-xs">
                            {e.categoria}
                            {e.marca || e.modelo ? ` · ${[e.marca, e.modelo].filter(Boolean).join(" ")}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!emp.activo && suyos.length > 0 && (
                    <span className="pill bg-red-50 text-red-600 mt-1">Recuperar equipos</span>
                  )}
                </td>
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
              );
            })}
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
