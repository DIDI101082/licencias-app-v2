"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteAmbiente, generarDesinstaladorPuenteAmbiente } from "@/lib/puente-ambiente";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type ConfigAmbiente = {
  configurado: boolean; ultimo_reporte: string | null; version_puente: string | null; alertas: boolean;
  temp_max: number; temp_critica: number; temp_min: number; hum_min: number; hum_max: number; minutos_sin_reporte: number;
};

// Configuración (solo administradores): sensores, instalador del puente y alertas.
// La community SNMP NO se guarda en la app: va solo dentro del instalador.
export default function PuenteAmbiente({ config, alCambiar }: { config: ConfigAmbiente; alCambiar: () => void }) {
  const [nuevo, setNuevo] = useState({ nombre: "", ip: "", ubicacion: "" });
  const [community, setCommunity] = useState("");
  const [intervalo, setIntervalo] = useState(2);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    alertas: config.alertas, temp_max: config.temp_max, temp_critica: config.temp_critica, temp_min: config.temp_min,
    hum_min: config.hum_min, hum_max: config.hum_max, minutos_sin_reporte: config.minutos_sin_reporte,
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function agregar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    const { error } = await createClient().from("amb_sensores").insert({ nombre: nuevo.nombre.trim(), ip: nuevo.ip.trim(), ubicacion: nuevo.ubicacion.trim() || null });
    if (error) {
      return setAviso({ ok: false, texto: error.message.includes("ip") ? "La IP no es válida (ej. 192.168.1.30)." : /amb_sensores/.test(error.message) ? "Falta ejecutar supabase/ambiente.sql en Supabase." : error.message });
    }
    setNuevo({ nombre: "", ip: "", ubicacion: "" });
    setAviso({ ok: true, texto: "Sensor agregado. En la próxima lectura del puente vas a poder elegir sus valores de temperatura y humedad." });
    alCambiar();
  }

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    if (!community.trim()) return setAviso({ ok: false, texto: "Falta la community SNMP de solo lectura." });
    if (config.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("amb_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /amb_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/ambiente.sql en Supabase." : error.message });
    descargar("Instalar Puente Temperatura Accusys Cyber.cmd", generarPuenteAmbiente({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, community: community.trim(), intervalo,
    }));
    setCommunity("");
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo con doble clic en un servidor que llegue al sensor (puede ser el de PRTG)." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    if (al.temp_critica <= al.temp_max) return setAvisoAl({ ok: false, texto: "La temperatura crítica tiene que ser mayor que la máxima." });
    if (al.hum_min >= al.hum_max) return setAvisoAl({ ok: false, texto: "La humedad mínima tiene que ser menor que la máxima." });
    const { error } = await createClient().rpc("amb_config_guardar", { p: al });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima lectura." });
    if (!error) alCambiar();
  }

  const num = (k: keyof typeof al, min: number, max: number, paso = 1) => (
    <input type="number" min={min} max={max} step={paso} className="input mt-1" value={al[k] as number}
      onChange={(e) => setAl({ ...al, [k]: Number(e.target.value) })} />
  );

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. Sensores</h2>
        <form onSubmit={agregar} className="grid sm:grid-cols-4 gap-3 items-end">
          <div><label className="label" htmlFor="amb-nombre">Nombre</label>
            <input id="amb-nombre" required className="input" placeholder="Sala de servidores" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></div>
          <div><label className="label" htmlFor="amb-ip">IP del sensor</label>
            <input id="amb-ip" required className="input" placeholder="192.168.5.30" value={nuevo.ip} onChange={(e) => setNuevo({ ...nuevo, ip: e.target.value })} /></div>
          <div><label className="label" htmlFor="amb-ubic">Ubicación (opcional)</label>
            <input id="amb-ubic" className="input" placeholder="Piso 5, rack 1…" value={nuevo.ubicacion} onChange={(e) => setNuevo({ ...nuevo, ubicacion: e.target.value })} /></div>
          <div><button className="btn-secondary w-full">Agregar sensor</button></div>
        </form>
        <p className="text-xs text-ink/50">
          Si el equipo tiene más de una sonda, cargalo una vez por sonda con la misma IP y elegí en cada uno sus valores.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Instalar el puente</h2>
        <ol className="text-sm text-ink/70 space-y-1 list-decimal pl-5">
          <li>En la página web del sensor (en el Xiolab Sense, en la configuración de SNMP), habilitá SNMP con una community de <b>solo lectura</b>.</li>
          <li>Escribí la community y descargá el puente. Ejecutalo con doble clic en un servidor que llegue al sensor; queda como tarea programada.</li>
          <li>Después de la primera lectura, en la tarjeta del sensor tocá <b>Elegir valores</b> e indicá cuál es la temperatura y cuál la humedad.</li>
        </ol>
        <form onSubmit={generar} className="grid sm:grid-cols-4 gap-3 items-end">
          <div className="sm:col-span-2"><label className="label" htmlFor="amb-com">Community SNMP (solo lectura)</label>
            <input id="amb-com" className="input" type="password" autoComplete="off" value={community} onChange={(e) => setCommunity(e.target.value)} /></div>
          <div><label className="label" htmlFor="amb-int">Cada</label>
            <select id="amb-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
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
          <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente Temperatura Accusys Cyber.cmd", generarDesinstaladorPuenteAmbiente())}>
            Descargar desinstalador
          </button>
        </div>
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El puente solo lee por SNMP (v2c, o v1 si el sensor no habla v2c): no cambia nada en el equipo. La community no se guarda en la app.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">3. Rangos y alertas</h2>
        <p className="text-sm text-ink/60">
          Los valores por defecto siguen la recomendación habitual para salas de servidores (18 a 27 °C). La temperatura crítica se avisa al
          instante; el resto, en la revisión de cada 10 minutos. Las alertas arrancan apagadas.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas de temperatura, humedad y sensor sin respuesta
        </label>
        <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <label className="block text-sm">Temp. mínima (°C){num("temp_min", -10, 40, 0.5)}</label>
          <label className="block text-sm">Temp. máxima (°C){num("temp_max", 10, 60, 0.5)}</label>
          <label className="block text-sm">Temp. crítica (°C){num("temp_critica", 10, 70, 0.5)}</label>
          <label className="block text-sm">Humedad mín. (%){num("hum_min", 0, 100)}</label>
          <label className="block text-sm">Humedad máx. (%){num("hum_max", 0, 100)}</label>
          <label className="block text-sm">Puente sin reportar (min){num("minutos_sin_reporte", 5, 720)}</label>
        </div>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar rangos y alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
