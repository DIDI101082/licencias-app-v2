"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteSwitches, generarDesinstaladorPuenteSwitches } from "@/lib/puente-switches";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type EstadoSwitches = {
  configurado: boolean; ultimo_reporte: string | null; version_puente: string | null; alertas: boolean;
  alertar_desconocidos: boolean; umbral_uso: number; umbral_errores: number; minutos_sin_reporte: number;
};

// Configuración (solo administradores): switches a consultar, instalador del puente y alertas.
// La community SNMP NO se guarda en la app: va solo dentro del instalador.
export default function PuenteSwitches({ estado, alCambiar }: { estado: EstadoSwitches; alCambiar: () => void }) {
  const [nuevo, setNuevo] = useState({ nombre: "", ip: "", zona: "" });
  const [community, setCommunity] = useState("");
  const [intervalo, setIntervalo] = useState(5);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    alertas: estado.alertas, alertar_desconocidos: estado.alertar_desconocidos, umbral_uso: estado.umbral_uso,
    umbral_errores: estado.umbral_errores, minutos_sin_reporte: estado.minutos_sin_reporte,
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function agregar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    const { error } = await createClient().from("sw_switches").insert({ nombre: nuevo.nombre.trim(), ip: nuevo.ip.trim(), zona: nuevo.zona.trim() || null });
    if (error) {
      return setAviso({ ok: false, texto: error.code === "23505" ? "Ya hay un switch con esa IP." : error.message.includes("ip") ? "La IP no es válida (ej. 192.168.1.10)." : error.message });
    }
    setNuevo({ nombre: "", ip: "", zona: "" });
    setAviso({ ok: true, texto: "Switch agregado. El puente lo empieza a consultar en su próxima ejecución, sin reinstalar nada." });
    alCambiar();
  }

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    if (!community.trim()) return setAviso({ ok: false, texto: "Falta la community SNMP de solo lectura." });
    if (estado.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("sw_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /sw_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/switches.sql en Supabase." : error.message });
    descargar("Instalar Puente Switches Accusys Cyber.cmd", generarPuenteSwitches({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, community: community.trim(), intervalo,
    }));
    setCommunity("");
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo con doble clic en un servidor que llegue a los switches por SNMP (puerto UDP 161)." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const { error } = await createClient().rpc("sw_config_guardar", { p: al });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos)." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. Switches a consultar</h2>
        <form onSubmit={agregar} className="grid sm:grid-cols-4 gap-3 items-end">
          <div><label className="label" htmlFor="sw-nombre">Nombre</label>
            <input id="sw-nombre" required className="input" placeholder="Core piso 5" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></div>
          <div><label className="label" htmlFor="sw-ip">IP de administración</label>
            <input id="sw-ip" required className="input" placeholder="192.168.5.2" value={nuevo.ip} onChange={(e) => setNuevo({ ...nuevo, ip: e.target.value })} /></div>
          <div><label className="label" htmlFor="sw-zona">Zona (opcional)</label>
            <input id="sw-zona" className="input" placeholder="Piso 5, Rack, Córdoba…" value={nuevo.zona} onChange={(e) => setNuevo({ ...nuevo, zona: e.target.value })} /></div>
          <div><button className="btn-secondary w-full">Agregar switch</button></div>
        </form>
        <p className="text-xs text-ink/50">Los switches se editan, desactivan o quitan desde la lista de abajo.</p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Instalar el puente</h2>
        <ol className="text-sm text-ink/70 space-y-1 list-decimal pl-5">
          <li>
            En cada switch, la community tiene que ser de <b>solo lectura</b> y, si el equipo lo permite, aceptar consultas solo desde la IP del
            servidor del puente (ACL).
          </li>
          <li>Escribí la community y descargá el puente.</li>
          <li>Ejecutalo con doble clic en un servidor que llegue a los switches (puede ser el mismo de PRTG o UniFi). Queda como tarea programada.</li>
        </ol>
        <form onSubmit={generar} className="grid sm:grid-cols-4 gap-3 items-end">
          <div className="sm:col-span-2"><label className="label" htmlFor="sw-com">Community SNMP v2c (solo lectura)</label>
            <input id="sw-com" className="input" type="password" autoComplete="off" value={community} onChange={(e) => setCommunity(e.target.value)} /></div>
          <div><label className="label" htmlFor="sw-int">Cada</label>
            <select id="sw-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
              <option value={5}>5 minutos</option><option value={10}>10 minutos</option>
            </select></div>
          <div><button className="btn-primary w-full" disabled={generando}>{generando ? "Generando…" : confirmar ? "Sí, generar uno nuevo" : "Generar y descargar"}</button></div>
          {confirmar && (
            <p className="sm:col-span-4 text-sm text-amber-700">
              El puente instalado deja de funcionar hasta que instales el nuevo.{" "}
              <button type="button" className="underline" onClick={() => setConfirmar(false)}>Cancelar</button>
            </p>
          )}
        </form>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente Switches Accusys Cyber.cmd", generarDesinstaladorPuenteSwitches())}>
            Descargar desinstalador
          </button>
        </div>
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El puente solo lee (SNMP GET): no cambia nada en los switches. La community no se guarda en la app: queda en una carpeta del servidor
          accesible únicamente para administradores.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">3. Alertas</h2>
        <p className="text-sm text-ink/60">
          Arrancan apagadas. Antes de activarlas, revisá que los enlaces troncales estén bien marcados en el detalle de cada switch.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas de switches (sin respuesta, reinicio, troncal caído, puerto inestable, errores, saturación y PoE)
        </label>
        <label className="flex items-center gap-2 text-sm pl-6">
          <input type="checkbox" disabled={!al.alertas} checked={al.alertar_desconocidos} onChange={(e) => setAl({ ...al, alertar_desconocidos: e.target.checked })} />
          Incluir dispositivos desconocidos conectados por cable
        </label>
        <div className="grid sm:grid-cols-3 gap-3 max-w-2xl">
          <label className="block text-sm">Puerto saturado desde (%)
            <input type="number" min={10} max={100} className="input mt-1" value={al.umbral_uso} onChange={(e) => setAl({ ...al, umbral_uso: Number(e.target.value) })} /></label>
          <label className="block text-sm">Errores por intervalo desde
            <input type="number" min={1} className="input mt-1" value={al.umbral_errores} onChange={(e) => setAl({ ...al, umbral_errores: Number(e.target.value) })} /></label>
          <label className="block text-sm">Puente sin reportar (minutos)
            <input type="number" min={5} max={720} className="input mt-1" value={al.minutos_sin_reporte} onChange={(e) => setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })} /></label>
        </div>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
