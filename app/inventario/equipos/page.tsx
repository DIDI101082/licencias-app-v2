"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS, CONDICIONES, dinero, fecha } from "@/lib/inventario";
import { usePerfil } from "@/components/PerfilContext";
import AbrirEnCelular from "@/components/AbrirEnCelular";

type Equipo = Record<string, any>;

const COLUMNAS_CSV: [string, string][] = [
  ["codigo", "Código"], ["grupo", "Grupo"], ["categoria", "Categoría"], ["marca", "Marca"], ["modelo", "Modelo"],
  ["numero_serie", "N° de serie"], ["estado", "Estado"], ["condicion", "Condición"], ["empleado", "Asignado a"],
  ["empleado_email", "Email"], ["area", "Área"], ["ubicacion", "Ubicación"], ["ubicacion_detalle", "Detalle ubicación"],
  ["hostname", "Hostname"], ["ip", "IP"], ["mac", "MAC"], ["procesador", "Procesador"], ["ram_gb", "RAM (GB)"],
  ["almacenamiento", "Almacenamiento"], ["sistema_operativo", "Sistema operativo"], ["proveedor", "Proveedor"],
  ["fecha_compra", "Fecha de compra"], ["costo", "Costo"], ["moneda", "Moneda"], ["nro_factura", "Factura"],
  ["garantia_hasta", "Garantía hasta"], ["cantidad", "Cantidad"], ["notas", "Notas"],
];

function exportarCSV(filas: Equipo[]) {
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cab = COLUMNAS_CSV.map(([, t]) => t).join(";");
  const cuerpo = filas.map((f) =>
    COLUMNAS_CSV.map(([k]) => esc(k === "estado" ? ESTADOS[f[k]] : k === "condicion" ? CONDICIONES[f[k]] : f[k])).join(";")
  );
  const blob = new Blob(["\uFEFF" + [cab, ...cuerpo].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `inventario-it-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function Listado() {
  const params = useSearchParams();
  const { puedeEditar, esAdmin } = usePerfil();
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [texto, setTexto] = useState("");
  const [estado, setEstado] = useState(params.get("estado") ?? "");
  const [grupo, setGrupo] = useState("");
  const [categoria, setCategoria] = useState("");
  const [ubicacion, setUbicacion] = useState("");
  const [area, setArea] = useState("");

  useEffect(() => {
    createClient()
      .from("inv_v_equipos")
      .select("*")
      .order("codigo", { ascending: false })
      .then(({ data }) => { setEquipos(data ?? []); setCargando(false); });
  }, []);

  const opciones = (k: string, base = equipos) =>
    Array.from(new Set(base.map((e) => e[k]).filter(Boolean))).sort() as string[];

  const filtrados = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return equipos.filter((e) =>
      (!estado || e.estado === estado) &&
      (!grupo || e.grupo === grupo) &&
      (!categoria || e.categoria === categoria) &&
      (!ubicacion || e.ubicacion === ubicacion) &&
      (!area || e.area === area) &&
      (!q || [e.codigo, e.marca, e.modelo, e.numero_serie, e.empleado, e.hostname, e.ip, e.mac, e.notas]
        .some((v) => v && String(v).toLowerCase().includes(q)))
    );
  }, [equipos, texto, estado, grupo, categoria, ubicacion, area]);

  const sel = "input w-auto";

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Equipos</h1>
          <p className="text-ink/60 text-sm mt-1">{cargando ? "Cargando…" : `${filtrados.length} de ${equipos.length} equipos`}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={() => exportarCSV(filtrados)} disabled={!filtrados.length}>
            Exportar a Excel
          </button>
          {puedeEditar && <AbrirEnCelular />}
          {esAdmin && <Link className="btn-secondary" href="/inventario/equipos/importar">Importar desde Excel</Link>}
          {puedeEditar && <Link className="btn-primary" href="/inventario/equipos/nuevo">+ Cargar equipo</Link>}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input type="search" className="input flex-1 min-w-[240px]" placeholder="Buscar por código, serie, modelo, persona, hostname, IP…"
          value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
        <select className={sel} value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option>
          {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={sel} value={grupo} onChange={(e) => { setGrupo(e.target.value); setCategoria(""); }} aria-label="Grupo">
          <option value="">Todos los grupos</option>
          {opciones("grupo").map((g) => <option key={g}>{g}</option>)}
        </select>
        <select className={sel} value={categoria} onChange={(e) => setCategoria(e.target.value)} aria-label="Categoría">
          <option value="">Todas las categorías</option>
          {opciones("categoria", grupo ? equipos.filter((e) => e.grupo === grupo) : equipos).map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className={sel} value={ubicacion} onChange={(e) => setUbicacion(e.target.value)} aria-label="Ubicación">
          <option value="">Todas las ubicaciones</option>
          {opciones("ubicacion").map((u) => <option key={u}>{u}</option>)}
        </select>
        <select className={sel} value={area} onChange={(e) => setArea(e.target.value)} aria-label="Área">
          <option value="">Todas las áreas</option>
          {opciones("area").map((a) => <option key={a}>{a}</option>)}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Código</th><th>Equipo</th><th>N° de serie</th><th>Estado</th>
              <th>Asignado a</th><th>Ubicación</th><th>Compra</th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((e) => (
              <tr key={e.id} className="hover:bg-black/[0.015]">
                <td><Link href={`/inventario/equipos/${e.id}`} className="tag-inv">{e.codigo}</Link></td>
                <td>
                  <span className="font-medium text-ink">{e.marca} {e.modelo}</span>
                  {e.cantidad > 1 && <b> ×{e.cantidad}</b>}
                  <div className="text-ink/50 text-xs">{e.categoria}{e.hostname ? ` · ${e.hostname}` : ""}</div>
                </td>
                <td className="text-ink/60">{e.numero_serie ?? "—"}</td>
                <td><span className={`est-${e.estado}`}>{ESTADOS[e.estado]}</span></td>
                <td>{e.empleado ?? <span className="text-ink/40">—</span>}{e.area && <div className="text-ink/50 text-xs">{e.area}</div>}</td>
                <td>{e.ubicacion ?? "—"}{e.ubicacion_detalle && <div className="text-ink/50 text-xs">{e.ubicacion_detalle}</div>}</td>
                <td>{fecha(e.fecha_compra)}<div className="text-ink/50 text-xs">{dinero(e.costo, e.moneda)}</div></td>
              </tr>
            ))}
            {!cargando && filtrados.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink/40 py-8">
                  {equipos.length === 0 ? "No hay equipos cargados. Empezá con “Cargar equipo”." : "Ningún equipo coincide con los filtros."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Pagina() {
  return <Suspense><Listado /></Suspense>;
}
