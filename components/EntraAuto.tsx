"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { hace } from "@/lib/monitoreo";

type Evento = {
  id: number; detectado: string; tipo: "alta" | "baja" | "reactivacion" | "eliminado";
  nombre: string | null; email: string | null; area: string | null;
  actor: string | null; actor_origen: "entra" | "ad" | "sincronizacion" | null; fecha_accion: string | null; movimiento_id: number | null;
};

type Estado = {
  activo: boolean; requerir_area: boolean; alertar: boolean; limite_bajas: number;
  auditoria_ok: boolean | null; ultima_ejecucion: string | null; resultado: Record<string, any>; ultimo_error: string | null;
  clave_configurada: boolean; alertas_teams: boolean; eventos: Evento[];
};

const TIPO: Record<Evento["tipo"], { t: string; c: string }> = {
  alta: { t: "Alta", c: "bg-emerald-500/15 text-emerald-700" },
  reactivacion: { t: "Habilitada", c: "bg-sky-500/15 text-sky-700" },
  baja: { t: "Baja", c: "bg-amber-500/15 text-amber-800" },
  eliminado: { t: "Eliminada", c: "bg-red-500/15 text-red-700" },
};

function quien(e: Evento) {
  if (!e.actor) return <span className="text-ink/40">sin identificar</span>;
  if (e.actor_origen === "sincronizacion") return <span className="text-ink/60">sincronizado desde el AD local</span>;
  return <>{e.actor}{e.actor_origen === "ad" && <span className="text-ink/50"> (AD local)</span>}</>;
}

// Sincronización automática con Entra ID (cada 15 minutos) y avisos de altas y bajas con "quién"
export default function EntraAuto() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [falta, setFalta] = useState(false);
  const [form, setForm] = useState({ activo: false, requerir_area: true, alertar: true, limite_bajas: 10 });
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [corriendo, setCorriendo] = useState(false);

  const cargar = useCallback(async () => {
    const { data, error } = await createClient().rpc("entra_auto_estado");
    if (error) { setFalta(/entra_auto_estado/.test(error.message)); return; }
    const e = data as Estado;
    setEstado(e);
    setForm({ activo: e.activo, requerir_area: e.requerir_area, alertar: e.alertar, limite_bajas: e.limite_bajas });
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  if (falta) return <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">Falta ejecutar supabase/entra-auto.sql en Supabase.</p>;
  if (!estado) return null;

  async function guardar() {
    setAviso(null);
    if (form.activo && !estado!.activo && !confirm(
      "Al activarla, cada 15 minutos se aplican solos los cambios de Entra ID (altas, datos y bajas).\n\n" +
      "Conviene hacer antes una sincronización manual (Ver cambios → Aplicar) para arrancar al día. ¿Activar?")) return;
    const { error } = await createClient().rpc("entra_auto_guardar", { p: form });
    setAviso(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado." });
    if (!error) cargar();
  }

  async function ahora() {
    setCorriendo(true); setAviso(null);
    const r = await fetch("/api/entra/auto", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setCorriendo(false);
    if (!r.ok) setAviso({ ok: false, texto: j.error ?? "No se pudo ejecutar" });
    else if (j.omitido) setAviso({ ok: false, texto: j.omitido });
    else if (j.frenado) setAviso({ ok: false, texto: `Frenada por seguridad: quería dar de baja ${j.bajas} cuentas (límite ${j.limite}).` });
    else setAviso({ ok: true, texto: `Listo: ${j.nuevos} altas, ${j.bajas} bajas, ${j.reactivaciones} rehabilitadas y ${j.actualizados} con datos actualizados.` });
    cargar();
  }

  const r = estado.resultado ?? {};
  const atrasada = estado.activo && (!estado.ultima_ejecucion || Date.now() - Date.parse(estado.ultima_ejecucion) > 3600000);
  const problemas = [
    !estado.clave_configurada && "Falta la clave CRON_SECRET: se genera en Seguridad → verificación diaria → Configurar, y se carga en Vercel.",
    estado.activo && !estado.alertas_teams && "Las alertas a Teams están apagadas o sin webhook: los movimientos se registran pero no se avisan.",
    estado.activo && estado.auditoria_ok === false && (r.auditoria_error ?? "No se pudo leer la auditoría de Entra: los avisos salen sin el autor."),
    estado.ultimo_error,
    atrasada && "La tarea no corrió en la última hora. Revisá que CRON_SECRET esté cargada en Vercel y que se haya publicado de nuevo.",
  ].filter(Boolean) as string[];

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-medium text-ink">Sincronización automática y avisos de altas y bajas</h2>
          <p className="text-sm text-ink/60 mt-1 max-w-2xl">
            Cada 15 minutos aplica los cambios de Entra ID, abre el checklist de alta o de baja y avisa en Teams quién creó,
            deshabilitó o eliminó la cuenta. Si una corrida quiere dar de baja más cuentas que el límite, se frena y avisa.
          </p>
          <p className="text-xs text-ink/50 mt-1">
            {estado.activo ? "Activa" : "Apagada"}
            {estado.ultima_ejecucion && <> · última corrida {hace(estado.ultima_ejecucion)}</>}
            {estado.activo && estado.auditoria_ok && <> · autor de los cambios: ok</>}
          </p>
        </div>
        {estado.activo && estado.clave_configurada && (
          <button className="btn-secondary" onClick={ahora} disabled={corriendo}>{corriendo ? "Sincronizando… (hasta 1 min)" : "Sincronizar ahora"}</button>
        )}
      </div>

      {problemas.length > 0 && (
        <ul className="text-sm rounded-md bg-amber-500/10 text-amber-800 px-4 py-3 space-y-1 list-disc pl-8">
          {problemas.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-3xl">
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.activo} onChange={(e) => setForm({ ...form, activo: e.target.checked })} />Sincronizar automáticamente cada 15 minutos</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.alertar} onChange={(e) => setForm({ ...form, alertar: e.target.checked })} />Avisar en Teams cada alta y baja</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.requerir_area} onChange={(e) => setForm({ ...form, requerir_area: e.target.checked })} />Solo usuarios con Departamento cargado</label>
        <label className="flex items-center gap-2">Frenar si hay más de
          <input type="number" min={1} max={500} className="input w-20" value={form.limite_bajas} onChange={(e) => setForm({ ...form, limite_bajas: Number(e.target.value) })} />
          bajas juntas</label>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={guardar}>Guardar</button>
        {aviso && <p role="status" className={`text-sm ${aviso.ok ? "text-emerald-700" : "text-red-600"}`}>{aviso.texto}</p>}
      </div>

      <details className="text-sm text-ink/70">
        <summary className="cursor-pointer">Cómo se configura</summary>
        <ol className="list-decimal pl-5 space-y-1.5 mt-2">
          <li>En Entra, en la app registrada que ya usa la sincronización: <b>Permisos de API → Agregar → Microsoft Graph → Permisos de aplicación</b>,
            agregá <code>AuditLog.Read.All</code> y tocá <b>Conceder consentimiento de administrador</b>. Es lo que permite saber quién hizo cada cambio.</li>
          <li>La tarea usa la misma clave <code>CRON_SECRET</code> que la verificación diaria. Si ya está cargada en Vercel, no hay que hacer nada más.</li>
          <li>Hacé una sincronización manual (arriba) para arrancar al día, y después activá la automática.</li>
          <li>Si las cuentas se crean en el AD local y se sincronizan con Entra Connect, el autor se toma de los eventos del puente de Active Directory.</li>
        </ol>
      </details>

      {estado.eventos.length > 0 && (
        <div className="overflow-x-auto">
          <h3 className="text-sm font-medium text-ink mb-2">Últimos movimientos detectados</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-ink/50">
              <tr><th className="py-1 pr-3">Cuándo</th><th className="pr-3">Tipo</th><th className="pr-3">Persona</th><th className="pr-3">Área</th><th className="pr-3">Quién</th><th></th></tr>
            </thead>
            <tbody>
              {estado.eventos.map((e) => (
                <tr key={e.id} className="border-t border-line/[0.06]">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(e.fecha_accion ?? e.detectado).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td className="pr-3"><span className={`text-xs rounded-full px-2 py-0.5 ${TIPO[e.tipo].c}`}>{TIPO[e.tipo].t}</span></td>
                  <td className="pr-3">{e.nombre}<div className="text-xs text-ink/50">{e.email}</div></td>
                  <td className="pr-3">{e.area ?? "—"}</td>
                  <td className="pr-3">{quien(e)}</td>
                  <td>{e.movimiento_id && <Link className="text-brand-600 hover:underline" href={`/empleados/movimientos/${e.movimiento_id}`}>Checklist</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
