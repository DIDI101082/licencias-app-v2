"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { exportarExcel } from "@/lib/excel";
import { hace } from "@/lib/monitoreo";
import {
  evaluar, estadoVisible, esWindowsCliente, agenteSoportaW11, APTITUD, ESTADO, EN_PROCESO, VERSION_AGENTE_W11,
  type EquipoW11, type Aptitud, type EstadoW11,
} from "@/lib/w11";

const COLUMNAS = [
  "id", "hostname", "usuario", "fabricante", "modelo", "numero_serie", "so_nombre", "so_version", "so_build", "procesador",
  "ram_total_gb", "discos", "tpm_version", "secure_boot", "cifrado_producto", "ultimo_reporte", "agente_version",
  "inv_w11(oleada, estado, orden_pendiente, orden_por, orden_fecha, detalle, compat, estado_fecha, build_origen, migrado_fecha, progreso)",
].join(", ");

type Config = { w11_origen: string | null; w11_sha256: string | null; w11_reiniciar: boolean; w11_internet: boolean };
type Fila = EquipoW11 & { ev: ReturnType<typeof evaluar>; est: EstadoW11 };

const PROBLEMAS: EstadoW11[] = ["bloqueado", "error", "revisar"];
const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—");

export default function MigracionW11() {
  const { esAdmin } = usePerfil();
  const [equipos, setEquipos] = useState<EquipoW11[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [verConfig, setVerConfig] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [filtroApt, setFiltroApt] = useState<"w10" | Aptitud | "todos">("w10");
  const [filtroEst, setFiltroEst] = useState<EstadoW11 | "todos" | "en_proceso" | "problemas">("todos");
  const [texto, setTexto] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [oleada, setOleada] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [r, c] = await Promise.all([
      sb.from("inv_dispositivos").select(COLUMNAS).eq("estado_registro", "aprobado").order("hostname"),
      esAdmin ? sb.from("inv_agente_config").select("w11_origen, w11_sha256, w11_reiniciar, w11_internet").eq("id", 1).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    if (r.error) {
      setError(r.error.message.includes("inv_w11") || r.error.message.includes("relationship")
        ? "Falta ejecutar migracion-w11.sql en Supabase." : r.error.message);
    } else {
      setError(null);
      setEquipos(((r.data ?? []) as unknown as EquipoW11[]).filter(esWindowsCliente));
    }
    if (c.data) setConfig(c.data as Config);
    setCargando(false);
  }, [esAdmin]);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 60_000);
    return () => clearInterval(t);
  }, [cargar]);

  const filas: Fila[] = useMemo(() => {
    const ahora = Date.now();
    return equipos.map((e) => ({ ...e, ev: evaluar(e), est: estadoVisible(e, ahora) }));
  }, [equipos]);

  const kpi = useMemo(() => {
    const w10 = filas.filter((f) => f.ev.aptitud !== "win11");
    return {
      w10: w10.length,
      aptos: w10.filter((f) => f.ev.aptitud === "apto").length,
      verificar: w10.filter((f) => f.ev.aptitud === "verificar").length,
      noAptos: w10.filter((f) => f.ev.aptitud === "no_apto").length,
      enProceso: filas.filter((f) => EN_PROCESO.includes(f.est)).length,
      problemas: filas.filter((f) => PROBLEMAS.includes(f.est)).length,
      migrados: filas.filter((f) => f.est === "migrado").length,
      win11: filas.length - w10.length,
      agenteViejo: w10.filter((f) => !agenteSoportaW11(f.agente_version)).length,
    };
  }, [filas]);

  const lista = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return filas.filter((f) => {
      if (filtroApt === "w10" ? f.ev.aptitud === "win11" : filtroApt !== "todos" && f.ev.aptitud !== filtroApt) return false;
      if (filtroEst === "en_proceso" ? !EN_PROCESO.includes(f.est)
        : filtroEst === "problemas" ? !PROBLEMAS.includes(f.est)
        : filtroEst !== "todos" && f.est !== filtroEst) return false;
      if (q && ![f.hostname, f.usuario, f.modelo, f.numero_serie, f.inv_w11?.oleada].some((v) => v?.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [filas, filtroApt, filtroEst, texto]);

  // Se pueden ordenar: aptos o a verificar, con agente 2.0+, que no estén ya en curso o migrados
  const seleccionable = (f: Fila) =>
    (f.ev.aptitud === "apto" || f.ev.aptitud === "verificar") && agenteSoportaW11(f.agente_version) &&
    !["entregado", "en_curso", "pendiente_reinicio", "migrado"].includes(f.est);
  const visiblesSel = lista.filter(seleccionable);
  const todosSel = visiblesSel.length > 0 && visiblesSel.every((f) => sel.has(f.id));
  const seleccionados = filas.filter((f) => sel.has(f.id));
  const configurado = !!config && (!!config.w11_origen || config.w11_internet);
  const modoTexto = !config ? "" : config.w11_origen && config.w11_internet ? "carpeta de la red y, si no llega, internet"
    : config.w11_origen ? "solo carpeta de la red" : "solo internet (Asistente de Microsoft)";

  function toggle(id: string) {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id); else n.add(id);
    setSel(n);
  }

  async function ordenar() {
    if (!seleccionados.length) return;
    const aVerificar = seleccionados.filter((f) => f.ev.aptitud === "verificar").length;
    const ok = confirm(
      `Vas a ordenar la actualización a Windows 11 de ${seleccionados.length} equipo(s)${oleada.trim() ? ` (oleada "${oleada.trim()}")` : ""}.` +
      (aVerificar ? `\n\n${aVerificar} figuran "a verificar": el escaneo de Microsoft en el equipo decide si se instala o no.` : "") +
      `\n\nEl agente toma la orden en su próximo reporte y lanza el upgrade (${modoTexto}).` +
      (config?.w11_reiniciar ? "\n\nATENCIÓN: está activado el reinicio automático al terminar." : "\nEl equipo termina la actualización cuando el usuario reinicia.") +
      `\n\n¿Confirmás?`,
    );
    if (!ok) return;
    setOcupado(true);
    const { data, error } = await createClient().rpc("inv_w11_ordenar", { p_ids: seleccionados.map((f) => f.id), p_oleada: oleada.trim() || null });
    setOcupado(false);
    if (error) return setMensaje(`Error: ${error.message}`);
    const omitidos: string[] = data?.omitidos ?? [];
    setMensaje(`Actualización ordenada en ${data?.ordenados ?? 0} equipo(s).` +
      (omitidos.length ? ` No se ordenó en: ${omitidos.join(", ")} (sin TPM 2.0 o Secure Boot reportados, o ya en curso).` : ""));
    setSel(new Set());
    cargar();
  }

  async function cancelar() {
    if (!seleccionados.length || !confirm(`¿Cancelar las órdenes pendientes de ${seleccionados.length} equipo(s)? Las que el agente ya tomó siguen su curso.`)) return;
    setOcupado(true);
    const { data, error } = await createClient().rpc("inv_w11_cancelar", { p_ids: seleccionados.map((f) => f.id) });
    setOcupado(false);
    if (error) return setMensaje(`Error: ${error.message}`);
    setMensaje(`Órdenes canceladas: ${data ?? 0}.`);
    setSel(new Set());
    cargar();
  }

  function exportar() {
    exportarExcel(
      `migracion-w11-${new Date().toISOString().slice(0, 10)}`,
      ["Equipo", "Usuario", "Modelo", "N° de serie", "Sistema", "Versión", "Build", "Procesador", "RAM (GB)", "TPM", "Secure Boot",
       "Aptitud", "Motivos", "A verificar", "Estado", "Detalle", "Oleada", "Ordenado por", "Fecha de orden", "Migrado", "Versión agente"],
      lista.map((f) => [
        f.hostname, f.usuario, f.modelo, f.numero_serie, f.so_nombre?.replace("Microsoft ", ""), f.so_version, f.so_build, f.procesador,
        f.ram_total_gb, f.tpm_version, f.secure_boot == null ? "" : f.secure_boot ? "Sí" : "No",
        APTITUD[f.ev.aptitud].txt, f.ev.motivos.join(" | "), f.ev.verificar.join(" | "), ESTADO[f.est].txt, f.inv_w11?.detalle,
        f.inv_w11?.oleada, f.inv_w11?.orden_por, fh(f.inv_w11?.orden_fecha ?? null), fh(f.inv_w11?.migrado_fecha ?? null), f.agente_version,
      ]),
      { Procesador: 40, Motivos: 60, "A verificar": 60, Detalle: 50, Usuario: 30 },
    );
  }

  const tarjetas: [string, number, string, () => void][] = [
    ["Con Windows 10", kpi.w10, "text-ink", () => { setFiltroApt("w10"); setFiltroEst("todos"); }],
    ["Aptos", kpi.aptos, "text-emerald-700", () => { setFiltroApt("apto"); setFiltroEst("todos"); }],
    ["A verificar", kpi.verificar, kpi.verificar ? "text-amber-700" : "text-ink", () => { setFiltroApt("verificar"); setFiltroEst("todos"); }],
    ["No aptos (recambio)", kpi.noAptos, kpi.noAptos ? "text-red-600" : "text-ink", () => { setFiltroApt("no_apto"); setFiltroEst("todos"); }],
    ["En proceso", kpi.enProceso, "text-brand-700", () => { setFiltroApt("todos"); setFiltroEst("en_proceso"); }],
    ["Con problemas", kpi.problemas, kpi.problemas ? "text-red-600" : "text-ink", () => { setFiltroApt("todos"); setFiltroEst("problemas"); }],
    ["Migrados", kpi.migrados, "text-emerald-700", () => { setFiltroApt("todos"); setFiltroEst("migrado"); }],
    ["Total en Windows 11", kpi.win11, "text-ink", () => { setFiltroApt("win11"); setFiltroEst("todos"); }],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Migración a Windows 11</h1>
          <p className="text-ink/60 text-sm mt-1">
            La aptitud sale de lo que ya reporta el agente (TPM, Secure Boot, procesador, RAM y disco). Al ordenar la actualización,
            el agente instala Windows 11 conservando aplicaciones y datos: desde la carpeta de la red si llega, o desde Microsoft por internet.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={exportar} disabled={!lista.length}>Exportar a Excel</button>
          {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)}>{verConfig ? "Cerrar configuración" : "Configurar"}</button>}
        </div>
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}
      {esAdmin && config && (verConfig || !configurado) && (
        <Configuracion config={config} onGuardado={(m) => { setMensaje(m); cargar(); }} />
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tarjetas.map(([t, v, c, fn]) => (
          <button key={t} className="card p-4 text-left hover:ring-2 hover:ring-brand-500/20" onClick={fn}>
            <div className="text-xs text-ink/50">{t}</div>
            <div className={`font-display text-3xl mt-1 ${c}`}>{cargando ? "—" : v}</div>
          </button>
        ))}
      </div>
      {kpi.agenteViejo > 0 && (
        <p className="text-sm text-amber-700">
          {kpi.agenteViejo} equipo(s) con Windows 10 tienen un agente anterior a la {VERSION_AGENTE_W11.toFixed(1)}: se ven acá, pero para
          poder actualizarlos hay que reinstalar el agente (Monitoreo → Instalar agente). La reinstalación conserva la clave del equipo.
        </p>
      )}

      <div className="flex gap-2 flex-wrap">
        <select className="input w-auto" value={filtroApt} onChange={(e) => setFiltroApt(e.target.value as typeof filtroApt)}>
          <option value="w10">Solo Windows 10</option>
          <option value="apto">Aptos</option>
          <option value="verificar">A verificar</option>
          <option value="no_apto">No aptos</option>
          <option value="win11">Ya en Windows 11</option>
          <option value="todos">Todos</option>
        </select>
        <select className="input w-auto" value={filtroEst} onChange={(e) => setFiltroEst(e.target.value as typeof filtroEst)}>
          <option value="todos">Todos los estados</option>
          <option value="en_proceso">En proceso</option>
          <option value="problemas">Con problemas</option>
          {(Object.keys(ESTADO) as EstadoW11[]).map((k) => <option key={k} value={k}>{ESTADO[k].txt}</option>)}
        </select>
        <input className="input flex-1 min-w-[240px]" placeholder="Buscar equipo, usuario, modelo, n° de serie u oleada" value={texto} onChange={(e) => setTexto(e.target.value)} />
      </div>

      {esAdmin && (
        <div className="card p-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink/60">{sel.size} seleccionado(s)</span>
          <input className="input w-56" placeholder="Oleada (ej: Piloto, Piso 4)" value={oleada} onChange={(e) => setOleada(e.target.value)} />
          <button className="btn-primary" disabled={!sel.size || ocupado || !configurado} onClick={ordenar}>Actualizar a Windows 11</button>
          <button className="btn-secondary" disabled={!sel.size || ocupado} onClick={cancelar}>Cancelar orden</button>
          {!configurado && <span className="text-xs text-red-600">Falta configurar de dónde se instala Windows 11.</span>}
          {configurado && <span className="text-xs text-ink/50">Origen: {modoTexto}</span>}
        </div>
      )}

      {mensaje && <div className="card p-3 text-sm text-ink/80 bg-brand-50">{mensaje}</div>}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              {esAdmin && (
                <th className="w-8">
                  <input type="checkbox" checked={todosSel} disabled={!visiblesSel.length}
                    onChange={() => setSel(todosSel ? new Set() : new Set([...sel, ...visiblesSel.map((f) => f.id)]))} />
                </th>
              )}
              <th>Equipo</th><th>Modelo</th><th>Sistema</th><th>Aptitud</th><th>Estado</th><th>Oleada</th><th>Último reporte</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((f) => {
              const det = [...f.ev.motivos, ...f.ev.verificar, ...f.ev.avisos];
              return (
                <Fragment key={f.id}>
                  <tr className="cursor-pointer hover:bg-line/[0.02]" onClick={() => setAbierto(abierto === f.id ? null : f.id)}>
                    {esAdmin && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" disabled={!seleccionable(f)} checked={sel.has(f.id)} onChange={() => toggle(f.id)} />
                      </td>
                    )}
                    <td>
                      <div className="text-ink font-medium">{f.hostname ?? "—"}</div>
                      <div className="text-xs text-ink/50">{f.usuario ?? ""}</div>
                    </td>
                    <td>
                      <div>{f.modelo ?? "—"}</div>
                      <div className="text-xs text-ink/50 font-mono">{f.numero_serie ?? ""}</div>
                    </td>
                    <td>
                      <div>{f.so_nombre?.replace("Microsoft ", "") ?? "—"}</div>
                      <div className="text-xs text-ink/50">{[f.so_version, f.so_build].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td>
                      <span className={APTITUD[f.ev.aptitud].cls}>{APTITUD[f.ev.aptitud].txt}</span>
                      {det.length > 0 && <div className="text-xs text-ink/50 mt-0.5">{det.length} {det.length === 1 ? "observación" : "observaciones"}</div>}
                    </td>
                    <td title={ESTADO[f.est].ayuda}>
                      <span className={ESTADO[f.est].cls}>{ESTADO[f.est].txt}</span>
                      {(f.est === "en_curso" || f.est === "pendiente_reinicio") && f.inv_w11?.progreso != null && <BarraAvance pct={f.inv_w11.progreso} />}
                      {f.inv_w11?.estado_fecha && f.est !== "sin_orden" && <div className="text-xs text-ink/50 mt-0.5">{hace(f.inv_w11.estado_fecha)}</div>}
                    </td>
                    <td>{f.inv_w11?.oleada ?? "—"}</td>
                    <td className="text-xs whitespace-nowrap">{hace(f.ultimo_reporte)}</td>
                  </tr>
                  {abierto === f.id && (
                    <tr className="bg-line/[0.02]">
                      <td colSpan={esAdmin ? 8 : 7}>
                        <div className="grid lg:grid-cols-2 gap-4 py-1 text-sm">
                          <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-ink/50">Requisitos</div>
                            <div className="text-ink/70">
                              Procesador: {f.procesador ?? "—"} · RAM: {f.ram_total_gb ?? "—"} GB · TPM: {f.tpm_version ?? "sin dato"} ·
                              Secure Boot: {f.secure_boot == null ? "sin dato" : f.secure_boot ? "activo" : "desactivado"}
                              {f.cifrado_producto ? ` · Cifrado: ${f.cifrado_producto}` : ""} · Agente {f.agente_version ?? "—"}
                            </div>
                            {f.ev.motivos.length > 0 && <Lista titulo="No cumple" items={f.ev.motivos} cls="text-red-700" />}
                            {f.ev.verificar.length > 0 && <Lista titulo="A verificar" items={f.ev.verificar} cls="text-amber-700" />}
                            {f.ev.avisos.length > 0 && <Lista titulo="Tener en cuenta" items={f.ev.avisos} cls="text-ink/70" />}
                            {!det.length && f.ev.aptitud === "apto" && <p className="text-emerald-700">Cumple todos los requisitos que reporta el agente.</p>}
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs uppercase tracking-wide text-ink/50">Actualización</div>
                            <p className="text-ink/70">{ESTADO[f.est].ayuda}.</p>
                            {f.inv_w11?.detalle && <p><b>Último estado:</b> {f.inv_w11.detalle} ({fh(f.inv_w11.estado_fecha)})</p>}
                            {(f.est === "en_curso" || f.est === "pendiente_reinicio") && f.inv_w11?.progreso != null && (
                              <p><b>Avance:</b> {f.inv_w11.progreso}% · {etapaAvance(f.inv_w11.progreso)}</p>
                            )}
                            {f.inv_w11?.compat && <p><b>Escaneo de Microsoft:</b> {f.inv_w11.compat}</p>}
                            {f.inv_w11?.orden_por && <p><b>Ordenado por:</b> {f.inv_w11.orden_por} el {fh(f.inv_w11.orden_fecha)}</p>}
                            {f.inv_w11?.build_origen && <p><b>Build al ordenar:</b> {f.inv_w11.build_origen}</p>}
                            {f.inv_w11?.migrado_fecha && <p><b>Migrado:</b> {fh(f.inv_w11.migrado_fecha)}</p>}
                            {(f.est === "error" || f.est === "bloqueado" || f.est === "revisar") && (
                              <p className="text-xs text-ink/50">Logs en el equipo: C:\ProgramData\AccusysAgente\w11\logs</p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!lista.length && (
              <tr><td colSpan={8} className="text-center text-ink/40 py-10">{cargando ? "Cargando…" : "No hay equipos para este filtro."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Lista({ titulo, items, cls }: { titulo: string; items: string[]; cls: string }) {
  return (
    <div>
      <div className="text-xs text-ink/50">{titulo}</div>
      <ul className={`list-disc ml-5 ${cls}`}>{items.map((m) => <li key={m}>{m}</li>)}</ul>
    </div>
  );
}

function Configuracion({ config, onGuardado }: { config: Config; onGuardado: (m: string) => void }) {
  const [origen, setOrigen] = useState(config.w11_origen ?? "");
  const [sha, setSha] = useState(config.w11_sha256 ?? "");
  const [internet, setInternet] = useState(config.w11_internet);
  const [reiniciar, setReiniciar] = useState(config.w11_reiniciar);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    const { error } = await createClient().rpc("inv_w11_config", {
      p_origen: origen.trim() || null, p_sha256: sha.trim() || null, p_reiniciar: reiniciar, p_internet: internet,
    });
    if (error) return setError(error.message);
    setError(null);
    onGuardado("Configuración guardada.");
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-display text-lg text-ink">De dónde se instala Windows 11</h2>
        <p className="text-sm text-ink/60">
          Modo mixto: si el equipo llega a la <b>carpeta compartida</b>, instala desde la red local (más rápido en la oficina y sin usar
          los enlaces de internet). Si no llega, por ejemplo en home office, y está permitido, baja el <b>Asistente de instalación de
          Windows 11</b> desde Microsoft. En los dos casos el agente verifica que el instalador esté firmado por Microsoft.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="label">Carpeta compartida con el ISO extraído (opcional, recomendada para la oficina)</label>
          <input className="input font-mono" placeholder="\\SERVIDOR\W11$\26H2" value={origen} onChange={(e) => setOrigen(e.target.value)} />
          <p className="text-xs text-ink/50 mt-1">
            Windows 11 26H2 o 25H2, mismo idioma y edición que los equipos. Permiso de lectura para <b>Equipos del dominio</b>
            (el agente corre como SYSTEM con la cuenta del equipo).
          </p>
        </div>
        <div>
          <label className="label">Huella SHA-256 de sources\install.wim (opcional)</label>
          <input className="input font-mono" placeholder="64 caracteres hexadecimales" value={sha} onChange={(e) => setSha(e.target.value)} />
          <p className="text-xs text-ink/50 mt-1">En PowerShell: (Get-FileHash \\SERVIDOR\W11$\26H2\sources\install.wim).Hash</p>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={internet} onChange={(e) => setInternet(e.target.checked)} />
        <span>
          Permitir la descarga desde internet cuando el equipo no llega a la carpeta.{" "}
          <span className="text-ink/50">
            Cada equipo baja unos 4 GB de Microsoft. Si no hay carpeta configurada, todos los equipos se actualizan por internet: en la
            oficina conviene ordenar oleadas chicas para no saturar los enlaces.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={reiniciar} onChange={(e) => setReiniciar(e.target.checked)} />
        <span>
          Reiniciar automáticamente al terminar.{" "}
          <span className="text-ink/50">
            Sin esta opción, el upgrade queda preparado y se completa cuando el usuario reinicia. Activarla solo para oleadas fuera de horario.
          </span>
        </span>
      </label>
      {!origen.trim() && !internet && <p className="text-sm text-amber-700">Configurá la carpeta o permití la descarga desde internet.</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary" onClick={guardar}>Guardar</button>
    </div>
  );
}

// Etapa según el avance general que informa el agente (2.5: copia 0-15, instalación 15-100;
// la instalación arranca verificando compatibilidad y bajando actualizaciones de Microsoft, y ahí puede quedar un rato quieta)
function etapaAvance(p: number) {
  if (p >= 100) return "listo, falta reiniciar";
  if (p < 15) return "copiando el instalador";
  if (p === 15) return "verificando compatibilidad";
  return "instalando Windows 11";
}

function BarraAvance({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div className="mt-1 w-28" title={`${v}% · ${etapaAvance(v)}`}>
      <div className="h-1.5 bg-line/[0.08] rounded-full overflow-hidden" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={`Avance de la actualización: ${v}%`}>
        <div className={`h-full rounded-full transition-all duration-700 ${v >= 100 ? "bg-emerald-500" : "bg-brand-500"}`} style={{ width: `${v}%` }} />
      </div>
      <div className="text-[11px] text-ink/60 tabular-nums mt-0.5">{v}%</div>
    </div>
  );
}
