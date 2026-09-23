"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Perfil = {
  id: string;
  nombre: string;
  email: string;
  rol: "administrador" | "lectura_escritura" | "solo_lectura";
  area: string | null;
  created_at: string;
};

const rolLabel: Record<string, string> = {
  administrador: "Administrador",
  lectura_escritura: "Lectura y escritura",
  solo_lectura: "Solo lectura",
};

export default function UsuariosClient({
  perfiles,
  miPropioId,
}: {
  perfiles: Perfil[];
  miPropioId: string;
}) {
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [rol, setRol] = useState<string>("solo_lectura");
  const [area, setArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  function abrirEdicion(p: Perfil) {
    setEditandoId(p.id);
    setRol(p.rol);
    setArea(p.area ?? "");
    setError(null);
  }

  async function guardar(id: string) {
    setError(null);
    setGuardando(true);

    const payload = {
      rol,
      area: rol === "lectura_escritura" ? area : null,
    };

    const { error } = await supabase.from("perfiles").update(payload).eq("id", id);

    setGuardando(false);

    if (error) {
      setError(error.message);
      return;
    }

    setEditandoId(null);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl text-ink">Usuarios</h1>
        <p className="text-ink/60 text-sm mt-1">
          Asigná el rol y, si corresponde, el área de cada persona que se
          registró en el sistema.
        </p>
      </div>

      <div className="card overflow-hidden">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>Rol</th>
              <th>Área</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {perfiles.map((p) => (
              <tr key={p.id}>
                <td className="font-medium text-ink">
                  {p.nombre}
                  {p.id === miPropioId && (
                    <span className="ml-2 text-xs text-ink/40 font-normal">(vos)</span>
                  )}
                </td>
                <td className="text-ink/60">{p.email}</td>

                {editandoId === p.id ? (
                  <>
                    <td>
                      <select
                        className="input"
                        value={rol}
                        onChange={(e) => setRol(e.target.value)}
                      >
                        <option value="solo_lectura">Solo lectura</option>
                        <option value="lectura_escritura">Lectura y escritura</option>
                        <option value="administrador">Administrador</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="input disabled:bg-black/[0.03]"
                        disabled={rol !== "lectura_escritura"}
                        placeholder={rol === "lectura_escritura" ? "Nombre del área" : "—"}
                        value={area}
                        onChange={(e) => setArea(e.target.value)}
                      />
                    </td>
                    <td className="text-right space-x-3">
                      <button
                        className="text-brand-600 hover:underline text-sm"
                        disabled={guardando}
                        onClick={() => guardar(p.id)}
                      >
                        {guardando ? "Guardando…" : "Guardar"}
                      </button>
                      <button
                        className="text-ink/50 hover:underline text-sm"
                        onClick={() => setEditandoId(null)}
                      >
                        Cancelar
                      </button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="text-ink/60">{rolLabel[p.rol] ?? p.rol}</td>
                    <td className="text-ink/60">{p.area || "—"}</td>
                    <td className="text-right">
                      <button
                        className="text-brand-600 hover:underline text-sm"
                        onClick={() => abrirEdicion(p)}
                      >
                        Editar
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {perfiles.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-ink/40 py-8">
                  Todavía no hay usuarios registrados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>
      )}
    </div>
  );
}
