"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { fecha, claseCodigo } from "@/lib/inventario";
import NuevaActa from "@/components/NuevaActa";

type Tarea = { id: number; orden: number; descripcion: string; responsable: string; hecha: boolean; hecha_en: string | null; hecha_por_nombre: string | null; nota: string | null };

const RESP_CLASE: Record<string, string> = {
  RRHH: "bg-violet-50 text-violet-700",
  CAU: "bg-brand-50 text-brand-700",
  Ciberseguridad: "bg-emerald-50 text-emerald-700",
};
const fh = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "");

export default function Movimiento({ params }: { params: { id: string } }) {
  const { puedeEditar } = usePerfil();
  const [mov, setMov] = useState<any>(null);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [equipos, setEquipos] = useState<any[]>([]);
  const [licencias, setLicencias] = useState<any[]>([]);
  const [actas, setActas] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [acta, setActa] = useState<"entrega" | "devolucion" | null>(null);
  const [notas, setNotas] = useState<Record<number, string>>({});

  const cargar = async () => {
    const sb = createClient();
    const { data: m } = await sb.from("empleados_v_movimientos").select("*").eq("id", params.id).maybeSingle();
    if (!m) { setError("No se encontró el checklist o no tenés permiso para verlo."); return; }
    setMov(m);
    const [t, eq, li, ac] = await Promise.all([
      sb.from("empleados_tareas").select("*").eq("movimiento_id", params.id).order("orden").order("id"),
      sb.from("inv_v_equipos").select("id, codigo, categoria, marca, modelo, numero_serie").eq("empleado_id", m.empleado_id).order("codigo"),
      sb.from("asignaciones").select("id, fecha_asignacion, licencias(nombre, proveedor)").eq("empleado_id", m.empleado_id).is("fecha_liberacion", null),
      sb.from("empleados_actas").select("id, numero, tipo, fecha").eq("empleado_id", m.empleado_id).order("fecha", { ascending: false }),
    ]);
    setTareas((t.data ?? []) as Tarea[]);
    setEquipos(eq.data ?? []);
    setLicencias(li.data ?? []);
    setActas(ac.data ?? []);
  };
  useEffect(() => { cargar(); }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function marcar(t: Tarea, hecha: boolean) {
    setError(null);
    const { error } = await createClient().rpc("empleados_tarea_marcar", { p_tarea: t.id, p_hecha: hecha, p_nota: notas[t.id] ?? null });
    if (error) return setError(error.message);
    setNotas((n) => { const c = { ...n }; delete c[t.id]; return c; });
    cargar();
  }
  async function cerrar(estado: "completo" | "descartado" | "abierto") {
    if (estado === "descartado" && !confirm("¿Descartar este checklist? Queda en el historial como descartado.")) return;
    setError(null);
    const { error } = await createClient().rpc("empleados_movimiento_cerrar", { p_mov: Number(params.id), p_estado: estado });
    if (error) return setError(error.message);
    cargar();
  }

  if (error && !mov) return <p className="text-sm text-ink/60">{error}</p>;
  if (!mov) return <p className="text-sm text-ink/50">Cargando…</p>;

  const abierto = mov.estado === "abierto";
  const editable = abierto && puedeEditar;
  const hechas = tareas.filter((t) => t.hecha).length;
  const grupos = Array.from(new Set(tareas.map((t) => t.responsable)));
  const esBaja = mov.tipo === "baja";

  return (
    <div className="space-y-6">
      <Link href="/empleados/movimientos" className="text-sm text-brand-600 hover:underline">← Altas y bajas</Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <span className={`pill ${esBaja ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{esBaja ? "Baja" : "Alta"}</span>
            <span className="pill bg-black/[0.05] text-ink/60">{abierto ? "En curso" : mov.estado === "completo" ? "Completo" : "Descartado"}</span>
          </div>
          <h1 className="font-display text-2xl text-ink mt-2">
            <Link href={`/empleados/${mov.empleado_id}`} className="hover:text-brand-700">{mov.nombre} {mov.apellido}</Link>
          </h1>
          <p className="text-sm text-ink/60 mt-1">{mov.email}{mov.area ? ` · ${mov.area}` : ""} · desde el {fecha(mov.fecha)} · {mov.origen === "manual" ? "iniciado a mano" : "detectado automáticamente"}</p>
        </div>
        {puedeEditar && (
          <div className="flex gap-2 flex-wrap">
            <button className="btn-secondary" onClick={() => setActa(esBaja ? "devolucion" : "entrega")}>Acta de {esBaja ? "devolución" : "entrega"}</button>
            {abierto ? (
              <>
                <button className="btn-secondary" onClick={() => cerrar("descartado")}>Descartar</button>
                <button className="btn-primary" disabled={hechas < tareas.length} title={hechas < tareas.length ? "Faltan tareas" : ""} onClick={() => cerrar("completo")}>Marcar como completo</button>
              </>
            ) : (
              <button className="btn-secondary" onClick={() => cerrar("abierto")}>Reabrir</button>
            )}
          </div>
        )}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}

      <div className="card p-4">
        <div className="flex items-center gap-3">
          <div className="h-2.5 flex-1 rounded-full bg-black/[0.06] overflow-hidden">
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${tareas.length ? (hechas / tareas.length) * 100 : 0}%` }} />
          </div>
          <span className="text-sm text-ink/70 tabular-nums">{hechas} de {tareas.length} tareas</span>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {grupos.map((g) => (
            <div key={g} className="card p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className={`pill ${RESP_CLASE[g] ?? "bg-black/[0.05] text-ink/60"}`}>{g}</span>
                <span className="text-xs text-ink/50">{tareas.filter((t) => t.responsable === g && t.hecha).length}/{tareas.filter((t) => t.responsable === g).length}</span>
              </div>
              <ul className="divide-y divide-black/[0.05]">
                {tareas.filter((t) => t.responsable === g).map((t) => (
                  <li key={t.id} className="py-2.5">
                    <label className={`flex items-start gap-3 text-sm ${editable ? "cursor-pointer" : ""}`}>
                      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={t.hecha} disabled={!editable} onChange={(e) => marcar(t, e.target.checked)} />
                      <span className="flex-1">
                        <span className={t.hecha ? "text-ink/50 line-through" : "text-ink"}>{t.descripcion}</span>
                        {t.hecha && <span className="block text-xs text-ink/50">Hecho por {t.hecha_por_nombre ?? "—"} · {fh(t.hecha_en)}</span>}
                        {t.nota && <span className="block text-xs text-ink/60 mt-0.5">📝 {t.nota}</span>}
                      </span>
                    </label>
                    {editable && !t.hecha && (
                      <input className="input mt-1.5 ml-7 py-1 text-xs w-[calc(100%-1.75rem)]" placeholder="Nota opcional (se guarda al marcar)"
                        value={notas[t.id] ?? ""} onChange={(e) => setNotas({ ...notas, [t.id]: e.target.value })} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-1">Equipos asignados</h2>
            {equipos.length === 0 ? <p className="text-sm text-ink/50">{esBaja ? "✅ No tiene equipos pendientes de devolver." : "Todavía sin equipos."}</p> : (
              <ul className="space-y-2 text-sm">
                {equipos.map((e) => (
                  <li key={e.id} className="flex gap-2 items-start">
                    <Link href={`/inventario/equipos/${e.id}`} className={claseCodigo(e.codigo)}>{e.codigo}</Link>
                    <span className="text-ink/70">{e.categoria} {[e.marca, e.modelo].filter(Boolean).join(" ")}</span>
                  </li>
                ))}
              </ul>
            )}
            {esBaja && equipos.length > 0 && <p className="text-xs text-red-600 mt-2">Registrá la devolución en Inventario IT y generá el acta.</p>}
          </div>
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-1">Licencias activas</h2>
            {licencias.length === 0 ? <p className="text-sm text-ink/50">{esBaja ? "✅ No tiene licencias sin liberar." : "Todavía sin licencias."}</p> : (
              <ul className="space-y-1 text-sm text-ink/70">
                {licencias.map((l) => <li key={l.id}>{l.licencias?.nombre} <span className="text-xs text-ink/40">· {l.licencias?.proveedor}</span></li>)}
              </ul>
            )}
            {esBaja && licencias.length > 0 && <Link href="/asignaciones" className="text-xs text-brand-600 hover:underline mt-2 inline-block">Liberar en Asignaciones →</Link>}
          </div>
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-1">Actas</h2>
            {actas.length === 0 ? <p className="text-sm text-ink/50">Sin actas generadas.</p> : (
              <ul className="space-y-1 text-sm">
                {actas.map((a) => (
                  <li key={a.id}>
                    <Link href={`/empleados/actas/${a.id}`} className="text-brand-600 hover:underline">
                      N° {String(a.numero).padStart(5, "0")} · {a.tipo === "entrega" ? "Entrega" : "Devolución"}
                    </Link>
                    <span className="text-xs text-ink/50"> · {fecha(a.fecha)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {acta && <NuevaActa empleadoId={mov.empleado_id} tipo={acta} onCerrar={() => setActa(null)} />}
    </div>
  );
}
