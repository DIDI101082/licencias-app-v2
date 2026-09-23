"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { calcularPlan, type EmpleadoActual, type EmpleadoFuente, type Plan } from "@/lib/empleados-sync";
import PlanEmpleados from "./PlanEmpleados";

// Títulos de columna aceptados (sin importar mayúsculas ni tildes)
const COLUMNAS: Record<string, keyof EmpleadoFuente> = {
  nombre: "nombre", nombres: "nombre",
  apellido: "apellido", apellidos: "apellido",
  email: "email", mail: "email", correo: "email", "correo electronico": "email", "e-mail": "email",
  area: "area", sector: "area", departamento: "area",
  puesto: "puesto", cargo: "puesto",
};
const sinTildes = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

function leerCSV(texto: string): string[][] {
  const sep = texto.split("\n")[0].includes(";") ? ";" : ",";
  const filas: string[][] = []; let fila: string[] = []; let celda = ""; let q = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (q) { if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++; } else if (c === '"') q = false; else celda += c; }
    else if (c === '"') q = true;
    else if (c === sep) { fila.push(celda); celda = ""; }
    else if (c === "\n") { fila.push(celda); filas.push(fila); fila = []; celda = ""; }
    else if (c !== "\r") celda += c;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return filas;
}

export default function EmpleadosExcel({ empleados }: { empleados: EmpleadoActual[] }) {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  async function descargarPlantilla() {
    const writeExcelFile = (await import("write-excel-file/browser")).default;
    const titulos = ["Nombre", "Apellido", "Email", "Área", "Puesto"];
    await writeExcelFile(
      [
        titulos.map((t) => ({ value: t, fontWeight: "bold" as const })),
        ["Juan", "Pérez", "juan.perez@accusys.com.ar", "CAU", "Analista"].map((v) => ({ value: v })),
      ],
      { columns: titulos.map((t) => ({ width: t === "Email" ? 34 : 20 })) }
    ).toFile("plantilla-empleados.xlsx");
  }

  async function leer(archivo: File) {
    setError(null); setResultado(null); setPlan(null);
    try {
      let filas: any[][];
      if (/\.csv$/i.test(archivo.name)) {
        filas = leerCSV((await archivo.text()).replace(/^\uFEFF/, ""));
      } else {
        const { readSheet } = await import("read-excel-file/browser");
        filas = await readSheet(archivo);
      }
      const [cab, ...cuerpo] = filas;
      const claves = (cab ?? []).map((c: any) => COLUMNAS[sinTildes(String(c ?? ""))]);
      const faltan = ["nombre", "apellido", "email", "area"].filter((k) => !claves.includes(k as any));
      if (faltan.length) {
        setError(`Al archivo le faltan las columnas: ${faltan.join(", ")}. Descargá la plantilla para ver el formato.`);
        return;
      }
      const fuente: EmpleadoFuente[] = cuerpo
        .filter((f) => f.some((c) => String(c ?? "").trim()))
        .map((f) => {
          const r: any = {};
          claves.forEach((k: any, i: number) => { if (k) r[k] = String(f[i] ?? "").trim(); });
          return r as EmpleadoFuente;
        });
      setPlan(calcularPlan(fuente, empleados, { desactivarAusentes: false }));
    } catch (e: any) {
      setError(`No se pudo leer el archivo: ${e.message}`);
    }
  }

  async function aplicar() {
    if (!plan) return;
    setAplicando(true); setError(null);
    const sb = createClient();
    try {
      if (plan.nuevos.length) {
        const { error } = await sb.from("empleados").insert(plan.nuevos.map((n) => ({
          nombre: n.nombre, apellido: n.apellido, email: n.email, area: n.area, puesto: n.puesto ?? null, origen: "excel",
        })));
        if (error) throw error;
      }
      for (const c of plan.actualizar) {
        const { error } = await sb.from("empleados")
          .update(Object.fromEntries(Object.entries(c.campos).map(([k, v]) => [k, v.despues]))).eq("id", c.id);
        if (error) throw error;
      }
      await sb.from("empleados_sync").insert({ fuente: "excel", nuevos: plan.nuevos.length, actualizados: plan.actualizar.length });
      setResultado(`Listo: ${plan.nuevos.length} creados y ${plan.actualizar.length} actualizados.`);
      setPlan(null);
      router.refresh();
    } catch (e: any) {
      setError(e.code === "23505" ? "Hay un email repetido con otro empleado existente." : e.message);
    } finally {
      setAplicando(false);
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-medium text-ink">Importar desde Excel</h2>
          <p className="text-sm text-ink/60 mt-1 max-w-xl">
            Subí un archivo .xlsx o .csv con las columnas Nombre, Apellido, Email, Área y Puesto. Los empleados se reconocen por el
            email: los que ya existen se actualizan y los nuevos se crean. Antes de aplicar vas a ver qué cambia.
          </p>
        </div>
        <button className="btn-secondary" onClick={descargarPlantilla}>Descargar plantilla</button>
      </div>
      <input type="file" accept=".xlsx,.csv" className="text-sm"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) leer(f); e.target.value = ""; }} />
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {resultado && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-md px-3 py-2">{resultado}</p>}
      {plan && (
        <>
          <PlanEmpleados plan={plan} />
          <div className="flex gap-2">
            <button className="btn-primary" onClick={aplicar} disabled={aplicando || (!plan.nuevos.length && !plan.actualizar.length)}>
              {aplicando ? "Aplicando…" : "Aplicar cambios"}
            </button>
            <button className="btn-secondary" onClick={() => setPlan(null)}>Cancelar</button>
          </div>
        </>
      )}
    </div>
  );
}

export async function exportarEmpleados(empleados: any[], equiposPorEmpleado: Record<string, string[]>) {
  const writeExcelFile = (await import("write-excel-file/browser")).default;
  const titulos = ["Nombre", "Apellido", "Email", "Área", "Puesto", "Estado", "Equipos IT", "Origen"];
  const filas = empleados.map((e) => [
    { value: e.nombre }, { value: e.apellido }, { value: e.email }, { value: e.area }, { value: e.puesto ?? "" },
    { value: e.activo ? "Activo" : "Inactivo" }, { value: (equiposPorEmpleado[e.id] ?? []).join(", ") },
    { value: e.entra_id ? "Entra ID" : "Manual" },
  ]);
  await writeExcelFile([titulos.map((t) => ({ value: t, fontWeight: "bold" as const })), ...filas], {
    columns: titulos.map((t) => ({ width: t === "Email" ? 34 : t === "Equipos IT" ? 24 : 20 })),
  }).toFile(`empleados-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
