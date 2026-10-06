"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuenteDns, generarDesinstaladorPuenteDns } from "@/lib/puente-dns";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export type EstadoDns = {
  configurado: boolean; ultimo_reporte: string | null; version_puente: string | null; servidor: string | null;
  intervalo_min: number | null; avisos: string[]; dias_sin_uso: number;
};

// Configuración (solo administradores): instalador del puente para un servidor DNS y criterio de "sin uso".
export default function PuenteDns({ estado, alCambiar }: { estado: EstadoDns; alCambiar: () => void }) {
  const [intervalo, setIntervalo] = useState(60);
  const [confirmar, setConfirmar] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [dias, setDias] = useState(estado.dias_sin_uso);
  const [avisoDias, setAvisoDias] = useState<{ ok: boolean; texto: string } | null>(null);

  async function generar(e: React.FormEvent) {
    e.preventDefault(); setAviso(null);
    if (estado.configurado && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false); setGenerando(true);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().rpc("dns_nuevo_puente", { p_token_hash: huella });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: /dns_nuevo_puente/.test(error.message) ? "Falta ejecutar supabase/dns.sql en Supabase." : error.message });
    descargar("Instalar Puente DNS Accusys Cyber.cmd", generarPuenteDns({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token, intervalo,
    }));
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo como administrador en UN controlador de dominio que sea servidor DNS (alcanza con uno: las zonas son las mismas en todos)." });
    alCambiar();
  }

  async function guardarDias() {
    setAvisoDias(null);
    const { error } = await createClient().rpc("dns_config_guardar", { p: { dias_sin_uso: dias } });
    setAvisoDias(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">1. Instalar el puente en un servidor DNS</h2>
        <ol className="text-sm text-ink/70 space-y-1.5 list-decimal pl-5">
          <li>Generá el instalador y ejecutalo con doble clic, como administrador, en <b>un</b> controlador de dominio que sea servidor DNS.
            A diferencia del puente de Active Directory, acá alcanza con uno solo.</li>
          <li>Queda como tarea programada que corre como SYSTEM. Solo <b>lee</b> las zonas: no crea, cambia ni borra ningún registro.</li>
          <li>Para saber si cada IP responde hace un ping y, si no contesta, prueba conectarse a puertos comunes (445, 135, 3389, 22, 443 y 80).
            Conviene elegir un servidor que llegue a todas las redes internas; si el antivirus o el firewall avisan de un escaneo de red desde ese
            servidor, es este chequeo.</li>
        </ol>
        <form onSubmit={generar} className="flex flex-wrap gap-3 items-end">
          <div><label className="label" htmlFor="dns-int">Cada</label>
            <select id="dns-int" className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
              <option value={30}>30 minutos</option><option value={60}>1 hora</option><option value={120}>2 horas</option><option value={360}>6 horas</option>
            </select></div>
          <button className="btn-primary" disabled={generando}>{generando ? "Generando…" : confirmar ? "Sí, generar uno nuevo" : "Generar y descargar"}</button>
          <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente DNS Accusys Cyber.cmd", generarDesinstaladorPuenteDns())}>
            Descargar desinstalador
          </button>
        </form>
        {confirmar && (
          <p className="text-sm text-amber-700">
            El puente instalado deja de funcionar hasta que instales el nuevo.{" "}
            <button type="button" className="underline" onClick={() => setConfirmar(false)}>Cancelar</button>
          </p>
        )}
        {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
        <p className="text-xs text-ink/50">
          El token no se guarda en la app: queda en una carpeta del servidor accesible únicamente para administradores.
        </p>
      </section>

      <section className="space-y-3 border-t border-line/[0.06] pt-5">
        <h2 className="font-display text-lg text-ink">2. Cuándo un registro se considera sin uso</h2>
        <p className="text-sm text-ink/60 max-w-3xl">
          Un equipo apagado o de alguien que está de vacaciones no responde, pero sigue en uso. Por eso un registro pasa a &ldquo;sin uso&rdquo; recién
          cuando lleva esta cantidad de días sin ninguna señal: sin responder, sin renovarse en el DNS y sin actividad en Active Directory ni en el
          agente de inventario.
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="block text-sm">Días sin señales
            <input type="number" min={15} max={365} className="input mt-1 w-32" value={dias} onChange={(e) => setDias(Number(e.target.value))} /></label>
          <button className="btn-secondary" onClick={guardarDias}>Guardar</button>
        </div>
        {avisoDias && <p role="status" className={`text-sm ${avisoDias.ok ? "text-emerald-700" : "text-red-600"}`}>{avisoDias.texto}</p>}
      </section>
    </div>
  );
}
