"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteUnifi, generarDesinstaladorPuenteUnifi } from "@/lib/puente-unifi";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type EstadoUnifi = {
  configurado: boolean; udm_url: string | null; ultimo_reporte: string | null; version_puente: string | null;
  resumen: { equipos: number; redes: number; clientes: number; vecinas: number } | null;
  alertas: boolean; alertar_aleatorias: boolean; alertar_cableados: boolean; minutos_sin_reporte: number;
  alertar_antenas?: boolean; alertar_red_abierta?: boolean; alertar_firmware?: boolean;
};

// Configuración (solo administradores): instalador del puente y alertas.
// La clave de API de la UDM NO se guarda en la app: va solo dentro del instalador,
// que la deja en una carpeta del servidor accesible únicamente para administradores.
export default function PuenteUnifi({ estado, alCambiar }: { estado: EstadoUnifi; alCambiar: () => void }) {
  const [udmUrl, setUdmUrl] = useState(estado.udm_url ?? "https://192.168.1.1");
  const [modo, setModo] = useState<"apikey" | "usuario">("apikey");
  const [apiKey, setApiKey] = useState("");
  const [usuario, setUsuario] = useState("");
  const [clave, setClave] = useState("");
  const [ignorarCert, setIgnorarCert] = useState(true);
  const [intervalo, setIntervalo] = useState(5);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    alertas: estado.alertas, alertar_aleatorias: estado.alertar_aleatorias,
    alertar_cableados: estado.alertar_cableados, minutos_sin_reporte: estado.minutos_sin_reporte,
    alertar_antenas: estado.alertar_antenas ?? true, alertar_red_abierta: estado.alertar_red_abierta ?? true,
    alertar_firmware: estado.alertar_firmware ?? false,
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    setAviso(null);
    const url = udmUrl.trim().replace(/\/$/, "");
    if (!/^https:\/\/\S+$/i.test(url)) return setAviso({ ok: false, texto: "La dirección de la UDM tiene que empezar con https://" });
    if (modo === "apikey" && !apiKey.trim()) return setAviso({ ok: false, texto: "Falta la clave de API de la UDM." });
    if (modo === "usuario" && (!usuario.trim() || !clave)) return setAviso({ ok: false, texto: "Faltan el usuario y la contraseña local de la UDM." });
    if (estado.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false);
    setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("unifi_nuevo_puente", { p_token_hash: huella, p_udm_url: url });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /unifi_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/unifi.sql en Supabase." : error.message });
    descargar("Instalar Puente UniFi Accusys Cyber.cmd", generarPuenteUnifi({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, udmUrl: url,
      apiKey: modo === "apikey" ? apiKey.trim() : "", usuario: modo === "usuario" ? usuario.trim() : "", clave: modo === "usuario" ? clave : "",
      ignorarCert, intervalo,
    }));
    setApiKey(""); setClave("");
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo con doble clic en un servidor que llegue a la UDM: en menos de un minuto aparecen los datos acá." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const { error } = await createClient().rpc("unifi_config_guardar", { p: al });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos)." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-4">
        <div>
          <h2 className="font-display text-lg text-ink">1. Conectar la UDM Pro</h2>
          <ol className="text-sm text-ink/70 mt-2 space-y-1 list-decimal pl-5">
            <li>
              En la UDM, entrá a <b>UniFi Network → Settings → Control Plane → Integrations</b> y creá una <b>clave de API</b>. Copiala: no se
              vuelve a mostrar.
            </li>
            <li>Completá los datos y descargá el puente.</li>
            <li>
              Ejecutalo con doble clic en un <b>servidor de la red que llegue a la UDM</b> (puede ser el mismo del puente de PRTG). Queda
              funcionando como tarea programada.
            </li>
          </ol>
        </div>
        <form onSubmit={generar} className="grid md:grid-cols-6 gap-3 items-end">
          <div className="md:col-span-3">
            <label className="label" htmlFor="udm-url">Dirección de la UDM</label>
            <input id="udm-url" className="input" value={udmUrl} onChange={(e) => setUdmUrl(e.target.value)} required />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="udm-modo">Acceso</label>
            <select id="udm-modo" className="input" value={modo} onChange={(e) => setModo(e.target.value as "apikey" | "usuario")}>
              <option value="apikey">Clave de API (recomendado)</option>
              <option value="usuario">Usuario local de la UDM</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="udm-int">Cada</label>
            <select id="udm-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
              <option value={5}>5 minutos</option><option value={10}>10 minutos</option>
            </select>
          </div>
          {modo === "apikey" ? (
            <div className="md:col-span-6">
              <label className="label" htmlFor="udm-key">Clave de API</label>
              <input id="udm-key" className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
          ) : (
            <>
              <div className="md:col-span-3">
                <label className="label" htmlFor="udm-usr">Usuario local (solo lectura)</label>
                <input id="udm-usr" className="input" autoComplete="off" value={usuario} onChange={(e) => setUsuario(e.target.value)} />
              </div>
              <div className="md:col-span-3">
                <label className="label" htmlFor="udm-pass">Contraseña</label>
                <input id="udm-pass" className="input" type="password" autoComplete="off" value={clave} onChange={(e) => setClave(e.target.value)} />
              </div>
              <p className="md:col-span-6 text-xs text-ink/50">
                Usá un usuario <b>local</b> creado solo para esto, con rol de solo lectura (View Only) y sin verificación en dos pasos. Una cuenta
                de UI.com no sirve.
              </p>
            </>
          )}
          <label className="md:col-span-6 flex items-center gap-2 text-sm text-ink/70">
            <input type="checkbox" checked={ignorarCert} onChange={(e) => setIgnorarCert(e.target.checked)} />
            La UDM usa su certificado de fábrica (autofirmado). Se acepta solo para la UDM; la conexión con la app se valida siempre.
          </label>
          <div className="md:col-span-6 flex gap-2 flex-wrap items-center">
            <button className="btn-primary" disabled={generando}>
              {generando ? "Generando…" : confirmar ? "Sí, generar un puente nuevo" : "Generar y descargar puente"}
            </button>
            {confirmar && (
              <>
                <span className="text-sm text-amber-700">El puente instalado deja de funcionar hasta que instales el nuevo.</span>
                <button type="button" className="btn-secondary" onClick={() => setConfirmar(false)}>Cancelar</button>
              </>
            )}
            <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente UniFi Accusys Cyber.cmd", generarDesinstaladorPuenteUnifi())}>
              Descargar desinstalador
            </button>
          </div>
        </form>
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El puente solo lee: dispositivos UniFi, redes WiFi (nombre y tipo de seguridad; nunca la contraseña), clientes conectados y redes
          vecinas. Se conecta hacia afuera, así que la UDM no necesita estar publicada en internet.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Alertas</h2>
        <p className="text-sm text-ink/60">
          Arrancan apagadas. Antes de activarlas, revisá la lista de desconocidos y marcá como conocidos los dispositivos legítimos
          (impresoras, teléfonos IP, equipos de salas); si no, el primer aviso a Teams trae todos juntos.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas de WiFi (posibles redes falsas, antenas intrusas, dispositivos desconocidos y puente sin reportar)
        </label>
        <label className="flex items-center gap-2 text-sm pl-6">
          <input type="checkbox" disabled={!al.alertas} checked={al.alertar_aleatorias} onChange={(e) => setAl({ ...al, alertar_aleatorias: e.target.checked })} />
          Incluir dispositivos con MAC aleatoria (casi siempre celulares personales)
        </label>
        <label className="flex items-center gap-2 text-sm pl-6">
          <input type="checkbox" disabled={!al.alertas} checked={al.alertar_cableados} onChange={(e) => setAl({ ...al, alertar_cableados: e.target.checked })} />
          Incluir dispositivos desconocidos conectados por cable
        </label>
        {estado.alertar_antenas !== undefined && (
          <>
            <label className="flex items-center gap-2 text-sm pl-6">
              <input type="checkbox" disabled={!al.alertas} checked={al.alertar_antenas} onChange={(e) => setAl({ ...al, alertar_antenas: e.target.checked })} />
              Antena, switch o gateway UniFi desconectado
            </label>
            <label className="flex items-center gap-2 text-sm pl-6">
              <input type="checkbox" disabled={!al.alertas} checked={al.alertar_red_abierta} onChange={(e) => setAl({ ...al, alertar_red_abierta: e.target.checked })} />
              Red WiFi sin contraseña
            </label>
            <label className="flex items-center gap-2 text-sm pl-6">
              <input type="checkbox" disabled={!al.alertas} checked={al.alertar_firmware} onChange={(e) => setAl({ ...al, alertar_firmware: e.target.checked })} />
              Firmware con actualización disponible (aviso informativo)
            </label>
          </>
        )}
        <label className="block text-sm max-w-xs">
          Avisar si el puente no reporta en (minutos)
          <input type="number" min={5} max={720} className="input mt-1" value={al.minutos_sin_reporte}
            onChange={(e) => setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })} />
        </label>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
