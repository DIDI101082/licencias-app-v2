"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteAD, generarDesinstaladorPuenteAD } from "@/lib/puente-ad";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type EstadoAD = {
  configurado: boolean; ultimo_reporte: string | null; ultimo_inventario: string | null; version_puente: string | null;
  alertas: boolean; alertar_altas: boolean; dias_inactivo: number; umbral_fallos: number; minutos_sin_reporte: number;
};

// Configuración (solo administradores): instalador del puente para los controladores de dominio y alertas.
export default function PuenteAD({ estado, alCambiar }: { estado: EstadoAD; alCambiar: () => void }) {
  const [intervalo, setIntervalo] = useState(10);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    alertas: estado.alertas, alertar_altas: estado.alertar_altas, dias_inactivo: estado.dias_inactivo,
    umbral_fallos: estado.umbral_fallos, minutos_sin_reporte: estado.minutos_sin_reporte,
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    if (estado.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("ad_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /ad_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/ad.sql en Supabase." : error.message });
    descargar("Instalar Puente AD Accusys Cyber.cmd", generarPuenteAD({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, intervalo,
    }));
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo como administrador en los DOS controladores de dominio (el mismo archivo sirve para ambos)." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const { error } = await createClient().rpc("ad_config_guardar", { p: al });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos)." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. Instalar el puente en los controladores de dominio</h2>
        <ol className="text-sm text-ink/70 space-y-1.5 list-decimal pl-5">
          <li>Generá el instalador y ejecutalo con doble clic, como administrador, en <b>cada</b> controlador de dominio. Los eventos de seguridad
            (bloqueos, intentos fallidos, cambios de grupos) quedan en el DC que resolvió cada pedido, por eso va en los dos.</li>
          <li>Queda como tarea programada que corre como SYSTEM. Solo <b>lee</b>: no crea, cambia ni borra nada en el dominio.</li>
          <li>
            Para que haya eventos, la auditoría de los DC tiene que registrar: <i>Administración de cuentas de usuario</i> y <i>de grupos de seguridad</i>
            (correcto), <i>Validación de credenciales</i>, <i>Servicio de autenticación Kerberos</i>, <i>Inicio de sesión</i> y <i>Bloqueo de cuenta</i> (error).
            Se revisa en el DC con <code className="bg-line/[0.04] px-1 rounded">auditpol /get /category:*</code> y se configura en la GPO
            <i> Default Domain Controllers Policy → Configuración avanzada de directivas de auditoría</i>.
          </li>
        </ol>
        <form onSubmit={generar} className="flex flex-wrap gap-3 items-end">
          <div><label className="label" htmlFor="ad-int">Cada</label>
            <select id="ad-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
              <option value={5}>5 minutos</option><option value={10}>10 minutos</option><option value={15}>15 minutos</option>
            </select></div>
          <button className="btn-primary" disabled={generando}>{generando ? "Generando…" : confirmar ? "Sí, generar uno nuevo" : "Generar y descargar"}</button>
          <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente AD Accusys Cyber.cmd", generarDesinstaladorPuenteAD())}>
            Descargar desinstalador
          </button>
        </form>
        {confirmar && (
          <p className="text-sm text-amber-700">
            Los puentes instalados dejan de funcionar hasta que instales el nuevo en los dos DC.{" "}
            <button type="button" className="underline" onClick={() => setConfirmar(false)}>Cancelar</button>
          </p>
        )}
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El inventario del dominio se envía cada hora y los eventos en cada ejecución. El token no se guarda en la app: queda en una carpeta del DC
          accesible únicamente para administradores.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Alertas</h2>
        <p className="text-sm text-ink/60">Arrancan apagadas. Antes de activarlas, revisá los hallazgos y los miembros de los grupos privilegiados.</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas de Active Directory (nuevos administradores, log borrado, password spraying, fuerza bruta, bloqueos y hallazgos graves)
        </label>
        <label className="flex items-center gap-2 text-sm pl-6">
          <input type="checkbox" disabled={!al.alertas} checked={al.alertar_altas} onChange={(e) => setAl({ ...al, alertar_altas: e.target.checked })} />
          Avisar también cada usuario creado o habilitado
        </label>
        <div className="grid sm:grid-cols-3 gap-3 max-w-3xl">
          <label className="block text-sm">Cuenta inactiva después de (días)
            <input type="number" min={30} max={365} className="input mt-1" value={al.dias_inactivo} onChange={(e) => setAl({ ...al, dias_inactivo: Number(e.target.value) })} /></label>
          <label className="block text-sm">Intentos fallidos por usuario por hora
            <input type="number" min={5} max={1000} className="input mt-1" value={al.umbral_fallos} onChange={(e) => setAl({ ...al, umbral_fallos: Number(e.target.value) })} /></label>
          <label className="block text-sm">Puente sin reportar (minutos)
            <input type="number" min={10} max={720} className="input mt-1" value={al.minutos_sin_reporte} onChange={(e) => setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })} /></label>
        </div>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
