"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { ThFiltro, FiltrosActivos, useFiltrosColumna } from "@/components/FiltroColumna";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { conectado, hace, discoCritico, usoDisco, tipoEquipo, TIPOS_EQUIPO, type Disco, type TipoEquipo } from "@/lib/monitoreo";
import BarraDisco from "@/components/BarraDisco";
import ClavesBios from "@/components/ClavesBios";
import { exportarExcel } from "@/lib/excel";
import { soporteWindows } from "@/lib/riesgos";
import { fecha } from "@/lib/inventario";
import { CONTROLES, ESTILO, evaluar, adminsExtra, usuarioEsAdmin, TEXTO_USUARIO_ADMIN, DIAS_MAX_SIN_PARCHES, type Control, type Resultado } from "@/lib/seguridad";

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

// Memoria y discos: mismos datos que Monitoreo, para ver todo el estado del equipo en una sola tabla
const ramUso = (d: any) => (d.ram_total_gb ? Math.round(((d.ram_total_gb - d.ram_libre_gb) / d.ram_total_gb) * 100) : null);
const textoSistema = (d: any) => (d.so_nombre ? String(d.so_nombre).replace("Microsoft ", "") : "Sin datos");
const detalleSistema = (d: any) => [d.so_version, d.so_build && `build ${d.so_build}`].filter(Boolean).join(" · ");
// Fin de soporte de Microsoft, con la misma tabla que usa Riesgos
const soporte = (d: any) => soporteWindows(d.so_nombre, d.so_version, d.so_build);
const fechaSoporte = (f: string | null) => (f ? new Date(f + "T12:00:00").toLocaleDateString("es-AR") : "");
const textoRam = (d: any) => (d.ram_total_gb ? `${Math.round(d.ram_total_gb)} GB` : "Sin datos");
const textoDiscos = (d: any) =>
  ((d.discos ?? []) as Disco[]).map((x) => `${x.unidad} ${x.libre_gb} GB libres de ${x.total_gb} (${usoDisco(x)}%)`).join(" | ");

// Asignación del equipo a una persona en el inventario
const ASIGNACION = { asignado: "Asignado", sin_asignar: "Sin asignar", sin_inventario: "Sin cargar en inventario" } as const;
const SIN_ASIGNAR = [ASIGNACION.sin_asignar, ASIGNACION.sin_inventario];

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
          el detalle de cada equipo (por ejemplo <code className="text-xs bg-line/[0.04] px-1 rounded">ACCUSYS\soporte</code>) o solo el
          nombre. La cuenta Administrador integrada de Windows nunca se marca.
        </p>
      </div>
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      <div className="flex gap-2 flex-wrap">
        {lista.map((a) => (
          <span key={a} className="pill bg-line/[0.05] text-ink/80 flex items-center gap-1.5">
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
  const [verBios, setVerBios] = useState(false);
  // Notebooks, PCs y servidores se ven por separado: los controles no significan lo mismo en un servidor que en una notebook
  const [tipo, setTipo] = useState<TipoEquipo | "todos">("todos");
  // Equipo del inventario → persona asignada (de la misma vista que usa Inventario IT)
  const [asignados, setAsignados] = useState<Record<string, string | null>>({});

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("inv_dispositivos").select("*, inv_equipos(id, codigo)").eq("estado_registro", "aprobado").order("hostname"),
      sb.rpc("inv_admins_permitidos"),
      sb.from("inv_v_equipos").select("id, empleado"),
    ]).then(([d, p, q]) => {
      setLista(d.data ?? []);
      setPermitidos((p.data as string[]) ?? []);
      setAsignados(Object.fromEntries(((q.data ?? []) as { id: string; empleado: string | null }[]).map((e) => [e.id, e.empleado])));
      setCargando(false);
    });
  }, []);

  const todosConDatos = useMemo(
    () => lista.filter((d) => d.seguridad_actualizado).map((d) => ({
      ...d, te: tipoEquipo(d), ev: evaluar(d, permitidos), ua: usuarioEsAdmin(d, permitidos),
      asignado: d.inv_equipos ? asignados[d.inv_equipos.id] ?? null : null,
      asignacion: !d.inv_equipos ? ASIGNACION.sin_inventario : asignados[d.inv_equipos.id] ? ASIGNACION.asignado : ASIGNACION.sin_asignar,
    })),
    [lista, permitidos, asignados]
  );
  const porTipo = useMemo(() => {
    const n: Record<TipoEquipo, number> = { notebook: 0, pc: 0, servidor: 0, otro: 0 };
    todosConDatos.forEach((d) => { n[d.te as TipoEquipo]++; });
    return n;
  }, [todosConDatos]);
  const conDatos = useMemo(() => (tipo === "todos" ? todosConDatos : todosConDatos.filter((d) => d.te === tipo)), [todosConDatos, tipo]);
  const sinDatos = lista.filter((d) => !d.seguridad_actualizado && (tipo === "todos" || tipoEquipo(d) === tipo)).length;

  const cuenta = (k: Control) => conDatos.filter((d) => d.ev[k].nivel === "problema" || d.ev[k].nivel === "aviso").length;
  const filas = filtro ? conDatos.filter((d) => ["problema", "aviso"].includes(d.ev[filtro].nivel)) : conDatos;
  const problemas = (d: any) => CONTROLES.filter((c) => d.ev[c.k].nivel === "problema").length;
  // Filtros por columna (tipo Excel): en cada control se filtra por su resultado (OK, atención, problema…)
  const fc = useFiltrosColumna(filas, {
    equipo: (d) => d.hostname,
    usuarioadmin: (d) => TEXTO_USUARIO_ADMIN[d.ua as keyof typeof TEXTO_USUARIO_ADMIN],
    ...Object.fromEntries(CONTROLES.map((c) => [c.k, (d: any) => ESTILO[d.ev[c.k].nivel as keyof typeof ESTILO].etiqueta])),
    sistema: (d) => textoSistema(d),
    asignacion: (d) => d.asignacion,
    soporte: (d) => soporte(d).texto.startsWith("Vence") ? "Por vencer" : soporte(d).texto,
    memoria: (d) => textoRam(d),
    discos: (d) => (!d.discos?.length ? "Sin datos" : discoCritico(d.discos) ? "Disco casi lleno" : "Espacio OK"),
  });
  const ordenadas = [...fc.filtradas].sort((a, b) => problemas(b) - problemas(a) || String(a.hostname).localeCompare(b.hostname));

  // Excel con filtro en cada columna: cada control va en dos columnas (resultado y detalle) para poder filtrar por resultado
  function exportar() {
    const cab = ["Equipo", "Tipo", "Código IT", "Usuario", "Asignado a", "Sistema operativo", "Versión", "Build", "Soporte", "Fin de soporte", "Usuario es admin",
      ...CONTROLES.flatMap((c) => [c.titulo, `${c.titulo} (detalle)`]),
      "Memoria RAM (GB)", "RAM en uso (%)", "Discos", "Disco casi lleno", "Último parche", "Admins locales", "Actualizado"];
    const filas = ordenadas.map((d) => [
      d.hostname, TIPOS_EQUIPO[d.te as TipoEquipo].uno, d.inv_equipos?.codigo ?? "", d.usuario ?? "", d.asignado ?? d.asignacion, textoSistema(d), d.so_version ?? "", d.so_build ?? "", soporte(d).texto, fechaSoporte(soporte(d).fin), TEXTO_USUARIO_ADMIN[d.ua as keyof typeof TEXTO_USUARIO_ADMIN],
      ...CONTROLES.flatMap((c) => [ESTILO[d.ev[c.k].nivel as keyof typeof ESTILO].etiqueta, d.ev[c.k].texto]),
      d.ram_total_gb ? Math.round(d.ram_total_gb) : null, ramUso(d), textoDiscos(d),
      d.discos?.length ? (discoCritico(d.discos) ? "Sí" : "No") : "",
      d.ultimo_parche_titulo ?? "", (d.admins_locales ?? []).map((a: any) => a.nombre).join(" | "),
      new Date(d.seguridad_actualizado).toLocaleString("es-AR"),
    ]);
    exportarExcel(`seguridad-${tipo === "todos" ? "equipos" : TIPOS_EQUIPO[tipo].varios.toLowerCase().replace(/ /g, "-")}-${new Date().toISOString().slice(0, 10)}`, cab, filas,
      { Equipo: 14, Usuario: 34, "Asignado a": 28, "Sistema operativo": 26, Discos: 40, "Último parche": 50, "Admins locales": 60, Actualizado: 20 });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Seguridad de los equipos</h1>
          <p className="text-ink/60 text-sm mt-1">
            Cifrado (ESET o BitLocker), parches, firewall, antivirus, administradores locales y clave del BIOS. El agente lo informa cuando cambia algo o cada 6 horas.
          </p>
        </div>
        <div className="flex gap-2">
          {esAdmin && <button className="btn-secondary" onClick={() => setVerBios(!verBios)}>Claves de BIOS</button>}
          {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)}>Admins permitidos</button>}
          <button className="btn-secondary" onClick={exportar} disabled={!conDatos.length}>Exportar para auditoría</button>
        </div>
      </div>

      {verBios && esAdmin && <ClavesBios />}
      {verConfig && esAdmin && <AdminsPermitidos lista={permitidos} onCambio={setPermitidos} />}

      <div role="tablist" aria-label="Tipo de equipo" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1 w-fit max-w-full">
        {([["todos", "Todos", todosConDatos.length], ...(Object.keys(TIPOS_EQUIPO) as TipoEquipo[])
            .filter((k) => k !== "otro" || porTipo.otro > 0)
            .map((k) => [k, TIPOS_EQUIPO[k].varios, porTipo[k]] as const)] as const).map(([k, t, n]) => (
          <button key={k} role="tab" aria-selected={tipo === k} onClick={() => { setTipo(k as TipoEquipo | "todos"); setAbierto(null); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${tipo === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
            {t} <span className="tabular-nums text-ink/45">{n}</span>
          </button>
        ))}
      </div>

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
        {(() => {
          // Personas que son administradoras de su propia notebook (sin contar las cuentas permitidas)
          const n = conDatos.filter((d) => d.ua === "si").length;
          const activa = fc.filtros.usuarioadmin?.size === 1 && fc.filtros.usuarioadmin.has(TEXTO_USUARIO_ADMIN.si);
          return (
            <button onClick={() => fc.fijar("usuarioadmin", activa ? null : new Set([TEXTO_USUARIO_ADMIN.si]))} aria-pressed={activa}
              className={`card p-5 text-left transition-colors ${activa ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
              <div className="text-xs text-ink/50 font-medium">El usuario es admin de su equipo</div>
              <div className={`font-display text-3xl mt-1 ${n ? "text-red-600" : "text-emerald-600"}`}>{n}</div>
            </button>
          );
        })()}
        {(() => {
          // Equipos sin una persona asignada en el inventario (o que ni siquiera están cargados)
          const sinInv = conDatos.filter((d) => d.asignacion === ASIGNACION.sin_inventario).length;
          const n = conDatos.filter((d) => d.asignacion !== ASIGNACION.asignado).length;
          const f = fc.filtros.asignacion;
          const activa = !!f && f.size === SIN_ASIGNAR.length && SIN_ASIGNAR.every((v) => f.has(v));
          return (
            <button onClick={() => fc.fijar("asignacion", activa ? null : new Set(SIN_ASIGNAR))} aria-pressed={activa}
              className={`card p-5 text-left transition-colors ${activa ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
              <div className="text-xs text-ink/50 font-medium">Sin asignar a una persona</div>
              <div className={`font-display text-3xl mt-1 ${n ? "text-amber-600" : "text-emerald-600"}`}>{n}</div>
              {sinInv > 0 && <div className="text-xs text-ink/50 mt-1">{sinInv} sin cargar en inventario</div>}
            </button>
          );
        })()}
      </div>

      {sinDatos > 0 && (
        <p className="text-sm text-ink/60">
          {sinDatos} {sinDatos === 1 ? "equipo todavía no informa" : "equipos todavía no informan"} datos de seguridad.
          Necesitan el agente 1.2: descargá el instalador de nuevo desde{" "}
          <Link href="/inventario/monitoreo/agente" className="text-brand-600 hover:underline">Instalar agente</Link>.
        </p>
      )}

      <FiltrosActivos ctl={fc} total={filas.length} />

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <ThFiltro ctl={fc} col="equipo">Equipo</ThFiltro>
              <ThFiltro ctl={fc} col="sistema">Sistema</ThFiltro>
              <ThFiltro ctl={fc} col="soporte">Soporte</ThFiltro>
              <ThFiltro ctl={fc} col="usuarioadmin">Usuario es admin</ThFiltro>
              {CONTROLES.map((c) => <ThFiltro key={c.k} ctl={fc} col={c.k}>{c.titulo}</ThFiltro>)}
              <ThFiltro ctl={fc} col="memoria">Memoria</ThFiltro>
              <ThFiltro ctl={fc} col="discos">Discos</ThFiltro>
            </tr>
          </thead>
          <tbody>
            {ordenadas.map((d) => {
              const extra = adminsExtra(d.admins_locales, permitidos);
              return (
                <Fragment key={d.id}>
                  <tr className="hover:bg-line/[0.015] cursor-pointer" onClick={() => setAbierto(abierto === d.id ? null : d.id)}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${conectado(d.ultimo_reporte) ? "bg-emerald-500" : "bg-line/20"}`}
                          title={conectado(d.ultimo_reporte) ? "Conectado" : "Desconectado"} />
                        <button className="font-medium text-ink hover:underline text-left" aria-expanded={abierto === d.id}>{d.hostname}</button>
                        {tipo === "todos" && d.te !== "notebook" && (
                          <span className={`pill ${d.te === "servidor" ? "bg-brand-50 text-brand-700" : "bg-line/[0.05] text-ink/55"}`}>{TIPOS_EQUIPO[d.te as TipoEquipo].uno}</span>
                        )}
                      </div>
                      <div className="text-xs text-ink/50 pl-[18px]">{d.usuario ?? "Sin sesión"}</div>
                      <div className="text-xs pl-[18px]">
                        {d.asignado ? <span className="text-ink/60">Asignado a {d.asignado}</span>
                          : <span className="text-amber-700">{d.asignacion}</span>}
                      </div>
                    </td>
                    <td className="text-sm">
                      {d.so_nombre ? <>
                        <div className="text-ink/80">{textoSistema(d)}</div>
                        {detalleSistema(d) && <div className="text-xs text-ink/50 whitespace-nowrap">{detalleSistema(d)}</div>}
                      </> : <span className="text-ink/40">Sin datos</span>}
                    </td>
                    <td>
                      {(() => {
                        const s = soporte(d);
                        return <>
                          <Celda r={{ nivel: s.nivel, texto: s.texto }} />
                          {s.fin && <div className="text-xs text-ink/50 whitespace-nowrap pl-[14px]">{s.nivel === "problema" ? "Desde" : "Hasta"} el {fechaSoporte(s.fin)}</div>}
                        </>;
                      })()}
                    </td>
                    <td className="whitespace-nowrap">
                      {d.ua === "si" ? <span className="pill bg-red-50 text-red-600">Sí</span>
                        : d.ua === "si_permitido" ? <span className="pill bg-line/[0.05] text-ink/60" title="Es una cuenta de la lista de admins permitidos">Sí (permitido)</span>
                        : d.ua === "no" ? <span className="text-sm text-emerald-700">No</span>
                        : <span className="text-sm text-ink/40">{TEXTO_USUARIO_ADMIN[d.ua as keyof typeof TEXTO_USUARIO_ADMIN]}</span>}
                    </td>
                    {CONTROLES.map((c) => <td key={c.k}><Celda r={d.ev[c.k]} /></td>)}
                    <td className="whitespace-nowrap text-sm">
                      {d.ram_total_gb ? <>
                        {Math.round(d.ram_total_gb)} GB
                        {ramUso(d) != null && <div className={`text-xs ${ramUso(d)! >= 90 ? "text-red-600" : "text-ink/50"}`}>{ramUso(d)}% en uso</div>}
                      </> : <span className="text-ink/40">Sin datos</span>}
                    </td>
                    <td>
                      {d.discos?.length
                        ? <div className="space-y-1.5">{(d.discos as Disco[]).map((x) => <BarraDisco key={x.unidad} d={x} />)}</div>
                        : <span className="text-sm text-ink/40">Sin datos</span>}
                    </td>
                  </tr>
                  {abierto === d.id && (
                    <tr>
                      <td colSpan={CONTROLES.length + 6} className="bg-canvas">
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
                            <div>
                              BIOS:{" "}
                              {d.bios_fuente
                                ? `clave de administrador ${d.bios_clave_admin ? "sí" : "no"} · clave de encendido ${d.bios_clave_sistema ? "sí" : "no"}`
                                : "sin datos (requiere agente 1.5)"}
                            </div>
                            {d.bios_fuente && <div className="text-xs text-ink/50">Leído con {d.bios_fuente}</div>}
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
              <tr><td colSpan={CONTROLES.length + 6} className="text-center text-ink/40 py-10">
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
