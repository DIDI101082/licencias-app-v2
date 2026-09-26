"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS, CONDICIONES, dinero, fecha, diasHasta, claseCodigo } from "@/lib/inventario";
import { usePerfil } from "@/components/PerfilContext";
import BarraDisco from "@/components/BarraDisco";
import { conectado, hace, encendidoDesde, type Disco } from "@/lib/monitoreo";
import { CONTROLES, ESTILO, evaluar } from "@/lib/seguridad";
import { textoUbicacion } from "@/lib/geo";

const CAMPOS_LOG: Record<string, string> = {
  estado: "Estado", condicion: "Condición", area: "Área", ubicacion_id: "Ubicación", empleado_id: "Asignado a",
  ubicacion_detalle: "Detalle de ubicación", hostname: "Hostname", ip: "IP", ram_gb: "RAM", almacenamiento: "Almacenamiento",
  sistema_operativo: "Sistema operativo", costo: "Costo", garantia_hasta: "Garantía", numero_serie: "N° de serie",
  marca: "Marca", modelo: "Modelo", notas: "Notas", codigo: "Código", categoria_id: "Categoría", proveedor_id: "Proveedor",
};

function Dato({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink/50">{t}</dt>
      <dd className="text-ink">{children}</dd>
    </>
  );
}

export default function FichaEquipo({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { esAdmin, puedeEditarEquipo } = usePerfil();
  const [e, setE] = useState<any>(null);
  const [asig, setAsig] = useState<any[]>([]);
  const [mant, setMant] = useState<any[]>([]);
  const [log, setLog] = useState<any[]>([]);
  const [empleados, setEmpleados] = useState<any[]>([]);
  const [qr, setQr] = useState("");
  const [vivo, setVivo] = useState<any>(null);
  const [otros, setOtros] = useState<any[]>([]);
  const [stockPer, setStockPer] = useState<any[]>([]);
  const [perSel, setPerSel] = useState("");
  const [permitidos, setPermitidos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [empSel, setEmpSel] = useState("");
  const [condDev, setCondDev] = useState("bueno");
  const [nuevoMant, setNuevoMant] = useState({ tipo: "correctivo", descripcion: "", costo: "", fecha: new Date().toISOString().slice(0, 10) });

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [eq, a, m, l, dv] = await Promise.all([
      sb.from("inv_v_equipos").select("*").eq("id", params.id).single(),
      sb.from("inv_asignaciones").select("*, empleados(nombre, apellido)").eq("equipo_id", params.id).order("fecha_entrega", { ascending: false }),
      sb.from("inv_mantenimientos").select("*, inv_proveedores(nombre)").eq("equipo_id", params.id).order("fecha", { ascending: false }),
      sb.from("inv_equipos_log").select("*").eq("equipo_id", params.id).order("fecha", { ascending: false }).limit(50),
      sb.from("inv_dispositivos").select("*").eq("equipo_id", params.id).eq("estado_registro", "aprobado").order("ultimo_reporte", { ascending: false }).limit(1),
    ]);
    setVivo(dv.data?.[0] ?? null);
    if (dv.data?.[0]?.seguridad_actualizado) {
      const { data: p } = await sb.rpc("inv_admins_permitidos");
      setPermitidos((p as string[]) ?? []);
    }
    setE(eq.data); setAsig(a.data ?? []); setMant(m.data ?? []); setLog(l.data ?? []);
    // Otros equipos de la misma persona (periféricos primero) y periféricos disponibles para entregarle
    if (eq.data?.empleado_id) {
      const [o, st] = await Promise.all([
        sb.from("inv_v_equipos").select("id, codigo, categoria, grupo, marca, modelo, numero_serie")
          .eq("empleado_id", eq.data.empleado_id).neq("id", params.id).order("codigo"),
        sb.from("inv_v_equipos").select("id, codigo, categoria, marca, modelo, numero_serie")
          .eq("estado", "en_stock").eq("grupo", "Periféricos").order("categoria").limit(300),
      ]);
      setOtros((o.data ?? []).sort((x: any, y: any) => Number(y.grupo === "Periféricos") - Number(x.grupo === "Periféricos")));
      setStockPer(st.data ?? []);
    } else {
      setOtros([]);
    }
    if (eq.data) setQr(await QRCode.toDataURL(`${window.location.origin}/inventario/equipos/${params.id}`, { margin: 0, width: 160 }));
  }, [params.id]);

  useEffect(() => {
    cargar();
    createClient().from("empleados").select("id,nombre,apellido,area").eq("activo", true).order("apellido")
      .then(({ data }) => setEmpleados(data ?? []));
  }, [cargar]);

  if (!e) return <p className="text-ink/50 text-sm">Cargando…</p>;
  const editable = puedeEditarEquipo(e.area);
  const dias = diasHasta(e.garantia_hasta);

  async function rpc(nombre: string, args: Record<string, any>) {
    setError(null);
    const { error } = await createClient().rpc(nombre, args);
    if (error) setError(error.message.includes("row-level security") ? "No tenés permiso sobre equipos o empleados de esa área." : error.message);
    else { setEmpSel(""); await cargar(); }
  }

  async function agregarMant(ev: React.FormEvent) {
    ev.preventDefault();
    const { error } = await createClient().from("inv_mantenimientos").insert({
      equipo_id: e.id, tipo: nuevoMant.tipo, descripcion: nuevoMant.descripcion, fecha: nuevoMant.fecha,
      costo: nuevoMant.costo ? Number(nuevoMant.costo) : null,
    });
    if (error) return setError(error.message);
    setNuevoMant({ ...nuevoMant, descripcion: "", costo: "" });
    cargar();
  }

  async function eliminar() {
    if (!confirm(`¿Eliminar ${e.codigo} definitivamente? Si el equipo ya no se usa, conviene marcarlo como “Dado de baja”.`)) return;
    const { error } = await createClient().from("inv_equipos").delete().eq("id", e.id);
    if (error) return setError(error.message);
    router.push("/inventario/equipos");
    router.refresh();
  }

  function imprimirEtiqueta() {
    document.body.classList.add("solo-etiqueta");
    window.print();
    document.body.classList.remove("solo-etiqueta");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <span className={claseCodigo(e.codigo, "tag-inv-grande")}>{e.codigo}</span>
          {/^NWKS-\d+$/.test(e.codigo) && (
            <span className="ml-3 text-xs text-ink/50">Código provisorio: pasa al hostname cuando el agente reporta este equipo</span>
          )}
          <h1 className="font-display text-2xl text-ink mt-3">{[e.marca, e.modelo].filter(Boolean).join(" ") || e.categoria}</h1>
          <p className="text-sm text-ink/60 mt-1 flex items-center gap-2">
            {e.categoria} <span className={`est-${e.estado}`}>{ESTADOS[e.estado]}</span>
          </p>
        </div>
        <div className="flex gap-2 flex-wrap print:hidden">
          <button className="btn-secondary" onClick={imprimirEtiqueta}>Imprimir etiqueta</button>
          {editable && <Link className="btn-secondary" href={`/inventario/equipos/${e.id}/editar`}>Editar</Link>}
          {esAdmin && <button className="btn-secondary text-red-600" onClick={eliminar}>Eliminar</button>}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="card p-5 space-y-3">
            <h2 className="font-medium text-ink">Asignación</h2>
            {e.empleado ? (
              <p className="text-sm">
                Lo tiene <b>{e.empleado}</b>{e.area ? ` (${e.area})` : ""} desde el{" "}
                {fecha(asig.find((a) => !a.fecha_devolucion)?.fecha_entrega)}.
              </p>
            ) : (
              <p className="text-sm text-ink/50">No está asignado a nadie.</p>
            )}
            {editable && e.estado === "asignado" && (
              <div className="flex gap-2 flex-wrap print:hidden">
                <select className="input w-auto" value={condDev} onChange={(x) => setCondDev(x.target.value)} aria-label="Condición al devolver">
                  {Object.entries(CONDICIONES).map(([k, t]) => <option key={k} value={k}>Vuelve en estado {t.toLowerCase()}</option>)}
                </select>
                <button className="btn-secondary" onClick={() => rpc("inv_devolver_equipo", { p_equipo: e.id, p_condicion: condDev })}>
                  Registrar devolución
                </button>
              </div>
            )}
            {editable && ["en_stock", "prestado"].includes(e.estado) && (
              <div className="flex gap-2 print:hidden">
                <select className="input flex-1" value={empSel} onChange={(x) => setEmpSel(x.target.value)} aria-label="Empleado">
                  <option value="">Elegí a quién se entrega</option>
                  {empleados.map((p) => <option key={p.id} value={p.id}>{p.apellido}, {p.nombre} · {p.area}</option>)}
                </select>
                <button className="btn-primary" disabled={!empSel} onClick={() => rpc("inv_asignar_equipo", { p_equipo: e.id, p_empleado: empSel })}>
                  Asignar
                </button>
              </div>
            )}
            {asig.length > 0 && (
              <table className="data w-full mt-2">
                <thead><tr><th>Persona</th><th>Entrega</th><th>Devolución</th></tr></thead>
                <tbody>
                  {asig.map((a) => (
                    <tr key={a.id}>
                      <td>{a.empleados?.nombre} {a.empleados?.apellido}</td>
                      <td className="text-ink/60">{fecha(a.fecha_entrega)}</td>
                      <td className="text-ink/60">
                        {a.fecha_devolucion ? `${fecha(a.fecha_devolucion)} · ${CONDICIONES[a.condicion_devolucion] ?? ""}` : "En uso"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {e.empleado && (
            <div className="card p-5 space-y-3">
              <h2 className="font-medium text-ink">Otros equipos de {e.empleado}</h2>
              {otros.length === 0 ? (
                <p className="text-sm text-ink/50">No tiene periféricos ni otros equipos asignados.</p>
              ) : (
                <ul className="divide-y divide-line/[0.05]">
                  {otros.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <Link href={`/inventario/equipos/${o.id}`} className={claseCodigo(o.codigo)}>{o.codigo}</Link>
                        <span className="min-w-0">
                          <span className="text-ink">{o.categoria}</span>
                          <span className="text-ink/60">{[o.marca, o.modelo].filter(Boolean).length ? ` · ${[o.marca, o.modelo].filter(Boolean).join(" ")}` : ""}</span>
                          {o.numero_serie && <span className="block text-xs text-ink/40 truncate">S/N {o.numero_serie}</span>}
                        </span>
                      </span>
                      {puedeEditarEquipo(e.area) && (
                        <button className="text-xs text-ink/40 hover:text-red-600 shrink-0"
                          onClick={async () => {
                            if (!confirm(`¿Registrar la devolución de ${o.codigo}? Vuelve al stock.`)) return;
                            await rpc("inv_devolver_equipo", { p_equipo: o.id, p_condicion: "bueno" });
                          }}>
                          Devolver
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {puedeEditarEquipo(e.area) && (
                <div className="flex gap-2 pt-1 print:hidden">
                  <select className="input flex-1" value={perSel} onChange={(x) => setPerSel(x.target.value)} aria-label="Periférico en stock">
                    <option value="">{stockPer.length ? "Entregarle un periférico en stock…" : "No hay periféricos en stock"}</option>
                    {stockPer.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.codigo} · {p.categoria}{p.marca || p.modelo ? ` ${[p.marca, p.modelo].filter(Boolean).join(" ")}` : ""}{p.numero_serie ? ` · S/N ${p.numero_serie}` : ""}
                      </option>
                    ))}
                  </select>
                  <button className="btn-secondary" disabled={!perSel}
                    onClick={async () => { await rpc("inv_asignar_equipo", { p_equipo: perSel, p_empleado: e.empleado_id }); setPerSel(""); }}>
                    Asignar
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="card p-5 space-y-3">
            <h2 className="font-medium text-ink">Mantenimientos y reparaciones</h2>
            {mant.length === 0 && <p className="text-sm text-ink/50">Sin registros.</p>}
            {mant.length > 0 && (
              <ul className="space-y-2">
                {mant.map((m) => (
                  <li key={m.id} className="text-sm flex justify-between gap-3 border-b border-line/[0.04] pb-2 last:border-0">
                    <span>
                      {m.descripcion}
                      <span className="block text-xs text-ink/50">
                        {fecha(m.fecha)} · {m.tipo}{m.inv_proveedores ? ` · ${m.inv_proveedores.nombre}` : ""}
                      </span>
                    </span>
                    <span className="text-ink/60 whitespace-nowrap">{dinero(m.costo, e.moneda)}</span>
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <form onSubmit={agregarMant} className="grid grid-cols-3 gap-3 pt-2 print:hidden">
                <div>
                  <label className="label">Tipo</label>
                  <select className="input" value={nuevoMant.tipo} onChange={(x) => setNuevoMant({ ...nuevoMant, tipo: x.target.value })}>
                    <option value="correctivo">Reparación</option><option value="preventivo">Preventivo</option>
                    <option value="upgrade">Mejora / upgrade</option><option value="garantia">Por garantía</option>
                  </select>
                </div>
                <div>
                  <label className="label">Fecha</label>
                  <input type="date" className="input" value={nuevoMant.fecha} onChange={(x) => setNuevoMant({ ...nuevoMant, fecha: x.target.value })} />
                </div>
                <div>
                  <label className="label">Costo</label>
                  <input type="number" min={0} className="input" value={nuevoMant.costo} onChange={(x) => setNuevoMant({ ...nuevoMant, costo: x.target.value })} />
                </div>
                <div className="col-span-3">
                  <label className="label">Qué se hizo</label>
                  <input required className="input" value={nuevoMant.descripcion} onChange={(x) => setNuevoMant({ ...nuevoMant, descripcion: x.target.value })} />
                </div>
                <div><button className="btn-secondary">Agregar registro</button></div>
              </form>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="card p-5 flex gap-5 items-center etiqueta-print">
            {qr && <img src={qr} alt={`Código QR de ${e.codigo}`} width={110} height={110} />}
            <div>
              <span className={`${claseCodigo(e.codigo)} text-base`}>{e.codigo}</span>
              <p className="text-sm mt-2">{e.categoria}<span className="block text-ink/50">S/N {e.numero_serie ?? "—"}</span></p>
            </div>
          </div>


          {vivo && (
            <div className="card p-5 print:hidden">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-medium text-ink flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${conectado(vivo.ultimo_reporte) ? "bg-emerald-500" : "bg-line/20"}`} />
                  {conectado(vivo.ultimo_reporte) ? "Conectado" : "Desconectado"}
                </h2>
                <span className="text-xs text-ink/50">Último reporte {hace(vivo.ultimo_reporte)}</span>
              </div>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm mb-3">
                <Dato t="Usuario">{vivo.usuario ?? "Sin sesión iniciada"}</Dato>
                <Dato t="IP">{vivo.ip ?? "—"}</Dato>
                {textoUbicacion(vivo) && <Dato t="Ubicación">{textoUbicacion(vivo)}</Dato>}
                <Dato t="Sistema">{vivo.so_nombre} {vivo.so_version}</Dato>
                <Dato t="RAM">{vivo.ram_total_gb} GB · {vivo.ram_libre_gb} GB libres</Dato>
                <Dato t="Encendido hace">{encendidoDesde(vivo.arranque)}</Dato>
                {vivo.bateria_pct != null && <Dato t="Batería">{vivo.bateria_pct}%</Dato>}
                {Array.isArray(vivo.av_productos) ? (
                  <Dato t="Antivirus">
                    {vivo.av_productos.some((p: any) => p.activo)
                      ? vivo.av_productos.filter((p: any) => p.activo).map((p: any) => p.nombre).join(", ")
                      : <span className="text-red-600">Sin antivirus activo</span>}
                  </Dato>
                ) : vivo.antivirus_activo === false && <Dato t="Antivirus"><span className="text-red-600">Desactivado</span></Dato>}
              </dl>
              <div className="space-y-2">{(vivo.discos as Disco[]).map((d) => <BarraDisco key={d.unidad} d={d} />)}</div>
              {vivo.seguridad_actualizado && (() => {
                const ev = evaluar(vivo, permitidos);
                return (
                  <div className="mt-4 pt-3 border-t border-line/[0.06]">
                    <div className="text-xs text-ink/50 mb-2">Seguridad</div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      {CONTROLES.map((c) => (
                        <div key={c.k} className="flex items-center gap-1.5 text-sm">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${ESTILO[ev[c.k].nivel].punto}`} aria-hidden />
                          <span className="text-ink/50">{c.titulo}:</span>
                          <span className={ESTILO[ev[c.k].nivel].texto}>{ev[c.k].texto}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {vivo.apps_cantidad != null && (
                <Link href={`/inventario/aplicaciones?vista=equipo&equipo=${vivo.id}`} className="inline-block mt-3 text-sm text-brand-600 hover:underline">
                  Ver las {vivo.apps_cantidad} aplicaciones instaladas
                </Link>
              )}
            </div>
          )}
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-3">Datos</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
              <Dato t="N° de serie">{e.numero_serie ?? "—"}</Dato>
              {e.cantidad > 1 && <Dato t="Cantidad">{e.cantidad}</Dato>}
              <Dato t="Condición">{CONDICIONES[e.condicion]}</Dato>
              <Dato t="Área">{e.area ?? "—"}</Dato>
              <Dato t="Ubicación">{e.ubicacion ?? "—"}{e.ubicacion_detalle ? ` · ${e.ubicacion_detalle}` : ""}</Dato>
              {e.hostname && <Dato t="Hostname">{e.hostname}</Dato>}
              {e.ip && <Dato t="IP">{e.ip}</Dato>}
              {e.mac && <Dato t="MAC">{e.mac}</Dato>}
              {e.procesador && <Dato t="Procesador">{e.procesador}</Dato>}
              {e.ram_gb && <Dato t="RAM">{e.ram_gb} GB</Dato>}
              {e.almacenamiento && <Dato t="Almacenamiento">{e.almacenamiento}</Dato>}
              {e.sistema_operativo && <Dato t="Sistema operativo">{e.sistema_operativo}</Dato>}
              <Dato t="Proveedor">{e.proveedor ?? "—"}</Dato>
              <Dato t="Compra">{fecha(e.fecha_compra)}{e.nro_factura ? ` · Fact. ${e.nro_factura}` : ""}</Dato>
              <Dato t="Costo">{dinero(e.costo, e.moneda)}</Dato>
              <Dato t="Garantía">
                <span className={dias !== null && dias < 0 ? "text-red-600" : dias !== null && dias <= 60 ? "text-amber-600" : ""}>
                  {e.garantia_hasta ? `${fecha(e.garantia_hasta)}${dias! < 0 ? " (vencida)" : ""}` : "—"}
                </span>
              </Dato>
              {e.notas && <Dato t="Notas"><span className="whitespace-pre-wrap">{e.notas}</span></Dato>}
            </dl>
          </div>

          <div className="card p-5 print:hidden">
            <h2 className="font-medium text-ink mb-3">Cambios registrados</h2>
            <ul className="space-y-1.5 text-sm">
              {log.map((l) => (
                <li key={l.id}>
                  <span className="text-ink/50">{new Date(l.fecha).toLocaleString("es-AR")}</span>{" "}
                  {l.accion === "alta" ? "Alta en el inventario" : Object.keys(l.cambios ?? {}).map((k) => CAMPOS_LOG[k] ?? k).join(", ")}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
