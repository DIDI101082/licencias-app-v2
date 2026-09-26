"use client";

import { useMemo, useState } from "react";
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
  numero_serie?: string | null;
  grupo?: string | null;
  empleado_id: string;
};

type Orden = "nombre" | "area" | "puesto" | "equipos" | "perifericos" | "estado";

// Periféricos: grupo "Periféricos" en el inventario (o código P-00001)
const esPeriferico = (e: EquipoAsignado) => e.grupo === "Periféricos" || /^P-/i.test(e.codigo ?? "");

function ListaEquipos({ items }: { items: EquipoAsignado[] }) {
  if (!items.length) return <span className="text-ink/40">—</span>;
  return (
    <ul className="space-y-1">
      {items.map((e) => (
        <li key={e.id} className="flex items-center gap-2 whitespace-nowrap">
          <Link href={`/inventario/equipos/${e.id}`} className={claseCodigo(e.codigo)}>{e.codigo}</Link>
          <span className="text-ink/70 text-xs">
            {e.categoria}
            {e.marca || e.modelo ? ` · ${[e.marca, e.modelo].filter(Boolean).join(" ")}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Busca sin distinguir mayúsculas ni acentos ("damian" encuentra "Damián")
const normal = (t: string | null | undefined) => (t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

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
  const porEmpleado = (lista: EquipoAsignado[]) => lista.reduce<Record<string, string[]>>((acc, e) => {
    (acc[e.empleado_id] ??= []).push(e.codigo);
    return acc;
  }, {});
  const equiposPorEmpleado = porEmpleado(equipos.filter((e) => !esPeriferico(e)));
  const perifericosPorEmpleado = porEmpleado(equipos.filter(esPeriferico));
  const [editando, setEditando] = useState<Empleado | null>(null);
  const [form, setForm] = useState({
    nombre: "",
    apellido: "",
    email: "",
    area: soloArea ?? "",
    puesto: "",
  });
  const [error, setError] = useState<string | null>(null);

  // Búsqueda, filtros y orden de la tabla
  const [busqueda, setBusqueda] = useState("");
  const [fArea, setFArea] = useState("");
  const [fPuesto, setFPuesto] = useState("");
  const [fEstado, setFEstado] = useState("");
  const [fEquipos, setFEquipos] = useState("");
  const [orden, setOrden] = useState<Orden>("nombre");
  const [asc, setAsc] = useState(true);
  const distintos = (v: (string | null)[]) => Array.from(new Set(v.filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b));
  const areas = useMemo(() => distintos(empleados.map((e) => e.area)), [empleados]);
  const puestos = useMemo(() => distintos(empleados.map((e) => e.puesto)), [empleados]);
  const categorias = useMemo(() => distintos(equipos.map((e) => e.categoria)), [equipos]);
  const hayFiltros = !!(busqueda.trim() || fArea || fPuesto || fEstado || fEquipos);
  const limpiar = () => { setBusqueda(""); setFArea(""); setFPuesto(""); setFEstado(""); setFEquipos(""); };
  const ordenarPor = (k: Orden) => { if (orden === k) setAsc(!asc); else { setOrden(k); setAsc(true); } };

  const visibles = useMemo(() => {
    const q = normal(busqueda.trim());
    const equiposDe = (id: string) => equipos.filter((e) => e.empleado_id === id);
    const lista = empleados.filter((emp) => {
      const suyos = equiposDe(emp.id);
      if (fArea && emp.area !== fArea) return false;
      if (fPuesto && emp.puesto !== fPuesto) return false;
      if (fEstado === "activo" && !emp.activo) return false;
      if (fEstado === "inactivo" && emp.activo) return false;
      const principales = suyos.filter((e) => !esPeriferico(e));
      const perifs = suyos.filter(esPeriferico);
      if (fEquipos === "con" && !principales.length) return false;
      if (fEquipos === "sin" && principales.length) return false;
      if (fEquipos === "con_p" && !perifs.length) return false;
      if (fEquipos === "sin_p" && perifs.length) return false;
      if (fEquipos.startsWith("cat:") && !suyos.some((e) => e.categoria === fEquipos.slice(4))) return false;
      if (!q) return true;
      const texto = [emp.nombre, emp.apellido, `${emp.nombre} ${emp.apellido}`, emp.email, emp.area, emp.puesto,
        ...suyos.flatMap((e) => [e.codigo, e.categoria, e.marca, e.modelo, e.numero_serie])].map(normal).join(" | ");
      return q.split(/\s+/).every((palabra) => texto.includes(palabra));
    });
    const clave = (e: Empleado) =>
      orden === "nombre" ? normal(`${e.nombre} ${e.apellido}`)
      : orden === "area" ? normal(e.area)
      : orden === "puesto" ? normal(e.puesto)
      : orden === "estado" ? (e.activo ? "0" : "1")
      : orden === "perifericos" ? String(1000 - equiposDe(e.id).filter(esPeriferico).length).padStart(4, "0")
      : String(1000 - equiposDe(e.id).filter((x) => !esPeriferico(x)).length).padStart(4, "0");
    return lista.sort((a, b) => (asc ? 1 : -1) * clave(a).localeCompare(clave(b)) || normal(a.apellido).localeCompare(normal(b.apellido)));
  }, [empleados, equipos, busqueda, fArea, fPuesto, fEstado, fEquipos, orden, asc]);
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
          <button className="btn-secondary" onClick={() => exportarEmpleados(visibles, equiposPorEmpleado, perifericosPorEmpleado)} disabled={!visibles.length}>
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

      <div className="space-y-3">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/40 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            className="input pl-9"
            placeholder="Buscar persona, email o equipo (código, modelo, número de serie)…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            aria-label="Buscar empleados o equipos"
          />
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <select className="input w-auto" value={fArea} onChange={(e) => setFArea(e.target.value)} aria-label="Filtrar por área">
            <option value="">Todas las áreas</option>
            {areas.map((a) => <option key={a}>{a}</option>)}
          </select>
          <select className="input w-auto" value={fPuesto} onChange={(e) => setFPuesto(e.target.value)} aria-label="Filtrar por puesto">
            <option value="">Todos los puestos</option>
            {puestos.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select className="input w-auto" value={fEstado} onChange={(e) => setFEstado(e.target.value)} aria-label="Filtrar por estado">
            <option value="">Activos e inactivos</option><option value="activo">Solo activos</option><option value="inactivo">Solo inactivos</option>
          </select>
          <select className="input w-auto" value={fEquipos} onChange={(e) => setFEquipos(e.target.value)} aria-label="Filtrar por equipos">
            <option value="">Todos (equipos y periféricos)</option>
            <option value="con">Con equipo asignado</option><option value="sin">Sin equipo asignado</option>
            <option value="con_p">Con periféricos</option><option value="sin_p">Sin periféricos</option>
            {categorias.map((c) => <option key={c} value={`cat:${c}`}>Con {c.toLowerCase()}</option>)}
          </select>
          <span className="text-sm text-ink/50 ml-auto">
            {hayFiltros ? `Mostrando ${visibles.length} de ${empleados.length}` : `${empleados.length} ${empleados.length === 1 ? "persona" : "personas"}`}
          </span>
          {hayFiltros && (
            <button className="text-sm text-brand-600 hover:underline" onClick={limpiar}>Limpiar filtros</button>
          )}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              {([["nombre", "Nombre"], ["area", "Área"], ["puesto", "Puesto"], ["equipos", "Equipos"], ["perifericos", "Periféricos"], ["estado", "Estado"]] as [Orden, string][]).map(([k, t]) => (
                <th key={k} aria-sort={orden === k ? (asc ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => ordenarPor(k)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink">
                    {t}
                    <span className={orden === k ? "text-brand-600" : "text-ink/20"} aria-hidden>{orden === k && !asc ? "▼" : "▲"}</span>
                  </button>
                </th>
              ))}
              {puedeEditar && <th></th>}
            </tr>
          </thead>
          <tbody>
            {visibles.map((emp) => {
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
                  <ListaEquipos items={suyos.filter((e) => !esPeriferico(e))} />
                  {!emp.activo && suyos.length > 0 && (
                    <span className="pill bg-red-50 text-red-600 mt-1">Recuperar equipos</span>
                  )}
                </td>
                <td>
                  <ListaEquipos items={suyos.filter(esPeriferico)} />
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
            {visibles.length === 0 && (
              <tr>
                <td colSpan={puedeEditar ? 7 : 6} className="text-center text-ink/40 py-8">
                  {empleados.length === 0 ? "Todavía no hay empleados cargados." : "Nadie coincide con la búsqueda o los filtros."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
