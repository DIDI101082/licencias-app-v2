import { createClient, getPerfil } from "@/lib/supabase/server";
import UsuariosClient from "./UsuariosClient";

export default async function UsuariosPage() {
  const { perfil, user } = await getPerfil();

  if (perfil?.rol !== "administrador") {
    return (
      <div className="card p-6 max-w-md">
        <h1 className="font-display text-xl text-ink mb-2">Usuarios</h1>
        <p className="text-sm text-ink/60">
          Esta sección es solo para administradores.
        </p>
      </div>
    );
  }

  const supabase = createClient();
  const [{ data: perfiles }, { data: grupos }] = await Promise.all([
    supabase.from("perfiles").select("*").order("created_at", { ascending: false }),
    supabase.from("grupos_acceso").select("*").order("nombre"),
  ]);

  return <UsuariosClient perfiles={perfiles ?? []} grupos={grupos ?? []} miPropioId={user?.id ?? ""} />;
}
