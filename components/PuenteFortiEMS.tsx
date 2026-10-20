"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteFortiEMS, generarDesinstaladorPuenteFortiEMS } from "@/lib/puente-forti-ems";

const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

export type EstadoEMS = {
  configurado: boolean;
  ultimo_reporte: string | null;
  version_puente: string | null;
  alertas: boolean;
  minutos_sin_reporte: number;
  dias_aviso: number;
  alertar_sin_ztna: boolean;
  alertar_vuln_critica: boolean;
  alertar_desconexion: boolean;
};

// Configuración (solo administradores): instalador del puente y alertas.
// Las credenciales NO se guardan en la app: van solo dentro del instalador.
export default function PuenteFortiEMS({
  estado,
  alCambiar,
}: {
  estado: EstadoEMS;
  alCambiar: () => void;
}) {
  const [emsUrl, setEmsUrl] = useState("https://forticlient.forticloud.com");
  const [accountEmail, setAccountEmail] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [intervalo, setIntervalo] = useState(10);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [al, setAl] = useState({
    alertas: estado.alertas,
    minutos_sin_reporte: estado.minutos_sin_reporte,
    dias_aviso: estado.dias_aviso,
    alertar_sin_ztna: estado.alertar_sin_ztna,
    alertar_vuln_critica: estado.alertar_vuln_critica,
    alertar_desconexion: estado.alertar_desconexion,
  });
  const [avisoAl, setAvisoAl] = useState<{ ok: boolean; texto: string } | null>(null);

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    setAviso(null);
    const url = emsUrl.trim();
    const email = accountEmail.trim();
    const key = accessKey.trim();
    if (!url || !email || !key)
      return setAviso({ ok: false, texto: "Completá la URL, el email de la cuenta y el Access Key." });
    if (!/^https:\/\//i.test(url))
      return setAviso({ ok: false, texto: "La URL debe empezar con https://." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return setAviso({ ok: false, texto: "El email no tiene un formato válido." });
    if (estado.configurado && !confirmar) {
      setConfirmar(true);
      return;
    }
    setConfirmar(false);
    setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    );
    const { error } = await createClient().rpc("ems_nuevo_puente", {
      p_token_hash: huella,
    });
    setGenerando(false);
    if (error)
      return setAviso({
        ok: false,
        texto: /ems_nuevo_puente/.test(error.message)
          ? "Falta ejecutar supabase/forti-ems.sql en Supabase."
          : error.message,
      });
    descargar(
      "Instalar Puente FortiClient EMS Cloud Accusys Cyber.cmd",
      generarPuenteFortiEMS({
        url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
        anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        token,
        emsUrl: url,
        emsEmail: email,
        emsAccessKey: key,
        intervalo,
      })
    );
    setAccessKey("");
    setAviso({
      ok: true,
      texto:
        "Puente descargado. Ejecutalo con doble clic en cualquier servidor Windows con salida a internet (el servidor PRTG ya funciona).",
    });
    alCambiar();
  }

  async function guardarAlertas() {
    setAvisoAl(null);
    const { error } = await createClient().rpc("ems_config_guardar", {
      p: {
        alertas: al.alertas,
        minutos_sin_reporte: al.minutos_sin_reporte,
        dias_aviso: al.dias_aviso,
        alertar_sin_ztna: al.alertar_sin_ztna,
        alertar_vuln_critica: al.alertar_vuln_critica,
        alertar_desconexion: al.alertar_desconexion,
      },
    });
    setAvisoAl(
      error
        ? { ok: false, texto: error.message }
        : {
            ok: true,
            texto: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos).",
          }
    );
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      {/* ── Paso 1: obtener el Access Key del EMS Cloud ── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">
          1. Obtener el Access Key del EMS Cloud
        </h2>
        <ol className="text-sm text-ink/70 space-y-1.5 list-decimal pl-5">
          <li>
            Ingresar a{" "}
            <a
              href="https://forticlient.forticloud.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              forticlient.forticloud.com
            </a>{" "}
            con la cuenta <b>master</b> (solo la cuenta master puede generar el Access Key).
          </li>
          <li>
            En la esquina inferior derecha, hacer clic en el <b>ícono de menú</b> (tres líneas
            o el avatar de cuenta).
          </li>
          <li>
            Seleccionar <b>Access Key</b> → pestaña <b>EMS API Access</b>.
          </li>
          <li>
            Hacer clic en <b>Create New Key</b> y copiar el valor generado.
          </li>
          <li>
            El puente puede correr desde cualquier servidor con acceso a internet. El servidor
            PRTG ya tiene el entorno necesario y es la opción más simple.
          </li>
        </ol>
      </section>

      {/* ── Paso 2: generar el puente ── */}
      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Generar el puente</h2>
        <form onSubmit={generar} className="space-y-3">
          <div className="grid sm:grid-cols-12 gap-3 items-end rounded-lg bg-line/[0.03] p-3">
            <div className="sm:col-span-4">
              <label className="label" htmlFor="ems-url">
                URL del EMS Cloud
              </label>
              <input
                id="ems-url"
                className="input"
                placeholder="https://forticlient.forticloud.com"
                value={emsUrl}
                onChange={(e) => setEmsUrl(e.target.value)}
              />
            </div>
            <div className="sm:col-span-4">
              <label className="label" htmlFor="ems-email">
                Email de la cuenta master
              </label>
              <input
                id="ems-email"
                className="input"
                type="email"
                placeholder="admin@tuempresa.com"
                value={accountEmail}
                onChange={(e) => setAccountEmail(e.target.value)}
              />
            </div>
            <div className="sm:col-span-4">
              <label className="label" htmlFor="ems-key">
                Access Key
              </label>
              <input
                id="ems-key"
                className="input"
                type="password"
                autoComplete="off"
                placeholder="Pegá el Access Key aquí"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="label" htmlFor="ems-int">
                Cada
              </label>
              <select
                id="ems-int"
                className="input"
                value={intervalo}
                onChange={(e) => setIntervalo(Number(e.target.value))}
              >
                <option value={5}>5 minutos</option>
                <option value={10}>10 minutos</option>
                <option value={15}>15 minutos</option>
                <option value={30}>30 minutos</option>
              </select>
            </div>
            <button className="btn-primary" disabled={generando}>
              {generando
                ? "Generando…"
                : confirmar
                ? "Sí, generar uno nuevo"
                : "Generar y descargar"}
            </button>
          </div>

          {confirmar && (
            <p className="text-sm text-amber-700">
              El puente instalado deja de funcionar hasta que instales el nuevo.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => setConfirmar(false)}
              >
                Cancelar
              </button>
            </p>
          )}
        </form>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              descargar(
                "Desinstalar Puente FortiClient EMS Cloud Accusys Cyber.cmd",
                generarDesinstaladorPuenteFortiEMS()
              )
            }
          >
            Descargar desinstalador
          </button>
        </div>

        {aviso && (
          <p
            role="status"
            className={`text-sm rounded-md px-3 py-2 ${
              aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
            }`}
          >
            {aviso.texto}
          </p>
        )}

        <p className="text-xs text-ink/50">
          El puente solo lee: no cambia nada en el EMS. Las credenciales no se guardan en la
          app: quedan en el servidor donde se instala el puente. La sesión se renueva
          automáticamente cada 25 minutos. Para cambiar las credenciales, generá el puente de
          nuevo.
        </p>
      </section>

      {/* ── Paso 3: alertas ── */}
      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">3. Alertas</h2>
        <p className="text-sm text-ink/60">
          Arrancan apagadas. Activarlas una vez que el puente esté reportando correctamente.
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={al.alertas}
            onChange={(e) => setAl({ ...al, alertas: e.target.checked })}
          />
          Enviar alertas de FortiClient EMS (puente sin reporte, endpoints offline,
          endpoints sin política, vulnerabilidades críticas, licencias por vencer)
        </label>

        <div className="pl-4 space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!al.alertas}
              checked={al.alertar_desconexion}
              onChange={(e) => setAl({ ...al, alertar_desconexion: e.target.checked })}
            />
            Alertar cuando un endpoint está offline más de 2 horas
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!al.alertas}
              checked={al.alertar_sin_ztna}
              onChange={(e) => setAl({ ...al, alertar_sin_ztna: e.target.checked })}
            />
            Alertar endpoints sin política ZTNA asignada
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!al.alertas}
              checked={al.alertar_vuln_critica}
              onChange={(e) => setAl({ ...al, alertar_vuln_critica: e.target.checked })}
            />
            Alertar vulnerabilidades críticas detectadas en las últimas 24 h
          </label>
        </div>

        <div className="grid sm:grid-cols-3 gap-3 max-w-3xl">
          <label className="block text-sm">
            Puente sin reportar (minutos)
            <input
              type="number"
              min={15}
              max={720}
              className="input mt-1"
              value={al.minutos_sin_reporte}
              onChange={(e) =>
                setAl({ ...al, minutos_sin_reporte: Number(e.target.value) })
              }
            />
          </label>
          <label className="block text-sm">
            Avisar vencimientos de licencia con (días)
            <input
              type="number"
              min={1}
              max={180}
              className="input mt-1"
              value={al.dias_aviso}
              onChange={(e) => setAl({ ...al, dias_aviso: Number(e.target.value) })}
            />
          </label>
        </div>

        <button className="btn-secondary" onClick={guardarAlertas}>
          Guardar alertas
        </button>
        {avisoAl && (
          <p
            role="status"
            className={`text-sm ${
              avisoAl.ok ? "text-emerald-700" : "text-red-600"
            }`}
          >
            {avisoAl.texto}
          </p>
        )}
      </section>
    </div>
  );
}
