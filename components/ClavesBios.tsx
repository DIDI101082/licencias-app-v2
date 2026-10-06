"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { descargar } from "@/lib/agente";
import { generarScriptBios } from "@/lib/bios-script";

type Clave = {
  numero_serie: string; hostname: string | null; estado: "pendiente" | "aplicada" | "error"; generada: string;
  aplicada: string | null; intentos: number; usb_bloqueado: boolean | null; ultimo_error: string | null;
};
type Consulta = { numero_serie: string; hostname: string | null; email: string | null; motivo: string; fecha: string };
type Resumen = { habilitado_hasta: string | null; habilitado_por: string | null; claves: Clave[]; consultas: Consulta[] };

const ESTADO = {
  aplicada: { texto: "Aplicada", clase: "bg-emerald-50 text-emerald-700" },
  pendiente: { texto: "Sin confirmar", clase: "bg-amber-50 text-amber-700" },
  error: { texto: "Con error", clase: "bg-red-50 text-red-600" },
} as const;
const cuando = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "—");
const SEGUNDOS_VISIBLE = 60;

// Una clave de BIOS distinta por equipo, asociada al número de serie. La app la genera, la guarda cifrada
// y se la entrega una sola vez al equipo; después solo la ve un administrador, y cada consulta queda registrada.
export default function ClavesBios() {
  const [r, setR] = useState<Resumen | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [horas, setHoras] = useState(8);
  const [pidiendo, setPidiendo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [vista, setVista] = useState<{ serie: string; clave: string } | null>(null);
  const [copiado, setCopiado] = useState(false);
  const reloj = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cargar = () =>
    createClient().rpc("bios_resumen").then(({ data, error }) => {
      if (error) setAviso(error.message.includes("bios_resumen") ? "Falta ejecutar bios-claves.sql en Supabase." : error.message);
      else { setR(data as Resumen); setAviso(null); }
    });
  useEffect(() => { cargar(); return () => { if (reloj.current) clearTimeout(reloj.current); }; }, []);

  async function habilitar(h: number) {
    const { error } = await createClient().rpc("bios_habilitar", { p_horas: h });
    if (error) return setAviso(error.message);
    cargar();
  }

  async function ver(serie: string) {
    setAviso(null);
    const resp = await fetch("/api/bios/ver", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serie, motivo }),
    });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) return setAviso(d.error ?? "No se pudo obtener la clave.");
    setPidiendo(null); setMotivo(""); setCopiado(false);
    setVista({ serie, clave: d.clave });
    if (reloj.current) clearTimeout(reloj.current);
    reloj.current = setTimeout(() => setVista(null), SEGUNDOS_VISIBLE * 1000);
    cargar();
  }

  const habilitado = !!r?.habilitado_hasta && new Date(r.habilitado_hasta).getTime() > Date.now();
  const claves = r?.claves ?? [];
  const cuenta = (e: Clave["estado"]) => claves.filter((c) => c.estado === e).length;

  return (
    <div className="card p-5 space-y-5">
      <div>
        <h2 className="font-medium text-ink">Claves de BIOS por equipo</h2>
        <p className="text-sm text-ink/60 mt-1">
          Cada notebook recibe una clave de administrador de BIOS distinta, asociada a su número de serie. La app la genera,
          la guarda cifrada y se la entrega solo a ese equipo mientras el despliegue está habilitado. Ver una clave deja
          registrado quién la consultó y por qué.
        </p>
      </div>

      {aviso && <p role="alert" className="text-sm text-red-600">{aviso}</p>}

      <div className="rounded-lg border border-line/10 p-4 space-y-3">
        <div className="text-sm">
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs mr-2 ${habilitado ? "bg-emerald-50 text-emerald-700" : "bg-line/[0.05] text-ink/60"}`}>
            {habilitado ? "Despliegue habilitado" : "Despliegue deshabilitado"}
          </span>
          {habilitado && <span className="text-ink/60">hasta {cuando(r!.habilitado_hasta)}{r!.habilitado_por ? ` · lo habilitó ${r!.habilitado_por}` : ""}</span>}
          {!habilitado && <span className="text-ink/60">Ningún equipo puede pedir su clave hasta que lo habilites.</span>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-ink/70">Habilitar por
            <select className="input mt-1 w-32 block" value={horas} onChange={(e) => setHoras(Number(e.target.value))}>
              {[2, 8, 24, 72].map((h) => <option key={h} value={h}>{h} horas</option>)}
            </select>
          </label>
          <button className="btn-primary" onClick={() => habilitar(horas)}>{habilitado ? "Extender" : "Habilitar"}</button>
          {habilitado && <button className="btn-secondary" onClick={() => habilitar(0)}>Deshabilitar ahora</button>}
          <button className="btn-secondary" onClick={() => descargar("bios-clave.ps1", generarScriptBios(window.location.origin))}>
            Descargar script para PDQ
          </button>
        </div>
        <details className="text-sm text-ink/70">
          <summary className="cursor-pointer text-brand-600">Cómo armar el paquete en PDQ Deploy</summary>
          <ol className="list-decimal pl-5 mt-2 space-y-1">
            <li>Guardá <code className="text-xs">bios-clave.ps1</code> en la misma carpeta que <code className="text-xs">cctk.exe</code> (la de Dell Command | Configure).</li>
            <li>Paso 1, File Copy: esa carpeta a <code className="text-xs">C:\Windows\Temp\cctk</code>.</li>
            <li>Paso 2, Command: <code className="text-xs">powershell -ExecutionPolicy Bypass -File C:\Windows\Temp\cctk\bios-clave.ps1</code></li>
            <li>Paso 3, Command: <code className="text-xs">rd /s /q C:\Windows\Temp\cctk</code> (marcalo para que corra aunque falle el paso 2).</li>
            <li>En los equipos que ya tienen una clave, agregá al paso 2 <code className="text-xs">-ClaveAnterior &quot;la clave actual&quot;</code>.</li>
          </ol>
          <p className="mt-2">El script no lleva ninguna clave: el equipo se identifica con el agente de Accusys, que tiene que estar instalado y aprobado.</p>
        </details>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <span><strong className="text-ink">{cuenta("aplicada")}</strong> <span className="text-ink/60">aplicadas</span></span>
        <span><strong className="text-ink">{cuenta("pendiente")}</strong> <span className="text-ink/60">sin confirmar</span></span>
        <span><strong className="text-ink">{cuenta("error")}</strong> <span className="text-ink/60">con error</span></span>
      </div>

      {vista && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <div className="text-ink/70">Clave de BIOS de {vista.serie} (se oculta en {SEGUNDOS_VISIBLE} segundos)</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <code className="text-lg tracking-wider text-ink select-all">{vista.clave}</code>
            <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(vista.clave).then(() => setCopiado(true))}>
              {copiado ? "Copiada" : "Copiar"}
            </button>
            <button className="btn-secondary" onClick={() => setVista(null)}>Ocultar</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink/50">
              <th className="py-2 pr-3">Número de serie</th><th className="py-2 pr-3">Equipo</th><th className="py-2 pr-3">Estado</th>
              <th className="py-2 pr-3">Aplicada</th><th className="py-2 pr-3">Arranque por USB</th><th className="py-2 pr-3">Detalle</th><th />
            </tr>
          </thead>
          <tbody>
            {claves.map((c) => (
              <tr key={c.numero_serie} className="border-t border-line/10 align-top">
                <td className="py-2 pr-3 font-mono">{c.numero_serie}</td>
                <td className="py-2 pr-3">{c.hostname ?? "—"}</td>
                <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${ESTADO[c.estado].clase}`}>{ESTADO[c.estado].texto}</span></td>
                <td className="py-2 pr-3">{cuando(c.aplicada)}</td>
                <td className="py-2 pr-3">{c.usb_bloqueado == null ? "—" : c.usb_bloqueado ? "Deshabilitado" : "No se pudo deshabilitar"}</td>
                <td className="py-2 pr-3 text-ink/60">{c.ultimo_error ?? (c.intentos > 1 ? `${c.intentos} intentos` : "")}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  {pidiendo === c.numero_serie ? (
                    <form className="flex gap-2 justify-end" onSubmit={(e) => { e.preventDefault(); ver(c.numero_serie); }}>
                      <input className="input w-56" autoFocus placeholder="Motivo de la consulta" aria-label="Motivo de la consulta"
                        value={motivo} onChange={(e) => setMotivo(e.target.value)} />
                      <button className="btn-primary" disabled={motivo.trim().length < 5}>Ver</button>
                      <button type="button" className="btn-secondary" onClick={() => { setPidiendo(null); setMotivo(""); }}>Cancelar</button>
                    </form>
                  ) : (
                    <button className="text-brand-600 hover:underline" onClick={() => { setPidiendo(c.numero_serie); setMotivo(""); }}>Ver clave</button>
                  )}
                </td>
              </tr>
            ))}
            {r && claves.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-ink/40">Todavía ningún equipo pidió su clave.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(r?.consultas.length ?? 0) > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-brand-600">Últimas consultas de claves ({r!.consultas.length})</summary>
          <ul className="mt-2 space-y-1 text-ink/70">
            {r!.consultas.map((q, i) => (
              <li key={i}>{cuando(q.fecha)} · {q.email ?? "—"} vio la de {q.hostname ?? q.numero_serie} · {q.motivo}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
