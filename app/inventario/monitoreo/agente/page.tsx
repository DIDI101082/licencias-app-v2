"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { generarInstalador, generarDesinstalador, generarInstaladorCmd, generarDesinstaladorCmd, descargar } from "@/lib/agente";

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

  function bajarInstalador(formato: "cmd" | "ps1") {
    if (!config) return;
    const args = [process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, config.token, config.intervalo_min] as const;
    if (formato === "cmd") descargar("Instalar Agente Accusys Cyber.cmd", generarInstaladorCmd(...args));
    else descargar("instalar-agente-accusys.ps1", generarInstalador(...args));
  }

  const [copiado, setCopiado] = useState(false);
  const mensaje = `Hola! Para instalar el agente de inventario de IT en tu equipo:

1. Guardá el archivo adjunto "Instalar Agente Accusys Cyber.cmd" (por ejemplo, en el Escritorio).
2. Hacé doble clic sobre el archivo.
3. Si aparece "Windows protegió su PC", tocá "Más información" y después "Ejecutar de todas formas".
4. Cuando Windows pregunte si permitís que la aplicación haga cambios, tocá "Sí".
5. Esperá unos 20 segundos: al final tiene que decir "Agente instalado" y una línea que empieza con "OK". Presioná una tecla para cerrar.

El agente solo informa datos técnicos del equipo (modelo, sistema, disco, seguridad). No lee archivos, correos ni lo que hacés en la PC.
Si ves algún error, sacale una captura y mandámela. Gracias!`;

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
        <p className="text-sm text-ink/60">
          Es un solo archivo que se abre con <b>doble clic</b>: pide permisos de administrador, instala el agente y muestra el resultado.
          Ya viene configurado con la dirección de esta app y el token de tu empresa. Sirve para instalar y para actualizar.
        </p>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary" onClick={() => bajarInstalador("cmd")} disabled={!config}>Descargar instalador (doble clic)</button>
          <button className="btn-secondary" onClick={() => descargar("Desinstalar Agente Accusys Cyber.cmd", generarDesinstaladorCmd())}>
            Descargar desinstalador
          </button>
        </div>
        <details className="text-sm">
          <summary className="text-brand-600 cursor-pointer">Versión PowerShell (.ps1) para Intune, GPO o ESET PROTECT</summary>
          <div className="mt-2 space-y-2 text-ink/70">
            <p>Para distribución masiva conviene el script sin el lanzador. Se ejecuta como SYSTEM o administrador:</p>
            <pre className="bg-ink text-white text-xs rounded-lg p-3 overflow-x-auto">powershell -ExecutionPolicy Bypass -File instalar-agente-accusys.ps1</pre>
            <div className="flex gap-2 flex-wrap">
              <button className="btn-secondary" onClick={() => bajarInstalador("ps1")} disabled={!config}>Descargar .ps1</button>
              <button className="btn-secondary" onClick={() => descargar("desinstalar-agente-accusys.ps1", generarDesinstalador())}>Desinstalador .ps1</button>
            </div>
          </div>
        </details>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium text-ink">2. Pasáselo a la persona</h2>
        <p className="text-sm text-ink/60">
          Mandale el archivo por Teams o por correo interno junto con este mensaje. Necesita ser administrador de su PC; si no lo es,
          alguien de IT tiene que poner la contraseña de administrador cuando Windows la pida.
        </p>
        <pre className="bg-black/[0.03] text-ink/80 text-xs rounded-lg p-3 whitespace-pre-wrap">{mensaje}</pre>
        <button className="btn-secondary" onClick={async () => { await navigator.clipboard.writeText(mensaje); setCopiado(true); setTimeout(() => setCopiado(false), 2000); }}>
          {copiado ? "¡Copiado!" : "Copiar mensaje"}
        </button>
        <p className="text-xs text-ink/50">
          El archivo contiene el token de registro de la empresa: no lo publiques en lugares abiertos. Igual, un equipo que se registre
          con él queda <b>pendiente</b> hasta que lo apruebes en Monitoreo.
        </p>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium text-ink">3. Para muchos equipos a la vez</h2>
        <ul className="text-sm text-ink/70 space-y-2 list-disc pl-5">
          <li><b>Intune:</b> Dispositivos → Scripts y correcciones → Scripts de plataforma → Agregar (Windows). Subí el instalador y marcá que se ejecute como sistema, no como el usuario que inició sesión.</li>
          <li><b>GPO:</b> Configuración del equipo → Directivas → Configuración de Windows → Scripts → Inicio → pestaña Scripts de PowerShell, agregando el instalador desde una carpeta compartida.</li>
          <li><b>ESET PROTECT:</b> Tareas de cliente → Ejecutar comando, en los equipos elegidos, con{" "}
            <code className="text-xs">powershell -ExecutionPolicy Bypass -File \\servidor\carpeta\instalar-agente-accusys.ps1</code>{" "}
            (el .ps1 en una carpeta compartida a la que lleguen los equipos). Corre como SYSTEM.</li>
          <li><b>A mano:</b> con el instalador de doble clic, como en los pasos 1 y 2.</li>
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
