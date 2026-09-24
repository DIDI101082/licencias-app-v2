"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { generarInstalador, generarDesinstalador, descargar } from "@/lib/agente";

export default function ConfigAgente() {
  const { esAdmin } = usePerfil();
  const [config, setConfig] = useState<{ token: string; intervalo_min: number; dominios_autoaprobados: string[] } | null>(null);
  const [nuevoDominio, setNuevoDominio] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cargar = () =>
    createClient().from("inv_agente_config").select("token, intervalo_min, dominios_autoaprobados").eq("id", 1).single()
      .then(({ data, error }) => {
        if (error) setError("No se encontró la configuración del agente. ¿Ejecutaste monitoreo.sql en Supabase?");
        setConfig(data);
      });
  useEffect(() => { if (esAdmin) cargar(); }, [esAdmin]);

  async function regenerar() {
    if (!confirm("Los agentes ya instalados van a dejar de reportar hasta que los reinstales con el instalador nuevo. ¿Generar un token nuevo?")) return;
    const nuevo = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const { error } = await createClient().from("inv_agente_config").update({ token: nuevo }).eq("id", 1);
    if (error) return setError(error.message);
    cargar();
  }

  async function guardarDominios(lista: string[]) {
    setError(null);
    const { error } = await createClient().from("inv_agente_config").update({ dominios_autoaprobados: lista }).eq("id", 1);
    if (error) return setError(error.message);
    cargar();
  }

  function bajarInstalador() {
    if (!config) return;
    descargar(
      "instalar-agente-accusys.ps1",
      generarInstalador(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, config.token, config.intervalo_min)
    );
  }

  if (!esAdmin) {
    return <div className="card p-6 max-w-md text-sm text-ink/60">Esta sección es solo para administradores.</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/inventario/monitoreo" className="text-sm text-brand-600 hover:underline">← Volver a Monitoreo</Link>
        <h1 className="font-display text-2xl text-ink mt-2">Instalar el agente</h1>
        <p className="text-ink/60 text-sm mt-1">
          El agente es un script de PowerShell que corre como tarea programada de Windows cada {config?.intervalo_min ?? 5} minutos
          y envía los datos del equipo a esta app. No abre puertos ni queda residente: solo necesita salida a internet por HTTPS.
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div className="card p-5 space-y-3">
        <h2 className="font-medium text-ink">1. Descargá el instalador</h2>
        <p className="text-sm text-ink/60">Ya viene configurado con la dirección de esta app y el token de tu empresa.</p>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary" onClick={bajarInstalador} disabled={!config}>Descargar instalador</button>
          <button className="btn-secondary" onClick={() => descargar("desinstalar-agente-accusys.ps1", generarDesinstalador())}>
            Descargar desinstalador
          </button>
        </div>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium text-ink">2. Instalalo en una PC para probar</h2>
        <p className="text-sm text-ink/60">Abrí PowerShell como administrador en la carpeta donde lo descargaste y ejecutá:</p>
        <pre className="bg-ink text-white text-sm rounded-lg p-4 overflow-x-auto">powershell -ExecutionPolicy Bypass -File .\instalar-agente-accusys.ps1</pre>
        <p className="text-sm text-ink/60">
          A los 15 segundos te muestra el resultado del primer reporte y el equipo aparece en Monitoreo.
          Si dice ERROR, el mensaje indica el motivo (por ejemplo, que el firewall bloquea la salida a supabase.co).
        </p>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium text-ink">3. Distribuilo a todos los equipos</h2>
        <ul className="text-sm text-ink/70 space-y-2 list-disc pl-5">
          <li><b>Intune:</b> Dispositivos → Scripts y correcciones → Scripts de plataforma → Agregar (Windows). Subí el instalador y marcá que se ejecute como sistema, no como el usuario que inició sesión.</li>
          <li><b>GPO:</b> Configuración del equipo → Directivas → Configuración de Windows → Scripts → Inicio → pestaña Scripts de PowerShell, agregando el instalador desde una carpeta compartida.</li>
          <li><b>A mano:</b> en cada equipo, igual que en el paso 2.</li>
        </ul>
        <p className="text-sm text-ink/60">Reinstalar encima no duplica nada: cada equipo se identifica por su ID de hardware.</p>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium text-ink">Cómo se protege el registro de equipos</h2>
        <ul className="text-sm text-ink/70 space-y-1.5 list-disc pl-5">
          <li><b>Aprobación:</b> todo equipo nuevo queda pendiente en Monitoreo. No aparece en ninguna pantalla ni guarda datos hasta que lo apruebes.</li>
          <li><b>Clave por equipo:</b> en el primer reporte cada equipo recibe una clave propia. Sin ella no puede reportar, así nadie puede hacerse pasar por otro equipo.</li>
          <li><b>Carpeta protegida:</b> el instalador deja <code className="text-xs">C:\ProgramData\AccusysAgente</code> accesible solo para SYSTEM y Administradores, para que un usuario común no pueda copiar el token.</li>
          <li><b>Rastro:</b> se guarda la IP pública desde la que se registró y reporta cada equipo.</li>
        </ul>
      </div>

      <div className="card p-5 space-y-3">
        <div>
          <h2 className="font-medium text-ink">Dominios aprobados automáticamente (opcional)</h2>
          <p className="text-sm text-ink/60 mt-1">
            Los equipos unidos a estos dominios se aprueban solos al registrarse. Si lo dejás vacío, todos los equipos requieren tu aprobación,
            que es la opción más segura. Podés escribir el nombre corto (por ejemplo <code className="text-xs">ACCUSYSARGBSAS</code>) o el completo.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(config?.dominios_autoaprobados ?? []).length === 0 && <span className="text-sm text-ink/50">Ninguno: todos los equipos se aprueban a mano.</span>}
          {(config?.dominios_autoaprobados ?? []).map((d) => (
            <span key={d} className="pill bg-black/[0.05] text-ink/80 flex items-center gap-1.5">
              {d}
              <button aria-label={`Quitar ${d}`} className="text-ink/40 hover:text-red-600"
                onClick={() => guardarDominios((config?.dominios_autoaprobados ?? []).filter((x) => x !== d))}>×</button>
            </span>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          const v = nuevoDominio.trim().toUpperCase();
          if (v) { guardarDominios([...(config?.dominios_autoaprobados ?? []), v]); setNuevoDominio(""); }
        }}>
          <input className="input flex-1" placeholder="Nombre del dominio" value={nuevoDominio} onChange={(e) => setNuevoDominio(e.target.value)} />
          <button className="btn-secondary" disabled={!config}>Agregar</button>
        </form>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium text-ink">Token del agente</h2>
        <p className="text-sm text-ink/60">
          Es la clave que usan los agentes para reportar. Si se filtra, generá uno nuevo y volvé a distribuir el instalador.
        </p>
        <code className="block bg-black/[0.04] rounded-md px-3 py-2 text-xs break-all">{config?.token ?? "…"}</code>
        <button className="btn-secondary" onClick={regenerar} disabled={!config}>Generar token nuevo</button>
      </div>
    </div>
  );
}
