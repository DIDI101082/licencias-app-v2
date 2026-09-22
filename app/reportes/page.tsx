import { createClient } from "@/lib/supabase/server";
import ReportesClient from "./ReportesClient";

export default async function ReportesPage() {
  const supabase = createClient();

  const { data: asignaciones } = await supabase
    .from("asignaciones")
    .select(
      "fecha_asignacion, fecha_liberacion, licencias(nombre, proveedor, costo_unitario, periodicidad), empleados(nombre, apellido, area)"
    )
    .order("fecha_asignacion", { ascending: false });

  const filas = (asignaciones ?? []).map((a: any) => ({
    empleado: `${a.empleados?.nombre ?? ""} ${a.empleados?.apellido ?? ""}`.trim(),
    area: a.empleados?.area ?? "",
    licencia: a.licencias?.nombre ?? "",
    proveedor: a.licencias?.proveedor ?? "",
    costo_unitario: a.licencias?.costo_unitario ?? 0,
    periodicidad: a.licencias?.periodicidad ?? "",
    fecha_asignacion: a.fecha_asignacion,
    fecha_liberacion: a.fecha_liberacion,
  }));

  function costoMensual(costo: number, periodicidad: string) {
    if (periodicidad === "mensual") return costo;
    if (periodicidad === "anual") return costo / 12;
    return 0;
  }

  const activas = filas.filter((f) => !f.fecha_liberacion);

  const porArea = new Map<string, number>();
  const porProveedor = new Map<string, number>();
  for (const f of activas) {
    const costo = costoMensual(f.costo_unitario, f.periodicidad);
    porArea.set(f.area, (porArea.get(f.area) ?? 0) + costo);
    porProveedor.set(f.proveedor, (porProveedor.get(f.proveedor) ?? 0) + costo);
  }

  return (
    <ReportesClient
      filas={filas}
      costoPorArea={Array.from(porArea, ([area, costo]) => ({ area, costo })).sort(
        (a, b) => b.costo - a.costo
      )}
      costoPorProveedor={Array.from(porProveedor, ([proveedor, costo]) => ({
        proveedor,
        costo,
      })).sort((a, b) => b.costo - a.costo)}
    />
  );
}
