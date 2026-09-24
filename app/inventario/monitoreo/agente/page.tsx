"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { generarDesinstalador, generarDesinstaladorCmd, descargar } from "@/lib/agente";
import CodigosInstalacion from "@/components/CodigosInstalacion";
import { generarDesinstaladorLinux } from "@/lib/agente-linux";

export default function ConfigAgente() {
  const { esAdmin } = usePerfil();
  const [config, setConfig] = useState<{ token: string; intervalo_min: number; dominios_autoaprobados: string[]; permitir_token_general?: boolean } | null>(null);
  const [nuevoDominio, setNuevoDominio] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cargar = () =>
    createClient().from("inv_agente_config").select("*").eq("id", 1).single()
      .then(({ data, error }) => {
        if (error) setError("No se encontró la configuración del agente. ¿Ejecutaste monitoreo.sql en Supabase?");
        setConfig(data);
      });
  useEffect(() => { if (esAdmin) cargar(); }, [esAdmin]);

  async function regenerar() {
    if (!confirm("¿Generar un token general nuevo? Los equipos ya registrados no se ven afectados (usan su propia clave).")) return;
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

  async function permitirTokenGeneral(valor: boolean) {
    if (valor && !confirm("El token general no vence ni tiene límite de equipos. ¿Habilitarlo para instaladores anteriores?")) return;
    const { error } = await createClient().from("inv_agente_config").update({ permitir_token_general: valor }).eq("id", 1);
    if (error) return setError(error.message);
    cargar();
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
          El agente corre cada {config?.intervalo_min ?? 5} minutos (tarea programada en Windows, systemd o cron en Linux)
          y envía los datos del equipo a esta app. No abre puertos ni queda residente: solo necesita salida a internet por HTTPS.
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {config && <CodigosInstalacion intervalo={config.intervalo_min} />}

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
          Mandalo solo por canales internos (Teams o correo de la empresa) y avisale a la persona que se lo vas a mandar: así sabe que es
          legítimo y desconfía de cualquier "instalador de IT" que le llegue por otro lado. Aunque se filtre, el código vence, tiene límite de
          equipos, y todo equipo nuevo queda <b>pendiente</b> hasta que lo apruebes.
        </p>
        <div className="flex gap-2 flex-wrap pt-1">
          <button className="btn-secondary" onClick={() => descargar("Desinstalar Agente Accusys Cyber.cmd", generarDesinstaladorCmd())}>
            Descargar desinstalador (doble clic)
          </button>
          <button className="btn-secondary" onClick={() => descargar("desinstalar-agente-accusys.ps1", generarDesinstalador())}>
            Desinstalador .ps1
          </button>
          <button className="btn-secondary" onClick={() => descargar("desinstalar-agente-accusys.sh", generarDesinstaladorLinux())}>
            Desinstalador Linux
          </button>
        </div>
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

      <details className="card p-5">
        <summary className="font-medium text-ink cursor-pointer">Token general (solo para instaladores anteriores)</summary>
        <div className="space-y-3 mt-3">
          <p className="text-sm text-ink/60">
            Los instaladores descargados antes de los códigos traen un token general que no vence. Por seguridad, ya no permite registrar
            equipos nuevos. Habilitalo solo si tenés que usar uno de esos instaladores viejos, y deshabilitalo después.
          </p>
          <label className="flex items-center gap-2 text-sm text-ink/80">
            <input type="checkbox" checked={!!config?.permitir_token_general} onChange={(e) => permitirTokenGeneral(e.target.checked)} disabled={!config} />
            Permitir registrar equipos con el token general
          </label>
          <button className="btn-secondary" onClick={regenerar} disabled={!config}>Generar token general nuevo</button>
        </div>
      </details>
    </div>
  );
}
