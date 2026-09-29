"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { useEstadoProg } from "@/components/TareasProgramadas";
import { calcularIndicadores, nivel, type Kpi } from "@/lib/indicadores";
import { COLOR } from "@/components/indicadores-estilo";

type Datos = Record<string, any>;
type Respuesta = { guardado: boolean; generado?: string; datos: Datos; kpis: Kpi[] | null };

const REGLAS: Record<string, string> = {
  prtg_caido: "Equipos de red caídos", puente_caido: "Puente de PRTG", amenaza: "Amenazas", fuera_pais: "Equipos fuera del país",
  sin_reportar: "Equipos que no reportan", sin_cifrar: "Discos sin cifrar", sin_parches: "Sin parches", antivirus: "Antivirus",
  software_prohibido: "Software prohibido", equipo_pendiente: "Equipos por aprobar", vulnerabilidad: "Vulnerabilidades", vencimiento: "Vencimientos",
  baja_pendiente: "Bajas sin cerrar", revision_accesos: "Revisión de accesos", backup: "Backups", servidor: "Servidores", wifi: "WiFi",
  switch: "Switches", fortigate: "FortiGate", ad: "Active Directory", acceso: "Accesos a servidores", virtualizacion: "Virtualización y storage",
  securescore: "Secure Score", correo: "Correo y dominio", superficie: "Superficie expuesta", normativa: "Normativa", programadas: "Verificaciones diarias",
};
const SEV = [["critica", "Críticas", "text-red-700"], ["alta", "Altas", "text-orange-700"], ["media", "Medias", "text-amber-700"], ["info", "Informativas", "text-ink/60"]] as const;
const mesTxt = (m: string) => new Date(m + "-15T12:00").toLocaleDateString("es-AR", { month: "long", year: "numeric" });
const mesActual = () => new Date().toISOString().slice(0, 7);
const ultimos = (n: number) => Array.from({ length: n }, (_, i) => { const d = new Date(); d.setDate(15); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7); });

function Cifra({ t, v, c = "text-ink", sub }: { t: string; v: any; c?: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-ink/50">{t}</div>
      <div className={`font-display text-3xl mt-1 tabular-nums ${v == null ? "text-ink/30" : c}`}>{v ?? "—"}</div>
      {sub && <div className="text-xs text-ink/50 mt-0.5">{sub}</div>}
    </div>
  );
}
function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return <section className="space-y-2 break-inside-avoid"><h2 className="font-display text-lg text-ink">{titulo}</h2>{children}</section>;
}

function Contenido() {
  const { esAdmin, puedeEditar } = usePerfil();
  const { estado: prog, guardar: guardarProg } = useEstadoProg();
  const params = useSearchParams();
  const router = useRouter();
  const mes = /^\d{4}-\d{2}$/.test(params.get("mes") ?? "") ? params.get("mes")! : mesActual();
  const [r, setR] = useState<Respuesta | null>(null);
  const [kpisHoy, setKpisHoy] = useState<Kpi[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setR(null); setError(null);
    const { data, error } = await createClient().rpc("informe_ver", { p_mes: `${mes}-01` });
    if (error) return setError(/informe_ver/.test(error.message) ? "Falta ejecutar supabase/postura.sql en Supabase." : error.message);
    setR(data as Respuesta);
  }, [mes]);
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { calcularIndicadores(createClient()).then(setKpisHoy); }, []);

  async function guardar(recalcular: boolean) {
    setGuardando(true);
    const { error } = await createClient().rpc("informe_guardar", { p_mes: `${mes}-01`, p_kpis: kpisHoy, p_recalcular: recalcular });
    setGuardando(false);
    if (error) return setError(error.message);
    cargar();
  }

  const d = r?.datos ?? {};
  const kpis = r?.kpis ?? (r && !r.guardado ? kpisHoy : null);
  const ss = d.securescore?.fin;
  const ssIni = d.securescore?.inicio;
  const esActual = mes === mesActual();
  const medidos = (kpis ?? []).filter((k) => nivel(k) !== "nd");
  const puntaje = medidos.length ? Math.round((100 * medidos.filter((k) => nivel(k) === "ok").length) / medidos.length) : null;

  return (
    <div className="space-y-6">
      <style>{`@media print { @page { size: A4; margin: 14mm; } body { background: #fff !important; } .card { box-shadow: none !important; border: 1px solid #ddd !important; break-inside: avoid; } a { color: inherit !important; text-decoration: none !important; } }`}</style>

      <div className="hidden print:block border-b pb-3">
        <div className="text-xs uppercase tracking-wide text-ink/50">Accusys Technology · Ciberseguridad y Tecnología</div>
        <div className="font-display text-2xl text-ink">Informe mensual de seguridad · {mesTxt(mes)}</div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="font-display text-2xl text-ink">Informe mensual</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Resumen de seguridad del mes para la dirección: alertas, incidentes, accesos, identidad, perímetro, vencimientos y normativa.
            El día 1 se cierra solo el del mes anterior y llega un aviso a Teams.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select className="input w-auto" value={mes} onChange={(e) => router.replace(`/inventario/informe?mes=${e.target.value}`, { scroll: false })} aria-label="Mes">
            {ultimos(13).map((m) => <option key={m} value={m}>{mesTxt(m)}</option>)}
          </select>
          <button className="btn-primary" disabled={!r} onClick={() => window.print()}>Exportar PDF</button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {r && (
        <div className="card p-3 text-sm flex flex-wrap items-center gap-3 print:hidden">
          {r.guardado
            ? <span>Informe cerrado el {new Date(r.generado!).toLocaleString("es-AR")}. {r.kpis ? "Incluye los indicadores de Cumplimiento de ese momento." : "No tiene los indicadores de Cumplimiento guardados."}</span>
            : <span>{esActual ? "Mes en curso: los números se calculan en el momento." : "Este mes todavía no se cerró: se calcula en el momento."}</span>}
          {puedeEditar && (
            <span className="ml-auto flex gap-2">
              {r.guardado && !r.kpis && <button className="btn-secondary" disabled={guardando || !kpisHoy} onClick={() => guardar(false)}>Agregar indicadores de hoy</button>}
              {!r.guardado && !esActual && <button className="btn-secondary" disabled={guardando || !kpisHoy} onClick={() => guardar(false)}>Cerrar este informe</button>}
              {r.guardado && esAdmin && <button className="btn-secondary" disabled={guardando} onClick={() => confirm("Se reemplazan los números guardados por los de hoy. ¿Seguir?") && guardar(true)}>Volver a calcular</button>}
            </span>
          )}
        </div>
      )}

      {!r && !error && <p className="text-sm text-ink/50">Calculando…</p>}
      {r && (
        <>
          <Seccion titulo="Resumen">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Cifra t="Indicadores que cumplen la meta" v={puntaje == null ? null : `${puntaje}%`} c={puntaje != null && puntaje >= 80 ? "text-emerald-700" : "text-amber-700"} sub={kpis ? `${medidos.length} medidos` : "sin indicadores"} />
              <Cifra t="Alertas nuevas" v={d.alertas?.nuevas} sub={d.alertas ? `${d.alertas.resueltas} resueltas en el mes` : undefined} />
              <Cifra t="Incidentes registrados" v={d.incidentes?.registrados} c={d.incidentes?.registrados ? "text-amber-700" : "text-ink"} sub={d.incidentes ? `${d.incidentes.abiertos} abiertos al cierre` : undefined} />
              <Cifra t="Secure Score" v={ss?.maximo ? `${Math.round((100 * ss.actual) / ss.maximo)}%` : null}
                sub={ss && ssIni ? `${Math.round(ssIni.actual)} → ${Math.round(ss.actual)} puntos` : undefined} />
            </div>
          </Seccion>

          {d.alertas && (
            <Seccion titulo="Alertas">
              <div className="grid md:grid-cols-2 gap-3">
                <div className="card p-4 flex justify-around text-center">
                  {SEV.map(([k, t, c]) => <div key={k}><div className={`font-display text-2xl ${c}`}>{d.alertas.por_severidad?.[k] ?? 0}</div><div className="text-xs text-ink/50">{t}</div></div>)}
                </div>
                <div className="card p-4">
                  <div className="text-xs text-ink/50 mb-1">Por tema</div>
                  {(d.alertas.por_regla ?? []).length === 0 ? <p className="text-sm text-ink/50">Sin alertas en el mes.</p> : (
                    <ul className="text-sm space-y-0.5">{d.alertas.por_regla.map((x: any) => <li key={x.regla} className="flex justify-between"><span>{REGLAS[x.regla] ?? x.regla}</span><span className="tabular-nums">{x.n}</span></li>)}</ul>
                  )}
                </div>
              </div>
            </Seccion>
          )}

          <Seccion titulo="Amenazas, accesos y personas">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Cifra t="Detecciones de ESET" v={d.eset?.detecciones} sub={d.eset ? `${d.eset.altas} de severidad alta · ${d.eset.sin_resolver} sin resolver` : undefined} />
              <Cifra t="Ingresos a servidores" v={d.accesos?.inicios} sub={d.accesos ? `${d.accesos.fallos} intentos fallidos` : undefined} />
              <Cifra t="Ingresos no autorizados o fuera de horario" v={d.accesos ? d.accesos.no_autorizados + d.accesos.fuera_horario : null} c={d.accesos && d.accesos.no_autorizados + d.accesos.fuera_horario ? "text-red-600" : "text-ink"}
                sub={d.accesos ? `${d.accesos.no_autorizados} no autorizados · ${d.accesos.fuera_horario} fuera de horario · ${d.accesos.cuentas_locales} con cuenta local` : undefined} />
              <Cifra t="Altas y bajas de personal" v={d.personas ? `${d.personas.altas} / ${d.personas.bajas}` : null} sub={d.personas ? `${d.personas.bajas_abiertas} bajas sin cerrar hoy` : undefined} />
            </div>
          </Seccion>

          <Seccion titulo="Identidad, perímetro y correo">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Cifra t="Cuentas sin MFA" v={d.identidad?.sin_mfa} c={d.identidad?.sin_mfa ? "text-red-600" : "text-emerald-700"} sub={d.identidad ? `de ${d.identidad.miembros} · ${d.identidad.admins_sin_mfa ?? 0} administradores` : undefined} />
              <Cifra t="Puertos expuestos sin justificar" v={d.superficie?.inesperados} c={d.superficie?.inesperados ? "text-red-600" : "text-emerald-700"} sub={d.superficie ? `${d.superficie.abiertos} abiertos en ${d.superficie.direcciones} direcciones · ${d.superficie.nuevos_mes} nuevos en el mes` : undefined} />
              <Cifra t="Dominios con problemas de correo" v={d.correo?.con_problemas} c={d.correo?.con_problemas ? "text-amber-700" : "text-emerald-700"} sub={d.correo ? `de ${d.correo.dominios} · ${d.correo.cambios_mes} cambios de DNS en el mes` : undefined} />
              <Cifra t="Versiones con vulnerabilidades explotadas" v={d.vulnerabilidades?.versiones_kev} c={d.vulnerabilidades?.versiones_kev ? "text-red-600" : "text-emerald-700"} sub={d.backups ? `Backups: ${d.backups.fallidos} de ${d.backups.trabajos} trabajos con falla` : undefined} />
            </div>
          </Seccion>

          {d.vencimientos && (
            <Seccion titulo="Vencimientos">
              <div className="card p-4 text-sm">
                <div className="mb-2">{d.vencimientos.vencidos ? <span className="text-red-600 font-medium">{d.vencimientos.vencidos} vencido(s). </span> : null}Próximos 60 días (al cierre):</div>
                {(d.vencimientos.proximos ?? []).length === 0 ? <p className="text-ink/50">Nada vence en los próximos 60 días.</p> : (
                  <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-0.5">{d.vencimientos.proximos.map((v: any, i: number) => <li key={i} className="flex justify-between gap-3"><span className="truncate">{v.descripcion}</span><span className="text-ink/60 whitespace-nowrap">{new Date(v.fecha + "T12:00").toLocaleDateString("es-AR")}</span></li>)}</ul>
                )}
              </div>
            </Seccion>
          )}

          {(d.normativa ?? []).length > 0 && (
            <Seccion titulo="Normativa">
              <div className="grid md:grid-cols-2 gap-3">
                {d.normativa.map((n: any) => {
                  const ev = n.total - n.no_aplica - n.sin_evaluar;
                  const pc = ev ? Math.round((100 * (n.cumple + 0.5 * n.parcial)) / ev) : null;
                  return (
                    <div key={n.marco} className="card p-4">
                      <div className="flex justify-between"><span className="font-medium">{n.marco === "BCRA" ? 'BCRA "A" 7724' : "ISO/IEC 27001:2022"}</span><span className="font-display text-xl">{pc == null ? "—" : `${pc}%`}</span></div>
                      <div className="text-xs text-ink/60 mt-1">{n.cumple} cumplen · {n.parcial} parciales · {n.no_cumple} no cumplen · {n.sin_evaluar} sin evaluar · {n.no_aplica} no aplican</div>
                    </div>
                  );
                })}
              </div>
            </Seccion>
          )}

          {kpis && (
            <Seccion titulo={`Indicadores de cumplimiento${r.guardado ? "" : " (al día de hoy)"}`}>
              <div className="card overflow-x-auto">
                <table className="data w-full">
                  <tbody>
                    {kpis.map((k) => {
                      const n = nivel(k);
                      return (
                        <tr key={k.clave}>
                          <td className="text-sm text-ink/60">{k.area}</td>
                          <td className="text-sm">{k.titulo}</td>
                          <td className={`text-sm tabular-nums ${COLOR[n].texto}`}>{k.valor == null ? "—" : `${k.valor}${k.unidad === "%" ? "%" : ""}`}</td>
                          <td className="text-xs text-ink/50">meta {k.menorEsMejor ? (k.meta === 0 ? "ninguno" : `≤ ${k.meta}`) : `≥ ${k.meta}${k.unidad === "%" ? "%" : ""}`}</td>
                          <td className={`text-xs ${COLOR[n].texto}`}>{COLOR[n].etiqueta}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Seccion>
          )}
          <p className="text-xs text-ink/45">Calculado el {new Date(d.calculado).toLocaleString("es-AR")}. Los valores “al cierre” reflejan el estado en ese momento.</p>
        </>
      )}

      {esAdmin && prog && (
        <label className="card p-4 flex items-center gap-2 text-sm print:hidden">
          <input type="checkbox" checked={prog.informe_mensual} onChange={(e) => guardarProg({ informe_mensual: e.target.checked })} />
          Cerrar el informe automáticamente el día 1 y avisar por Teams (usa el canal de Logs → Alertas)
        </label>
      )}
    </div>
  );
}

export default function Informe() {
  return <Suspense><Contenido /></Suspense>;
}
