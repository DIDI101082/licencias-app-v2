import { createClient, getPerfil } from "@/lib/supabase/server";
import LicenciasClient from "./LicenciasClient";

export default async function LicenciasPage() {
  const supabase = createClient();
  const { perfil } = await getPerfil();

  const [{ data: licencias }, { data: ocupacion }] = await Promise.all([
    supabase.from("licencias").select("*").order("nombre"),
    supabase.from("licencias_ocupacion").select("*"),
  ]);

  return (
    <LicenciasClient
      licencias={licencias ?? []}
      ocupacion={ocupacion ?? []}
      esRRHH={perfil?.rol === "administrador"}
    />
  );
}
