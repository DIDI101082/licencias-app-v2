"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { hace } from "@/lib/monitoreo";

export type EstadoProg = {
  configurado: boolean; ultima_ejecucion: string | null; resultado: Record<string, any>;
  alertas_securescore: boolean; securescore_min: number; securescore_caida: number;
  alertas_correo: boolean; alertas_superficie: boolean; alertas_normativa: boolean; informe_mensual: boolean;
};

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export function useEstadoProg() {
  const [estado, setEstado] = useState<EstadoProg | null>(null);
  const [falta, setFalta] = useState(false);
  const cargar = useCallback(async () => {
    const { data, error } = await createClient().rpc("prog_estado");
    setFalta(!!error && /prog_estado/.test(error.message));
    setEstado((data as EstadoProg) ?? null);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);
  const guardar = async (p: Partial<EstadoProg>) => {
    const { error } = await createClient().rpc("prog_config_guardar", { p });
    if (!error) await cargar();
    return error?.message ?? null;
  };
  return { estado, falta, cargar, guardar };
}

// Estado de la verificación diaria (Vercel, una vez por día) y, para administradores, la clave y "Verificar ahora"
export default function TareasProgramadas({ parte, alTerminar }: { parte: "securescore" | "correo" | "superficie" | "vencimientos"; alTerminar?: () => void }) {
  const { esAdmin } = usePerfil();
  const { estado, falta, cargar } = useEstadoProg();
  const [abierto, setAbierto] = useState(false);
  const [clave, setClave] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [corriendo, setCorriendo] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  if (falta) return <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">Falta ejecutar supabase/postura.sql en Supabase.</p>;
  if (!estado) return null;

  async function generar() {
    if (estado?.configurado && !confirm("La clave actual deja de funcionar hasta que cargues la nueva en Vercel. ¿Seguir?")) return;
    const t = hex(crypto.getRandomValues(new Uint8Array(32)));
    const h = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
    const { error } = await createClient().rpc("prog_nuevo_token", { p_token_hash: h });
    if (error) return setAviso({ ok: false, texto: error.message });
    setClave(t); setCopiado(false); cargar();
  }

  async function ahora() {
    setCorriendo(true); setAviso(null);
    const r = await fetch("/api/programado", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setCorriendo(false);
    if (!r.ok) return setAviso({ ok: false, texto: j.error ?? "No se pudo ejecutar" });
    const detalle = j[parte];
    setAviso({ ok: true, texto: `Listo en ${j.duracion_s} s. ${typeof detalle === "string" ? detalle : ""}` });
    await cargar(); alTerminar?.();
  }

  const res = estado.resultado?.[parte];
  const viejo = estado.ultima_ejecucion ? Date.now() - Date.parse(estado.ultima_ejecucion) > 36 * 3600000 : true;

  return (
    <div className={`card p-3 text-sm space-y-2 ${!estado.configurado || viejo || (res && res !== "ok") ? "bg-amber-500/10" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span>
          <b>Verificación diaria:</b>{" "}
          {!estado.configurado ? "sin configurar" : estado.ultima_ejecucion ? hace(estado.ultima_ejecucion) : "todavía no corrió"}
        </span>
        {res && res !== "ok" && <span className="text-red-600">{String(res)}</span>}
        {esAdmin && (
          <span className="flex gap-2 ml-auto">
            {estado.configurado && <button className="btn-secondary" disabled={corriendo} onClick={ahora}>{corriendo ? "Verificando… (hasta 1 min)" : "Verificar ahora"}</button>}
            <button className="btn-secondary" onClick={() => setAbierto(!abierto)}>{abierto ? "Cerrar" : "Configurar"}</button>
          </span>
        )}
      </div>
      {aviso && <p role="status" className={aviso.ok ? "text-emerald-700" : "text-red-600"}>{aviso.texto}</p>}
      {abierto && esAdmin && (
        <div className="border-t border-line/[0.08] pt-3 space-y-3">
          <p className="text-ink/70">
            La app revisa todos los días (07:00) el Secure Score, el correo de los dominios, la superficie expuesta y los certificados y dominios
            públicos. Vercel la dispara con una clave: en la base queda solo su huella, nunca la clave.
          </p>
          <ol className="list-decimal pl-5 space-y-1.5 text-ink/70">
            <li>Generá la clave (se muestra una sola vez).</li>
            <li>En Vercel, <b>solo en el proyecto de Accusys Cyber</b>: Settings → Environment Variables → agregá <code>CRON_SECRET</code> con la clave, para Production.</li>
            <li>Deployments → en el último, “Redeploy”, para que tome la variable.</li>
            <li>Volvé acá y tocá “Verificar ahora” para probar.</li>
            <li>Para el Secure Score, la app de Entra que ya usan necesita además el permiso de aplicación <code>SecurityEvents.Read.All</code> (con consentimiento de administrador).</li>
          </ol>
          <button className="btn-primary" onClick={generar}>{estado.configurado ? "Generar una clave nueva" : "Generar clave"}</button>
          {clave && (
            <div className="flex flex-wrap gap-2 items-center">
              <input readOnly className="input font-mono flex-1 min-w-[16rem]" value={clave} onFocus={(e) => e.target.select()} aria-label="Clave para CRON_SECRET" />
              <button className="btn-secondary" onClick={async () => { await navigator.clipboard.writeText(clave); setCopiado(true); }}>{copiado ? "Copiada" : "Copiar"}</button>
              <span className="text-xs text-amber-700 w-full">Copiala ahora: al salir de esta pantalla no se puede volver a ver.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
