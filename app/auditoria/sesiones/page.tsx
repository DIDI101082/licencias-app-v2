"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Sesion = { fecha: string; email: string | null; accion: string; ip: string | null; proveedor: string | null };
const ACCION: Record<string, { texto: string; clase: string }> = {
  login: { texto: "Inicio de sesión", clase: "bg-emerald-50 text-emerald-700" },
  logout: { texto: "Cierre de sesión", clase: "bg-black/[0.05] text-ink/60" },
  user_signedup: { texto: "Primer ingreso", clase: "bg-brand-50 text-brand-700" },
  user_deleted: { texto: "Usuario eliminado", clase: "bg-red-50 text-red-600" },
  user_invited: { texto: "Invitación", clase: "bg-brand-50 text-brand-700" },
  user_updated_password: { texto: "Cambio de contraseña", clase: "bg-amber-500/10 text-amber-700" },
  user_recovery_requested: { texto: "Recuperación de contraseña", clase: "bg-amber-500/10 text-amber-700" },
};
const METODO: Record<string, string> = { azure: "Microsoft", email: "Email y contraseña" };

export default function Sesiones() {
  const [filas, setFilas] = useState<Sesion[]>([]);
  const [dias, setDias] = useState(7);
  const [cargando, setCargando] = useState(true);
  const [texto, setTexto] = useState("");

  useEffect(() => {
    setCargando(true);
    createClient().rpc("auditoria_sesiones", { p_desde: new Date(Date.now() - dias * 86400000).toISOString(), p_limite: 1000 })
      .then(({ data }) => { setFilas((data ?? []) as Sesion[]); setCargando(false); });
  }, [dias]);

  const q = texto.trim().toLowerCase();
  const visibles = q ? filas.filter((f) => [f.email, f.ip].some((v) => v?.toLowerCase().includes(q))) : filas;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-ink">Inicios de sesión</h1>
        <p className="text-ink/60 text-sm mt-1">Quién entró a la app, cuándo, desde qué IP y con qué método.</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <select className="input w-auto" value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Período">
          <option value={1}>Últimas 24 horas</option><option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option><option value={90}>Últimos 90 días</option>
        </select>
        <input type="search" className="input flex-1 min-w-[200px]" placeholder="Buscar por email o IP" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
      </div>
      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Fecha</th><th>Persona</th><th>Evento</th><th>Método</th><th>IP</th></tr></thead>
          <tbody>
            {visibles.map((f, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap text-sm text-ink/70">{new Date(f.fecha).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "medium" })}</td>
                <td className="text-ink">{f.email ?? "—"}</td>
                <td><span className={`pill ${ACCION[f.accion]?.clase ?? "bg-black/[0.05] text-ink/60"}`}>{ACCION[f.accion]?.texto ?? f.accion}</span></td>
                <td className="text-ink/70">{f.proveedor ? METODO[f.proveedor] ?? f.proveedor : "—"}</td>
                <td className="text-xs text-ink/60 font-mono">{f.ip ?? "—"}</td>
              </tr>
            ))}
            {!cargando && visibles.length === 0 && <tr><td colSpan={5} className="text-center text-ink/40 py-10">Sin inicios de sesión en este período.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">Datos del registro de autenticación de Supabase.</p>
    </div>
  );
}
