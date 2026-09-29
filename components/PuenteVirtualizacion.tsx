"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteVirtualizacion, generarDesinstaladorPuenteVirtualizacion } from "@/lib/puente-virtualizacion";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type EstadoVirt = {
  configurado: boolean; ultimo_reporte: string | null; version_puente: string | null; error_vcenter: string | null; error_storage: string | null;
  avisos: string[]; alertas: boolean; pct_lleno: number; dias_snapshot: number; dias_aviso: number; minutos_sin_reporte: number;
};

// Configuración (solo administradores): instalador del puente (vCenter + storage) y alertas.
// Las claves NO se guardan en la app: van solo dentro del instalador.
export default function PuenteVirtualizacion({ estado, alCambiar }: { estado: EstadoVirt; alCambiar: () => void }) {
  const [f, setF] = useState({ vcenter: "", vcUsuario: "", vcClave: "", stoUrl: "", stoUsuario: "", stoClave: "", ignorarCert: true, intervalo: 15 });
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({ alertas: estado.alertas, pct_lleno: estado.pct_lleno, dias_snapshot: estado.dias_snapshot, dias_aviso: estado.dias_aviso, minutos_sin_reporte: estado.minutos_sin_reporte });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    const conVc = !!f.vcenter.trim(), conSto = !!f.stoUrl.trim();
    if (!conVc && !conSto) return setAviso({ ok: false, texto: "Completá vCenter, el storage o los dos." });
    if (conVc && (!f.vcUsuario.trim() || !f.vcClave)) return setAviso({ ok: false, texto: "Falta el usuario o la clave de vCenter." });
    if (conSto && (!f.stoUsuario.trim() || !f.stoClave)) return setAviso({ ok: false, texto: "Falta el usuario o la clave del storage." });
    if (estado.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("virt_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /virt_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/virtualizacion.sql en Supabase." : error.message });
    descargar("Instalar Puente Virtualizacion Accusys Cyber.cmd", generarPuenteVirtualizacion({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, ...f,
    }));
    setF({ ...f, vcClave: "", stoClave: "" });
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo como administrador en un servidor que llegue a vCenter (443) y al storage (7443)." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const { error } = await createClient().rpc("virt_config_guardar", { p: al });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos)." });
    if (!error) alCambiar();
  }

  const campo = (k: keyof typeof f, label: string, ph = "", tipo = "text") => (
    <label className="block text-sm">{label}
      <input className="input mt-1" type={tipo} autoComplete="off" placeholder={ph} value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. Crear usuarios de solo lectura</h2>
        <ol className="text-sm text-ink/70 space-y-1.5 list-decimal pl-5">
          <li><b>vCenter:</b> creá un usuario (por ejemplo <code>svc-accusys@vsphere.local</code> o uno del dominio) y en <b>Administración → Permisos globales</b>
            asignale el rol <b>Solo lectura</b> (Read-only) con “Propagar a los hijos”. Para ver las licencias hace falta además el privilegio
            <i> Global → Licencias</i>; sin él, esa parte queda vacía.</li>
          <li><b>Storage IBM:</b> en <b>Acceso → Usuarios</b> creá un usuario en el grupo <b>Monitor</b>. La API REST usa el puerto 7443 (código 8.1.3 o posterior).</li>
          <li>El servidor del puente necesita PowerCLI: el instalador lo baja solo de la PowerShell Gallery la primera vez (requiere salida a Internet).</li>
        </ol>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Generar el puente</h2>
        <form onSubmit={generar} className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-3">
            {campo("vcenter", "vCenter (nombre o IP)", "vcenter.accusys.local")}
            {campo("vcUsuario", "Usuario de vCenter", "svc-accusys@vsphere.local")}
            {campo("vcClave", "Clave de vCenter", "", "password")}
            {campo("stoUrl", "Storage (IP de administración)", "192.168.1.50")}
            {campo("stoUsuario", "Usuario del storage (Monitor)", "monitor-accusys")}
            {campo("stoClave", "Clave del storage", "", "password")}
          </div>
          <div className="flex flex-wrap gap-4 items-end">
            <label className="flex items-center gap-2 text-sm pb-2">
              <input type="checkbox" checked={f.ignorarCert} onChange={(e) => setF({ ...f, ignorarCert: e.target.checked })} />
              Usan certificados de fábrica (se aceptan solo para estas dos direcciones)
            </label>
            <label className="block text-sm">Cada
              <select className="input mt-1" value={f.intervalo} onChange={(e) => setF({ ...f, intervalo: Number(e.target.value) })}>
                <option value={10}>10 minutos</option><option value={15}>15 minutos</option><option value={30}>30 minutos</option>
              </select>
            </label>
            <button className="btn-primary" disabled={generando}>{generando ? "Generando…" : confirmar ? "Sí, generar uno nuevo" : "Generar y descargar"}</button>
            <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente Virtualizacion Accusys Cyber.cmd", generarDesinstaladorPuenteVirtualizacion())}>
              Descargar desinstalador
            </button>
          </div>
          {confirmar && (
            <p className="text-sm text-amber-700">El puente instalado deja de funcionar hasta que instales el nuevo.{" "}
              <button type="button" className="underline" onClick={() => setConfirmar(false)}>Cancelar</button></p>
          )}
        </form>
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">El puente solo lee: no enciende, apaga ni cambia nada. Las claves no se guardan en la app: quedan en una carpeta del servidor accesible únicamente para administradores.</p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">3. Alertas</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas (hosts caídos, hardware, SSH, vulnerabilidades explotadas, datastores y pools llenos, snapshots viejos, discos y componentes del storage)
        </label>
        <div className="grid sm:grid-cols-4 gap-3 max-w-4xl">
          <label className="block text-sm">Lleno desde (%)
            <input type="number" min={50} max={99} className="input mt-1" value={al.pct_lleno} onChange={(e) => setAl({ ...al, pct_lleno: Number(e.target.value) })} /></label>
          <label className="block text-sm">Snapshot viejo después de (días)
            <input type="number" min={1} max={90} className="input mt-1" value={al.dias_snapshot} onChange={(e) => setAl({ ...al, dias_snapshot: Number(e.target.value) })} /></label>
          <label className="block text-sm">Avisar vencimientos con (días)
            <input type="number" min={1} max={180} className="input mt-1" value={al.dias_aviso} onChange={(e) => setAl({ ...al, dias_aviso: Number(e.target.value) })} /></label>
          <label className="block text-sm">Puente sin reportar (minutos)
            <input type="number" min={10} max={720} className="input mt-1" value={al.minutos_sin_reporte} onChange={(e) => setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })} /></label>
        </div>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
