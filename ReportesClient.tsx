"use client";

type Fila = {
  empleado: string;
  area: string;
  licencia: string;
  proveedor: string;
  costo_unitario: number;
  periodicidad: string;
  fecha_asignacion: string;
  fecha_liberacion: string | null;
};

function aCSV(filas: Fila[]) {
  const encabezados = [
    "Empleado",
    "Área",
    "Licencia",
    "Proveedor",
    "Costo unitario",
    "Periodicidad",
    "Fecha asignación",
    "Fecha liberación",
  ];
  const lineas = filas.map((f) =>
    [
      f.empleado,
      f.area,
      f.licencia,
      f.proveedor,
      f.costo_unitario,
      f.periodicidad,
      f.fecha_asignacion,
      f.fecha_liberacion ?? "",
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [encabezados.join(","), ...lineas].join("\n");
}

export default function ReportesClient({
  filas,
  costoPorArea,
  costoPorProveedor,
}: {
  filas: Fila[];
  costoPorArea: { area: string; costo: number }[];
  costoPorProveedor: { proveedor: string; costo: number }[];
}) {
  function descargar() {
    const csv = aCSV(filas);
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `licencias_asignaciones_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const fmt = (n: number) =>
    n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Reportes</h1>
        <button className="btn-primary" onClick={descargar}>
          Exportar CSV
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-3">Costo mensual por área</h2>
          <ul className="space-y-2">
            {costoPorArea.map((r) => (
              <li key={r.area} className="flex justify-between text-sm">
                <span className="text-ink/70">{r.area}</span>
                <span className="font-medium text-ink">{fmt(r.costo)}</span>
              </li>
            ))}
            {costoPorArea.length === 0 && (
              <p className="text-sm text-ink/40">Sin datos todavía.</p>
            )}
          </ul>
        </div>

        <div className="card p-5">
          <h2 className="font-medium text-ink mb-3">Costo mensual por proveedor</h2>
          <ul className="space-y-2">
            {costoPorProveedor.map((r) => (
              <li key={r.proveedor} className="flex justify-between text-sm">
                <span className="text-ink/70">{r.proveedor}</span>
                <span className="font-medium text-ink">{fmt(r.costo)}</span>
              </li>
            ))}
            {costoPorProveedor.length === 0 && (
              <p className="text-sm text-ink/40">Sin datos todavía.</p>
            )}
          </ul>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Empleado</th>
              <th>Área</th>
              <th>Licencia</th>
              <th>Proveedor</th>
              <th>Asignada</th>
              <th>Liberada</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={i}>
                <td className="font-medium text-ink">{f.empleado}</td>
                <td className="text-ink/60">{f.area}</td>
                <td className="text-ink/60">{f.licencia}</td>
                <td className="text-ink/60">{f.proveedor}</td>
                <td className="text-ink/60">
                  {new Date(f.fecha_asignacion).toLocaleDateString("es-AR")}
                </td>
                <td className="text-ink/60">
                  {f.fecha_liberacion
                    ? new Date(f.fecha_liberacion).toLocaleDateString("es-AR")
                    : "—"}
                </td>
              </tr>
            ))}
            {filas.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-ink/40 py-8">
                  No hay datos para mostrar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
