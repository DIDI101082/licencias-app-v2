"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { hace } from "@/lib/monitoreo";
import { ESTADO_INT, type Integracion } from "@/components/integraciones";

export default function Integraciones() {
  const [ints, setInts] = useState<Integracion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const { data, error } = await createClient().rpc("integraciones_estado");
    if (error) setError(/integraciones_estado/.test(error.message) ? "Falta ejecutar supabase/inicio.sql en Supabase." : error.message);
    setInts((data as Integracion[]) ?? []);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 60000); return () => clearInterval(t); }, [cargar]);

  const lista = [...(ints ?? [])].sort((a, b) => ESTADO_INT[a.estado].orden - ESTADO_INT[b.estado].orden || a.nombre.localeCompare(b.nombre));
  const cuenta = (e: Integracion["estado"]) => (ints ?? []).filter((i) => i.estado === e).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Integraciones</h1>
        <p className="text-ink/60 text-sm mt-1 max-w-3xl">
          Todos los puentes y conexiones en un solo lugar: si reportan, desde cuándo, qué versión tienen y si informaron algún error.
          Cada uno se configura en su pantalla (botón “Configurar”). Se actualiza solo cada minuto.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(["ok", "aviso", "mal", "sin_configurar"] as const).map((e) => (
          <div key={e} className="card p-5">
            <div className="text-xs text-ink/50 font-medium flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${ESTADO_INT[e].punto}`} />{ESTADO_INT[e].t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${e === "mal" && cuenta(e) ? "text-red-600" : e === "aviso" && cuenta(e) ? "text-amber-700" : "text-ink"}`}>{ints ? cuenta(e) : "—"}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Integración</th><th>Estado</th><th>Último reporte</th><th>Versión</th><th>Detalle</th><th></th></tr></thead>
          <tbody>
            {!ints && <tr><td colSpan={6} className="text-center text-ink/40 py-8">Cargando…</td></tr>}
            {lista.map((i) => (
              <tr key={i.clave}>
                <td className="text-sm"><div className="font-medium text-ink">{i.nombre}</div><div className="text-xs text-ink/45">{i.area}</div></td>
                <td><span className={`pill whitespace-nowrap ${ESTADO_INT[i.estado].pill}`}>{ESTADO_INT[i.estado].t}</span></td>
                <td className="text-sm text-ink/70 whitespace-nowrap" title={i.ultimo ? new Date(i.ultimo).toLocaleString("es-AR") : undefined}>{i.ultimo ? hace(i.ultimo) : "nunca"}</td>
                <td className="text-sm text-ink/60 whitespace-nowrap">{i.version ?? "—"}</td>
                <td className="text-sm max-w-md">
                  {i.error && <div className="text-red-600 break-words">{i.error}</div>}
                  {i.detalle && <div className="text-ink/60">{i.detalle}</div>}
                </td>
                <td className="text-right"><Link href={i.enlace} className="text-sm text-brand-600 hover:underline whitespace-nowrap">{i.estado === "sin_configurar" ? "Configurar" : "Abrir"}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/45">
        El semáforo usa el tiempo que cada puente puede estar sin reportar (el mismo de sus alertas cuando lo tiene): amarillo pasado ese tiempo o con errores,
        rojo cuando lleva varias veces ese tiempo sin reportar.
      </p>
    </div>
  );
}
