"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import TareasProgramadas, { useEstadoProg } from "@/components/TareasProgramadas";
import { hace } from "@/lib/monitoreo";

type Objetivo = { id: number; direccion: string; descripcion: string | null; activo: boolean; ip: string | null; hostnames: string[] | null; verificado: string | null; error: string | null };
type Puerto = { objetivo_id: number; puerto: number; servicio: string | null; fuente: string | null; abierto: boolean; esperado: boolean; nota: string | null; primera_vez: string; ultima_vez: string };
type Vuln = { objetivo_id: number; cve: string; primera_vez: string };

// Puertos que no deberían estar publicados (misma lista que la base)
const RIESGOSOS = new Set([21, 23, 69, 135, 137, 139, 161, 389, 445, 636, 873, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 5985, 5986, 6379, 9200, 9300, 11211, 27017]);

export default function Superficie() {
  const { esAdmin } = usePerfil();
  const { estado: prog, guardar } = useEstadoProg();
  const [objs, setObjs] = useState<Objetivo[]>([]);
  const [puertos, setPuertos] = useState<Puerto[]>([]);
  const [vulns, setVulns] = useState<Vuln[]>([]);
  const [nuevo, setNuevo] = useState({ direccion: "", descripcion: "" });
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [verCerrados, setVerCerrados] = useState(false);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [o, p, v] = await Promise.all([
      sb.from("sup_objetivos").select("*").order("id"), sb.from("sup_puertos").select("*").order("puerto"), sb.from("sup_vulns").select("*").order("cve", { ascending: false }),
    ]);
    if (o.error) setError(/sup_/.test(o.error.message) ? "Falta ejecutar supabase/postura.sql en Supabase." : o.error.message);
    setObjs((o.data ?? []) as Objetivo[]); setPuertos((p.data ?? []) as Puerto[]); setVulns((v.data ?? []) as Vuln[]); setCargando(false);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  async function agregar(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const direccion = nuevo.direccion.trim().toLowerCase();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(direccion) && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(direccion)) return setError("Usá una IP pública (ej. 200.45.10.20) o un nombre (ej. vpn.accusys.com.ar).");
    const { error } = await createClient().from("sup_objetivos").insert({ direccion, descripcion: nuevo.descripcion.trim() || null });
    if (error) return setError(error.code === "23505" ? "Esa dirección ya está cargada." : error.message);
    setNuevo({ direccion: "", descripcion: "" }); cargar();
  }
  async function quitar(o: Objetivo) {
    if (!confirm(`¿Dejar de revisar ${o.direccion}? Se borra su historial.`)) return;
    const { error } = await createClient().from("sup_objetivos").delete().eq("id", o.id);
    if (error) return setError(error.message);
    cargar();
  }
  async function marcar(p: Puerto, esperado: boolean) {
    const nota = esperado ? prompt(`¿Por qué está publicado el puerto ${p.puerto}? (ej. VPN SSL, web institucional)`, p.nota ?? "") : null;
    if (esperado && nota === null) return;
    const { error } = await createClient().rpc("sup_marcar", { p_objetivo: p.objetivo_id, p_puerto: p.puerto, p_esperado: esperado, p_nota: nota });
    if (error) return setError(error.message);
    cargar();
  }

  const abiertos = puertos.filter((p) => p.abierto);
  const inesperados = abiertos.filter((p) => !p.esperado);
  const nuevos = abiertos.filter((p) => Date.now() - Date.parse(p.primera_vez) < 7 * 86400000);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Superficie expuesta</h1>
        <p className="text-ink/60 text-sm mt-1 max-w-3xl">
          Qué responde desde Internet en las IPs públicas de la empresa, revisado todos los días desde afuera (solo se intenta la conexión, no se prueban
          contraseñas ni vulnerabilidades), más lo que publica Shodan. Marcá como esperados los puertos que tienen que estar abiertos: cualquier otro avisa.
        </p>
      </div>
      <TareasProgramadas parte="superficie" alTerminar={cargar} />
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-5"><div className="text-xs text-ink/50">Direcciones revisadas</div><div className="font-display text-3xl mt-1">{objs.filter((o) => o.activo).length}</div></div>
        <div className="card p-5"><div className="text-xs text-ink/50">Puertos abiertos</div><div className="font-display text-3xl mt-1">{abiertos.length}</div></div>
        <div className="card p-5"><div className="text-xs text-ink/50">Sin justificar</div><div className={`font-display text-3xl mt-1 ${inesperados.length ? "text-red-600" : "text-emerald-700"}`}>{inesperados.length}</div></div>
        <div className="card p-5"><div className="text-xs text-ink/50">Abiertos esta semana</div><div className={`font-display text-3xl mt-1 ${nuevos.length ? "text-amber-700" : "text-ink"}`}>{nuevos.length}</div></div>
      </div>

      {!objs.length && !cargando && <div className="card p-6 text-sm text-ink/60">Todavía no hay direcciones cargadas.{esAdmin ? " Agregá las IPs públicas de los enlaces (las WAN de los FortiGate) y los nombres publicados, como la VPN o la web." : ""}</div>}

      <div className="flex justify-end">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={verCerrados} onChange={(e) => setVerCerrados(e.target.checked)} />Mostrar también los que se cerraron</label>
      </div>

      {objs.map((o) => {
        const ps = puertos.filter((p) => p.objetivo_id === o.id && (verCerrados || p.abierto));
        const vs = vulns.filter((v) => v.objetivo_id === o.id);
        return (
          <div key={o.id} className="card overflow-x-auto">
            <div className="px-4 pt-4 flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-medium text-ink">{o.direccion}{o.ip && o.ip !== o.direccion && <span className="text-ink/50 font-normal"> · {o.ip}</span>}</div>
                <div className="text-xs text-ink/50">{[o.descripcion, o.hostnames?.length ? o.hostnames.join(", ") : null, o.verificado ? `revisado ${hace(o.verificado)}` : "se revisa en la próxima verificación"].filter(Boolean).join(" · ")}</div>
                {o.error && <div className="text-sm text-red-600">{o.error}</div>}
              </div>
              {esAdmin && <button className="text-xs text-ink/40 hover:text-red-600" onClick={() => quitar(o)}>Dejar de revisar</button>}
            </div>
            <table className="data w-full">
              <thead><tr><th>Puerto</th><th>Servicio</th><th>Estado</th><th>Desde</th><th>Justificación</th><th></th></tr></thead>
              <tbody>
                {!ps.length && <tr><td colSpan={6} className="text-center text-ink/40 py-6">{o.verificado ? "No respondió ningún puerto de la lista." : "Sin datos todavía."}</td></tr>}
                {ps.map((p) => (
                  <tr key={p.puerto} className={p.abierto ? "" : "opacity-50"}>
                    <td className="text-sm font-mono">{p.puerto}</td>
                    <td className="text-sm">{p.servicio ?? "—"}{p.fuente === "shodan" && <span className="text-xs text-ink/45"> · visto por Shodan</span>}</td>
                    <td>{!p.abierto ? <span className="pill bg-line/[0.05] text-ink/50">Cerrado {hace(p.ultima_vez)}</span>
                      : p.esperado ? <span className="pill bg-emerald-50 text-emerald-700">Esperado</span>
                      : <span className={`pill ${RIESGOSOS.has(p.puerto) ? "bg-red-600 text-white" : "bg-amber-500/15 text-amber-700"}`}>{RIESGOSOS.has(p.puerto) ? "Riesgoso" : "Sin justificar"}</span>}</td>
                    <td className="text-sm text-ink/60 whitespace-nowrap">{new Date(p.primera_vez).toLocaleDateString("es-AR")}</td>
                    <td className="text-sm text-ink/70">{p.nota ?? "—"}</td>
                    <td className="text-right whitespace-nowrap">{esAdmin && p.abierto && (
                      p.esperado ? <button className="text-sm text-ink/50 hover:underline" onClick={() => marcar(p, false)}>Quitar justificación</button>
                                 : <button className="text-sm text-brand-600 hover:underline" onClick={() => marcar(p, true)}>Marcar como esperado</button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {vs.length > 0 && (
              <div className="px-4 pb-4 text-sm">
                <div className="font-medium text-ink mb-1">Vulnerabilidades que Shodan asocia a lo publicado ({vs.length})</div>
                <div className="flex flex-wrap gap-1.5">
                  {vs.slice(0, 40).map((v) => <a key={v.cve} href={`https://nvd.nist.gov/vuln/detail/${v.cve}`} target="_blank" rel="noopener noreferrer" className="pill bg-red-50 text-red-700 font-mono hover:underline">{v.cve}</a>)}
                  {vs.length > 40 && <span className="text-xs text-ink/50">y {vs.length - 40} más</span>}
                </div>
                <p className="text-xs text-ink/50 mt-1">Shodan las deduce por la versión que muestra cada servicio: confirmalas contra la versión real del equipo.</p>
              </div>
            )}
          </div>
        );
      })}

      {esAdmin && (
        <form onSubmit={agregar} className="card p-5 grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <label className="block text-sm">IP pública o nombre<input className="input mt-1 font-mono" required placeholder="200.45.10.20 o vpn.accusys.com.ar" value={nuevo.direccion} onChange={(e) => setNuevo({ ...nuevo, direccion: e.target.value })} /></label>
          <label className="block text-sm">Descripción<input className="input mt-1" placeholder="Enlace Telecom · FortiGate Reconquista" value={nuevo.descripcion} onChange={(e) => setNuevo({ ...nuevo, descripcion: e.target.value })} /></label>
          <button className="btn-primary">Agregar</button>
          <p className="text-xs text-ink/50 sm:col-span-3">La revisión sale desde los servidores de Vercel: el FortiGate puede registrarla como un escaneo de puertos. Es normal y ocurre una vez por día.</p>
        </form>
      )}

      {esAdmin && prog && (
        <label className="card p-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={prog.alertas_superficie} onChange={(e) => guardar({ alertas_superficie: e.target.checked })} />
          Enviar alertas: puertos abiertos sin justificar (los riesgosos, como RDP, SMB o bases de datos, con prioridad alta) y vulnerabilidades publicadas
        </label>
      )}
    </div>
  );
}
