"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteGrupo, generarDesinstaladorPuenteGrupo } from "@/lib/puente-grupo";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type ConfigGrupo = {
  configurado: boolean; nombre: string; ultimo_reporte: string | null; version_puente: string | null; ip: string | null;
  alertas: boolean; alertar_en_marcha: boolean; combustible_minimo: number; bateria_minima: number;
  minutos_sin_reporte: number; litros_tanque: number | null;
};

// Configuración (solo administradores): instalador del puente y alertas del grupo electrógeno.
export default function PuenteGrupo({ config, alCambiar }: { config: ConfigGrupo; alCambiar: () => void }) {
  const [ip, setIp] = useState(config.ip ?? "");
  const [puerto, setPuerto] = useState(502);
  const [unidad, setUnidad] = useState("");
  const [intervalo, setIntervalo] = useState(2);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    nombre: config.nombre, alertas: config.alertas, alertar_en_marcha: config.alertar_en_marcha,
    combustible_minimo: config.combustible_minimo, bateria_minima: config.bateria_minima,
    minutos_sin_reporte: config.minutos_sin_reporte, litros_tanque: config.litros_tanque?.toString() ?? "",
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    if (!/^[A-Za-z0-9.\-]+$/.test(ip.trim())) return setAviso({ ok: false, texto: "La IP del DSE855 no es válida (ej. 192.168.1.50)." });
    if (unidad.trim() && !/^\d{1,3}$/.test(unidad.trim())) return setAviso({ ok: false, texto: "El número de unidad Modbus va de 0 a 255, o dejalo vacío." });
    if (config.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("ge_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /ge_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/grupo-electrogeno.sql en Supabase." : error.message });
    descargar("Instalar Puente Grupo Electrogeno Accusys Cyber.cmd", generarPuenteGrupo({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token,
      ip: ip.trim(), puerto, unidad: unidad.trim() ? Number(unidad) : null, intervalo,
    }));
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo con doble clic en un servidor que llegue al DSE855 (puede ser el de PRTG)." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const { error } = await createClient().rpc("ge_config_guardar", { p: al });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. Preparar el DSE855</h2>
        <ol className="text-sm text-ink/70 space-y-1 list-decimal pl-5">
          <li>En la página web del DSE855, en <b>Configuration</b>, verificá que <b>Modbus TCP</b> esté habilitado y anotá el puerto (normalmente 502).</li>
          <li>
            Modbus TCP no tiene usuario ni contraseña y permite comandos (arrancar o parar el grupo). En el FortiGate, dejá el puerto accesible
            <b> solo desde el servidor del puente</b>.
          </li>
          <li>Si podés, cambiá la contraseña por defecto del usuario Admin de la página web.</li>
        </ol>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Instalar el puente</h2>
        <form onSubmit={generar} className="grid sm:grid-cols-5 gap-3 items-end">
          <div className="sm:col-span-2"><label className="label" htmlFor="ge-ip">IP del DSE855</label>
            <input id="ge-ip" required className="input" placeholder="192.168.1.50" value={ip} onChange={(e) => setIp(e.target.value)} /></div>
          <div><label className="label" htmlFor="ge-puerto">Puerto</label>
            <input id="ge-puerto" type="number" min={1} max={65535} className="input" value={puerto} onChange={(e) => setPuerto(Number(e.target.value) || 502)} /></div>
          <div><label className="label" htmlFor="ge-unidad">Unidad Modbus</label>
            <input id="ge-unidad" className="input" placeholder="Automático" value={unidad} onChange={(e) => setUnidad(e.target.value)} /></div>
          <div><label className="label" htmlFor="ge-int">Cada</label>
            <select id="ge-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
              <option value={1}>1 minuto</option><option value={2}>2 minutos</option><option value={5}>5 minutos</option>
            </select></div>
          <div className="sm:col-span-5 flex flex-wrap gap-2">
            <button className="btn-primary" disabled={generando}>{generando ? "Generando…" : confirmar ? "Sí, generar uno nuevo" : "Generar y descargar"}</button>
            <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente Grupo Electrogeno Accusys Cyber.cmd", generarDesinstaladorPuenteGrupo())}>
              Descargar desinstalador
            </button>
          </div>
          {confirmar && (
            <p className="sm:col-span-5 text-sm text-amber-700">
              El puente instalado deja de funcionar hasta que instales el nuevo.{" "}
              <button type="button" className="underline" onClick={() => setConfirmar(false)}>Cancelar</button>
            </p>
          )}
        </form>
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El puente solo lee (función Modbus 03): nunca arranca, para ni cambia nada en el grupo. Al instalarlo muestra los valores leídos para
          compararlos con la página web del DSE855. Si dejás la unidad Modbus vacía, prueba sola las habituales de Deep Sea.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">3. Alertas</h2>
        <p className="text-sm text-ink/60">
          Arrancan apagadas. El corte de luz y el arranque del grupo se avisan apenas llega el reporte; el resto, en la revisión de cada 10 minutos.
        </p>
        <div className="grid sm:grid-cols-2 gap-3 max-w-2xl">
          <label className="block text-sm">Nombre del equipo
            <input className="input mt-1" value={al.nombre} onChange={(e) => setAl({ ...al, nombre: e.target.value })} /></label>
          <label className="block text-sm">Capacidad del tanque (litros, opcional)
            <input type="number" min={1} className="input mt-1" value={al.litros_tanque} onChange={(e) => setAl({ ...al, litros_tanque: e.target.value })} /></label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas: corte de luz, grupo fuera de automático, combustible bajo, batería baja y grupo sin respuesta
        </label>
        <label className="flex items-center gap-2 text-sm pl-6">
          <input type="checkbox" disabled={!al.alertas} checked={al.alertar_en_marcha} onChange={(e) => setAl({ ...al, alertar_en_marcha: e.target.checked })} />
          Avisar también cuando el grupo funciona con red presente (pruebas o arranque manual)
        </label>
        <div className="grid sm:grid-cols-3 gap-3 max-w-2xl">
          <label className="block text-sm">Combustible mínimo (%)
            <input type="number" min={5} max={95} className="input mt-1" value={al.combustible_minimo} onChange={(e) => setAl({ ...al, combustible_minimo: Number(e.target.value) })} /></label>
          <label className="block text-sm">Batería mínima (V)
            <input type="number" min={5} max={30} step={0.1} className="input mt-1" value={al.bateria_minima} onChange={(e) => setAl({ ...al, bateria_minima: Number(e.target.value) })} /></label>
          <label className="block text-sm">Puente sin reportar (minutos)
            <input type="number" min={5} max={720} className="input mt-1" value={al.minutos_sin_reporte} onChange={(e) => setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })} /></label>
        </div>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
