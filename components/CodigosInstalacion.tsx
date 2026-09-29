"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { generarInstalador, generarInstaladorCmd, descargar } from "@/lib/agente";
import { generarInstaladorLinux } from "@/lib/agente-linux";

type Codigo = {
  id: number; descripcion: string; creado_en: string; vence: string; usos: number; usos_max: number;
  revocado: boolean; ultimo_uso: string | null; inv_dispositivos: { count: number }[];
};

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

function estado(c: Codigo) {
  if (c.revocado) return { texto: "Revocado", clase: "bg-red-50 text-red-600" };
  if (new Date(c.vence).getTime() < Date.now()) return { texto: "Vencido", clase: "bg-line/[0.05] text-ink/50" };
  if (c.usos >= c.usos_max) return { texto: "Agotado", clase: "bg-line/[0.05] text-ink/50" };
  return { texto: "Vigente", clase: "bg-emerald-50 text-emerald-700" };
}

// Cada instalador lleva su propio código: vence, tiene un límite de equipos y se puede revocar.
// En la base se guarda solo la huella (SHA-256) del código, nunca el código.
export default function CodigosInstalacion({ intervalo }: { intervalo: number }) {
  const [lista, setLista] = useState<Codigo[]>([]);
  const [descripcion, setDescripcion] = useState("");
  const [dias, setDias] = useState(7);
  const [usos, setUsos] = useState(1);
  const [formato, setFormato] = useState<"cmd" | "ps1" | "linux" | "eset">("cmd");
  const [comando, setComando] = useState<{ descripcion: string; texto: string } | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  const cargar = () =>
    createClient().from("inv_codigos_instalacion").select("*, inv_dispositivos(count)").order("creado_en", { ascending: false }).limit(50)
      .then(({ data, error }) => {
        if (error) setAviso({ ok: false, texto: "No se encontraron los códigos de instalación. ¿Ejecutaste instalacion-segura.sql en Supabase?" });
        else setLista((data ?? []) as Codigo[]);
      });
  useEffect(() => { cargar(); }, []);

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    if (!descripcion.trim()) return;
    setGenerando(true); setAviso(null);
    const codigo = hex(crypto.getRandomValues(new Uint8Array(20)));
    const huella = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codigo)));
    const { error } = await createClient().from("inv_codigos_instalacion").insert({
      codigo_hash: huella, descripcion: descripcion.trim(),
      vence: new Date(Date.now() + dias * 86400000).toISOString(), usos_max: usos,
    });
    setGenerando(false);
    if (error) return setAviso({ ok: false, texto: error.message });

    const args = [process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, codigo, intervalo] as const;
    if (formato === "eset") {
      // No se descarga nada: el comando baja el instalador de la app con este código y lo ejecuta como SYSTEM
      const origen = window.location.origin;
      const texto = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $f=Join-Path $env:TEMP ('accusys-agente-'+[guid]::NewGuid().ToString('N')+'.ps1'); $c=1; try { Invoke-WebRequest -UseBasicParsing -Uri '${origen}/api/agente/instalar?codigo=${codigo}' -OutFile $f; & $f; $c=[int]$LASTEXITCODE } catch { Write-Output ('ERROR: ' + $_.Exception.Message) } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }; exit $c"`;
      setComando({ descripcion: descripcion.trim(), texto });
      setCopiado(false);
      setAviso({ ok: true, texto: `Comando para "${descripcion.trim()}" listo: sirve para ${usos === 1 ? "1 equipo" : `${usos} equipos`} y vence en ${dias} ${dias === 1 ? "día" : "días"}. Copialo ahora: no se vuelve a mostrar.` });
      setDescripcion("");
      cargar();
      return;
    }
    setComando(null);
    if (formato === "cmd") descargar("Instalar Agente Accusys Cyber.cmd", generarInstaladorCmd(...args));
    else if (formato === "ps1") descargar("instalar-agente-accusys.ps1", generarInstalador(...args));
    else descargar("instalar-agente-accusys.sh", generarInstaladorLinux(...args), { linux: true });
    setAviso({
      ok: true,
      texto: `Instalador para "${descripcion.trim()}" descargado: sirve para ${usos === 1 ? "1 equipo" : `${usos} equipos`} y vence en ${dias} ${dias === 1 ? "día" : "días"}.`,
    });
    setDescripcion("");
    cargar();
  }

  async function revocar(c: Codigo) {
    if (!confirm(`¿Revocar el instalador "${c.descripcion}"? No va a poder registrar más equipos. Los que ya se registraron siguen funcionando.`)) return;
    const { error } = await createClient().from("inv_codigos_instalacion").update({ revocado: true }).eq("id", c.id);
    if (error) return setAviso({ ok: false, texto: error.message });
    cargar();
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-medium text-ink">1. Generá un instalador</h2>
        <p className="text-sm text-ink/60 mt-1">
          Cada instalador lleva un código propio: indicá para quién es, cuántos equipos puede registrar y cuándo vence. Si se pierde o
          llega a otra persona, lo revocás desde la lista de abajo. Los equipos ya registrados no lo necesitan: siguen funcionando aunque
          el código venza.
        </p>
      </div>

      <form onSubmit={generar} className="grid md:grid-cols-4 gap-3 items-end">
        <div className="md:col-span-4">
          <label className="label">Para quién o para qué es</label>
          <input className="input" required value={descripcion} onChange={(e) => setDescripcion(e.target.value)}
            placeholder="Ej: Felipe Alborch · Notebooks nuevas de septiembre · Despliegue por ESET" />
        </div>
        <div>
          <label className="label">Equipos que puede registrar</label>
          <select className="input" value={usos} onChange={(e) => setUsos(Number(e.target.value))}>
            {[1, 3, 5, 20, 100, 500].map((n) => <option key={n} value={n}>{n === 1 ? "1 equipo" : `${n} equipos`}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Vence en</label>
          <select className="input" value={dias} onChange={(e) => setDias(Number(e.target.value))}>
            <option value={1}>1 día</option><option value={7}>7 días</option><option value={30}>30 días</option>
          </select>
        </div>
        <div>
          <label className="label">Formato</label>
          <select className="input" value={formato} onChange={(e) => {
            const f = e.target.value as "cmd" | "ps1" | "linux" | "eset";
            setFormato(f);
            if (f === "eset" && usos === 1) { setUsos(100); setDias(7); }
          }}>
            <option value="cmd">Windows: doble clic (.cmd)</option>
            <option value="ps1">Windows: PowerShell (.ps1) para ESET, Intune o GPO</option>
            <option value="linux">Linux (.sh)</option>
            <option value="eset">ESET PROTECT: comando para "Ejecutar comando"</option>
          </select>
        </div>
        <button className="btn-primary" disabled={generando || !descripcion.trim()}>{generando ? "Generando…" : formato === "eset" ? "Generar comando" : "Generar y descargar"}</button>
      </form>

      {formato === "linux" && (
        <p className="text-xs text-ink/60">
          En el equipo Linux se ejecuta con <code className="bg-line/[0.04] px-1 rounded">sudo bash instalar-agente-accusys.sh</code>.
          Funciona en Ubuntu, Debian, Red Hat, Rocky, Alma y derivadas (con systemd o cron). Solo necesita <code>curl</code>.
        </p>
      )}

      {formato === "eset" && !comando && (
        <p className="text-xs text-ink/60">
          Para equipos remotos sin VPN: ESET PROTECT ejecuta el comando como SYSTEM, el equipo baja el instalador de esta app con el código y
          queda pendiente de aprobación. Poné como límite la cantidad de equipos a instalar (con un margen) y un vencimiento corto.
        </p>
      )}

      {comando && (
        <div className="rounded-lg border border-line/10 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-ink">Comando para ESET PROTECT · {comando.descripcion}</div>
            <button type="button" className="btn-secondary" onClick={async () => { await navigator.clipboard.writeText(comando.texto); setCopiado(true); }}>
              {copiado ? "Copiado" : "Copiar comando"}
            </button>
          </div>
          <pre className="text-xs bg-line/[0.04] rounded-md p-3 whitespace-pre-wrap break-all select-all">{comando.texto}</pre>
          <ol className="text-sm text-ink/70 space-y-1 list-decimal pl-5">
            <li>En <b>ESET PROTECT Cloud</b>: <b>Tareas → Nueva → Tarea de cliente</b>.</li>
            <li>En <b>Tarea</b> elegí <b>Ejecutar comando</b> (Run Command). Pegá el comando en <b>Línea de comandos</b> y dejá vacío el directorio de trabajo.</li>
            <li>En <b>Destino</b>, elegí primero 1 o 2 equipos de prueba; cuando aparezcan en Monitoreo como pendientes, repetí con el grupo completo.</li>
            <li>Activador: <b>Lo antes posible</b>. Los equipos apagados la ejecutan cuando se conectan.</li>
            <li>Aprobá los equipos nuevos en Monitoreo. Al terminar el despliegue, revocá este código desde la lista de abajo.</li>
          </ol>
          <p className="text-xs text-ink/50">El comando contiene el código: tratalo como una contraseña. La app no lo guarda, solo su huella.</p>
        </div>
      )}

      {aviso && (
        <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>
      )}

      {lista.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Instalador</th><th>Estado</th><th>Equipos</th><th>Vence</th><th></th></tr></thead>
            <tbody>
              {lista.map((c) => {
                const est = estado(c);
                return (
                  <tr key={c.id}>
                    <td>
                      <span className="text-ink">{c.descripcion}</span>
                      <div className="text-xs text-ink/50">Creado el {new Date(c.creado_en).toLocaleDateString("es-AR")}</div>
                    </td>
                    <td><span className={`pill ${est.clase}`}>{est.texto}</span></td>
                    <td className="text-ink/70 whitespace-nowrap">
                      {c.usos} de {c.usos_max}
                      {c.inv_dispositivos?.[0]?.count ? <div className="text-xs text-ink/50">{c.inv_dispositivos[0].count} registrados</div> : null}
                    </td>
                    <td className="text-ink/60 whitespace-nowrap">{new Date(c.vence).toLocaleDateString("es-AR")}</td>
                    <td className="text-right">
                      {est.texto === "Vigente" && (
                        <button className="text-sm text-ink/50 hover:text-red-600 hover:underline" onClick={() => revocar(c)}>Revocar</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
