"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS_MOB, COLOR_ESTADO, exportarMobCSV, type MobiliarioItem } from "@/lib/mobiliario";
import { fecha } from "@/lib/inventario";
import { usePerfil } from "@/components/PerfilContext";
import { ThFiltro, FiltrosActivos, useFiltrosColumna } from "@/components/FiltroColumna";

function Listado() {
  const { puedeEditar, esAdmin } = usePerfil();

  async function eliminar(id: number, codigo: string) {
    if (!confirm(`¿Eliminar ${codigo} permanentemente? Esta acción no se puede deshacer.`)) return;
    const sb = createClient();
    await sb.from("mob_movimientos").delete().eq("mobiliario_id", id);
    await sb.from("mob_mobiliario").delete().eq("id", id);
    cargar();
  }
  const [items, setItems] = useState<MobiliarioItem[]>([]);
  const [cargando, setCargando] = useState(true);
  const [texto, setTexto] = useState("");
  const [estado, setEstado] = useState("");
  const [tipo, setTipo] = useState("");
  const [piso, setPiso] = useState("");
  const [sector, setSector] = useState("");

  function cargar() {
    createClient()
      .from("mob_v_mobiliario")
      .select("*")
      .order("id", { ascending: false })
      .then(({ data }) => { setItems((data ?? []) as MobiliarioItem[]); setCargando(false); });
  }

  useEffect(() => { cargar(); }, []);

  const opciones = (k: keyof MobiliarioItem, base = items) =>
    Array.from(new Set(base.map((e) => e[k]).filter(Boolean))).sort() as string[];

  const filtrados = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return items.filter((e) =>
      (!estado || e.estado === estado) &&
      (!tipo || e.tipo === tipo) &&
      (!piso || e.piso === piso) &&
      (!sector || e.sector === sector) &&
      (!q || [e.codigo, e.tipo, e.descripcion, e.marca, e.modelo, e.numero_serie,
               e.empleado, e.piso, e.sector, e.numero_inventario, e.notas]
        .some((v) => v && String(v).toLowerCase().includes(q)))
    );
  }, [items, texto, estado, tipo, piso, sector]);

  const fc = useFiltrosColumna(filtrados, {
    codigo:    (e) => e.codigo,
    tipo:      (e) => e.tipo,
    estado:    (e) => ESTADOS_MOB[e.estado] ?? e.estado,
    ubicacion: (e) => [e.piso, e.sector].filter(Boolean).join(" – "),
    asignado:  (e) => e.empleado,
    ingreso:   (e) => (e.fecha_ingreso ? String(e.fecha_ingreso).slice(0, 4) : null),
  });
  const lista = fc.filtradas;

  const sel = "input w-auto";

  const total = {
    en_deposito:   items.filter((e) => e.estado === "en_deposito").length,
    asignado:      items.filter((e) => e.estado === "asignado").length,
    en_reparacion: items.filter((e) => e.estado === "en_reparacion").length,
    dado_de_baja:  items.filter((e) => e.estado === "dado_de_baja").length,
  };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Mobiliario</h1>
          <p className="text-ink/60 text-sm mt-1">
            {cargando ? "Cargando…" : `${lista.length} de ${items.length} elementos`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={() => exportarMobCSV(lista)} disabled={!lista.length}>
            Exportar a Excel
          </button>
          {puedeEditar && (
            <Link className="btn-primary" href="/mobiliario/nuevo">
              + Registrar mobiliario
            </Link>
          )}
        </div>
      </div>

      {/* Tarjetas de resumen */}
      {!cargando && items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(["en_deposito", "asignado", "en_reparacion", "dado_de_baja"] as const).map((est) => (
            <button
              key={est}
              className={`card text-left p-4 transition-colors hover:bg-line/[0.03] ${estado === est ? "ring-2 ring-brand-500" : ""}`}
              onClick={() => setEstado(estado === est ? "" : est)}
            >
              <p className="text-2xl font-display font-bold text-ink">{total[est]}</p>
              <p className="text-sm text-ink/60 mt-0.5">{ESTADOS_MOB[est]}</p>
            </button>
          ))}
        </div>
      )}

      {/* Filtros */}
      <div className="flex gap-2 flex-wrap">
        <input
          type="search"
          className="input flex-1 min-w-[240px]"
          placeholder="Buscar por código, tipo, descripción, serie, persona…"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          aria-label="Buscar"
        />
        <select className={sel} value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option>
          {Object.entries(ESTADOS_MOB).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={sel} value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {opciones("tipo").map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className={sel} value={piso} onChange={(e) => setPiso(e.target.value)} aria-label="Piso">
          <option value="">Todos los pisos</option>
          {opciones("piso").map((p) => <option key={p}>{p}</option>)}
        </select>
        <select className={sel} value={sector} onChange={(e) => setSector(e.target.value)} aria-label="Sector">
          <option value="">Todos los sectores</option>
          {opciones("sector").map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      <FiltrosActivos ctl={fc} total={filtrados.length} />

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <ThFiltro ctl={fc} col="codigo">Código</ThFiltro>
              <ThFiltro ctl={fc} col="tipo">Tipo / descripción</ThFiltro>
              <ThFiltro ctl={fc} col="estado">Estado</ThFiltro>
              <ThFiltro ctl={fc} col="ubicacion">Ubicación</ThFiltro>
              <ThFiltro ctl={fc} col="asignado">Asignado a</ThFiltro>
              <ThFiltro ctl={fc} col="ingreso">Ingreso</ThFiltro>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((e) => (
              <tr key={e.id} className="hover:bg-line/[0.015]">
                <td>
                  <Link href={`/mobiliario/${e.id}`} className="tag-inv font-mono text-xs">
                    {e.codigo}
                  </Link>
                </td>
                <td>
                  <span className="font-medium text-ink">{e.tipo}</span>
                  {e.descripcion && <div className="text-ink/50 text-xs">{e.descripcion}</div>}
                  {(e.marca || e.modelo) && (
                    <div className="text-ink/40 text-xs">{[e.marca, e.modelo].filter(Boolean).join(" ")}</div>
                  )}
                </td>
                <td>
                  <span className={COLOR_ESTADO[e.estado] ?? ""}>{ESTADOS_MOB[e.estado]}</span>
                </td>
                <td>
                  {e.piso ?? <span className="text-ink/40">—</span>}
                  {e.sector && <div className="text-ink/50 text-xs">{e.sector}</div>}
                  {e.detalle_ubicacion && <div className="text-ink/40 text-xs">{e.detalle_ubicacion}</div>}
                </td>
                <td>
                  {e.empleado ?? <span className="text-ink/40">—</span>}
                </td>
                <td className="text-ink/60">{fecha(e.fecha_ingreso)}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/mobiliario/qr?id=${e.id}`}
                      className="text-ink/40 hover:text-ink transition-colors"
                      title="Generar QR"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M3 4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4Zm2 2V5h1v1H5Zm-2 7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3Zm2 2v-1h1v1H5Zm8-12a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-3Zm1 2v1h1V5h-1Zm-1 7a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1h1a1 1 0 0 1 0 2h-1v1a1 1 0 0 1-2 0v-1h-1a1 1 0 0 1-1-1v-1h-1a1 1 0 0 1 0-2h1Zm1 2v-1h1v1h-1Z" clipRule="evenodd" />
                      </svg>
                    </Link>
                    {esAdmin && (
                      <button
                        onClick={() => eliminar(e.id, e.codigo)}
                        className="text-red-400 hover:text-red-600 transition-colors"
                        title="Eliminar"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                          <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!cargando && lista.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink/40 py-8">
                  {items.length === 0
                    ? 'No hay mobiliario registrado. Empezá con "Registrar mobiliario".'
                    : "Ningún elemento coincide con los filtros."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PaginaMobiliario() {
  return <Suspense><Listado /></Suspense>;
}
