"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { conectado, hace } from "@/lib/monitoreo";
import { fecha } from "@/lib/inventario";
import { CONTROLES, ESTILO, evaluar, adminsExtra, DIAS_MAX_SIN_PARCHES, type Control, type Resultado } from "@/lib/seguridad";

function Celda({ r }: { r: Resultado }) {
  const e = ESTILO[r.nivel];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${e.texto}`}>
      <span className={`h-2 w-2 rounded-full shrink-0 ${e.punto}`} aria-hidden />
      <span className="sr-only">{e.etiqueta}: </span>
      {r.texto}
    </span>
  );
}

function AdminsPermitidos({ lista, onCambio }: { lista: string[]; onCambio: (l: string[]) => void }) {
  const [nuevo, setNuevo] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function guardar(l: string[]) {
    setError(null);
    const { error } = await createClient().from("inv_agente_config").update({ admins_permitidos: l }).eq("id", 1);
    if (error) return setError(error.message);
    onCambio(l);
  }

  return (
    <div className="card p-5 space-y-3">
      <div>
        <h2 className="font-medium text-ink">Administradores permitidos</h2>
        <p className="text-sm text-ink/60 mt-1">
          Cuentas o grupos que pueden ser administradores locales sin que se marque como problema. Escribilos como aparecen en
          el detalle de cada equipo (por ejemplo <code className="text-xs bg-black/[0.04] px-1 rounded">ACCUSYS\soporte</code>) o solo el
          nombre. La cuenta Administrador integrada de Windows nunca se marca.
        </p>
      </div>
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      <div className="flex gap-2 flex-wrap">
        {lista.map((a) => (
          <span key={a} className="pill bg-black/[0.05] text-ink/80 flex items-center gap-1.5">
            {a}
            <button onClick={() => guardar(lista.filter((x) => x !== a))} aria-label={`Quitar ${a}`} className="text-ink/40 hover:text-red-600">×</button>
          </span>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (nuevo.trim()) { guardar([...lista, nuevo.trim()]); setNuevo(""); } }}>
        <input className="input flex-1" placeholder="Agregar cuenta o grupo" value={nuevo} onChange={(e) => setNuevo(e.target.value)} />
        <button className="btn-secondary">Agregar</button>
      </form>
    </div>
  );
}

export default function Seguridad() {
  const { esAdmin } = usePerfil();
  const [lista, setLista] = useState<any[]>([]);
  const [permitidos, setPermitidos] = useState<string[]>([]);
  const [cargando, setCargando] = useState(true);
  const [filtro, setFiltro] = useState<Control | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [verConfig, setVerConfig] = useState(false);

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("inv_dispositivos").select("*, inv_equipos(id, codigo)").order("hostname"),
      sb.rpc("inv_admins_permitidos"),
    ]).then(([d, p]) => {
      setLista(d.data ?? []);
      setPermitidos((p.data as string[]) ?? []);
      setCargando(false);
    });
  }, []);

  const conDatos = useMemo(
    () => lista.filter((d) => d.seguridad_actualizado).map((d) => ({ ...d, ev: evaluar(d, permitidos) })),
    [lista, permitidos]
  );
  const sinDatos = lista.length - conDatos.length;

  const cuenta = (k: Control) => conDatos.filter((d) => d.ev[k].nivel === "problema" || d.ev[k].nivel === "aviso").length;
  const filas = filtro ? conDatos.filter((d) => ["problema", "aviso"].includes(d.ev[filtro].nivel)) : conDatos;
  const problemas = (d: any) => CONTROLES.filter((c) => d.ev[c.k].nivel === "problema").length;
  const ordenadas = [...filas].sort((a, b) => problemas(b) - problemas(a) || String(a.hostname).localeCompare(b.hostname));

  function exportar() {
    const cab = ["Equipo", "Código IT", "Usuario", ...CONTROLES.map((c) => c.titulo), "Último parche", "Admins locales", "Actualizado"];
    const filasCsv = ordenadas.map((d) => [
      d.hostname, d.inv_equipos?.codigo ?? "", d.usuario ?? "",
      ...CONTROLES.map((c) => `${ESTILO[d.ev[c.k].nivel as keyof typeof ESTILO].etiqueta}: ${d.ev[c.k].texto}`),
      d.ultimo_parche_titulo ?? "", (d.admins_locales ?? []).map((a: any) => a.nombre).join(" | "),
      new Date(d.seguridad_actualizado).toLocaleString("es-AR"),
    ]);
    const esc = (v: any) => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const texto = [cab, ...filasCsv].map((f) => f.map(esc).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\uFEFF" + texto], { type: "text/csv;charset=utf-8" }));
    a.download = `seguridad-equipos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Seguridad de los equipos</h1>
          <p className="text-ink/60 text-sm mt-1">
            Cifrado (ESET o BitLocker), parches, firewall, antivirus y administradores locales. El agente lo informa cuando cambia algo o cada 6 horas.
          </p>
        </div>
        <div className="flex gap-2">
          {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)}>Admins permitidos</button>}
          <button className="btn-secondary" onClick={exportar} disabled={!conDatos.length}>Exportar para auditoría</button>
        </div>
      </div>

      {verConfig && esAdmin && <AdminsPermitidos lista={permitidos} onCambio={setPermitidos} />}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {CONTROLES.map((c) => {
          const n = cuenta(c.k);
          return (
            <button key={c.k} onClick={() => setFiltro(filtro === c.k ? null : c.k)} aria-pressed={filtro === c.k}
              className={`card p-5 text-left transition-colors ${filtro === c.k ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
              <div className="text-xs text-ink/50 font-medium">{c.tarjeta}</div>
              <div className={`font-display text-3xl mt-1 ${n ? "text-red-600" : "text-emerald-600"}`}>{n}</div>
            </button>
          );
        })}
      </div>

      {sinDatos > 0 && (
        <p className="text-sm text-ink/60">
          {sinDatos} {sinDatos === 1 ? "equipo todavía no informa" : "equipos todavía no informan"} datos de seguridad.
          Necesitan el agente 1.2: descargá el instalador de nuevo desde{" "}
          <Link href="/inventario/monitoreo/agente" className="text-brand-600 hover:underline">Instalar agente</Link>.
        </p>
      )}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr><th>Equipo</th>{CONTROLES.map((c) => <th key={c.k}>{c.titulo}</th>)}</tr>
          </thead>
          <tbody>
            {ordenadas.map((d) => {
              const extra = adminsExtra(d.admins_locales, permitidos);
              return (
                <Fragment key={d.id}>
                  <tr className="hover:bg-black/[0.015] cursor-pointer" onClick={() => setAbierto(abierto === d.id ? null : d.id)}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${conectado(d.ultimo_reporte) ? "bg-emerald-500" : "bg-black/20"}`}
                          title={conectado(d.ultimo_reporte) ? "Conectado" : "Desconectado"} />
                        <button className="font-medium text-ink hover:underline text-left" aria-expanded={abierto === d.id}>{d.hostname}</button>
                      </div>
                      <div className="text-xs text-ink/50 pl-[18px]">{d.usuario ?? "Sin sesión"}</div>
                    </td>
                    {CONTROLES.map((c) => <td key={c.k}><Celda r={d.ev[c.k]} /></td>)}
                  </tr>
                  {abierto === d.id && (
                    <tr>
                      <td colSpan={7} className="bg-[#F5F7FB]">
                        <div className="grid md:grid-cols-3 gap-5 text-sm py-1">
                          <div>
                            {d.cifrado_producto && (
                              <>
                                <div className="text-xs text-ink/50 mb-1">Cifrado: {d.cifrado_producto}</div>
                                <div>{String(d.cifrado_estado ?? "desconocido").replace("_", " ")}</div>
                                {d.cifrado_detalle && (
                                  <details className="mt-1">
                                    <summary className="text-xs text-brand-600 cursor-pointer">Ver lo que informa ESET</summary>
                                    <p className="text-xs text-ink/60 mt-1 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{d.cifrado_detalle}</p>
                                  </details>
                                )}
                                <div className="text-xs text-ink/50 mt-3 mb-1">BitLocker (Windows)</div>
                              </>
                            )}
                            {!d.cifrado_producto && <div className="text-xs text-ink/50 mb-1">Unidades (BitLocker)</div>}
                            {(d.bitlocker_detalle ?? []).length === 0 ? <span className="text-ink/50">Sin información de BitLocker</span> :
                              d.bitlocker_detalle.map((u: any) => (
                                <div key={u.unidad}>{u.unidad} · {u.estado.replace("_", " ")}{u.porcentaje != null && u.estado !== "sin_cifrar" ? ` (${u.porcentaje}%)` : ""}</div>
                              ))}
                            <div className="text-xs text-ink/50 mt-3 mb-1">Último parche</div>
                            <div>{d.ultimo_parche ? fecha(d.ultimo_parche) : "—"}</div>
                            {d.ultimo_parche_titulo && <div className="text-xs text-ink/50">{d.ultimo_parche_titulo}</div>}
                          </div>
                          <div>
                            <div className="text-xs text-ink/50 mb-1">Administradores locales</div>
                            {(d.admins_locales ?? []).map((a: any) => {
                              const esExtra = extra.includes(a);
                              return (
                                <div key={a.nombre} className={esExtra ? "text-amber-700" : ""}>
                                  {a.nombre}
                                  <span className="text-xs text-ink/50">
                                    {a.integrado ? " · integrado" : ""}{a.tipo ? ` · ${a.tipo}` : ""}{esExtra ? " · no permitido" : ""}
                                  </span>
                                </div>
                              );
                            })}
                            {esAdmin && extra.length > 0 && (
                              <button className="text-xs text-brand-600 hover:underline mt-1"
                                onClick={() => setVerConfig(true)}>Agregar a permitidos</button>
                            )}
                          </div>
                          <div>
                            <div className="text-xs text-ink/50 mb-1">Antivirus</div>
                            {(d.av_productos ?? []).map((p: any) => (
                              <div key={p.nombre}>{p.nombre} <span className="text-xs text-ink/50">· {p.activo ? "activo" : "inactivo"} · {p.actualizado ? "actualizado" : "desactualizado"}</span></div>
                            ))}
                            {d.av_firmas_fecha && <div className="text-xs text-ink/50">Firmas de Defender: {fecha(d.av_firmas_fecha)}</div>}
                            <div className="text-xs text-ink/50 mt-3 mb-1">Hardware</div>
                            <div>TPM {d.tpm_presente ? d.tpm_version : "no detectado"} · Secure Boot {d.secure_boot ? "activo" : "apagado"}</div>
                            <div className="text-xs text-ink/50 mt-3">
                              Informado {hace(d.seguridad_actualizado)}
                              {d.inv_equipos && <> · <Link href={`/inventario/equipos/${d.inv_equipos.id}`} className="text-brand-600 hover:underline">{d.inv_equipos.codigo}</Link></>}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!cargando && ordenadas.length === 0 && (
              <tr><td colSpan={7} className="text-center text-ink/40 py-10">
                {filtro ? "Ningún equipo tiene este problema." : "Todavía ningún equipo informó datos de seguridad."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Criterios: parches con más de {DIAS_MAX_SIN_PARCHES} días se marcan como problema. Los umbrales se ajustan en <code>lib/seguridad.ts</code>.
      </p>
    </div>
  );
}
