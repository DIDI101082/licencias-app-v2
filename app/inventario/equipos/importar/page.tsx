"use client";
import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

// Columnas aceptadas (mismos títulos que la exportación). Solo "Categoría" es obligatoria.
const MAPA: Record<string, string> = {
  "categoría": "categoria", "categoria": "categoria", "marca": "marca", "modelo": "modelo",
  "n° de serie": "numero_serie", "numero de serie": "numero_serie", "serie": "numero_serie",
  "área": "area", "area": "area", "ubicación": "ubicacion", "ubicacion": "ubicacion",
  "detalle ubicación": "ubicacion_detalle", "hostname": "hostname", "ip": "ip", "mac": "mac",
  "procesador": "procesador", "ram (gb)": "ram_gb", "almacenamiento": "almacenamiento",
  "sistema operativo": "sistema_operativo", "fecha de compra": "fecha_compra", "costo": "costo",
  "moneda": "moneda", "factura": "nro_factura", "garantía hasta": "garantia_hasta",
  "garantia hasta": "garantia_hasta", "cantidad": "cantidad", "notas": "notas",
};

function parsearCSV(texto: string): string[][] {
  const sep = texto.split("\n")[0].includes(";") ? ";" : ",";
  const filas: string[][] = []; let fila: string[] = []; let celda = ""; let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++; }
      else if (c === '"') comillas = false;
      else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(celda); celda = ""; }
    else if (c === "\n") { fila.push(celda); filas.push(fila); fila = []; celda = ""; }
    else if (c !== "\r") celda += c;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return filas.filter((f) => f.some((x) => x.trim()));
}

// Acepta 31/12/2025 o 2025-12-31
const aFecha = (v: string) => {
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : v;
};

export default function Importar() {
  const { esAdmin } = usePerfil();
  const [filas, setFilas] = useState<Record<string, any>[]>([]);
  const [problemas, setProblemas] = useState<string[]>([]);
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function leer(archivo: File) {
    setResultado(null);
    const sb = createClient();
    const [{ data: cats }, { data: ubis }] = await Promise.all([
      sb.from("inv_categorias").select("id,nombre"), sb.from("inv_ubicaciones").select("id,nombre"),
    ]);
    const buscar = (lista: any[] | null, n: string) => lista?.find((x) => x.nombre.toLowerCase() === n.trim().toLowerCase())?.id;

    const [cab, ...cuerpo] = parsearCSV((await archivo.text()).replace(/^\uFEFF/, ""));
    const claves = cab.map((c) => MAPA[c.trim().toLowerCase()]);
    const errores: string[] = [];
    const salida = cuerpo.map((f, i) => {
      const r: Record<string, any> = {};
      claves.forEach((k, j) => { if (k && f[j]?.trim()) r[k] = f[j].trim(); });
      const catId = r.categoria && buscar(cats, r.categoria);
      if (!catId) errores.push(`Fila ${i + 2}: la categoría “${r.categoria ?? ""}” no existe.`);
      const eq: Record<string, any> = { ...r, categoria_id: catId };
      delete eq.categoria; delete eq.ubicacion;
      if (r.ubicacion) eq.ubicacion_id = buscar(ubis, r.ubicacion) ?? null;
      if (eq.costo) eq.costo = Number(String(eq.costo).replace(/\./g, "").replace(",", "."));
      if (eq.ram_gb) eq.ram_gb = parseInt(eq.ram_gb);
      if (eq.cantidad) eq.cantidad = parseInt(eq.cantidad);
      if (eq.fecha_compra) eq.fecha_compra = aFecha(eq.fecha_compra);
      if (eq.garantia_hasta) eq.garantia_hasta = aFecha(eq.garantia_hasta);
      return eq;
    });
    setProblemas(errores); setFilas(salida);
  }

  async function importar() {
    setEnviando(true);
    const { error, data } = await createClient().from("inv_equipos").insert(filas).select("id");
    setEnviando(false);
    if (error) {
      return setResultado({ ok: false, texto: error.code === "23505"
        ? "Hay números de serie repetidos o que ya existen. No se importó nada."
        : error.message });
    }
    setResultado({ ok: true, texto: `Se cargaron ${data.length} equipos.` });
    setFilas([]);
  }

  if (!esAdmin) {
    return <div className="card p-6 max-w-md text-sm text-ink/60">Solo los administradores pueden importar equipos.</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Importar equipos</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-2xl">
            Subí un CSV guardado desde Excel. Usá los mismos títulos de columna que la exportación; solo “Categoría” es obligatoria
            y tiene que coincidir con una categoría existente.
          </p>
        </div>
        <Link href="/inventario/equipos" className="btn-secondary">Volver a equipos</Link>
      </div>
      <div className="card p-5">
        <input type="file" accept=".csv,text/csv" className="text-sm" onChange={(e) => e.target.files?.[0] && leer(e.target.files[0])} />
      </div>
      {resultado && (
        <p role="status" className={`text-sm rounded-md px-3 py-2 ${resultado.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
          {resultado.texto}
        </p>
      )}
      {problemas.length > 0 && (
        <div className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
          Corregí esto en el archivo y volvé a subirlo:
          <ul className="list-disc pl-5 mt-1">{problemas.slice(0, 20).map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {filas.length > 0 && problemas.length === 0 && (
        <div className="card p-5 space-y-3">
          <p className="text-sm">{filas.length} equipos listos para cargar. Cada uno recibe su código IT-xxxxx automáticamente.</p>
          <button className="btn-primary" onClick={importar} disabled={enviando}>
            {enviando ? "Importando…" : `Importar ${filas.length} equipos`}
          </button>
        </div>
      )}
    </div>
  );
}
