"use client";

import Link from "next/link";
import { hace } from "@/lib/monitoreo";

type Urgente = {
  id: number;
  severidad: string;
  titulo: string;
  detalle: string | null;
  enlace: string | null;
  abierta: string;
};

type Props = {
  urgentes?: Urgente[] | null;
  avisoConf: string | null;
  confirmarId: number | null;
  notaConfirmar: string;
  confirmando: boolean;
  puedeEditar: boolean;
  cargando: boolean;
  onConfirmar: () => void;
  onSetConfirmarId: (id: number | null) => void;
  onSetNotaConfirmar: (nota: string) => void;
  onSetAvisoConf: (aviso: string | null) => void;
};

const SEV_PILL: Record<string, [string, string]> = {
  critica: ["Crítica", "bg-red-600 text-white"],
  alta: ["Alta", "bg-orange-500/15 text-orange-700"],
  media: ["Media", "bg-amber-500/15 text-amber-700"],
  info: ["Info", "bg-line/[0.05] text-ink/60"],
};

export default function LoUrgenteHoy({
  urgentes,
  avisoConf,
  confirmarId,
  notaConfirmar,
  confirmando,
  puedeEditar,
  cargando,
  onConfirmar,
  onSetConfirmarId,
  onSetNotaConfirmar,
  onSetAvisoConf,
}: Props) {
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2 className="font-display text-base text-ink">Lo urgente hoy</h2>
        <Link href="/auditoria/alertas" className="text-sm text-brand-600 hover:underline">
          Ver todas las alertas
        </Link>
      </div>

      {avisoConf && (
        <div className="mb-2 p-2 rounded-lg bg-emerald-50 text-sm text-emerald-700">
          {avisoConf}
        </div>
      )}

      {cargando ? (
        <p className="text-sm text-ink/50">Cargando…</p>
      ) : urgentes == null ? (
        <p className="text-sm text-ink/50">El detalle de las alertas se ve con la solapa Logs.</p>
      ) : !urgentes.length ? (
        <p className="text-sm text-emerald-700">No hay alertas abiertas.</p>
      ) : (
        <ul className="divide-y divide-line/[0.06]">
          {urgentes.map((u) => (
            <li key={u.id} className="py-2.5">
              <div className="flex gap-3 items-start">
                <span
                  className={`pill shrink-0 w-16 justify-center text-center ${SEV_PILL[u.severidad]?.[1] ?? ""}`}
                >
                  {SEV_PILL[u.severidad]?.[0] ?? u.severidad}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={u.enlace ?? "/auditoria/alertas"}
                    className="font-medium text-ink hover:text-brand-700"
                  >
                    {u.titulo}
                  </Link>
                  <div className="text-xs text-ink/55 truncate">
                    {[u.detalle, hace(u.abierta)].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {puedeEditar && (
                  <button
                    className="shrink-0 text-xs text-ink/40 hover:text-emerald-700 hover:bg-emerald-50 px-2 py-1 rounded transition-colors"
                    title="Confirmar alerta"
                    onClick={() => {
                      onSetConfirmarId(confirmarId === u.id ? null : u.id);
                      onSetNotaConfirmar("");
                      onSetAvisoConf(null);
                    }}
                  >
                    {confirmarId === u.id ? "Cancelar" : "✓ Confirmar"}
                  </button>
                )}
              </div>

              {confirmarId === u.id && (
                <div className="mt-2 ml-[76px] flex gap-2 items-center">
                  <input
                    className="input text-sm flex-1"
                    placeholder="Qué se hizo (mín. 3 caracteres)"
                    value={notaConfirmar}
                    onChange={(e) => onSetNotaConfirmar(e.target.value)}
                    maxLength={500}
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && onConfirmar()}
                  />
                  <button
                    className="btn-primary text-sm"
                    disabled={confirmando || notaConfirmar.trim().length < 3}
                    onClick={onConfirmar}
                  >
                    {confirmando ? "…" : "Confirmar"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
