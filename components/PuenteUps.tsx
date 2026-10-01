"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteUps, generarDesinstaladorPuenteUps } from "@/lib/puente-ups";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type ConfigUps = {
  configurado: boolean; ultimo_reporte: string | null; version_puente: string | null; alertas: boolean;
  autonomia_minima: number; carga_maxima: number; temp_maxima: number; minutos_sin_reporte: number;
};

// Configuración (solo administradores): UPS a consultar, instalador del puente y alertas.
// La community SNMP NO se guarda en la app: va solo dentro del instalador.
export default function PuenteUps({ config, alCambiar }: { config: ConfigUps; alCambiar: () => void }) {
  const [nueva, setNueva] = useState({ nombre: "", ip: "", ubicacion: "" });
  const [community, setCommunity] = useState("");
  const [intervalo, setIntervalo] = useState(2);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    alertas: config.alertas, autonomia_minima: config.autonomia_minima, carga_maxima: config.carga_maxima,
    temp_maxima: config.temp_maxima, minutos_sin_reporte: config.minutos_sin_reporte,
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function agregar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    const { error } = await createClient().from("ups_equipos").insert({ nombre: nueva.nombre.trim(), ip: nueva.ip.trim(), ubicacion: nueva.ubicacion.trim() || null });
    if (error) {
      return setAviso({ ok: false, texto: error.code === "23505" ? "Ya hay una UPS con esa IP." : error.message.includes("ip") ? "La IP no es válida (ej. 192.168.1.20)." : /ups_equipos/.test(error.message) ? "Falta ejecutar supabase/ups.sql en Supabase." : error.message });
    }
    setNueva({ nombre: "", ip: "", ubicacion: "" });
    setAviso({ ok: true, texto: "UPS agregada. El puente la empieza a consultar en su próxima ejecución, sin reinstalar nada." });
    alCambiar();
  }

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    if (!community.trim()) return setAviso({ ok: false, texto: "Falta la community SNMP de solo lectura." });
    if (config.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("ups_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /ups_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/ups.sql en Supabase." : error.message });
    descargar("Instalar Puente UPS Accusys Cyber.cmd", generarPuenteUps({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, community: community.trim(), intervalo,
    }));
    setCommunity("");
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo con doble clic en un servidor que llegue a las UPS (puede ser el de PRTG)." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const { error } = await createClient().rpc("ups_config_guardar", { p: al });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. UPS a consultar</h2>
        <form onSubmit={agregar} className="grid sm:grid-cols-4 gap-3 items-end">
          <div><label className="label" htmlFor="ups-nombre">Nombre</label>
            <input id="ups-nombre" required className="input" placeholder="UPS Rack Piso 5" value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} /></div>
          <div><label className="label" htmlFor="ups-ip">IP de la placa de red</label>
            <input id="ups-ip" required className="input" placeholder="192.168.5.20" value={nueva.ip} onChange={(e) => setNueva({ ...nueva, ip: e.target.value })} /></div>
          <div><label className="label" htmlFor="ups-ubic">Ubicación (opcional)</label>
            <input id="ups-ubic" className="input" placeholder="Piso 5, Sala de servidores…" value={nueva.ubicacion} onChange={(e) => setNueva({ ...nueva, ubicacion: e.target.value })} /></div>
          <div><button className="btn-secondary w-full">Agregar UPS</button></div>
        </form>
        <p className="text-xs text-ink/50">Las UPS se desactivan o quitan desde su tarjeta, más abajo.</p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Instalar el puente</h2>
        <ol className="text-sm text-ink/70 space-y-1 list-decimal pl-5">
          <li>
            En la página web de la placa de red de cada UPS (en la Liebert ITA, la placa Intellislot SIC), habilitá <b>SNMP v2c</b> con una
            community de <b>solo lectura</b> y, si lo permite, aceptá consultas solo desde la IP del servidor del puente.
          </li>
          <li>Escribí la community y descargá el puente.</li>
          <li>Ejecutalo con doble clic en un servidor que llegue a las UPS (puede ser el mismo de PRTG). Queda como tarea programada.</li>
        </ol>
        <form onSubmit={generar} className="grid sm:grid-cols-4 gap-3 items-end">
          <div className="sm:col-span-2"><label className="label" htmlFor="ups-com">Community SNMP v2c (solo lectura)</label>
            <input id="ups-com" className="input" type="password" autoComplete="off" value={community} onChange={(e) => setCommunity(e.target.value)} /></div>
          <div><label className="label" htmlFor="ups-int">Cada</label>
            <select id="ups-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
              <option value={1}>1 minuto</option><option value={2}>2 minutos</option><option value={5}>5 minutos</option>
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
          <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente UPS Accusys Cyber.cmd", generarDesinstaladorPuenteUps())}>
            Descargar desinstalador
          </button>
        </div>
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El puente solo lee (SNMP GET) con la MIB estándar de UPS: no apaga, no prueba ni cambia nada en las UPS. La community no se guarda en
          la app: queda en una carpeta del servidor accesible únicamente para administradores.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">3. Alertas</h2>
        <p className="text-sm text-ink/60">
          Arrancan apagadas. El paso a batería y la batería baja se avisan apenas llega el reporte; el resto, en la revisión de cada 10 minutos.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas de UPS (en batería, batería baja, poca autonomía, carga y temperatura altas, bypass, alarmas y sin respuesta)
        </label>
        <div className="grid sm:grid-cols-4 gap-3 max-w-3xl">
          <label className="block text-sm">Autonomía mínima (min)
            <input type="number" min={1} max={600} className="input mt-1" value={al.autonomia_minima} onChange={(e) => setAl({ ...al, autonomia_minima: Number(e.target.value) })} /></label>
          <label className="block text-sm">Carga máxima (%)
            <input type="number" min={10} max={100} className="input mt-1" value={al.carga_maxima} onChange={(e) => setAl({ ...al, carga_maxima: Number(e.target.value) })} /></label>
          <label className="block text-sm">Temperatura máxima (°C)
            <input type="number" min={15} max={80} className="input mt-1" value={al.temp_maxima} onChange={(e) => setAl({ ...al, temp_maxima: Number(e.target.value) })} /></label>
          <label className="block text-sm">Puente sin reportar (min)
            <input type="number" min={5} max={720} className="input mt-1" value={al.minutos_sin_reporte} onChange={(e) => setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })} /></label>
        </div>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
