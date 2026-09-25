"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarPuente, generarDesinstaladorPuente } from "@/lib/puente-prtg";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

// Genera el instalador del puente. La clave de API de PRTG NO se guarda en la app:
// va solo dentro del archivo, que queda en una carpeta protegida del servidor de PRTG.
export default function PuentePrtg({ alTerminar }: { alTerminar: () => void }) {
  const [prtgUrl, setPrtgUrl] = useState("https://prtg.accusys.com.ar");
  const [clave, setClave] = useState("");
  const [ignorarCert, setIgnorarCert] = useState(false);
  const [intervalo, setIntervalo] = useState(2);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [generando, setGenerando] = useState(false);

  useEffect(() => {
    createClient().from("red_puente_config").select("prtg_url").eq("id", 1).maybeSingle()
      .then(({ data }) => { if (data?.prtg_url) setPrtgUrl(data.prtg_url); });
  }, []);

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    const url = prtgUrl.trim().replace(/\/$/, "");
    if (!/^https:\/\/\S+$/i.test(url)) return setAviso({ ok: false, texto: "La dirección de PRTG tiene que empezar con https://" });
    if (!clave.trim()) return setAviso({ ok: false, texto: "Falta la clave de API de PRTG." });
    if (!confirm("Se genera un puente nuevo. Si ya había uno instalado, deja de funcionar hasta que instales este. ¿Continuar?")) return;
    setGenerando(true); setAviso(null);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const { error } = await createClient().from("red_puente_config")
      .update({ token_hash: huella, prtg_url: url, creado_en: new Date().toISOString() }).eq("id", 1);
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: error.message.includes("red_puente_config") ? "Falta ejecutar red-auto.sql en Supabase." : error.message });
    descargar("Instalar Puente PRTG Accusys Cyber.cmd", generarPuente({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      token, prtgUrl: url, prtgClave: clave.trim(), ignorarCert, intervalo,
    }));
    setClave("");
    setAviso({ ok: true, texto: "Puente descargado. Ejecutalo con doble clic en el servidor de PRTG: a los 20 segundos aparece el mapa acá." });
    alTerminar();
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-medium text-ink">Conectar con PRTG</h2>
        <ol className="text-sm text-ink/70 mt-2 space-y-1 list-decimal pl-5">
          <li>
            En PRTG creá una <b>clave de API de solo lectura</b> (en la configuración de tu cuenta, sección de claves de API). Si podés, que
            sea de un usuario de PRTG de solo lectura con acceso a los grupos que querés ver.
          </li>
          <li>Completá los datos y descargá el puente.</li>
          <li>
            Copialo al <b>servidor de PRTG</b> (o a cualquier PC de la red que llegue a PRTG) y ejecutalo con doble clic. Queda funcionando
            como tarea programada.
          </li>
        </ol>
      </div>
      <form onSubmit={generar} className="grid md:grid-cols-6 gap-3 items-end">
        <div className="md:col-span-3">
          <label className="label">Dirección de PRTG</label>
          <input className="input" value={prtgUrl} onChange={(e) => setPrtgUrl(e.target.value)} required />
        </div>
        <div className="md:col-span-2">
          <label className="label">Clave de API de PRTG</label>
          <input className="input" type="password" autoComplete="off" value={clave} onChange={(e) => setClave(e.target.value)} required />
        </div>
        <div>
          <label className="label">Cada</label>
          <select className="input" value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}>
            <option value={2}>2 minutos</option><option value={5}>5 minutos</option>
          </select>
        </div>
        <label className="md:col-span-6 flex items-center gap-2 text-sm text-ink/70">
          <input type="checkbox" checked={ignorarCert} onChange={(e) => setIgnorarCert(e.target.checked)} />
          PRTG usa un certificado propio (autofirmado). Se acepta solo para PRTG; la conexión con la app se valida siempre.
        </label>
        <div className="md:col-span-6 flex gap-2 flex-wrap">
          <button className="btn-primary" disabled={generando}>{generando ? "Generando…" : "Generar y descargar puente"}</button>
          <button type="button" className="btn-secondary" onClick={() => descargar("Desinstalar Puente PRTG Accusys Cyber.cmd", generarDesinstaladorPuente())}>
            Descargar desinstalador
          </button>
        </div>
      </form>
      {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
      <p className="text-xs text-ink/50">
        La clave de PRTG no se guarda en la app: queda solo dentro del archivo, que el instalador guarda en una carpeta del servidor accesible
        únicamente para administradores. El puente se conecta hacia afuera: PRTG no necesita estar publicado en internet.
      </p>
    </div>
  );
}
