"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { exportarExcel } from "@/lib/excel";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

type Origen = "propia" | "microsoft" | "terceros" | "identidad_administrada";
type App = {
  id: string; app_id: string; nombre: string; origen: Origen; editor: string | null; habilitada: boolean;
  ultimo_uso: string | null; ingresos_ok: number | null; ingresos_fallidos: number | null;
  delegados: string[]; de_aplicacion: string[]; sensibles: string[]; consentimiento_usuario: boolean;
  credenciales: { tipo: "secreto" | "certificado"; nombre: string | null; vence: string | null }[];
  vence: string | null; vencidas: number;
};
type Borrada = { id: string; app_id: string | null; nombre: string; objeto: "registro" | "empresarial"; borrada: string | null; se_purga: string | null };
type Accion = "borrada" | "borrada_definitiva" | "deshabilitada" | "reactivada" | "restaurada";
type Cambio = { evento_id: string; fecha: string; accion: Accion; objeto: "registro" | "empresarial"; objeto_id: string | null; app_id: string | null; aplicacion: string; actor: string | null; ip: string | null };
type Cambios = { alertar?: boolean; leido_hasta?: string | null; ultima_ejecucion?: string | null; ultimo_error?: string | null; eventos?: Cambio[]; falta?: boolean; error?: string };
type Respuesta = {
  configurado: boolean; error?: string; apps?: App[]; borradas?: Borrada[] | null; cambios?: Cambios | null; avisos?: string[]; consultado?: string;
  disponibles?: { uso: boolean; ingresos: boolean; delegados: boolean; aplicacion: boolean; credenciales: boolean };
};
type Filtro = "en_uso" | "sin_uso" | "riesgo" | "vencen" | "deshabilitadas" | "borradas" | "cambios" | "todas";

const ORIGEN: Record<Origen, string> = { propia: "Propia", microsoft: "Microsoft", terceros: "Terceros", identidad_administrada: "Identidad administrada" };
const ACCION: Record<Accion, { txt: string; cls: string }> = {
  borrada: { txt: "Borrada", cls: "bg-red-50 text-red-700" },
  borrada_definitiva: { txt: "Borrada definitivamente", cls: "bg-red-100 text-red-800" },
  deshabilitada: { txt: "Deshabilitada", cls: "bg-amber-50 text-amber-800" },
  reactivada: { txt: "Reactivada", cls: "bg-emerald-50 text-emerald-700" },
  restaurada: { txt: "Restaurada", cls: "bg-emerald-50 text-emerald-700" },
};
const OBJETO = { registro: "Registro de aplicación", empresarial: "Aplicación empresarial" };
const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fd = (f: string | null) => (f ? new Date(f).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "—");
const dias = (f: string | null) => (f ? Math.floor((Date.now() - Date.parse(f)) / 86400000) : null);
const faltan = (f: string | null) => (f ? Math.ceil((Date.parse(f) - Date.now()) / 86400000) : null);
const portal = (a: App) => `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/${a.id}/appId/${a.app_id}`;

export default function AppsEntra() {
  const { esAdmin } = usePerfil();
  const [d, setD] = useState<Respuesta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [filtro, setFiltro] = useState<Filtro>("en_uso");
  const [sinUso, setSinUso] = useState(90);
  const [conMicrosoft, setConMicrosoft] = useState(false);
  const [q, setQ] = useState("");
  const [abierta, setAbierta] = useState<string | null>(null);

  const cargar = async () => {
    setCargando(true);
    setD(await fetch("/api/entra/apps").then((x) => x.json()).catch((e) => ({ configurado: true, error: String(e) })));
    setCargando(false);
  };
  useEffect(() => { cargar(); }, []);
  const guardarAlertar = async (alertar: boolean) => {
    await createClient().rpc("entra_apps_cambios_guardar", { p: { alertar } });
    cargar();
  };

  const disp = d?.disponibles;
  // Las aplicaciones propias de Microsoft (Office, Teams, etc.) son cientos y no se administran: se ocultan salvo que se pidan
  const base = useMemo(() => (d?.apps ?? []).filter((a) => conMicrosoft || a.origen !== "microsoft"), [d, conMicrosoft]);

  const enUso = (a: App) => (a.ingresos_ok ?? 0) + (a.ingresos_fallidos ?? 0) > 0 || (dias(a.ultimo_uso) ?? 999) <= 30;
  const esSinUso = (a: App) => a.habilitada && (a.ultimo_uso ? dias(a.ultimo_uso)! > sinUso : !enUso(a));
  const esRiesgo = (a: App) => a.origen === "terceros" && (a.sensibles.length > 0 || a.consentimiento_usuario);
  const porVencer = (a: App) => a.vencidas > 0 || (faltan(a.vence) ?? 999) <= 60;

  const cuenta = {
    en_uso: disp?.uso || disp?.ingresos ? base.filter(enUso).length : null,
    sin_uso: disp?.uso ? base.filter(esSinUso).length : null,
    riesgo: disp?.delegados || disp?.aplicacion ? base.filter(esRiesgo).length : null,
    vencen: disp?.credenciales ? base.filter(porVencer).length : null,
  };

  const camb = d?.cambios && !d.cambios.error ? d.cambios : null;
  const ultimos7 = (camb?.eventos ?? []).filter((c) => ["borrada", "borrada_definitiva", "deshabilitada"].includes(c.accion) && Date.now() - Date.parse(c.fecha) <= 7 * 86400000).length;
  const coincide = (vals: (string | null | undefined)[]) => { const t = q.trim().toLowerCase(); return !t || vals.some((v) => v?.toLowerCase().includes(t)); };
  const listaCambios = (camb?.eventos ?? []).filter((c) => coincide([c.aplicacion, c.actor, c.app_id, c.ip]));
  const listaBorradas = (d?.borradas ?? []).filter((b) => coincide([b.nombre, b.app_id]));
  const deshabilitadas = base.filter((a) => !a.habilitada).length;

  const lista = useMemo(() => {
    const t = q.trim().toLowerCase();
    return base
      .filter((a) => !t || [a.nombre, a.editor, a.app_id].some((v) => v?.toLowerCase().includes(t)))
      .filter((a) => filtro === "todas" || (filtro === "en_uso" ? enUso(a) : filtro === "sin_uso" ? esSinUso(a) : filtro === "riesgo" ? esRiesgo(a)
        : filtro === "deshabilitadas" ? !a.habilitada : filtro === "vencen" ? porVencer(a) : false))
      .sort((a, b) => filtro === "vencen" ? (a.vencidas ? -1 : faltan(a.vence) ?? 9999) - (b.vencidas ? -1 : faltan(b.vence) ?? 9999)
        : filtro === "sin_uso" ? (a.ultimo_uso ?? "").localeCompare(b.ultimo_uso ?? "")
        : ((b.ingresos_ok ?? 0) - (a.ingresos_ok ?? 0)) || (b.ultimo_uso ?? "").localeCompare(a.ultimo_uso ?? "") || a.nombre.localeCompare(b.nombre));
  }, [base, filtro, q, sinUso]); // eslint-disable-line react-hooks/exhaustive-deps

  const hoy = new Date().toISOString().slice(0, 10);
  const exportar = () => filtro === "cambios"
    ? exportarExcel(`aplicaciones-entra-cambios-${hoy}`, ["Fecha", "Aplicación", "Acción", "Tipo", "Quién", "IP", "Id de aplicación"],
        listaCambios.map((c) => [fh(c.fecha), c.aplicacion, ACCION[c.accion].txt, OBJETO[c.objeto], c.actor, c.ip, c.app_id]))
    : filtro === "borradas"
    ? exportarExcel(`aplicaciones-entra-borradas-${hoy}`, ["Aplicación", "Tipo", "Borrada", "Se elimina definitivamente", "Id de aplicación"],
        listaBorradas.map((b) => [b.nombre, OBJETO[b.objeto], fh(b.borrada), fd(b.se_purga), b.app_id]))
    : exportarExcel(`aplicaciones-entra-${hoy}`,
    ["Aplicación", "Origen", "Editor verificado", "Habilitada", "Último uso", "Ingresos correctos (30 días)", "Ingresos fallidos (30 días)", "Permisos delegados", "Permisos de aplicación", "Permisos sensibles", "Consentida por un usuario", "Próximo vencimiento", "Credenciales vencidas", "Id de aplicación"],
    lista.map((a) => [a.nombre, ORIGEN[a.origen], a.editor, a.habilitada ? "Sí" : "No", a.ultimo_uso ? fd(a.ultimo_uso) : disp?.uso ? "Nunca" : "", a.ingresos_ok, a.ingresos_fallidos,
      a.delegados.join(", "), a.de_aplicacion.join(", "), a.sensibles.join(", "), a.consentimiento_usuario ? "Sí" : "No", a.vence ? fd(a.vence) : "", a.vencidas, a.app_id]));

  const tarjeta = (f: Filtro, titulo: string, valor: number | null, malo: boolean, sub: string) => (
    <button onClick={() => setFiltro(f)} className={`card p-4 text-left transition ${filtro === f ? "ring-2 ring-brand-600" : "hover:ring-1 hover:ring-line/20"}`}>
      <div className="text-xs text-ink/50">{titulo}</div>
      <div className={`font-display text-3xl mt-1 ${valor == null ? "text-ink/30" : malo && valor > 0 ? "text-red-600" : "text-ink"}`}>{valor ?? "N/D"}</div>
      <div className="text-xs text-ink/50 mt-1">{sub}</div>
    </button>
  );
  const chip = (p: string, sensible: boolean) => (
    <span key={p} className={`inline-block rounded px-1.5 py-0.5 text-xs mr-1 mb-1 ${sensible ? "bg-red-50 text-red-700" : "bg-line/[0.06] text-ink/70"}`}>{p}</span>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Aplicaciones de Entra ID</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Las aplicaciones conectadas al tenant de Microsoft 365: cuáles se usan de verdad, cuáles quedaron sin uso, qué permisos
            tienen sobre correo, archivos y directorio, y qué secretos o certificados están por vencer. Solo lectura.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink/60">Sin uso después de</label>
          <select className="input w-auto" value={sinUso} onChange={(e) => setSinUso(Number(e.target.value))} aria-label="Días sin uso">
            {[30, 60, 90, 180].map((n) => <option key={n} value={n}>{n} días</option>)}
          </select>
          <button className="btn-secondary" onClick={cargar} disabled={cargando}>{cargando ? "Consultando…" : "Actualizar"}</button>
        </div>
      </div>

      {d && !d.configurado && (
        <div className="card p-4 text-sm">
          Falta configurar la conexión con Entra ID (variables <code>AZURE_TENANT_ID</code>, <code>AZURE_CLIENT_ID</code> y{" "}
          <code>AZURE_CLIENT_SECRET</code> en Vercel). Es la misma app que usa la sincronización de empleados.
        </div>
      )}
      {d?.error && <div role="alert" className="card p-3 text-sm text-red-600 bg-red-50">{d.error}</div>}
      {!!d?.avisos?.length && (
        <div className="card p-3 text-sm bg-amber-50 text-amber-800 space-y-1">
          <div className="font-medium">Algunos datos no están disponibles:</div>
          {d.avisos.map((a) => <div key={a}>• {a}</div>)}
          <div className="text-xs text-amber-700/80 pt-1">
            Los permisos se agregan en Entra → Registros de aplicaciones → tu app → Permisos de API → Microsoft Graph → Permisos de
            aplicación, y después “Conceder consentimiento de administrador”. Son todos de lectura.
          </div>
        </div>
      )}

      {ultimos7 > 0 && filtro !== "cambios" && (
        <button onClick={() => setFiltro("cambios")} className="card w-full p-3 text-left text-sm bg-red-50 text-red-700 hover:ring-1 hover:ring-red-300">
          {ultimos7} aplicación{ultimos7 === 1 ? "" : "es"} borrada{ultimos7 === 1 ? "" : "s"} o deshabilitada{ultimos7 === 1 ? "" : "s"} en los últimos 7 días. Ver quién lo hizo →
        </button>
      )}

      {d?.apps && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {tarjeta("en_uso", "En uso", cuenta.en_uso, false, "con inicios de sesión en los últimos 30 días")}
          {tarjeta("sin_uso", `Sin uso hace ${sinUso}+ días`, cuenta.sin_uso, true, cuenta.sin_uso != null ? "habilitadas, candidatas a eliminar" : "Requiere Entra ID P1")}
          {tarjeta("riesgo", "De terceros a revisar", cuenta.riesgo, true, "con permisos sensibles o aceptadas por un usuario")}
          {tarjeta("vencen", "Secretos por vencer", cuenta.vencen, true, "vencidos o que vencen en 60 días")}
        </div>
      )}

      {d?.apps && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-line/[0.08]">
            <div className="flex flex-wrap gap-1 text-sm">
              {([["en_uso", "En uso"], ["sin_uso", "Sin uso"], ["riesgo", "A revisar"], ["vencen", "Por vencer"],
                ["deshabilitadas", `Deshabilitadas (${deshabilitadas})`], ["borradas", `Borradas${d.borradas ? ` (${d.borradas.length})` : ""}`],
                ["cambios", "Cambios"], ["todas", "Todas"]] as [Filtro, string][]).map(([k, t]) => (
                <button key={k} onClick={() => setFiltro(k)} aria-pressed={filtro === k}
                  className={`px-3 py-1 rounded-full ${filtro === k ? "bg-brand-600 text-white" : "text-ink/60 hover:bg-line/[0.05]"}`}>{t}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink/60">
                <input type="checkbox" checked={conMicrosoft} onChange={(e) => setConMicrosoft(e.target.checked)} /> Incluir las de Microsoft
              </label>
              <input className="input w-56" placeholder={filtro === "cambios" ? "Buscar aplicación o persona" : "Buscar aplicación o editor"} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
              <button className="btn-secondary" onClick={exportar}
                disabled={!(filtro === "cambios" ? listaCambios.length : filtro === "borradas" ? listaBorradas.length : lista.length)}>Excel</button>
            </div>
          </div>
          {filtro === "cambios" ? (
            <div>
              <div className="p-3 text-sm text-ink/60 space-y-2 border-b border-line/[0.08]">
                {!camb ? (
                  <p>{d.cambios?.falta
                    ? "Para registrar quién borra o deshabilita aplicaciones, ejecutá supabase/entra-apps-cambios.sql en Supabase. La primera lectura trae los últimos 30 días."
                    : `No se pudo leer el historial: ${d.cambios?.error ?? "sin datos"}`}</p>
                ) : (
                  <>
                    <p>Aplicaciones borradas, deshabilitadas, reactivadas o restauradas según la auditoría de Entra ID. Se revisa cada 15 minutos y se guarda 2 años
                      {camb.ultima_ejecucion ? ` · última revisión ${fh(camb.ultima_ejecucion)}` : " · todavía no corrió la primera revisión"}.</p>
                    {camb.ultimo_error && <p role="alert" className="text-red-600 bg-red-50 rounded-md px-3 py-2">La última revisión falló: {camb.ultimo_error}</p>}
                    {esAdmin && (
                      <label className="flex items-center gap-2 text-ink/70">
                        <input type="checkbox" checked={!!camb.alertar} onChange={(e) => guardarAlertar(e.target.checked)} />
                        Avisar por Teams cuando se borre o deshabilite una aplicación
                      </label>
                    )}
                  </>
                )}
              </div>
              {camb && (
                <div className="overflow-x-auto">
                  <table className="data w-full">
                    <thead><tr><th>Fecha</th><th>Aplicación</th><th>Acción</th><th>Quién lo hizo</th><th>Desde</th></tr></thead>
                    <tbody>
                      {!listaCambios.length && <tr><td colSpan={5} className="text-center text-ink/50 py-6">Sin cambios registrados.</td></tr>}
                      {listaCambios.map((c) => (
                        <tr key={c.evento_id}>
                          <td className="text-sm whitespace-nowrap">{fh(c.fecha)}</td>
                          <td className="text-sm"><div className="font-medium text-ink">{c.aplicacion}</div><div className="text-xs text-ink/45">{OBJETO[c.objeto]}</div></td>
                          <td className="text-sm"><span className={`inline-block rounded px-2 py-0.5 text-xs ${ACCION[c.accion].cls}`}>{ACCION[c.accion].txt}</span></td>
                          <td className="text-sm">{c.actor ?? "—"}</td>
                          <td className="text-sm font-mono text-xs">{c.ip ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : filtro === "borradas" ? (
            <div className="overflow-x-auto">
              <p className="p-3 text-sm text-ink/60 border-b border-line/[0.08]">
                Aplicaciones en la papelera de Entra ID: se pueden restaurar desde Entra hasta 30 días después de borradas; después se eliminan solas.
                Para saber quién las borró, mirá la solapa Cambios.
              </p>
              {d.borradas == null ? <p className="p-3 text-sm text-ink/50">No disponible (ver avisos arriba).</p> : (
                <table className="data w-full">
                  <thead><tr><th>Aplicación</th><th>Tipo</th><th>Borrada</th><th>Se puede restaurar hasta</th></tr></thead>
                  <tbody>
                    {!listaBorradas.length && <tr><td colSpan={4} className="text-center text-ink/50 py-6">No hay aplicaciones borradas en los últimos 30 días.</td></tr>}
                    {listaBorradas.map((b) => {
                      const f = faltan(b.se_purga);
                      return (
                        <tr key={`${b.objeto}:${b.id}`}>
                          <td className="text-sm"><div className="font-medium text-ink">{b.nombre}</div>{b.app_id && <div className="text-xs text-ink/45 font-mono">{b.app_id}</div>}</td>
                          <td className="text-sm text-ink/70">{OBJETO[b.objeto]}</td>
                          <td className="text-sm whitespace-nowrap">{fh(b.borrada)}</td>
                          <td className="text-sm whitespace-nowrap">{fd(b.se_purga)}{f != null && <div className={`text-xs ${f <= 7 ? "text-red-600" : "text-ink/45"}`}>en {f} día{f === 1 ? "" : "s"}</div>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
          <div className="overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Aplicación</th><th>Origen</th><th>Último uso</th><th>Ingresos (30 días)</th><th>Permisos</th><th>Secreto / certificado</th><th></th></tr></thead>
              <tbody>
                {!lista.length && <tr><td colSpan={7} className="text-center text-ink/50 py-6">Nada para revisar en esta vista.</td></tr>}
                {lista.map((a) => {
                  const hace = dias(a.ultimo_uso), f = faltan(a.vence), total = a.delegados.length + a.de_aplicacion.length;
                  return (
                    <Fragment key={a.id}>
                      <tr>
                        <td className="text-sm">
                          <div className="font-medium text-ink">{a.nombre}</div>
                          <div className="text-xs text-ink/45">{a.editor ? `${a.editor} · editor verificado` : a.origen === "terceros" ? "Editor sin verificar" : ""}{!a.habilitada && " · deshabilitada"}</div>
                        </td>
                        <td className="text-sm text-ink/70 whitespace-nowrap">{ORIGEN[a.origen]}</td>
                        <td className="text-sm whitespace-nowrap">
                          {!disp?.uso ? <span className="text-ink/40">N/D</span> : a.ultimo_uso
                            ? <><span className={hace! > sinUso ? "text-red-600" : "text-ink"}>{fd(a.ultimo_uso)}</span><div className="text-xs text-ink/45">hace {hace} día{hace === 1 ? "" : "s"}</div></>
                            : <span className="text-amber-700">Sin registro de uso</span>}
                        </td>
                        <td className="text-sm tabular-nums whitespace-nowrap">
                          {a.ingresos_ok == null ? <span className="text-ink/40">N/D</span> : <>{a.ingresos_ok.toLocaleString("es-AR")}
                            {!!a.ingresos_fallidos && <div className="text-xs text-amber-700">{a.ingresos_fallidos.toLocaleString("es-AR")} fallidos</div>}</>}
                        </td>
                        <td className="text-sm">
                          {total === 0 ? <span className="text-ink/40">—</span> : (
                            <button className="text-left hover:underline" onClick={() => setAbierta(abierta === a.id ? null : a.id)} aria-expanded={abierta === a.id}>
                              {total} permiso{total === 1 ? "" : "s"}
                              {!!a.sensibles.length && <div className="text-xs text-red-600">{a.sensibles.length} sensible{a.sensibles.length === 1 ? "" : "s"}</div>}
                              {a.consentimiento_usuario && <div className="text-xs text-amber-700">aceptada por un usuario</div>}
                            </button>
                          )}
                        </td>
                        <td className="text-sm whitespace-nowrap">
                          {!a.credenciales.length ? <span className="text-ink/40">—</span>
                            : a.vence ? <><span className={f! <= 30 ? "text-red-600" : f! <= 60 ? "text-amber-700" : "text-ink"}>{fd(a.vence)}</span><div className="text-xs text-ink/45">en {f} día{f === 1 ? "" : "s"}{a.vencidas ? ` · ${a.vencidas} vencido(s)` : ""}</div></>
                            : <span className="text-red-600">Vencido</span>}
                        </td>
                        <td className="text-right"><a href={portal(a)} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-600 hover:underline whitespace-nowrap">Abrir en Entra</a></td>
                      </tr>
                      {abierta === a.id && (
                        <tr>
                          <td colSpan={7} className="bg-line/[0.03] text-sm space-y-2">
                            {!!a.delegados.length && <div><div className="text-xs text-ink/50 mb-1">Delegados (actúa en nombre del usuario que inició sesión)</div>{a.delegados.map((p) => chip(p, a.sensibles.includes(p)))}</div>}
                            {!!a.de_aplicacion.length && <div><div className="text-xs text-ink/50 mb-1">De aplicación sobre Microsoft Graph (actúa sola, sobre todo el tenant)</div>{a.de_aplicacion.map((p) => chip(p, a.sensibles.includes(p)))}</div>}
                            {!!a.credenciales.length && <div className="text-xs text-ink/60">Credenciales: {a.credenciales.map((c) => `${c.tipo}${c.nombre ? ` “${c.nombre}”` : ""} vence ${fd(c.vence)}`).join(" · ")}</div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
          <div className="p-3 text-xs text-ink/50 border-t border-line/[0.08]">
            {filtro === "cambios" ? `${listaCambios.length} cambios` : filtro === "borradas" ? `${listaBorradas.length} borradas` : `${lista.length} de ${base.length} aplicaciones`}{d.consultado && ` · consultado ${new Date(d.consultado).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}`}
          </div>
        </div>
      )}
      {cargando && !d && <p className="text-sm text-ink/50">Consultando Entra ID…</p>}
    </div>
  );
}
