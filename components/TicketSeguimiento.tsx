"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Seguimiento de un ticket del helpdesk: su recorrido (asignaciones, cambios de estado y de subárea)
// y sus mensajes, en orden cronológico. Solo lectura.

type Evento = {
  origen: "mensaje" | "metrica"; id: string; fecha: string | null; usuario: string | null; proceso: string | null; estado: string | null;
  area: string | null; subarea: string | null; actor: string | null; texto: string | null; privado: boolean;
};

const cuando = (v: string | null) =>
  v ? new Date(v).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
// Procesos que no aportan al recorrido (ya se ven como mensajes o son técnicos)
const OCULTOS = /^(mensaje|actualizaci[oó]n datos json)$/i;

export default function TicketSeguimiento({ id, solicitante, recorrido }: { id: string; solicitante: string | null; recorrido: string | null }) {
  const [eventos, setEventos] = useState<Evento[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [soloMensajes, setSoloMensajes] = useState(false);

  useEffect(() => {
    let vivo = true;
    setEventos(null); setError(null); setAviso(null);
    createClient().rpc("tickets_seguimiento", { p_id: id }).then(({ data, error }) => {
      if (!vivo) return;
      if (error) return setError(/tickets_seguimiento/.test(error.message) ? "Falta ejecutar supabase/helpdesk.sql en Supabase." : error.message);
      setEventos((data?.eventos ?? []) as Evento[]);
      setAviso(data?.error ?? null);
    });
    return () => { vivo = false; };
  }, [id]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!eventos) return <p className="text-sm text-ink/50">Leyendo el seguimiento…</p>;

  const visibles = eventos.filter((e) => (e.origen === "mensaje" ? true : !soloMensajes && !OCULTOS.test(e.proceso ?? "")));
  const esSolicitante = (u: string | null) => !!u && !!solicitante && u.trim().toLowerCase() === solicitante.trim().toLowerCase();

  return (
    <div className="space-y-3">
      {aviso && <p className="text-xs text-amber-700">No se pudo actualizar desde el helpdesk ({aviso}). Se muestra lo último guardado.</p>}
      {recorrido && (
        <div className="text-sm">
          <span className="text-ink/50">Recorrido: </span>
          {recorrido.split(" → ").map((s, i) => (
            <span key={i}>{i > 0 && <span className="text-ink/30 mx-1">→</span>}<span className="pill bg-line/[0.06] text-ink/80">{s}</span></span>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-ink/60">
        <input type="checkbox" checked={soloMensajes} onChange={(e) => setSoloMensajes(e.target.checked)} /> Ver solo los mensajes
      </label>
      {visibles.length === 0 ? <p className="text-sm text-ink/50">El helpdesk no informa movimientos para este ticket.</p> : (
        <ol className="space-y-2 border-l border-line/20 ml-1.5 pl-4">
          {visibles.map((e) => (
            <li key={`${e.origen}-${e.id}`} className="relative text-sm">
              <i className={`absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full ${e.origen === "mensaje" ? (e.privado ? "bg-amber-500" : "bg-brand-500") : "bg-line/40"}`} />
              <div className="text-xs text-ink/50">
                {cuando(e.fecha)}
                {e.origen === "mensaje"
                  ? <> · <span className="text-ink/80 font-medium">{e.usuario ?? "—"}</span>{esSolicitante(e.usuario) && " (solicitante)"}{e.id === "0" && " · descripción del ticket"}{e.privado && " · nota interna"}</>
                  : <> · <span className="text-ink/80">{e.proceso ?? "Movimiento"}</span>{e.usuario && <> · {e.usuario}</>}{e.subarea && <> · {e.subarea}</>}{e.estado && <> · estado: {e.estado}</>}</>}
              </div>
              {e.origen === "mensaje" && (
                e.texto
                  ? <p className={`mt-0.5 whitespace-pre-wrap break-words rounded-md px-3 py-2 ${e.privado ? "bg-amber-500/10" : "bg-line/[0.04]"} text-ink/90`}>{e.texto}</p>
                  : <p className="mt-0.5 text-xs text-ink/40 italic">{e.privado ? "Nota interna: el texto no se guarda en Accusys Cyber." : "Sin texto."}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
