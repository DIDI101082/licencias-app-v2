"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteFortiGate, generarDesinstaladorPuenteFortiGate, type EquipoFortiGate } from "@/lib/puente-fortigate";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type EstadoFortiGate = {
  configurado: boolean; ultimo_reporte: string | null; version_puente: string | null; alertas: boolean; alertar_cambios: boolean;
  umbral_fallos: number; dias_aviso: number; paises_vpn: string[]; minutos_sin_reporte: number; umbral_uso?: number;
};

const vacio = (nombre = ""): EquipoFortiGate => ({ nombre, url: "", clave: "", ignorarCert: true, backup: false });

// Configuración (solo administradores): instalador del puente y alertas.
// Las claves de API de los FortiGate NO se guardan en la app: van solo dentro del instalador.
export default function PuenteFortiGate({ estado, alCambiar }: { estado: EstadoFortiGate; alCambiar: () => void }) {
  const [equipos, setEquipos] = useState<EquipoFortiGate[]>([vacio("Reconquista"), vacio("Córdoba")]);
  const [intervalo, setIntervalo] = useState(10);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    alertas: estado.alertas, alertar_cambios: estado.alertar_cambios, umbral_fallos: estado.umbral_fallos,
    dias_aviso: estado.dias_aviso, paises: estado.paises_vpn.join(", "), minutos_sin_reporte: estado.minutos_sin_reporte, umbral_uso: estado.umbral_uso ?? 85,
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  const cambiar = (i: number, c: Partial<EquipoFortiGate>) => setEquipos(equipos.map((e, j) => (j === i ? { ...e, ...c } : e)));

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    const lista = equipos.map((x) => ({ ...x, nombre: x.nombre.trim(), url: x.url.trim(), clave: x.clave.trim() })).filter((x) => x.nombre || x.url || x.clave);
    if (!lista.length) return setAviso({ ok: false, texto: "Cargá al menos un FortiGate." });
    const incompleto = lista.find((x) => !x.nombre || !x.url || !x.clave);
    if (incompleto) return setAviso({ ok: false, texto: `Falta completar nombre, dirección o clave de API${incompleto.nombre ? ` de ${incompleto.nombre}` : ""}.` });
    if (new Set(lista.map((x) => x.nombre.toLowerCase())).size !== lista.length) return setAviso({ ok: false, texto: "Hay dos FortiGate con el mismo nombre." });
    if (lista.some((x) => /^http:\/\//i.test(x.url))) return setAviso({ ok: false, texto: "Usá https:// (la clave de API no debe viajar sin cifrar)." });
    if (estado.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("fg_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /fg_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/fortigate.sql en Supabase." : error.message });
    descargar("Instalar Puente FortiGate Accusys Cyber.cmd", generarPuenteFortiGate({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, equipos: lista, intervalo,
    }));
    setEquipos(equipos.map((x) => ({ ...x, clave: "" })));
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo con doble clic en el servidor cuya IP pusiste como host de confianza en los FortiGate." });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const paises = al.paises.split(/[\s,;]+/).map((p) => p.trim().toUpperCase()).filter(Boolean);
    if (paises.some((p) => !/^[A-Z]{2}$/.test(p))) return setAvisoAl({ ok: false, texto: "Los países van con su código de 2 letras (AR, UY, ES…)." });
    const { minutos_sin_reporte, alertas, alertar_cambios, umbral_fallos, dias_aviso, umbral_uso } = al;
    const { error } = await createClient().rpc("fg_config_guardar", { p: { alertas, alertar_cambios, umbral_fallos, dias_aviso, minutos_sin_reporte, umbral_uso, paises_vpn: paises } });
    setAvisoAl(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos)." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. Crear un usuario de API de solo lectura en cada FortiGate</h2>
        <ol className="text-sm text-ink/70 space-y-1.5 list-decimal pl-5">
          <li>
            <b>System → Admin Profiles → Create New</b>, por ejemplo <code>accusys-lectura</code>: todo en <b>Read</b> (o al menos System, Security
            Profiles, Firewall, VPN, Log &amp; Report y WAN Opt &amp; Cache/Network en Read). Nada en Read/Write.
          </li>
          <li>
            <b>System → Administrators → Create New → REST API Admin</b>: usuario <code>accusys-cyber</code>, el perfil anterior y en{" "}
            <b>Trusted Hosts</b> solo la IP del servidor donde vas a instalar el puente. Al guardar, el FortiGate muestra la clave una sola vez: copiala.
          </li>
          <li>
            En los clusters HA alcanza con hacerlo en el primario (se sincroniza) y usar la IP de administración del cluster: el puente ve los dos
            miembros desde ahí.
          </li>
          <li>
            Backup para detectar cambios de configuración (opcional): FortiOS solo deja bajar la configuración a un administrador con perfil{" "}
            <b>super_admin</b>. No lo recomendamos para una clave guardada en un servidor; si igual lo querés, usá un segundo REST API Admin
            super_admin con el mismo host de confianza y marcá “Backup”. El archivo completo queda solo en el servidor del puente.
          </li>
        </ol>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Generar el puente</h2>
        <form onSubmit={generar} className="space-y-3">
          {equipos.map((x, i) => (
            <div key={i} className="grid sm:grid-cols-12 gap-3 items-end rounded-lg bg-line/[0.03] p-3">
              <div className="sm:col-span-2"><label className="label" htmlFor={`fg-n-${i}`}>Nombre</label>
                <input id={`fg-n-${i}`} className="input" placeholder="Reconquista" value={x.nombre} onChange={(e) => cambiar(i, { nombre: e.target.value })} /></div>
              <div className="sm:col-span-3"><label className="label" htmlFor={`fg-u-${i}`}>Dirección de administración</label>
                <input id={`fg-u-${i}`} className="input" placeholder="https://192.168.1.99:443" value={x.url} onChange={(e) => cambiar(i, { url: e.target.value })} /></div>
              <div className="sm:col-span-3"><label className="label" htmlFor={`fg-k-${i}`}>Clave del REST API Admin</label>
                <input id={`fg-k-${i}`} className="input" type="password" autoComplete="off" value={x.clave} onChange={(e) => cambiar(i, { clave: e.target.value })} /></div>
              <div className="sm:col-span-3 flex flex-col gap-1 text-sm pb-1">
                <label className="flex items-center gap-2" title="El FortiGate usa su certificado de fábrica: se acepta solo para esta dirección">
                  <input type="checkbox" checked={x.ignorarCert} onChange={(e) => cambiar(i, { ignorarCert: e.target.checked })} /> Certificado de fábrica
                </label>
                <label className="flex items-center gap-2" title="Requiere un REST API Admin super_admin">
                  <input type="checkbox" checked={x.backup} onChange={(e) => cambiar(i, { backup: e.target.checked })} /> Backup y cambios
                </label>
              </div>
              <div className="sm:col-span-1 text-right">
                {equipos.length > 1 && <button type="button" className="text-sm text-ink/40 hover:text-red-600" onClick={() => setEquipos(equipos.filter((_, j) => j !== i))}>Quitar</button>}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-3 items-end">
            <button type="button" className="btn-secondary" onClick={() => setEquipos([...equipos, vacio()])}>Agregar otro FortiGate</button>
            <div><label className="label" htmlFor="fg-int">Cada</label>
              <select id="fg-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
                <option value={5}>5 minutos</option><option value={10}>10 minutos</option><option value={15}>15 minutos</option>
              </select></div>
            <button className="btn-primary" disabled={generando}>{generando ? "Generando…" : confirmar ? "Sí, generar uno nuevo" : "Generar y descargar"}</button>
          </div>
          {confirmar && (
            <p className="text-sm text-amber-700">
              El puente instalado deja de funcionar hasta que instales el nuevo.{" "}
              <button type="button" className="underline" onClick={() => setConfirmar(false)}>Cancelar</button>
            </p>
          )}
        </form>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente FortiGate Accusys Cyber.cmd", generarDesinstaladorPuenteFortiGate())}>
            Descargar desinstalador
          </button>
        </div>
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El puente solo lee: no cambia nada en los FortiGate. Las claves de API no se guardan en la app: quedan en una carpeta del servidor accesible
          únicamente para administradores. Los registros de VPN, IPS y antivirus se leen del FortiAnalyzer a través de cada FortiGate (si no
          responde, del disco o la memoria del equipo). Para agregar o cambiar un FortiGate, generá el puente de nuevo con la lista completa.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">3. Alertas</h2>
        <p className="text-sm text-ink/60">Arrancan apagadas. Antes de activarlas, revisá la configuración encontrada y cargá los países desde donde se conectan por VPN.</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={al.alertas} onChange={(e) => setAl({ ...al, alertas: e.target.checked })} />
          Enviar alertas de FortiGate (sin respuesta, HA, vulnerabilidades, licencias, configuración riesgosa, fuerza bruta, VPN desde otro país,
          enlaces caídos o saturados, tráfico por el respaldo y amenazas no bloqueadas)
        </label>
        <label className="flex items-center gap-2 text-sm pl-6">
          <input type="checkbox" disabled={!al.alertas} checked={al.alertar_cambios} onChange={(e) => setAl({ ...al, alertar_cambios: e.target.checked })} />
          Avisar cada cambio de configuración (solo si el backup está activado)
        </label>
        <div className="grid sm:grid-cols-5 gap-3 max-w-5xl">
          <label className="block text-sm">Intentos fallidos de VPN por hora
            <input type="number" min={3} max={1000} className="input mt-1" value={al.umbral_fallos} onChange={(e) => setAl({ ...al, umbral_fallos: Number(e.target.value) })} /></label>
          <label className="block text-sm">Avisar vencimientos con (días)
            <input type="number" min={1} max={180} className="input mt-1" value={al.dias_aviso} onChange={(e) => setAl({ ...al, dias_aviso: Number(e.target.value) })} /></label>
          <label className="block text-sm">Países permitidos para la VPN
            <input className="input mt-1" placeholder="AR, UY" value={al.paises} onChange={(e) => setAl({ ...al, paises: e.target.value })} /></label>
          <label className="block text-sm">Enlace saturado desde (%)
            <input type="number" min={30} max={100} className="input mt-1" value={al.umbral_uso} onChange={(e) => setAl({ ...al, umbral_uso: Number(e.target.value) })} /></label>
          <label className="block text-sm">Puente sin reportar (minutos)
            <input type="number" min={5} max={720} className="input mt-1" value={al.minutos_sin_reporte} onChange={(e) => setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })} /></label>
        </div>
        <button className="btn-secondary" onClick={guardarAlertas}>Guardar alertas</button>
        {avisoAl && <p role="status" className={`text-sm ${avisoAl.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoAl.texto}</p>}
      </section>
    </div>
  );
}
