import { createClient, getPerfil } from "@/lib/supabase/server";
import AsignacionesClient from "./AsignacionesClient";

export default async function AsignacionesPage() {
  const supabase = createClient();
  const { perfil } = await getPerfil();

  const [
    { data: asignaciones },
    { data: licencias },
    { data: empleados },
    { data: ocupacion },
  ] = await Promise.all([
    supabase
      .from("asignaciones")
      .select(
        "id, fecha_asignacion, fecha_liberacion, notas, licencias(id, nombre), empleados(id, nombre, apellido, area)"
      )
      .order("fecha_asignacion", { ascending: false }),
    supabase.from("licencias").select("id, nombre, seats_totales").order("nombre"),
    supabase.from("empleados").select("id, nombre, apellido").eq("activo", true).order("apellido"),
    supabase.from("licencias_ocupacion").select("licencia_id, seats_libres"),
  ]);

  return (
    <AsignacionesClient
      asignaciones={(asignaciones as any) ?? []}
      licencias={licencias ?? []}
      empleados={empleados ?? []}
      ocupacion={ocupacion ?? []}
      puedeEditar={perfil?.rol === "administrador" || perfil?.rol === "lectura_escritura"}
    />
  );
}
