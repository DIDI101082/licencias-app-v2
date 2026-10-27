"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS_CEL, COLOR_ESTADO_CEL, exportarCelCSV, type CelularItem } from "@/lib/celulares";
import { fecha } from "@/lib/inventario";
import { usePerfil } from "@/components/PerfilContext";
import { ThFiltro, FiltrosActivos, useFiltrosColumna } from "@/components/FiltroColumna";

function Listado() {
  const { puedeEditar, esAdmin } = usePerfil();
  const [items, setItems] = useState<CelularItem[]>([]);
  const [cargando, setCargando] = useState(true);
  const [texto, setTexto] = useState("");
  const [estado, setEstado] = useState("");
  const [operadora, setOperadora] = useState("");

  function cargar() {
    createClient()
      .from("cel_v_celulares")
      .select("*")
      .order("id", { ascending: false })
      .then(({ data }) => { setItems((data ?? []) as CelularItem[]); setCargando(false); });
  }

  useEffect(() => { cargar(); }, []);

  async function eliminar(id: number, codigo: string) {
    if (!confirm(`¿Eliminar ${codigo} permanentemente? Esta acción no se puede deshacer.`)) return;
    const sb = createClient();
    await sb.from("cel_movimientos").delete().eq("celular_id", id);
    await sb.from("cel_celulares").delete().eq("id", id);
    cargar();
  }

  const opciones = (k: keyof CelularItem, base = items) =>
    Array.from(new Set(base.map((e) => e[k]).filter(Boolean))).sort() as string[];

  const filtrados = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return items.filter((e) =>
      (!estado || e.estado === estado) &&
      (!operadora || e.operadora === operadora) &&
      (!q || [e.codigo, e.marca, e.modelo, e.imei, e.imei2, e.numero_linea,
               e.numero_sim, e.empleado, e.plan, e.notas]
        .some((v) => v && String(v).toLowerCase().includes(q)))
    );
  }, [items, texto, estado, operadora]);

  const fc = useFiltrosColumna(filtrados, {
    codigo:    (e) => e.codigo,
    equipo:    (e) => `${e.marca} ${e.modelo}`,
    estado:    (e) => ESTADOS_CEL[e.estado] ?? e.estado,
    linea:     (e) => e.numero_linea,
    operadora: (e) => e.operadora,
    asignado:  (e) => e.empleado,
  });
  const lista = fc.filtradas;

  const total = {
    en_deposito:   items.filter((e) => e.estado === "en_deposito").length,
    asignado:      items.filter((e) => e.estado === "asignado").length,
    en_reparacion: items.filter((e) => e.estado === "en_reparacion").length,
    dado_de_baja:  items.filter((e) => e.estado === "dado_de_baja").length,
  };

  const sel = "input w-auto";

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Celulares corporativos</h1>
          <p className="text-ink/60 text-sm mt-1">
            {cargando ? "Cargando…" : `${lista.length} de ${items.length} equipos`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={() => exportarCelCSV(lista)} disabled={!lista.length}>
            Exportar a Excel
          </button>
          {puedeEditar && (
            <Link className="btn-primary" href="/celulares/nuevo">
              + Registrar celular
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
              <p className="text-sm text-ink/60 mt-0.5">{ESTADOS_CEL[est]}</p>
            </button>
          ))}
        </div>
      )}

      {/* Filtros */}
      <div className="flex gap-2 flex-wrap">
        <input
          type="search"
          className="input flex-1 min-w-[240px]"
          placeholder="Buscar por código, marca, modelo, IMEI, línea, persona…"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          aria-label="Buscar"
        />
        <select className={sel} value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option>
          {Object.entries(ESTADOS_CEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={sel} value={operadora} onChange={(e) => setOperadora(e.target.value)} aria-label="Operadora">
          <option value="">Todas las operadoras</option>
          {opciones("operadora").map((o) => <option key={o}>{o}</option>)}
        </select>
      </div>

      <FiltrosActivos ctl={fc} total={filtrados.length} />

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <ThFiltro ctl={fc} col="codigo">Código</ThFiltro>
              <ThFiltro ctl={fc} col="equipo">Equipo</ThFiltro>
              <ThFiltro ctl={fc} col="estado">Estado</ThFiltro>
              <ThFiltro ctl={fc} col="linea">N° línea</ThFiltro>
              <ThFiltro ctl={fc} col="operadora">Operadora</ThFiltro>
              <ThFiltro ctl={fc} col="asignado">Asignado a</ThFiltro>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((e) => (
              <tr key={e.id} className="hover:bg-line/[0.015]">
                <td>
                  <Link href={`/celulares/${e.id}`} className="tag-inv font-mono text-xs">
                    {e.codigo}
                  </Link>
                </td>
                <td>
                  <span className="font-medium text-ink">{e.marca} {e.modelo}</span>
                  {e.color && <div className="text-ink/50 text-xs">{e.color}{e.almacenamiento ? ` · ${e.almacenamiento}` : ""}</div>}
                  {e.imei && <div className="text-ink/40 text-xs font-mono">IMEI: {e.imei}</div>}
                </td>
                <td>
                  <span className={COLOR_ESTADO_CEL[e.estado] ?? ""}>{ESTADOS_CEL[e.estado]}</span>
                </td>
                <td className="font-mono text-sm">{e.numero_linea ?? <span className="text-ink/40">—</span>}</td>
                <td>{e.operadora ?? <span className="text-ink/40">—</span>}</td>
                <td>{e.empleado ?? <span className="text-ink/40">—</span>}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/celulares/qr?id=${e.id}`}
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
                    ? 'No hay celulares registrados. Empezá con "+ Registrar celular".'
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

export default function PaginaCelulares() {
  return <Suspense><Listado /></Suspense>;
}
