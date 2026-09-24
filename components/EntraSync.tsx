"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Plan } from "@/lib/empleados-sync";
import PlanEmpleados from "./PlanEmpleados";

type Respuesta = {
  configurado: boolean;
  plan?: Plan;
  descartes?: { invitados: number; sinMail: number; sinArea: number; otroDominio: number };
  total?: number;
  error?: string;
};

export default function EntraSync({ ultima }: { ultima: string | null }) {
  const router = useRouter();
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [cargando, setCargando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [requerirArea, setRequerirArea] = useState(true);
  const [resultado, setResultado] = useState<string | null>(null);

  async function previsualizar(req = requerirArea) {
    setCargando(true); setResultado(null);
    try {
      const r = await fetch(`/api/entra?requerirArea=${req ? 1 : 0}`, { cache: "no-store" });
      setDatos(await r.json());
    } catch (e: any) {
      setDatos({ configurado: true, error: e.message });
    }
    setCargando(false);
  }

  async function aplicar() {
    setAplicando(true);
    const r = await fetch("/api/entra", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requerirArea }),
    });
    const j = await r.json();
    setAplicando(false);
    if (!r.ok) return setDatos({ ...(datos as Respuesta), error: j.error });
    setResultado(`Sincronización completa: ${j.nuevos} creados, ${j.actualizados} actualizados y ${j.desactivados} desactivados.`);
    setDatos(null);
    router.refresh();
  }

  const d = datos?.descartes;
  const hayCambios = !!datos?.plan && (datos.plan.nuevos.length + datos.plan.actualizar.length + datos.plan.desactivar.length) > 0;

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-medium text-ink">Sincronizar con Entra ID</h2>
          <p className="text-sm text-ink/60 mt-1 max-w-xl">
            Trae los usuarios de Microsoft Entra ID: nombre, email, área (Departamento) y puesto (Cargo). Crea los que faltan, actualiza
            los datos y desactiva a quienes tengan la cuenta deshabilitada o eliminada. Los empleados cargados a mano se vinculan por email.
          </p>
          {ultima && <p className="text-xs text-ink/50 mt-1">Última sincronización: {new Date(ultima).toLocaleString("es-AR")}</p>}
        </div>
        <button className="btn-primary" onClick={() => previsualizar()} disabled={cargando}>
          {cargando ? "Consultando Entra ID…" : "Ver cambios"}
        </button>
      </div>

      {resultado && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-md px-3 py-2">{resultado}</p>}

      {datos && !datos.configurado && (
        <div className="text-sm rounded-md bg-amber-500/10 text-amber-800 px-4 py-3 space-y-2">
          <b>Falta conectar la app con Entra ID.</b>
          <ol className="list-decimal pl-5 space-y-1">
            <li>En el portal de Entra: <b>Registros de aplicaciones → Nuevo registro</b>, por ejemplo “Accusys Cyber – Sincronización”.</li>
            <li>En <b>Permisos de API → Agregar → Microsoft Graph → Permisos de aplicación</b>, agregá <code>User.Read.All</code> y tocá <b>Conceder consentimiento de administrador</b>.</li>
            <li>En <b>Certificados y secretos</b> creá un secreto de cliente y copiá su <b>Valor</b>.</li>
            <li>En Vercel → Settings → Environment Variables, cargá <code>AZURE_TENANT_ID</code>, <code>AZURE_CLIENT_ID</code> y <code>AZURE_CLIENT_SECRET</code>, y hacé Redeploy.</li>
          </ol>
        </div>
      )}

      {datos?.error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{datos.error}</p>}

      {datos?.plan && (
        <>
          <p className="text-sm text-ink/60">
            Entra ID tiene {datos.total} cuentas. Se descartan {d!.invitados} invitados externos, {d!.sinMail} sin email
            {d!.otroDominio ? `, ${d!.otroDominio} de otros dominios` : ""}
            {requerirArea ? ` y ${d!.sinArea} sin departamento cargado (salas, buzones compartidos o cuentas de servicio)` : ""}.
          </p>
          <label className="text-sm text-ink/70 flex items-center gap-2">
            <input type="checkbox" checked={requerirArea}
              onChange={(e) => { setRequerirArea(e.target.checked); previsualizar(e.target.checked); }} />
            Solo usuarios con Departamento cargado en Entra ID
          </label>
          <PlanEmpleados plan={datos.plan} />
          <div className="flex gap-2">
            <button className="btn-primary" onClick={aplicar} disabled={aplicando || !hayCambios}>
              {aplicando ? "Sincronizando…" : hayCambios ? "Aplicar cambios" : "Todo está al día"}
            </button>
            <button className="btn-secondary" onClick={() => setDatos(null)}>Cerrar</button>
          </div>
        </>
      )}
    </div>
  );
}
