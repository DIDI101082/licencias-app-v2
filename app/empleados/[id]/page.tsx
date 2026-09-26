"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { claseCodigo, fecha, dinero } from "@/lib/inventario";
import { conectado, hace } from "@/lib/monitoreo";
import { useRouter } from "next/navigation";
import { usePerfil } from "@/components/PerfilContext";
import NuevaActa from "@/components/NuevaActa";

const UBICACION: Record<string, { texto: string; clase: string }> = {
  oficina: { texto: "En la oficina", clase: "bg-brand-50 text-brand-700" },
  vpn: { texto: "Home office con VPN", clase: "bg-emerald-50 text-emerald-700" },
  remoto: { texto: "Home office sin VPN", clase: "bg-amber-500/10 text-amber-700" },
  invitados: { texto: "WiFi de invitados", clase: "bg-red-50 text-red-600" },
};

// Costo mensual equivalente de una licencia
function mensual(l: any) {
  if (!l) return 0;
  if (l.periodicidad === "mensual") return Number(l.costo_unitario) || 0;
  if (l.periodicidad === "anual") return (Number(l.costo_unitario) || 0) / 12;
  return 0;
}

export default function FichaEmpleado({ params }: { params: { id: string } }) {
  const [emp, setEmp] = useState<any>(null);
  const [noExiste, setNoExiste] = useState(false);
  const [equipos, setEquipos] = useState<any[]>([]);
  const [histEquipos, setHistEquipos] = useState<any[]>([]);
  const [licencias, setLicencias] = useState<any[]>([]);
  const [vivos, setVivos] = useState<Record<string, any>>({});
  const [movs, setMovs] = useState<any[]>([]);
  const [actas, setActas] = useState<any[]>([]);
  const [acta, setActa] = useState<"entrega" | "devolucion" | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const { puedeEditar } = usePerfil();
  const router = useRouter();

  async function iniciar(tipo: "alta" | "baja") {
    setErrorAccion(null);
    const { data, error } = await createClient().rpc("empleados_iniciar", { p_empleado: params.id, p_tipo: tipo });
    if (error) return setErrorAccion(error.message);
    router.push(`/empleados/movimientos/${data}`);
  }

  useEffect(() => {
    const sb = createClient();
    (async () => {
      const [e, eq, he, li] = await Promise.all([
        sb.from("empleados").select("*").eq("id", params.id).maybeSingle(),
        sb.from("inv_v_equipos").select("id, codigo, categoria, grupo, marca, modelo, numero_serie, estado")
          .eq("empleado_id", params.id).order("codigo"),
        sb.from("inv_asignaciones")
          .select("id, fecha_entrega, fecha_devolucion, condicion_devolucion, inv_equipos(id, codigo, marca, modelo, inv_categorias(nombre))")
          .eq("empleado_id", params.id).order("fecha_entrega", { ascending: false }),
        sb.from("asignaciones")
          .select("id, fecha_asignacion, fecha_liberacion, notas, licencias(id, nombre, proveedor, costo_unitario, periodicidad)")
          .eq("empleado_id", params.id).order("fecha_asignacion", { ascending: false }),
      ]);
      if (!e.data) { setNoExiste(true); return; }
      setEmp(e.data);
      const lista = eq.data ?? [];
      // Periféricos después de las computadoras
      setEquipos(lista.sort((a: any, b: any) => Number(a.grupo === "Periféricos") - Number(b.grupo === "Periféricos")));
      setHistEquipos(he.data ?? []);
      setLicencias(li.data ?? []);
      // Altas/bajas y actas (si todavía no se ejecutó altas-bajas.sql, quedan vacías)
      const [mv, ac] = await Promise.all([
        sb.from("empleados_movimientos").select("id, tipo, estado, fecha").eq("empleado_id", params.id).order("creado", { ascending: false }),
        sb.from("empleados_actas").select("id, numero, tipo, fecha").eq("empleado_id", params.id).order("fecha", { ascending: false }),
      ]);
      setMovs(mv.data ?? []);
      setActas(ac.data ?? []);
      if (lista.length) {
        const { data: d } = await sb.from("inv_dispositivos")
          .select("equipo_id, hostname, ultimo_reporte, ubicacion_tipo, ubicacion_sede, ubicacion_red")
          .in("equipo_id", lista.map((x: any) => x.id)).eq("estado_registro", "aprobado");
        setVivos(Object.fromEntries((d ?? []).map((x: any) => [x.equipo_id, x])));
      }
    })();
  }, [params.id]);

  if (noExiste) {
    return (
      <div className="card p-6 max-w-md">
        <p className="text-sm text-ink/60">No se encontró el empleado, o no tenés permiso para verlo.</p>
        <Link href="/empleados" className="text-sm text-brand-600 hover:underline mt-2 inline-block">← Volver a Empleados</Link>
      </div>
    );
  }
  if (!emp) return <p className="text-sm text-ink/50">Cargando…</p>;

  const licActivas = licencias.filter((l) => !l.fecha_liberacion);
  const licPasadas = licencias.filter((l) => l.fecha_liberacion);
  const costoMensual = licActivas.reduce((s, l) => s + mensual(l.licencias), 0);
  const devueltos = histEquipos.filter((h) => h.fecha_devolucion);
  const computadoras = equipos.filter((e) => e.grupo !== "Periféricos");
  const perifericos = equipos.filter((e) => e.grupo === "Periféricos");
  const vivoPrincipal = computadoras.map((c) => vivos[c.id]).find(Boolean);

  const FilaEquipo = ({ e }: { e: any }) => {
    const v = vivos[e.id];
    const asig = histEquipos.find((h) => h.inv_equipos?.id === e.id && !h.fecha_devolucion);
    return (
      <li className="flex items-start justify-between gap-3 py-2.5 text-sm">
        <span className="flex items-start gap-2 min-w-0">
          <Link href={`/inventario/equipos/${e.id}`} className={claseCodigo(e.codigo)}>{e.codigo}</Link>
          <span className="min-w-0">
            <span className="text-ink">{e.categoria}</span>
            <span className="text-ink/60">{e.marca || e.modelo ? ` · ${[e.marca, e.modelo].filter(Boolean).join(" ")}` : ""}</span>
            <span className="block text-xs text-ink/40">
              {e.numero_serie ? `S/N ${e.numero_serie}` : ""}{asig ? `${e.numero_serie ? " · " : ""}entregado el ${fecha(asig.fecha_entrega)}` : ""}
            </span>
          </span>
        </span>
        {v && (
          <span className="flex items-center gap-1.5 text-xs whitespace-nowrap shrink-0">
            <span className={`h-2 w-2 rounded-full ${conectado(v.ultimo_reporte) ? "bg-emerald-500" : "bg-line/20"}`} />
            {conectado(v.ultimo_reporte) ? "Conectado" : `Visto ${hace(v.ultimo_reporte)}`}
          </span>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <Link href="/empleados" className="text-sm text-brand-600 hover:underline">← Empleados</Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">{emp.nombre} {emp.apellido}</h1>
          <p className="text-sm text-ink/60 mt-1">
            {emp.email}{emp.area ? ` · ${emp.area}` : ""}{emp.puesto ? ` · ${emp.puesto}` : ""}
          </p>
          <div className="flex gap-2 mt-2">
            <span className={`pill ${emp.activo ? "bg-emerald-50 text-emerald-700" : "bg-line/[0.05] text-ink/50"}`}>{emp.activo ? "Activo" : "Inactivo"}</span>
            {emp.entra_id && <span className="pill bg-brand-50 text-brand-700">Sincronizado con Entra ID</span>}
            {!emp.activo && equipos.length > 0 && <span className="pill bg-red-50 text-red-600">Tiene equipos para recuperar</span>}
            {movs.filter((m) => m.estado === "abierto").map((m) => (
              <Link key={m.id} href={`/empleados/movimientos/${m.id}`} className={`pill ${m.tipo === "alta" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"} hover:underline`}>
                {m.tipo === "alta" ? "Alta en curso" : "Baja en curso"} →
              </Link>
            ))}
          </div>
        </div>
        {puedeEditar && (
          <div className="flex gap-2 flex-wrap print:hidden">
            <button className="btn-secondary" onClick={() => setActa("entrega")}>Acta de entrega</button>
            <button className="btn-secondary" onClick={() => setActa("devolucion")}>Acta de devolución</button>
            {!movs.some((m) => m.estado === "abierto") && (
              <button className="btn-secondary" onClick={() => iniciar(emp.activo ? "baja" : "alta")}>
                {emp.activo ? "Iniciar baja" : "Iniciar alta"}
              </button>
            )}
          </div>
        )}
      </div>
      {errorAccion && <div className="card p-3 text-sm text-red-600 bg-red-50">{errorAccion}</div>}
      {acta && <NuevaActa empleadoId={params.id} tipo={acta} onCerrar={() => setActa(null)} />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Equipos IT asignados</div>
          <div className="font-display text-3xl text-ink mt-1">{equipos.length}</div>
          <div className="text-xs text-ink/50">{computadoras.length} computadoras · {perifericos.length} periféricos</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Licencias activas</div>
          <div className="font-display text-3xl text-ink mt-1">{licActivas.length}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Costo mensual en licencias</div>
          <div className="font-display text-2xl text-ink mt-1">{dinero(costoMensual)}</div>
          <div className="text-xs text-ink/50">las anuales se prorratean</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Dónde está ahora</div>
          {vivoPrincipal && conectado(vivoPrincipal.ultimo_reporte) && vivoPrincipal.ubicacion_tipo ? (
            <>
              <span className={`pill mt-2 ${UBICACION[vivoPrincipal.ubicacion_tipo]?.clase ?? "bg-line/[0.05] text-ink/60"}`}>
                {UBICACION[vivoPrincipal.ubicacion_tipo]?.texto ?? "Sin datos"}
              </span>
              {vivoPrincipal.ubicacion_red && <div className="text-xs text-ink/50 mt-1">{vivoPrincipal.ubicacion_red}</div>}
            </>
          ) : (
            <div className="text-sm text-ink/50 mt-2">{vivoPrincipal ? "Equipo desconectado" : "Sin datos del agente"}</div>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-1">Equipos IT</h2>
          {equipos.length === 0 ? <p className="text-sm text-ink/50">No tiene equipos asignados.</p> : (
            <>
              {computadoras.length > 0 && <ul className="divide-y divide-line/[0.05]">{computadoras.map((e) => <FilaEquipo key={e.id} e={e} />)}</ul>}
              {perifericos.length > 0 && (
                <>
                  <div className="text-xs text-ink/50 mt-3 uppercase tracking-wide">Periféricos</div>
                  <ul className="divide-y divide-line/[0.05]">{perifericos.map((e) => <FilaEquipo key={e.id} e={e} />)}</ul>
                </>
              )}
            </>
          )}
          {devueltos.length > 0 && (
            <details className="mt-4">
              <summary className="text-sm text-brand-600 cursor-pointer">Equipos que tuvo antes ({devueltos.length})</summary>
              <ul className="mt-2 space-y-1 text-sm text-ink/70">
                {devueltos.map((h) => (
                  <li key={h.id}>
                    {h.inv_equipos ? (
                      <Link href={`/inventario/equipos/${h.inv_equipos.id}`} className="text-brand-600 hover:underline">{h.inv_equipos.codigo}</Link>
                    ) : "Equipo eliminado"}{" "}
                    {h.inv_equipos?.inv_categorias?.nombre} {[h.inv_equipos?.marca, h.inv_equipos?.modelo].filter(Boolean).join(" ")}
                    <span className="text-xs text-ink/50"> · del {fecha(h.fecha_entrega)} al {fecha(h.fecha_devolucion)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="font-medium text-ink">Licencias</h2>
            <Link href="/asignaciones" className="text-xs text-brand-600 hover:underline">Asignar o liberar</Link>
          </div>
          {licActivas.length === 0 ? <p className="text-sm text-ink/50">No tiene licencias asignadas.</p> : (
            <ul className="divide-y divide-line/[0.05]">
              {licActivas.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                  <span>
                    <span className="text-ink">{a.licencias?.nombre}</span>
                    <span className="block text-xs text-ink/50">{a.licencias?.proveedor} · desde el {fecha(a.fecha_asignacion)}</span>
                  </span>
                  <span className="text-ink/60 whitespace-nowrap text-xs text-right">
                    {dinero(Number(a.licencias?.costo_unitario) || 0)}
                    <span className="block text-ink/40">{a.licencias?.periodicidad}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {licPasadas.length > 0 && (
            <details className="mt-4">
              <summary className="text-sm text-brand-600 cursor-pointer">Licencias que tuvo antes ({licPasadas.length})</summary>
              <ul className="mt-2 space-y-1 text-sm text-ink/70">
                {licPasadas.map((a) => (
                  <li key={a.id}>
                    {a.licencias?.nombre}
                    <span className="text-xs text-ink/50"> · del {fecha(a.fecha_asignacion)} al {fecha(a.fecha_liberacion)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {(movs.length > 0 || actas.length > 0) && (
        <div className="grid md:grid-cols-2 gap-6">
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-1">Altas y bajas</h2>
            {movs.length === 0 ? <p className="text-sm text-ink/50">Sin registros.</p> : (
              <ul className="space-y-1 text-sm">
                {movs.map((m) => (
                  <li key={m.id}>
                    <Link href={`/empleados/movimientos/${m.id}`} className="text-brand-600 hover:underline">{m.tipo === "alta" ? "Alta" : "Baja"} del {fecha(m.fecha)}</Link>
                    <span className="text-xs text-ink/50"> · {m.estado === "abierto" ? "en curso" : m.estado}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-1">Actas</h2>
            {actas.length === 0 ? <p className="text-sm text-ink/50">Sin actas.</p> : (
              <ul className="space-y-1 text-sm">
                {actas.map((a) => (
                  <li key={a.id}>
                    <Link href={`/empleados/actas/${a.id}`} className="text-brand-600 hover:underline">N° {String(a.numero).padStart(5, "0")} · {a.tipo === "entrega" ? "Entrega" : "Devolución"}</Link>
                    <span className="text-xs text-ink/50"> · {fecha(a.fecha)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
