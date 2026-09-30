"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { calcularIndicadores, nivel, type Kpi } from "@/lib/indicadores";
import { hace } from "@/lib/monitoreo";
import { ESTADO_INT, type Integracion } from "@/components/integraciones";

type Datos = {
  alertas?: Record<string, number>;
  por_dia?: { dia: string; n: number }[];
  urgentes?: { id: number; severidad: string; titulo: string; detalle: string | null; enlace: string | null; abierta: string }[] | null;
  securescore?: { actual: number; maximo: number; promedio: number | null } | null;
  securescore_30?: number | null;
  vencimientos?: { descripcion: string; fecha: string; enlace: string }[];
};

const SEV: [string, string, string][] = [["critica", "críticas", "bg-red-600 text-white"], ["alta", "altas", "bg-orange-500/15 text-orange-700"], ["media", "medias", "bg-amber-500/15 text-amber-700"], ["info", "informativas", "bg-line/[0.05] text-ink/60"]];
const SEV_PILL: Record<string, [string, string]> = { critica: ["Crítica", "bg-red-600 text-white"], alta: ["Alta", "bg-orange-500/15 text-orange-700"], media: ["Media", "bg-amber-500/15 text-amber-700"], info: ["Info", "bg-line/[0.05] text-ink/60"] };

function Medidor({ v, color }: { v: number; color: string }) {
  return <div className="h-1.5 rounded-full bg-line/[0.08] mt-3 overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></div>;
}

export default function Inicio() {
  const { perfil } = usePerfil();
  const [d, setD] = useState<Datos | null>(null);
  const [ints, setInts] = useState<Integracion[] | null>(null);
  const [kpis, setKpis] = useState<Kpi[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sb = createClient();
    sb.rpc("inicio_datos").then(({ data, error }) => {
      if (error) setError(/inicio_datos/.test(error.message) ? "Falta ejecutar supabase/inicio.sql en Supabase." : error.message);
      setD((data as Datos) ?? {});
    });
    sb.rpc("integraciones_estado").then(({ data }) => setInts((data as Integracion[]) ?? []));
    calcularIndicadores(sb).then(setKpis);
  }, []);

  const hora = Number(new Date().toLocaleString("es-AR", { hour: "numeric", hour12: false, timeZone: "America/Argentina/Buenos_Aires" }));
  const saludo = hora < 12 ? "Buen día" : hora < 20 ? "Buenas tardes" : "Buenas noches";
  const nombre = (perfil?.nombre ?? "").split(/[\s@]/)[0];
  const fecha = new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Argentina/Buenos_Aires" });

  const medidos = (kpis ?? []).filter((k) => nivel(k) !== "nd");
  const enMeta = medidos.filter((k) => nivel(k) === "ok").length;
  const cumplimiento = medidos.length ? Math.round((100 * enMeta) / medidos.length) : null;
  const totalAlertas = Object.values(d?.alertas ?? {}).reduce((a, b) => a + b, 0);
  const ss = d?.securescore;
  const ssPct = ss?.maximo ? Math.round((100 * ss.actual) / ss.maximo) : null;
  const configuradas = (ints ?? []).filter((i) => i.estado !== "sin_configurar");
  const bien = configuradas.filter((i) => i.estado === "ok").length;
  const maxDia = Math.max(1, ...(d?.por_dia ?? []).map((x) => x.n));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">{saludo}{nombre ? `, ${nombre}` : ""}</h1>
        <p className="text-ink/60 text-sm mt-1 first-letter:uppercase">{fecha} · estado general de la seguridad y lo que conviene resolver hoy.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Link href="/inventario/cumplimiento" className="card p-5 hover:ring-1 hover:ring-line/20">
          <div className="text-xs text-ink/50 font-medium">Nivel de cumplimiento</div>
          <div className="font-display text-3xl mt-1 tabular-nums">{cumplimiento == null ? "—" : `${cumplimiento}%`}</div>
          <div className="text-xs text-ink/50">{kpis ? `${enMeta} de ${medidos.length} indicadores en meta` : "Calculando…"}</div>
          {cumplimiento != null && <Medidor v={cumplimiento} color={cumplimiento >= 80 ? "bg-emerald-500" : cumplimiento >= 60 ? "bg-amber-500" : "bg-red-500"} />}
        </Link>
        <Link href="/auditoria/alertas" className="card p-5 hover:ring-1 hover:ring-line/20">
          <div className="text-xs text-ink/50 font-medium">Alertas abiertas</div>
          <div className="font-display text-3xl mt-1 tabular-nums">{d ? totalAlertas : "—"}</div>
          <div className="flex flex-wrap gap-1 mt-2">
            {SEV.filter(([k]) => d?.alertas?.[k]).map(([k, t, c]) => <span key={k} className={`pill ${c}`}>{d!.alertas![k]} {t}</span>)}
            {d && !totalAlertas && <span className="text-xs text-emerald-700">Nada pendiente</span>}
          </div>
        </Link>
        <Link href="/inventario/securescore" className="card p-5 hover:ring-1 hover:ring-line/20">
          <div className="text-xs text-ink/50 font-medium">Secure Score de Microsoft 365</div>
          <div className="font-display text-3xl mt-1 tabular-nums">{ssPct == null ? "—" : `${ssPct}%`}</div>
          <div className="text-xs text-ink/50">
            {ss ? [d?.securescore_30 != null ? `${ss.actual - d.securescore_30 >= 0 ? "+" : ""}${Math.round((ss.actual - d.securescore_30) * 10) / 10} puntos en 30 días` : null,
                   ss.promedio != null ? `promedio ${Math.round((100 * ss.promedio) / ss.maximo)}%` : null].filter(Boolean).join(" · ") : "Sin datos todavía"}
          </div>
          {ssPct != null && <Medidor v={ssPct} color={ssPct >= 70 ? "bg-emerald-500" : "bg-amber-500"} />}
        </Link>
        <Link href="/inicio/integraciones" className="card p-5 hover:ring-1 hover:ring-line/20">
          <div className="text-xs text-ink/50 font-medium">Integraciones reportando</div>
          <div className="font-display text-3xl mt-1 tabular-nums">{ints ? <>{bien}<span className="text-lg text-ink/40"> / {configuradas.length}</span></> : "—"}</div>
          <div className="text-xs text-ink/50">{ints ? (configuradas.length - bien ? `${configuradas.length - bien} con demora o sin reportar` : "Todas al día") : "Cargando…"}</div>
          {ints && configuradas.length > 0 && <Medidor v={(100 * bien) / configuradas.length} color={bien === configuradas.length ? "bg-emerald-500" : "bg-amber-500"} />}
        </Link>
      </div>

      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4 items-start">
        <div className="card p-5">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <h2 className="font-display text-base text-ink">Lo urgente hoy</h2>
            <Link href="/auditoria/alertas" className="text-sm text-brand-600 hover:underline">Ver todas las alertas</Link>
          </div>
          {!d ? <p className="text-sm text-ink/50">Cargando…</p>
            : d.urgentes == null ? <p className="text-sm text-ink/50">El detalle de las alertas se ve con la solapa Logs.</p>
            : !d.urgentes.length ? <p className="text-sm text-emerald-700">No hay alertas abiertas.</p>
            : (
              <ul className="divide-y divide-line/[0.06]">
                {d.urgentes.map((u) => (
                  <li key={u.id} className="py-2.5 flex gap-3 items-start">
                    <span className={`pill shrink-0 w-16 justify-center text-center ${SEV_PILL[u.severidad]?.[1] ?? ""}`}>{SEV_PILL[u.severidad]?.[0] ?? u.severidad}</span>
                    <div className="min-w-0 flex-1">
                      <Link href={u.enlace ?? "/auditoria/alertas"} className="font-medium text-ink hover:text-brand-700">{u.titulo}</Link>
                      <div className="text-xs text-ink/55 truncate">{[u.detalle, hace(u.abierta)].filter(Boolean).join(" · ")}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h2 className="font-display text-base text-ink">Integraciones</h2>
              <Link href="/inicio/integraciones" className="text-sm text-brand-600 hover:underline">Detalle</Link>
            </div>
            {!ints ? <p className="text-sm text-ink/50">Cargando…</p> : (
              <ul className="space-y-1.5">
                {configuradas.sort((a, b) => ESTADO_INT[a.estado].orden - ESTADO_INT[b.estado].orden).map((i) => (
                  <li key={i.clave} className="flex items-center gap-2 text-sm">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${ESTADO_INT[i.estado].punto}`} aria-label={ESTADO_INT[i.estado].t} />
                    <Link href={i.enlace} className="truncate text-ink hover:text-brand-700">{i.nombre}</Link>
                    <span className="ml-auto text-xs text-ink/50 whitespace-nowrap">{i.ultimo ? hace(i.ultimo) : "nunca"}</span>
                  </li>
                ))}
                {!configuradas.length && <li className="text-sm text-ink/50">Todavía no hay integraciones configuradas.</li>}
              </ul>
            )}
          </div>

          <div className="card p-5">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h2 className="font-display text-base text-ink">Vencen en 30 días</h2>
              <Link href="/vencimientos" className="text-sm text-brand-600 hover:underline">Vencimientos</Link>
            </div>
            {!d ? <p className="text-sm text-ink/50">Cargando…</p> : !(d.vencimientos ?? []).length ? <p className="text-sm text-emerald-700">Nada vence en los próximos 30 días.</p> : (
              <ul className="space-y-1 text-sm">
                {d.vencimientos!.map((v, i) => {
                  const vencido = v.fecha < new Date().toISOString().slice(0, 10);
                  return (
                    <li key={i} className="flex gap-3">
                      <Link href={v.enlace} className="truncate text-ink hover:text-brand-700">{v.descripcion}</Link>
                      <span className={`ml-auto tabular-nums whitespace-nowrap ${vencido ? "text-red-600 font-medium" : "text-ink/55"}`}>{vencido ? "vencido" : new Date(v.fecha + "T12:00").toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {(d?.por_dia ?? []).length > 0 && (
            <div className="card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-base text-ink">Alertas nuevas por día</h2>
                <span className="text-xs text-ink/50">últimos 14 días</span>
              </div>
              <div className="flex items-end gap-1 h-16 mt-3" role="img" aria-label={`Alertas nuevas por día: máximo ${maxDia}`}>
                {d!.por_dia!.map((x, i) => (
                  <div key={x.dia} title={`${new Date(x.dia + "T12:00").toLocaleDateString("es-AR")}: ${x.n}`}
                    className={`flex-1 rounded-t ${i === d!.por_dia!.length - 1 ? "bg-brand-600" : "bg-brand-100"}`} style={{ height: `${Math.max(3, (100 * x.n) / maxDia)}%` }} />
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-ink/40 mt-1"><span>hace 13 días</span><span>hoy</span></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
