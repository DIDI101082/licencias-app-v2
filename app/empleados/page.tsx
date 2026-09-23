import { createClient, getPerfil } from "@/lib/supabase/server";
import EmpleadosClient from "./EmpleadosClient";

export default async function EmpleadosPage() {
  const supabase = createClient();
  const { perfil } = await getPerfil();

  const [{ data: empleados }, { data: equipos }, { data: ultimaSync }] = await Promise.all([
    supabase.from("empleados").select("*").order("apellido"),
    // Equipos del inventario IT asignados a cada empleado
    supabase
      .from("inv_v_equipos")
      .select("id, codigo, categoria, marca, modelo, empleado_id")
      .eq("estado", "asignado")
      .order("codigo"),
    supabase.from("empleados_sync").select("fecha").eq("fuente", "entra").order("fecha", { ascending: false }).limit(1),
  ]);

  return (
    <EmpleadosClient
      empleados={empleados ?? []}
      equipos={equipos ?? []}
      esAdmin={perfil?.rol === "administrador"}
      ultimaSyncEntra={ultimaSync?.[0]?.fecha ?? null}
      soloArea={perfil?.rol === "lectura_escritura" ? perfil.area : null}
      puedeEditar={perfil?.rol === "administrador" || perfil?.rol === "lectura_escritura"}
    />
  );
}
