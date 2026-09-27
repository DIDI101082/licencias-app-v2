"use client";

import { useMemo, useState } from "react";
import {
  CRITICIDAD, SOPORTE, diasHastaFecha, fechaCorta, useServidores, type Fila,
} from "@/lib/servidores";

type Filtro = "todos" | "sin_soporte" | "por_vencer" | "parches" | "reinicio";

export default function Parches() {
  const { filas, config, cargando, error, ahora } = useServidores();
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const activos = filas.filter((f) => f.activo);

  const atrasado = (f: Fila) => f.diasParche != null && f.diasParche > config.dias_sin_parche;
  const sinDatoParche = (f: Fila) => !!f.disp && f.diasParche == null;

  const tarjetas: { k: Filtro; t: string; n: number; rojo?: boolean }[] = [
    { k: "sin_soporte", t: "Sin soporte del fabricante", n: activos.filter((f) => f.soporte === "sin_soporte").length, rojo: true },
    { k: "por_vencer", t: `Pierden soporte en ${config.dias_aviso_fin_soporte} días`, n: activos.filter((f) => f.soporte === "por_vencer").length },
    { k: "parches", t: `Sin parches hace +${config.dias_sin_parche} días`, n: activos.filter(atrasado).length, rojo: true },
    { k: "reinicio", t: "Reinicio pendiente", n: activos.filter((f) => f.disp?.reinicio_pendiente).length },
  ];

  const lista = useMemo(() => activos
    .filter((f) => filtro === "todos" ? true
      : filtro === "parches" ? atrasado(f)
      : filtro === "reinicio" ? !!f.disp?.reinicio_pendiente
      : f.soporte === filtro)
    .sort((a, b) => SOPORTE[a.soporte].orden - SOPORTE[b.soporte].orden || (b.diasParche ?? -1) - (a.diasParche ?? -1) ||
      CRITICIDAD[a.criticidad].orden - CRITICIDAD[b.criticidad].orden || a.nombre.localeCompare(b.nombre)),
  [activos, filtro]); // eslint-disable-line react-hooks/exhaustive-deps

  // Versiones que se usan y cuándo pierden soporte (resumen)
  const versiones = useMemo(() => {
    const m = new Map<string, { nombre: string; fin: string; n: number }>();
    activos.forEach((f) => {
      if (!f.fin) return;
      const x = m.get(f.fin.nombre) ?? { nombre: f.fin.nombre, fin: f.fin.fin_extendido, n: 0 };
      x.n++; m.set(f.fin.nombre, x);
    });
    return Array.from(m.values()).sort((a, b) => a.fin.localeCompare(b.fin));
  }, [activos]);
  const desconocidos = activos.filter((f) => f.soporte === "desconocido").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Parches y fin de soporte</h1>
        <p className="text-ink/60 text-sm mt-1">
          Un servidor sin soporte del fabricante ya no recibe parches de seguridad: cada vulnerabilidad nueva queda abierta para siempre.
        </p>
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {tarjetas.map((c) => (
          <button key={c.k} onClick={() => setFiltro(filtro === c.k ? "todos" : c.k)} aria-pressed={filtro === c.k}
            className={`card p-5 text-left transition-colors ${filtro === c.k ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{c.t}</div>
            <div className={`font-display text-3xl mt-1 ${c.rojo && c.n ? "text-red-600" : "text-ink"}`}>{c.n}</div>
          </button>
        ))}
      </div>

      {versiones.length > 0 && (
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-3">Versiones en uso</h2>
          <ul className="space-y-2">
            {versiones.map((v) => {
              const dias = diasHastaFecha(v.fin, ahora);
              return (
                <li key={v.nombre} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-ink">{v.nombre} <span className="text-ink/50">· {v.n} {v.n === 1 ? "servidor" : "servidores"}</span></span>
                  <span className={dias < 0 ? "text-red-600 font-medium" : dias <= config.dias_aviso_fin_soporte ? "text-amber-700 font-medium" : "text-ink/60"}>
                    {dias < 0 ? `sin soporte desde el ${fechaCorta(v.fin)}` : `con soporte hasta el ${fechaCorta(v.fin)}${dias <= 365 ? ` (faltan ${dias} días)` : ""}`}
                  </span>
                </li>
              );
            })}
          </ul>
          {desconocidos > 0 && (
            <p className="text-xs text-ink/50 mt-3">
              {desconocidos} {desconocidos === 1 ? "servidor no tiene" : "servidores no tienen"} fecha de fin de soporte: falta el sistema operativo
              (agente o dato manual) o la versión no está en la tabla de Configuración.
            </p>
          )}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Servidor</th><th>Sistema operativo</th><th>Soporte</th><th>Último parche</th><th>Reinicio</th></tr></thead>
          <tbody>
            {cargando && <tr><td colSpan={5} className="text-center text-ink/40 py-10">Cargando…</td></tr>}
            {!cargando && !lista.length && <tr><td colSpan={5} className="text-center text-ink/40 py-10">Ningún servidor en esta situación.</td></tr>}
            {lista.map((f) => (
              <tr key={f.id}>
                <td>
                  <div className="font-medium text-ink">{f.nombre}</div>
                  <span className={`pill mt-0.5 ${CRITICIDAD[f.criticidad].c}`}>{CRITICIDAD[f.criticidad].t}</span>
                </td>
                <td className="text-sm">
                  <div className="text-ink/80">{f.so ?? "—"}</div>
                  {f.disp?.so_build && <div className="text-xs text-ink/50">Build {f.disp.so_build}{f.disp.so_version && !f.disp.so_build.startsWith(f.disp.so_version) ? ` · ${f.disp.so_version}` : ""}</div>}
                  {!f.disp && f.so && <div className="text-xs text-ink/50">Cargado a mano</div>}
                </td>
                <td className="text-sm">
                  <span className={`pill ${SOPORTE[f.soporte].c}`}>{SOPORTE[f.soporte].t}</span>
                  {f.fin && (
                    <div className="text-xs text-ink/60 mt-0.5">
                      {f.soporte === "sin_soporte" ? "desde el " : "hasta el "}{fechaCorta(f.fin.fin_extendido)}
                      {f.fin.fin_estandar && diasHastaFecha(f.fin.fin_estandar, ahora) < 0 && f.soporte !== "sin_soporte" && (
                        <span className="block text-ink/45">Soporte general terminado el {fechaCorta(f.fin.fin_estandar)}: solo parches de seguridad</span>
                      )}
                      {f.fin.notas && <span className="block text-ink/45">{f.fin.notas}</span>}
                    </div>
                  )}
                </td>
                <td className="text-sm">
                  {!f.disp ? <span className="text-ink/40">Sin agente</span> : sinDatoParche(f) ? <span className="text-ink/40">Sin datos</span> : (
                    <>
                      <div className={atrasado(f) ? "text-red-600 font-medium" : "text-ink/80"}>
                        {f.diasParche === 0 ? "hoy" : `hace ${f.diasParche} ${f.diasParche === 1 ? "día" : "días"}`}
                      </div>
                      {f.disp.ultimo_parche_titulo && <div className="text-xs text-ink/50 max-w-xs truncate" title={f.disp.ultimo_parche_titulo}>{f.disp.ultimo_parche_titulo}</div>}
                    </>
                  )}
                </td>
                <td className="text-sm">
                  {f.disp?.reinicio_pendiente ? <span className="pill bg-amber-500/10 text-amber-700">Pendiente</span> : f.disp ? <span className="text-ink/40">No</span> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Las fechas de fin de soporte salen de la tabla de Configuración (precargada con Windows Server y las distribuciones Linux más comunes).
        Los parches y el reinicio pendiente los informa el agente.
      </p>
    </div>
  );
}
