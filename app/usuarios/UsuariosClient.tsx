"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import GruposAcceso, { type Grupo } from "./GruposAcceso";

type Perfil = {
  id: string;
  nombre: string;
  email: string;
  rol: "administrador" | "lectura_escritura" | "solo_lectura";
  area: string | null;
  grupo_id: number | null;
  created_at: string;
};

const rolLabel: Record<string, string> = {
  administrador: "Administrador",
  lectura_escritura: "Lectura y escritura",
  solo_lectura: "Solo lectura",
};

export default function UsuariosClient({
  perfiles,
  grupos,
  miPropioId,
}: {
  perfiles: Perfil[];
  grupos: Grupo[];
  miPropioId: string;
}) {
  const [grupo, setGrupo] = useState<string>("");
  const [verGrupos, setVerGrupos] = useState(false);
  const nombreGrupo = (id: number | null) => grupos.find((g) => g.id === id)?.nombre;
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
    setGrupo(p.grupo_id ? String(p.grupo_id) : "");
    setError(null);
  }

  async function eliminar(p: Perfil) {
    const ok = confirm(
      `¿Eliminar a ${p.email}?\n\n` +
        "Se borra su cuenta de la app. Lo que haya cargado (asignaciones, etc.) se conserva.\n" +
        "Si sigue habilitado en Entra ID, podría volver a entrar con Microsoft, pero sin acceso a ninguna solapa hasta que le asignes un grupo."
    );
    if (!ok) return;
    setError(null);
    const { error } = await createClient().rpc("eliminar_usuario", { p_id: p.id });
    if (error) {
      setError(error.message.includes("eliminar_usuario") && error.message.includes("function") ? "Falta ejecutar eliminar-usuario.sql en Supabase." : error.message);
      return;
    }
    router.refresh();
  }

  async function guardar(id: string) {
    setError(null);
    setGuardando(true);

    const payload = {
      rol,
      area: rol === "lectura_escritura" ? area : null,
      grupo_id: rol === "administrador" || !grupo ? null : Number(grupo),
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
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Usuarios</h1>
          <p className="text-ink/60 text-sm mt-1">
            El <b>rol</b> define si puede editar; el <b>acceso</b> define qué solapas ve. Los administradores ven todo.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => setVerGrupos(!verGrupos)} aria-expanded={verGrupos}>
          Grupos de acceso
        </button>
      </div>

      {verGrupos && <GruposAcceso grupos={grupos} />}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>Rol</th>
              <th>Acceso</th>
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
                      <select
                        className="input disabled:bg-line/[0.03]"
                        value={rol === "administrador" ? "" : grupo}
                        disabled={rol === "administrador"}
                        onChange={(e) => setGrupo(e.target.value)}
                        aria-label="Grupo de acceso"
                      >
                        <option value="">{rol === "administrador" ? "Todo (administrador)" : "Sin grupo: sin acceso"}</option>
                        {grupos.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input disabled:bg-line/[0.03]"
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
                    <td className="text-ink/60">
                      {p.rol === "administrador" ? "Todo" : nombreGrupo(p.grupo_id) ?? <span className="text-amber-700">Sin grupo (sin acceso)</span>}
                    </td>
                    <td className="text-ink/60">{p.area || "—"}</td>
                    <td className="text-right whitespace-nowrap">
                      <button
                        className="text-brand-600 hover:underline text-sm"
                        onClick={() => abrirEdicion(p)}
                      >
                        Editar
                      </button>
                      {p.id !== miPropioId && (
                        <button
                          className="text-ink/40 hover:text-red-600 hover:underline text-sm ml-3"
                          onClick={() => eliminar(p)}
                        >
                          Eliminar
                        </button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {perfiles.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-ink/40 py-8">
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
