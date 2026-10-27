"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS_MOB, COLOR_ESTADO, LABELS_MOVIMIENTO, type MobiliarioItem, type MovimientoMob } from "@/lib/mobiliario";
import { fecha } from "@/lib/inventario";
import { usePerfil } from "@/components/PerfilContext";

export default function DetalleMobiliario() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { puedeEditar, esAdmin } = usePerfil();
  const [item, setItem] = useState<MobiliarioItem | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoMob[]>([]);
  const [cargando, setCargando] = useState(true);
  const [confirmBaja, setConfirmBaja] = useState(false);

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("mob_v_mobiliario").select("*").eq("id", id).single(),
      sb.from("mob_v_movimientos").select("*").eq("mobiliario_id", id).order("fecha", { ascending: false }),
    ]).then(([{ data: mob }, { data: movs }]) => {
      setItem(mob as MobiliarioItem | null);
      setMovimientos((movs ?? []) as MovimientoMob[]);
      setCargando(false);
    });
  }, [id]);

  async function eliminar() {
    if (!confirm("¿Eliminar este elemento permanentemente? Esta acción no se puede deshacer.")) return;
    const sb = createClient();
    await sb.from("mob_movimientos").delete().eq("mobiliario_id", id);
    await sb.from("mob_mobiliario").delete().eq("id", id);
    router.push("/mobiliario");
  }

  async function darDeBaja() {
    const motivo = prompt("Motivo de la baja:");
    if (motivo === null) return;
    const sb = createClient();
    const { data: { user } } = await sb.auth.getUser();
    await sb.from("mobiliario").update({
      estado: "dado_de_baja",
      fecha_baja: new Date().toISOString().slice(0, 10),
      motivo_baja: motivo || null,
      empleado_id: null,
    }).eq("id", id);
    await sb.from("mob_movimientos").insert({
      mobiliario_id: Number(id),
      tipo_movimiento: "baja",
      piso_origen: item?.piso ?? null,
      sector_origen: item?.sector ?? null,
      empleado_origen_id: item?.empleado_id ?? null,
      usuario_id: user?.id ?? null,
      notas: motivo || null,
    });
    router.refresh();
    router.push("/mobiliario");
  }

  async function registrarTraslado() {
    const piso = prompt("Piso destino:");
    if (piso === null) return;
    const sector = prompt("Sector destino:");
    if (sector === null) return;
    const sb = createClient();
    const { data: { user } } = await sb.auth.getUser();
    await sb.from("mobiliario").update({ piso, sector }).eq("id", id);
    await sb.from("mob_movimientos").insert({
      mobiliario_id: Number(id),
      tipo_movimiento: "traslado",
      piso_origen: item?.piso ?? null,
      sector_origen: item?.sector ?? null,
      piso_destino: piso || null,
      sector_destino: sector || null,
      empleado_origen_id: item?.empleado_id ?? null,
      empleado_destino_id: item?.empleado_id ?? null,
      usuario_id: user?.id ?? null,
    });
    setItem((prev) => prev ? { ...prev, piso, sector } : prev);
    setMovimientos((prev) => [
      {
        id: Date.now(),
        mobiliario_id: Number(id),
        codigo: item?.codigo ?? "",
        tipo_movimiento: "traslado",
        piso_origen: item?.piso ?? null,
        sector_origen: item?.sector ?? null,
        piso_destino: piso || null,
        sector_destino: sector || null,
        empleado_origen_id: item?.empleado_id ?? null,
        empleado_origen: item?.empleado ?? null,
        empleado_destino_id: item?.empleado_id ?? null,
        empleado_destino: item?.empleado ?? null,
        fecha: new Date().toISOString(),
        usuario: null,
        notas: null,
      },
      ...prev,
    ]);
  }

  if (cargando) return <p className="text-ink/40 py-12 text-center">Cargando…</p>;
  if (!item) return <p className="text-ink/40 py-12 text-center">Elemento no encontrado.</p>;

  const esBaja = item.estado === "dado_de_baja";

  return (
    <div className="space-y-6">
      {/* Encabezado */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-2xl text-ink">{item.tipo}</h1>
            <span className="tag-inv font-mono text-xs">{item.codigo}</span>
            <span className={COLOR_ESTADO[item.estado] ?? ""}>{ESTADOS_MOB[item.estado]}</span>
          </div>
          {item.descripcion && <p className="text-ink/60 mt-1">{item.descripcion}</p>}
        </div>
        {puedeEditar && (
          <div className="flex gap-2 flex-wrap">
            <Link href={`/mobiliario/qr?id=${id}`} className="btn-secondary">
              🔲 Generar QR
            </Link>
            {!esBaja && (
              <button className="btn-secondary" onClick={registrarTraslado}>
                Registrar traslado
              </button>
            )}
            <Link href={`/mobiliario/${id}/editar`} className="btn-secondary">
              Editar
            </Link>
            {!esBaja && esAdmin && (
              <button className="btn-danger" onClick={darDeBaja}>
                Dar de baja
              </button>
            )}
            {esAdmin && (
              <button className="btn-danger" onClick={eliminar}>
                Eliminar
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Datos del mueble */}
        <div className="card p-5 space-y-3">
          <h2 className="font-display font-bold text-ink">Datos del mueble</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink/50">Tipo</dt><dd className="text-ink">{item.tipo}</dd>
            {item.marca && <><dt className="text-ink/50">Marca / Modelo</dt><dd className="text-ink">{[item.marca, item.modelo].filter(Boolean).join(" ")}</dd></>}
            {item.numero_serie && <><dt className="text-ink/50">N° de serie</dt><dd className="font-mono text-ink">{item.numero_serie}</dd></>}
            {item.color && <><dt className="text-ink/50">Color</dt><dd className="text-ink">{item.color}</dd></>}
            {item.numero_inventario && <><dt className="text-ink/50">N° inventario</dt><dd className="font-mono text-ink">{item.numero_inventario}</dd></>}
            <dt className="text-ink/50">Fecha ingreso</dt><dd className="text-ink">{fecha(item.fecha_ingreso)}</dd>
            {item.responsable && <><dt className="text-ink/50">Responsable</dt><dd className="text-ink">{item.responsable}</dd></>}
            {esBaja && item.fecha_baja && <><dt className="text-ink/50">Fecha baja</dt><dd className="text-ink">{fecha(item.fecha_baja)}</dd></>}
            {esBaja && item.motivo_baja && <><dt className="text-ink/50">Motivo baja</dt><dd className="text-ink">{item.motivo_baja}</dd></>}
          </dl>
          {item.notas && <p className="text-sm text-ink/60 border-t border-line/[0.06] pt-3">{item.notas}</p>}
        </div>

        {/* Ubicación y asignación */}
        <div className="card p-5 space-y-3">
          <h2 className="font-display font-bold text-ink">Ubicación y asignación</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink/50">Estado</dt><dd><span className={COLOR_ESTADO[item.estado] ?? ""}>{ESTADOS_MOB[item.estado]}</span></dd>
            <dt className="text-ink/50">Piso</dt><dd className="text-ink">{item.piso ?? "—"}</dd>
            <dt className="text-ink/50">Sector</dt><dd className="text-ink">{item.sector ?? "—"}</dd>
            {item.detalle_ubicacion && <><dt className="text-ink/50">Detalle</dt><dd className="text-ink">{item.detalle_ubicacion}</dd></>}
            <dt className="text-ink/50">Asignado a</dt>
            <dd className="text-ink">{item.empleado ?? <span className="text-ink/40">Sin asignación</span>}</dd>
          </dl>
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
                <th>Origen</th>
                <th>Destino</th>
                <th>Notas</th>
              </tr>
            </thead>
            <tbody>
              {movimientos.map((m) => (
                <tr key={m.id}>
                  <td className="text-ink/60 whitespace-nowrap">{fecha(m.fecha)}</td>
                  <td><span className="tag-inv">{LABELS_MOVIMIENTO[m.tipo_movimiento] ?? m.tipo_movimiento}</span></td>
                  <td>
                    {m.piso_origen && <div className="text-sm">{m.piso_origen}{m.sector_origen ? ` – ${m.sector_origen}` : ""}</div>}
                    {m.empleado_origen && <div className="text-xs text-ink/50">{m.empleado_origen}</div>}
                    {!m.piso_origen && !m.empleado_origen && <span className="text-ink/40">—</span>}
                  </td>
                  <td>
                    {m.piso_destino && <div className="text-sm">{m.piso_destino}{m.sector_destino ? ` – ${m.sector_destino}` : ""}</div>}
                    {m.empleado_destino && <div className="text-xs text-ink/50">{m.empleado_destino}</div>}
                    {!m.piso_destino && !m.empleado_destino && <span className="text-ink/40">—</span>}
                  </td>
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
