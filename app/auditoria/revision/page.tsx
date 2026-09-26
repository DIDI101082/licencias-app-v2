"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { NOMBRE_MODULO, type Modulo } from "@/lib/modulos";

type Campana = {
  id: number; nombre: string; creada: string; creada_por_nombre: string | null; vence: string; estado: "abierta" | "cerrada";
  cerrada: string | null; cerrada_por_nombre: string | null; conclusion: string | null;
};
type Item = {
  id: number; email: string; nombre: string | null; rol: string; grupo: string | null; modulos: string[]; ultimo_ingreso: string | null;
  empleado_activo: boolean | null; observaciones: string[]; decision: "pendiente" | "mantener" | "cambiar" | "quitar"; nota: string | null;
  decidido_por_nombre: string | null; decidido_en: string | null; aplicado: string | null;
};

const ROL: Record<string, string> = { administrador: "Administrador", lectura_escritura: "Lectura y escritura", solo_lectura: "Solo lectura" };
const DEC = {
  pendiente: { texto: "Pendiente", clase: "bg-black/[0.05] text-ink/60" },
  mantener: { texto: "Mantener", clase: "bg-emerald-50 text-emerald-700" },
  cambiar: { texto: "Cambiar", clase: "bg-amber-500/10 text-amber-700" },
  quitar: { texto: "Quitar", clase: "bg-red-50 text-red-600" },
};
const f = (v: string | null, hora = false) => (v ? new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleString("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", ...(hora ? { timeStyle: "short" } : {}),
}) : "—");

export default function RevisionAccesos() {
  const { esAdmin, puedeEditar } = usePerfil();
  const [campanas, setCampanas] = useState<Campana[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notas, setNotas] = useState<Record<number, string>>({});
  const [soloObs, setSoloObs] = useState(false);
  const [cargando, setCargando] = useState(true);

  const cargarCampanas = async (elegir?: number) => {
    const { data, error } = await createClient().from("revision_campanas").select("*").order("creada", { ascending: false });
    if (error) setError(error.message.includes("revision_") ? "Falta ejecutar revision-accesos.sql en Supabase." : error.message);
    const lista = (data ?? []) as Campana[];
    setCampanas(lista);
    setSel((s) => elegir ?? (s && lista.some((c) => c.id === s) ? s : lista[0]?.id ?? null));
    setCargando(false);
  };
  const cargarItems = async (id: number) => {
    const { data } = await createClient().from("revision_items").select("*").eq("campana_id", id).order("email");
    setItems((data ?? []) as Item[]);
  };
  useEffect(() => { cargarCampanas(); }, []);
  useEffect(() => { if (sel) cargarItems(sel); else setItems([]); }, [sel]);

  const camp = campanas.find((c) => c.id === sel);
  const abierta = camp?.estado === "abierta";
  const pendientes = items.filter((i) => i.decision === "pendiente").length;
  const visibles = useMemo(() => (soloObs ? items.filter((i) => i.observaciones?.length) : items), [items, soloObs]);
  const ultimaCerrada = campanas.find((c) => c.estado === "cerrada");
  const diasDesde = ultimaCerrada?.cerrada ? Math.floor((Date.now() - new Date(ultimaCerrada.cerrada).getTime()) / 86400000) : null;

  async function nueva() {
    setError(null);
    const vence = prompt("¿Hasta qué fecha hay para completarla? (AAAA-MM-DD)", new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10));
    if (!vence) return;
    const { data, error } = await createClient().rpc("revision_crear", { p_nombre: null, p_vence: vence });
    if (error) return setError(error.message);
    cargarCampanas(data as number);
  }
  async function decidir(i: Item, decision: Item["decision"]) {
    setError(null);
    const { error } = await createClient().rpc("revision_decidir", { p_item: i.id, p_decision: decision, p_nota: notas[i.id] ?? i.nota ?? null });
    if (error) return setError(error.message);
    if (sel) cargarItems(sel);
  }
  async function aplicar(i: Item) {
    if (!confirm(`¿Quitar el acceso de ${i.email}? Queda sin grupo y en solo lectura (no ve ninguna solapa).`)) return;
    const { error } = await createClient().rpc("revision_aplicar", { p_item: i.id });
    if (error) return setError(error.message);
    if (sel) cargarItems(sel);
  }
  async function cerrar() {
    if (!camp) return;
    const conclusion = prompt("Conclusión de la revisión (queda como evidencia):", pendientes ? "" : "Accesos revisados y ajustados según lo decidido.");
    if (conclusion === null) return;
    const { error } = await createClient().rpc("revision_cerrar", { p_campana: camp.id, p_conclusion: conclusion });
    if (error) return setError(error.message);
    cargarCampanas(camp.id);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="font-display text-2xl text-ink">Revisión de accesos</h1>
          <p className="text-ink/60 text-sm mt-1">
            Cada trimestre se revisa quién tiene acceso a la app y a qué. Queda como evidencia para auditorías.
            {diasDesde != null ? ` Última revisión cerrada hace ${diasDesde} días.` : " Todavía no se cerró ninguna."}
          </p>
        </div>
        <div className="flex gap-2">
          {camp && <button className="btn-secondary" onClick={() => window.print()}>Imprimir / PDF</button>}
          {esAdmin && !campanas.some((c) => c.estado === "abierta") && <button className="btn-primary" onClick={nueva}>Nueva revisión</button>}
        </div>
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50 print:hidden">{error}</div>}
      {!cargando && campanas.length === 0 && (
        <div className="card p-6 text-sm text-ink/60">Todavía no hay revisiones. {esAdmin ? "Abrí la primera con “Nueva revisión”." : "Un administrador tiene que abrir la primera."}</div>
      )}

      {campanas.length > 0 && (
        <div className="flex gap-2 flex-wrap items-center print:hidden">
          <select className="input w-auto" value={sel ?? ""} onChange={(e) => setSel(Number(e.target.value))} aria-label="Revisión">
            {campanas.map((c) => <option key={c.id} value={c.id}>{c.nombre} · {c.estado === "abierta" ? "abierta" : `cerrada ${f(c.cerrada)}`}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-ink/70"><input type="checkbox" checked={soloObs} onChange={(e) => setSoloObs(e.target.checked)} /> Solo los que tienen observaciones</label>
        </div>
      )}

      {camp && (
        <>
          <div className="card p-4 text-sm flex flex-wrap gap-x-6 gap-y-1">
            <span className="font-display font-bold text-ink">{camp.nombre}</span>
            <span>Abierta el {f(camp.creada)} por {camp.creada_por_nombre ?? "—"}</span>
            <span className={abierta && camp.vence < new Date().toISOString().slice(0, 10) ? "text-red-600" : ""}>Vence el {f(camp.vence)}</span>
            <span>{items.length - pendientes} de {items.length} revisados</span>
            {camp.estado === "cerrada" && <span>Cerrada el {f(camp.cerrada, true)} por {camp.cerrada_por_nombre}</span>}
            {camp.conclusion && <span className="basis-full text-ink/70">Conclusión: {camp.conclusion}</span>}
          </div>

          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Usuario</th><th>Acceso</th><th>Último ingreso</th><th>Observaciones</th><th>Decisión</th></tr></thead>
              <tbody>
                {visibles.map((i) => (
                  <tr key={i.id} className="align-top">
                    <td><div className="text-ink font-medium">{i.nombre ?? i.email}</div><div className="text-xs text-ink/50">{i.email}</div></td>
                    <td className="text-xs">
                      <div className="text-ink">{ROL[i.rol] ?? i.rol}{i.grupo ? ` · ${i.grupo}` : ""}</div>
                      <div className="text-ink/50">{(i.modulos ?? []).map((m) => (m === "todas" ? "Todas las solapas" : NOMBRE_MODULO[m as Modulo] ?? m)).join(", ") || "Ninguna solapa"}</div>
                    </td>
                    <td className="text-xs text-ink/70 whitespace-nowrap">{f(i.ultimo_ingreso)}</td>
                    <td className="text-xs">
                      {(i.observaciones ?? []).length === 0 ? <span className="text-ink/30">—</span> : (
                        <ul className="space-y-0.5">{i.observaciones.map((o) => <li key={o} className="text-amber-700">• {o}</li>)}</ul>
                      )}
                    </td>
                    <td className="min-w-[260px]">
                      <span className={`pill ${DEC[i.decision].clase}`}>{DEC[i.decision].texto}</span>
                      {i.decidido_por_nombre && <span className="text-xs text-ink/50"> · {i.decidido_por_nombre}, {f(i.decidido_en)}</span>}
                      {i.nota && <div className="text-xs text-ink/70 mt-1">📝 {i.nota}</div>}
                      {i.aplicado && <div className="text-xs text-emerald-700 mt-1">Acceso quitado el {f(i.aplicado)}</div>}
                      {abierta && puedeEditar && (
                        <div className="mt-2 space-y-1.5 print:hidden">
                          <input className="input py-1 text-xs" placeholder="Nota (obligatoria para cambiar o quitar)"
                            value={notas[i.id] ?? ""} onChange={(e) => setNotas({ ...notas, [i.id]: e.target.value })} />
                          <div className="flex gap-1 flex-wrap">
                            {(["mantener", "cambiar", "quitar"] as const).map((d) => (
                              <button key={d} onClick={() => decidir(i, d)}
                                className={`px-2 py-1 rounded text-xs border ${i.decision === d ? "border-transparent " + DEC[d].clase : "border-black/10 text-ink/70 hover:bg-black/[0.03]"}`}>
                                {DEC[d].texto}
                              </button>
                            ))}
                            {esAdmin && i.decision === "quitar" && !i.aplicado && (
                              <button className="px-2 py-1 rounded text-xs bg-red-600 text-white" onClick={() => aplicar(i)}>Aplicar ahora</button>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {abierta && esAdmin && (
            <div className="flex items-center gap-3 print:hidden">
              <button className="btn-primary" disabled={pendientes > 0} onClick={cerrar}>Cerrar revisión</button>
              {pendientes > 0 && <span className="text-sm text-ink/60">Faltan {pendientes} usuario{pendientes > 1 ? "s" : ""} por revisar.</span>}
            </div>
          )}
          <p className="text-xs text-ink/50 print:hidden">
            “Cambiar” deja registrado qué ajustar (el cambio se hace en Usuarios y accesos). “Quitar” se puede aplicar desde acá:
            el usuario queda sin grupo y no ve ninguna solapa. Para eliminarlo del todo, usá Usuarios y accesos.
          </p>
        </>
      )}
    </div>
  );
}
