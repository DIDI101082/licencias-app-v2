"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS_CEL, COLOR_ESTADO_CEL, LABELS_MOV_CEL, type CelularItem, type MovimientoCel } from "@/lib/celulares";
import { fecha } from "@/lib/inventario";
import { usePerfil } from "@/components/PerfilContext";

export default function DetalleCelular() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { puedeEditar, esAdmin } = usePerfil();
  const [item, setItem] = useState<CelularItem | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoCel[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("cel_v_celulares").select("*").eq("id", id).single(),
      sb.from("cel_v_movimientos").select("*").eq("celular_id", id).order("fecha", { ascending: false }),
    ]).then(([{ data: cel }, { data: movs }]) => {
      setItem(cel as CelularItem | null);
      setMovimientos((movs ?? []) as MovimientoCel[]);
      setCargando(false);
    });
  }, [id]);

  async function eliminar() {
    if (!confirm("¿Eliminar este celular permanentemente? Esta acción no se puede deshacer.")) return;
    const sb = createClient();
    await sb.from("cel_movimientos").delete().eq("celular_id", id);
    await sb.from("cel_celulares").delete().eq("id", id);
    router.push("/celulares");
  }

  if (cargando) return <p className="text-ink/40 py-12 text-center">Cargando…</p>;
  if (!item) return <p className="text-ink/40 py-12 text-center">Equipo no encontrado.</p>;

  const esBaja = item.estado === "dado_de_baja";

  return (
    <div className="space-y-6">
      {/* Encabezado */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-2xl text-ink">{item.marca} {item.modelo}</h1>
            <span className="tag-inv font-mono text-xs">{item.codigo}</span>
            <span className={COLOR_ESTADO_CEL[item.estado] ?? ""}>{ESTADOS_CEL[item.estado]}</span>
          </div>
          {item.color && <p className="text-ink/60 mt-1">{item.color}{item.almacenamiento ? ` · ${item.almacenamiento}` : ""}</p>}
        </div>
        {puedeEditar && (
          <div className="flex gap-2 flex-wrap">
            <Link href={`/celulares/qr?id=${id}`} className="btn-secondary">
              🔲 Generar QR
            </Link>
            <Link href={`/celulares/${id}/editar`} className="btn-secondary">
              Editar
            </Link>
            {esAdmin && (
              <button className="btn-danger" onClick={eliminar}>
                Eliminar
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Datos del equipo */}
        <div className="card p-5 space-y-3">
          <h2 className="font-display font-bold text-ink">Datos del equipo</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink/50">Marca</dt><dd className="text-ink">{item.marca}</dd>
            <dt className="text-ink/50">Modelo</dt><dd className="text-ink">{item.modelo}</dd>
            {item.color && <><dt className="text-ink/50">Color</dt><dd className="text-ink">{item.color}</dd></>}
            {item.almacenamiento && <><dt className="text-ink/50">Almacenamiento</dt><dd className="text-ink">{item.almacenamiento}</dd></>}
            {item.numero_inventario && <><dt className="text-ink/50">N° inventario</dt><dd className="font-mono text-ink">{item.numero_inventario}</dd></>}
            <dt className="text-ink/50">Fecha ingreso</dt><dd className="text-ink">{fecha(item.fecha_ingreso)}</dd>
            {esBaja && item.fecha_baja && <><dt className="text-ink/50">Fecha baja</dt><dd className="text-ink">{fecha(item.fecha_baja)}</dd></>}
            {esBaja && item.motivo_baja && <><dt className="text-ink/50">Motivo baja</dt><dd className="text-ink">{item.motivo_baja}</dd></>}
          </dl>
        </div>

        {/* IMEI y SIM */}
        <div className="card p-5 space-y-3">
          <h2 className="font-display font-bold text-ink">IMEI y SIM</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {item.imei
              ? <><dt className="text-ink/50">IMEI</dt><dd className="font-mono text-ink break-all">{item.imei}</dd></>
              : <><dt className="text-ink/50">IMEI</dt><dd className="text-ink/40">—</dd></>}
            {item.imei2 && <><dt className="text-ink/50">IMEI 2</dt><dd className="font-mono text-ink break-all">{item.imei2}</dd></>}
            {item.numero_linea
              ? <><dt className="text-ink/50">N° línea</dt><dd className="text-ink">{item.numero_linea}</dd></>
              : <><dt className="text-ink/50">N° línea</dt><dd className="text-ink/40">—</dd></>}
            {item.operadora && <><dt className="text-ink/50">Operadora</dt><dd className="text-ink">{item.operadora}</dd></>}
            {item.numero_sim && <><dt className="text-ink/50">N° SIM</dt><dd className="font-mono text-ink break-all">{item.numero_sim}</dd></>}
            {item.plan && <><dt className="text-ink/50">Plan</dt><dd className="text-ink">{item.plan}</dd></>}
          </dl>
        </div>

        {/* Asignación y ubicación */}
        <div className="card p-5 space-y-3">
          <h2 className="font-display font-bold text-ink">Asignación y ubicación</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink/50">Estado</dt>
            <dd><span className={COLOR_ESTADO_CEL[item.estado] ?? ""}>{ESTADOS_CEL[item.estado]}</span></dd>
            <dt className="text-ink/50">Asignado a</dt>
            <dd className="text-ink">{item.empleado ?? <span className="text-ink/40">Sin asignación</span>}</dd>
            <dt className="text-ink/50">Piso</dt><dd className="text-ink">{item.piso ?? "—"}</dd>
            <dt className="text-ink/50">Sector</dt><dd className="text-ink">{item.sector ?? "—"}</dd>
            {item.responsable && <><dt className="text-ink/50">Responsable</dt><dd className="text-ink">{item.responsable}</dd></>}
          </dl>
          {item.notas && <p className="text-sm text-ink/60 border-t border-line/[0.06] pt-3">{item.notas}</p>}
        </div>
      </div>

      {/* Historial de movimientos */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-line/[0.06]">
          <h2 className="font-display font-bold text-ink">Historial de movimientos</h2>
        </div>
        {movimientos.length === 0 ? (
          <p className="text-ink/40 text-sm py-8 text-center">Sin movimientos registrados.</p>
        ) : (
          <table className="data w-full">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Persona anterior</th>
                <th>Persona nueva</th>
                <th>Notas</th>
              </tr>
            </thead>
            <tbody>
              {movimientos.map((m) => (
                <tr key={m.id}>
                  <td className="text-ink/60 whitespace-nowrap">{fecha(m.fecha)}</td>
                  <td><span className="tag-inv">{LABELS_MOV_CEL[m.tipo_movimiento] ?? m.tipo_movimiento}</span></td>
                  <td className="text-sm">{m.empleado_origen ?? <span className="text-ink/40">—</span>}</td>
                  <td className="text-sm">{m.empleado_destino ?? <span className="text-ink/40">—</span>}</td>
                  <td className="text-ink/60 text-sm">{m.notas ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
