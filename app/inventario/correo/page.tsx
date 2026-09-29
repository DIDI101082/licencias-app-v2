"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import TareasProgramadas, { useEstadoProg } from "@/components/TareasProgramadas";
import { hace } from "@/lib/monitoreo";

type Hallazgo = { severidad: "alta" | "media" | "baja"; titulo: string; detalle: string };
type Dominio = { dominio: string; selectores: string[]; activo: boolean };
type Estado = {
  dominio: string; mx: string[] | null; spf: string | null; dmarc: string | null; dmarc_politica: string | null;
  dkim: { selector: string; valor: string | null }[]; mta_sts: string | null; tls_rpt: string | null;
  puntaje: number | null; hallazgos: Hallazgo[]; error: string | null; verificado: string;
};
type Cambio = { id: number; dominio: string; fecha: string; registro: string; antes: string | null; despues: string | null; revisado: string | null };

const SEV: Record<string, string> = { alta: "bg-red-50 text-red-700", media: "bg-amber-500/15 text-amber-700", baja: "bg-line/[0.05] text-ink/60" };
const POL: Record<string, { t: string; c: string }> = {
  reject: { t: "Rechaza (p=reject)", c: "bg-emerald-50 text-emerald-700" }, quarantine: { t: "Cuarentena", c: "bg-amber-500/15 text-amber-700" },
  none: { t: "Solo monitorea", c: "bg-red-50 text-red-700" },
};

function Registro({ nombre, valor, ok }: { nombre: string; valor: string | null; ok: boolean }) {
  return (
    <div className="text-sm">
      <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden /><span className="font-medium">{nombre}</span>{!ok && <span className="text-xs text-red-600">no configurado</span>}</div>
      {valor && <div className="font-mono text-xs text-ink/60 break-all mt-0.5 pl-4">{valor}</div>}
    </div>
  );
}

export default function Correo() {
  const { esAdmin, puedeEditar } = usePerfil();
  const { estado: prog, guardar } = useEstadoProg();
  const [dominios, setDominios] = useState<Dominio[]>([]);
  const [estados, setEstados] = useState<Estado[]>([]);
  const [cambios, setCambios] = useState<Cambio[]>([]);
  const [nuevo, setNuevo] = useState({ dominio: "", selectores: "selector1, selector2" });
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [d, e, c] = await Promise.all([
      sb.from("correo_dominios").select("*").order("dominio"), sb.from("correo_estado").select("*"),
      sb.from("correo_cambios").select("*").order("fecha", { ascending: false }).limit(100),
    ]);
    if (d.error) setError(/correo_/.test(d.error.message) ? "Falta ejecutar supabase/postura.sql en Supabase." : d.error.message);
    setDominios((d.data ?? []) as Dominio[]); setEstados((e.data ?? []) as Estado[]); setCambios((c.data ?? []) as Cambio[]); setCargando(false);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  async function agregar(ev: React.FormEvent) {
    ev.preventDefault(); setError(null);
    const dominio = nuevo.dominio.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    const selectores = nuevo.selectores.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^[a-z0-9._-]{1,63}$/i.test(s));
    const { error } = await createClient().from("correo_dominios").insert({ dominio, selectores });
    if (error) return setError(error.code === "23505" ? "Ese dominio ya está cargado." : error.code === "23514" ? "Dominio inválido (ej. accusys.com.ar)." : error.message);
    setNuevo({ dominio: "", selectores: "selector1, selector2" }); cargar();
  }
  async function quitar(d: string) {
    if (!confirm(`¿Dejar de revisar ${d}? Se borra también su historial de cambios.`)) return;
    const { error } = await createClient().from("correo_dominios").delete().eq("dominio", d);
    if (error) return setError(error.message);
    cargar();
  }
  async function revisado(id: number) {
    const { error } = await createClient().rpc("correo_cambio_revisado", { p_id: id });
    if (error) return setError(error.message);
    cargar();
  }

  const pendientes = cambios.filter((c) => !c.revisado);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Correo y dominio</h1>
        <p className="text-ink/60 text-sm mt-1 max-w-3xl">
          Protección contra la suplantación del dominio por correo (SPF, DKIM y DMARC) y cifrado entre servidores (MTA-STS, TLS-RPT).
          Se revisa todos los días en el DNS público y avisa si alguien cambia un registro.
        </p>
      </div>
      <TareasProgramadas parte="correo" alTerminar={cargar} />
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {pendientes.length > 0 && (
        <div className="card overflow-x-auto border-l-4 border-l-red-500">
          <div className="px-4 pt-4 font-medium text-ink">Cambios en el DNS sin revisar ({pendientes.length})</div>
          <table className="data w-full">
            <tbody>
              {pendientes.map((c) => (
                <tr key={c.id}>
                  <td className="text-sm whitespace-nowrap">{hace(c.fecha)}</td>
                  <td className="text-sm"><b>{c.registro}</b> de {c.dominio}
                    <div className="font-mono text-xs text-ink/55 break-all">Antes: {c.antes ?? "(no existía)"}</div>
                    <div className="font-mono text-xs text-ink break-all">Ahora: {c.despues ?? "(no existe)"}</div></td>
                  <td className="text-right">{puedeEditar && <button className="btn-secondary" onClick={() => revisado(c.id)}>Fue un cambio autorizado</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!dominios.length && !cargando && <div className="card p-6 text-sm text-ink/60">Todavía no hay dominios cargados.{esAdmin ? " Agregá el dominio de la empresa abajo." : ""}</div>}

      <div className="grid lg:grid-cols-2 gap-4">
        {dominios.map((d) => {
          const e = estados.find((x) => x.dominio === d.dominio);
          const pol = POL[e?.dmarc_politica ?? ""];
          return (
            <div key={d.dominio} className="card p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-lg text-ink">{d.dominio}</h2>
                  <div className="text-xs text-ink/50">{e ? `Revisado ${hace(e.verificado)}` : "Se revisa en la próxima verificación"}</div>
                </div>
                {e?.puntaje != null && !e.error && (
                  <div className={`font-display text-3xl tabular-nums ${e.puntaje >= 85 ? "text-emerald-700" : e.puntaje >= 60 ? "text-amber-700" : "text-red-600"}`}>{e.puntaje}<span className="text-sm text-ink/40">/100</span></div>
                )}
              </div>
              {e?.error && <p className="text-sm text-red-600">{e.error}</p>}
              {e && !e.error && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {pol ? <span className={`pill ${pol.c}`}>DMARC: {pol.t}</span> : <span className="pill bg-red-50 text-red-700">Sin DMARC</span>}
                    <span className="pill bg-line/[0.05] text-ink/60">MX: {e.mx?.length ? e.mx.join(", ") : "ninguno"}</span>
                  </div>
                  <div className="space-y-2">
                    <Registro nombre="SPF" valor={e.spf} ok={!!e.spf} />
                    <Registro nombre="DMARC" valor={e.dmarc} ok={!!e.dmarc} />
                    {e.dkim.map((k) => <Registro key={k.selector} nombre={`DKIM (${k.selector})`} valor={k.valor} ok={!!k.valor} />)}
                    <Registro nombre="MTA-STS" valor={e.mta_sts} ok={!!e.mta_sts} />
                    <Registro nombre="TLS-RPT" valor={e.tls_rpt} ok={!!e.tls_rpt} />
                  </div>
                  {e.hallazgos.length > 0 && (
                    <ul className="space-y-2 border-t border-line/[0.06] pt-3">
                      {e.hallazgos.map((h) => (
                        <li key={h.titulo} className="text-sm flex gap-2 items-start">
                          <span className={`pill shrink-0 ${SEV[h.severidad]}`}>{h.severidad === "alta" ? "Alta" : h.severidad === "media" ? "Media" : "Baja"}</span>
                          <span><span className="font-medium text-ink">{h.titulo}</span><span className="block text-ink/60">{h.detalle}</span></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {esAdmin && (
                <div className="text-xs text-ink/45 flex justify-between border-t border-line/[0.06] pt-2">
                  <span>Selectores DKIM: {d.selectores.join(", ") || "ninguno"}</span>
                  <button className="hover:text-red-600" onClick={() => quitar(d.dominio)}>Dejar de revisar</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {esAdmin && (
        <form onSubmit={agregar} className="card p-5 grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <label className="block text-sm">Dominio<input className="input mt-1" required placeholder="accusys.com.ar" value={nuevo.dominio} onChange={(e) => setNuevo({ ...nuevo, dominio: e.target.value })} /></label>
          <label className="block text-sm">Selectores DKIM<input className="input mt-1" value={nuevo.selectores} onChange={(e) => setNuevo({ ...nuevo, selectores: e.target.value })} /></label>
          <button className="btn-primary">Agregar dominio</button>
          <p className="text-xs text-ink/50 sm:col-span-3">Microsoft 365 usa los selectores selector1 y selector2. Cargá también los dominios que no envían correo: igual los pueden usar para suplantarlos.</p>
        </form>
      )}

      {cambios.some((c) => c.revisado) && (
        <details className="card p-4">
          <summary className="text-sm font-medium cursor-pointer">Historial de cambios revisados</summary>
          <ul className="mt-3 space-y-2 text-sm">
            {cambios.filter((c) => c.revisado).map((c) => (
              <li key={c.id}><span className="text-ink/50">{new Date(c.fecha).toLocaleString("es-AR")}</span> · <b>{c.registro}</b> de {c.dominio}
                <div className="font-mono text-xs text-ink/55 break-all">{c.antes ?? "(no existía)"} → {c.despues ?? "(no existe)"}</div></li>
            ))}
          </ul>
        </details>
      )}

      {esAdmin && prog && (
        <label className="card p-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={prog.alertas_correo} onChange={(e) => guardar({ alertas_correo: e.target.checked })} />
          Enviar alertas: problemas graves de SPF/DKIM/DMARC y cualquier cambio en los registros de correo del DNS
        </label>
      )}
    </div>
  );
}
