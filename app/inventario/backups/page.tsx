"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { generarScriptVeeam, TAREA_VEEAM } from "@/lib/veeam";

type Trabajo = {
  nombre: string; tipo: string | null; habilitado: boolean; ultimo_resultado: string | null; ultimo_inicio: string | null;
  ultimo_fin: string | null; ultimo_exito: string | null; detalle: string | null; ignorar: boolean; actualizado: string;
};
type Estado = {
  configurado: boolean; ultimo_reporte: string | null; servidor: string | null; version: string | null;
  horas_max_sin_exito: number; horas_max_sin_reporte: number; alertas: boolean;
};

const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—");
const horas = (f: string | null) => (f ? (Date.now() - Date.parse(f)) / 3600000 : Infinity);
const hace = (f: string | null) => {
  const h = horas(f);
  if (!isFinite(h)) return "nunca";
  return h < 1 ? "hace minutos" : h < 48 ? `hace ${Math.floor(h)} h` : `hace ${Math.floor(h / 24)} días`;
};
const RES: Record<string, { t: string; c: string }> = {
  Success: { t: "Exitoso", c: "bg-emerald-50 text-emerald-700" },
  Warning: { t: "Con advertencias", c: "bg-amber-50 text-amber-700" },
  Failed: { t: "Falló", c: "bg-red-600 text-white" },
  None: { t: "En curso", c: "bg-brand-50 text-brand-700" },
};

export default function Backups() {
  const { esAdmin } = usePerfil();
  const [trabajos, setTrabajos] = useState<Trabajo[]>([]);
  const [hist, setHist] = useState<{ nombre: string; fecha: string; resultado: string }[]>([]);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);

  const cargar = async () => {
    const sb = createClient();
    const desde = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const [t, h, e] = await Promise.all([
      sb.from("backups_trabajos").select("*").order("nombre"),
      sb.from("backups_historial").select("*").gte("fecha", desde),
      sb.rpc("backups_estado"),
    ]);
    if (t.error) setError(t.error.message.includes("backups") ? "Falta ejecutar backups.sql en Supabase." : t.error.message);
    setTrabajos((t.data ?? []) as Trabajo[]); setHist(h.data ?? []); setEstado(e.data as Estado);
  };
  useEffect(() => { cargar(); }, []);

  const limite = estado?.horas_max_sin_exito ?? 26;
  const problema = (t: Trabajo) => t.habilitado && !t.ignorar && (t.ultimo_resultado === "Failed" || horas(t.ultimo_exito) > limite);
  const lista = useMemo(() => [...trabajos].sort((a, b) => Number(problema(b)) - Number(problema(a)) || a.nombre.localeCompare(b.nombre)), [trabajos, limite]); // eslint-disable-line react-hooks/exhaustive-deps
  const activos = trabajos.filter((t) => t.habilitado && !t.ignorar);
  const conProblema = activos.filter(problema).length;
  const reporteViejo = estado?.ultimo_reporte ? horas(estado.ultimo_reporte) > (estado.horas_max_sin_reporte ?? 3) : false;
  const dias = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }));
  const exitos14 = hist.filter((h) => h.resultado !== "Failed").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Backups</h1>
          <p className="text-ink/60 text-sm mt-1">
            Estado de los trabajos de Veeam. Un backup que falla en silencio se descubre el día que hace falta restaurar:
            acá se ve cada trabajo, cuándo fue el último exitoso, y se alerta por Teams si algo falla.
          </p>
        </div>
        {esAdmin && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}
      {estado && !estado.configurado && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está conectado el servidor de Veeam. {esAdmin ? "Tocá “Configurar” para generar el script." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <Configuracion estado={estado} onCambio={cargar} />}

      {estado?.configurado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${reporteViejo ? "bg-red-50" : ""}`}>
          <span><b>Servidor:</b> {estado.servidor ?? "—"}{estado.version ? ` · Veeam ${estado.version}` : ""}</span>
          <span className={reporteViejo ? "text-red-600" : ""}><b>Último reporte:</b> {fh(estado.ultimo_reporte)} ({hace(estado.ultimo_reporte)})</span>
          <span><b>Alerta si no hay backup exitoso en:</b> {limite} h</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-4"><div className="text-xs text-ink/50">Trabajos activos</div><div className="font-display text-3xl mt-1 text-ink">{activos.length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Con problemas</div><div className={`font-display text-3xl mt-1 ${conProblema ? "text-red-600" : "text-ink"}`}>{conProblema}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Al día</div><div className="font-display text-3xl mt-1 text-emerald-700">{activos.length - conProblema}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Ejecuciones OK (14 días)</div><div className="font-display text-3xl mt-1 text-ink">{hist.length ? `${Math.round((exitos14 / hist.length) * 100)}%` : "—"}</div></div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Trabajo</th><th>Último resultado</th><th>Último exitoso</th><th>Últimos 14 días</th>{esAdmin && <th></th>}</tr></thead>
            <tbody>
              {!lista.length && <tr><td colSpan={5} className="text-center text-ink/50 py-6">Sin datos todavía.</td></tr>}
              {lista.map((t) => {
                const mal = problema(t);
                return (
                  <tr key={t.nombre} className={t.ignorar || !t.habilitado ? "opacity-50" : ""}>
                    <td>
                      <div className="font-medium text-ink">{t.nombre}</div>
                      <div className="text-xs text-ink/50">{t.tipo ?? ""}{!t.habilitado ? " · programación desactivada" : ""}{t.ignorar ? " · ignorado" : ""}</div>
                    </td>
                    <td className="text-sm">
                      {t.ultimo_resultado ? <span className={`pill ${RES[t.ultimo_resultado]?.c ?? ""}`}>{RES[t.ultimo_resultado]?.t ?? t.ultimo_resultado}</span> : "—"}
                      <div className="text-xs text-ink/50 mt-0.5">{fh(t.ultimo_fin ?? t.ultimo_inicio)}</div>
                      {t.detalle && <div className="text-xs text-red-600 mt-0.5 max-w-sm">{t.detalle}</div>}
                    </td>
                    <td className={`text-sm ${mal ? "text-red-600 font-medium" : "text-ink/70"}`}>{hace(t.ultimo_exito)}</td>
                    <td>
                      <div className="flex gap-0.5">
                        {dias.map((d) => {
                          const r = hist.find((h) => h.nombre === t.nombre && h.fecha === d)?.resultado;
                          return <span key={d} title={`${d}: ${r ? RES[r]?.t : "sin ejecución"}`}
                            className={`h-4 w-2.5 rounded-sm ${r === "Success" ? "bg-emerald-500" : r === "Warning" ? "bg-amber-400" : r === "Failed" ? "bg-red-600" : "bg-line/[0.08]"}`} />;
                        })}
                      </div>
                    </td>
                    {esAdmin && (
                      <td className="text-right">
                        <button className="text-xs text-ink/50 hover:text-ink" onClick={async () => {
                          const { error } = await createClient().rpc("backups_ignorar", { p_nombre: t.nombre, p_ignorar: !t.ignorar });
                          if (error) setError(error.message); else cargar();
                        }}>{t.ignorar ? "Dejar de ignorar" : "Ignorar"}</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Configuracion({ estado, onCambio }: { estado: Estado; onCambio: () => void }) {
  const [f, setF] = useState({ horas_max_sin_exito: estado.horas_max_sin_exito, horas_max_sin_reporte: estado.horas_max_sin_reporte, alertas: estado.alertas });
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const sb = createClient();

  async function generar() {
    if (estado.configurado && !confirm("Se genera un token nuevo: el script instalado deja de funcionar hasta que lo reemplaces. ¿Seguir?")) return;
    const { data, error } = await sb.rpc("backups_nuevo_token");
    if (error) return setMsg({ ok: false, texto: error.message });
    const s = generarScriptVeeam({ url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token: data as string });
    setScript(s);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([s], { type: "text/plain" }));
    a.download = "reporte-veeam.ps1";
    a.click();
    onCambio();
  }

  return (
    <div className="card p-5 space-y-5">
      <div>
        <h2 className="font-display text-lg text-ink">1. Instalar el script en el servidor de Veeam</h2>
        <ol className="text-sm text-ink/70 mt-2 space-y-1.5 list-decimal pl-5">
          <li>Generá el script (se descarga <code>reporte-veeam.ps1</code> con un token propio).</li>
          <li>Copialo en el servidor de Veeam en <code>C:\ProgramData\AccusysBackups\reporte-veeam.ps1</code>.</li>
          <li>En ese servidor, abrí una consola como administrador y creá la tarea programada (cada hora):
            <pre className="mt-1 p-2 rounded bg-line/[0.04] text-xs whitespace-pre-wrap break-all">{TAREA_VEEAM}</pre>
          </li>
          <li>Para probar ya: <code>schtasks /Run /TN &quot;Accusys Cyber - Backups Veeam&quot;</code> y en un minuto recargá esta página.
            Si no aparece nada, mirá <code>C:\ProgramData\AccusysBackups\reporte.log</code>.</li>
        </ol>
        <p className="text-xs text-ink/50 mt-2">
          El script solo lee (usa el módulo de PowerShell que instala Veeam) y envía el resultado de cada trabajo; no toca los backups.
          Necesita salida a internet por HTTPS hacia Supabase.
        </p>
        <button className="btn-primary mt-3" onClick={generar}>{estado.configurado ? "Generar script con token nuevo" : "Generar script"}</button>
        {script && <p className="text-xs text-emerald-700 mt-2">Script descargado. El token no se vuelve a mostrar: si lo perdés, generá uno nuevo.</p>}
      </div>

      <div>
        <h2 className="font-display text-lg text-ink">2. Alertas</h2>
        <div className="grid sm:grid-cols-2 gap-3 mt-2">
          <label className="block text-sm">Alertar si un trabajo no tiene backup exitoso en (horas)
            <input type="number" min={1} max={720} className="input mt-1" value={f.horas_max_sin_exito} onChange={(e) => setF({ ...f, horas_max_sin_exito: Number(e.target.value) })} />
            <span className="text-xs text-ink/50">26 h sirve para backups diarios (da margen si uno se atrasa).</span>
          </label>
          <label className="block text-sm">Alertar si el servidor no reporta en (horas)
            <input type="number" min={1} max={72} className="input mt-1" value={f.horas_max_sin_reporte} onChange={(e) => setF({ ...f, horas_max_sin_reporte: Number(e.target.value) })} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm mt-3"><input type="checkbox" checked={f.alertas} onChange={(e) => setF({ ...f, alertas: e.target.checked })} /> Enviar alertas (Teams y sistema de tickets)</label>
        <button className="btn-secondary mt-3" onClick={async () => {
          const { error } = await sb.rpc("backups_config_guardar", { p: f });
          setMsg(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado." });
          if (!error) onCambio();
        }}>Guardar</button>
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.texto}</p>}
    </div>
  );
}
