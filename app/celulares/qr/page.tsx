"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS_CEL, type CelularItem } from "@/lib/celulares";

function EtiquetaQR({ item, baseUrl, size }: { item: CelularItem; baseUrl: string; size: number }) {
  const url = `${baseUrl}/celulares/${item.id}`;
  const [qrError, setQrError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    import("qrcode").then((QRCode) => {
      QRCode.toCanvas(canvasRef.current!, url, {
        width: size,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }).catch(() => setQrError(true));
  }, [url, size]);

  const fallbackUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}&margin=10`;

  return (
    <div className="etiqueta-qr flex flex-col items-center gap-2 p-4 border-2 border-dashed border-gray-300 rounded-lg bg-white print:border-gray-600">
      <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">Accusys Cyber</div>
      {qrError
        ? <img src={fallbackUrl} alt="QR Code" width={size} height={size} className="rounded" />
        : <canvas ref={canvasRef} width={size} height={size} />}
      <div className="text-center space-y-0.5">
        <div className="font-mono font-bold text-sm text-gray-900">{item.codigo}</div>
        <div className="font-medium text-gray-800">{item.marca} {item.modelo}</div>
        {item.numero_linea && <div className="text-xs text-gray-500">{item.numero_linea}</div>}
        {item.piso && <div className="text-xs text-gray-500">{item.piso}{item.sector ? ` – ${item.sector}` : ""}</div>}
      </div>
    </div>
  );
}

function GeneradorQR() {
  const params = useSearchParams();
  const idParam = params.get("id");
  const [items, setItems] = useState<CelularItem[]>([]);
  const [seleccionados, setSeleccionados] = useState<Set<number>>(new Set());
  const [cargando, setCargando] = useState(true);
  const [tamano, setTamano] = useState(160);
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    setBaseUrl(window.location.origin);
    createClient()
      .from("cel_v_celulares")
      .select("*")
      .neq("estado", "dado_de_baja")
      .order("id", { ascending: false })
      .then(({ data }) => {
        const lista = (data ?? []) as CelularItem[];
        setItems(lista);
        if (idParam) {
          const n = parseInt(idParam, 10);
          if (!isNaN(n)) setSeleccionados(new Set([n]));
        }
        setCargando(false);
      });
  }, [idParam]);

  const toggleSel = (id: number) =>
    setSeleccionados((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });

  const selAll = () => setSeleccionados(new Set(items.map((i) => i.id)));
  const selNone = () => setSeleccionados(new Set());

  const itemsSel = items.filter((i) => seleccionados.has(i.id));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Generar QR — Celulares</h1>
          <p className="text-ink/60 text-sm mt-1">
            Seleccioná los equipos y hacé clic en Imprimir para generar las etiquetas.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap print:hidden">
          <select className="input w-auto" value={tamano} onChange={(e) => setTamano(Number(e.target.value))}>
            <option value={120}>Chico (3 cm)</option>
            <option value={160}>Mediano (4 cm)</option>
            <option value={200}>Grande (5 cm)</option>
          </select>
          {itemsSel.length > 0 && (
            <button className="btn-primary" onClick={() => window.print()}>
              🖨 Imprimir {itemsSel.length} etiqueta{itemsSel.length !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      </div>

      {itemsSel.length > 0 && (
        <div className="print-area hidden print:block">
          <div className="flex flex-wrap gap-4 p-4">
            {itemsSel.map((item) => (
              <EtiquetaQR key={item.id} item={item} baseUrl={baseUrl} size={tamano} />
            ))}
          </div>
        </div>
      )}

      <div className="print:hidden space-y-4">
        <div className="flex gap-2 items-center flex-wrap">
          <button className="btn-secondary" onClick={selAll}>Seleccionar todos</button>
          <button className="btn-secondary" onClick={selNone}>Deseleccionar todos</button>
          <span className="text-ink/50 text-sm ml-2">
            {seleccionados.size} seleccionado{seleccionados.size !== 1 ? "s" : ""}
          </span>
        </div>

        {itemsSel.length > 0 && (
          <div className="card p-5">
            <h2 className="font-display font-bold text-ink mb-4">Vista previa</h2>
            <div className="flex flex-wrap gap-4">
              {itemsSel.map((item) => (
                <EtiquetaQR key={item.id} item={item} baseUrl={baseUrl} size={tamano} />
              ))}
            </div>
          </div>
        )}

        <div className="card overflow-hidden">
          <table className="data w-full">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    checked={seleccionados.size === items.length && items.length > 0}
                    onChange={seleccionados.size === items.length ? selNone : selAll}
                    aria-label="Seleccionar todos"
                  />
                </th>
                <th>Código</th>
                <th>Equipo</th>
                <th>N° línea</th>
                <th>Ubicación</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {cargando && (
                <tr><td colSpan={6} className="text-center text-ink/40 py-8">Cargando…</td></tr>
              )}
              {items.map((e) => (
                <tr
                  key={e.id}
                  className={`cursor-pointer hover:bg-line/[0.015] ${seleccionados.has(e.id) ? "bg-brand-50/40" : ""}`}
                  onClick={() => toggleSel(e.id)}
                >
                  <td onClick={(ev) => ev.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={seleccionados.has(e.id)}
                      onChange={() => toggleSel(e.id)}
                      aria-label={`Seleccionar ${e.codigo}`}
                    />
                  </td>
                  <td><span className="tag-inv font-mono text-xs">{e.codigo}</span></td>
                  <td>
                    <span className="font-medium text-ink">{e.marca} {e.modelo}</span>
                    {e.color && <div className="text-xs text-ink/50">{e.color}</div>}
                  </td>
                  <td className="font-mono text-sm">{e.numero_linea ?? <span className="text-ink/40">—</span>}</td>
                  <td>
                    {e.piso ?? "—"}
                    {e.sector && <span className="text-ink/50"> – {e.sector}</span>}
                  </td>
                  <td><span className="text-sm">{ESTADOS_CEL[e.estado]}</span></td>
                </tr>
              ))}
              {!cargando && items.length === 0 && (
                <tr><td colSpan={6} className="text-center text-ink/40 py-8">No hay celulares activos.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function PaginaQRCelulares() {
  return <Suspense><GeneradorQR /></Suspense>;
}
