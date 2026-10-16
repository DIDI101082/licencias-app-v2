"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { diagnosticar, ocupantes, ESTILO_NIVEL, agenteSoportaDisco, type DiscoDiag, type Clase } from "@/lib/disco";
import { hace } from "@/lib/monitoreo";

const CLASE: Record<Clase, { t: string; c: string }> = {
  limpiable: { t: "Se puede limpiar", c: "bg-emerald-50 text-emerald-700" },
  usuario: { t: "Revisar con el usuario", c: "bg-amber-50 text-amber-800" },
  sistema: { t: "Sistema", c: "bg-line/[0.05] text-ink/60" },
};

const gb = (n: number | null | undefined) => (n == null ? "—" : n >= 100 ? `${Math.round(n)} GB` : `${Math.round(n * 10) / 10} GB`);

// Diagnóstico del disco C de un equipo: por qué está lleno y si hay que cambiar el disco.
export default function DiagnosticoDisco({ id, hostname, agenteVersion, esAdmin }: {
  id: string; hostname: string; agenteVersion: string | null; esAdmin: boolean;
}) {
  const [diag, setDiag] = useState<DiscoDiag | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verTodo, setVerTodo] = useState(false);

  const cargar = useCallback(() =>
    createClient().from("inv_disco_diag").select("*").eq("dispositivo_id", id).maybeSingle()
      .then(({ data, error }) => {
        if (error) setError(/inv_disco_diag/.test(error.message) ? "Falta ejecutar supabase/disco-diagnostico.sql" : error.message);
        setDiag((data as DiscoDiag) ?? null);
        setCargando(false);
      }), [id]);

  useEffect(() => {
    cargar();
    const sb = createClient();
    const canal = sb.channel(`disco-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "inv_disco_diag", filter: `dispositivo_id=eq.${id}` }, () => cargar())
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [id, cargar]);

  async function pedir() {
    setError(null);
    const { error } = await createClient().rpc("inv_disco_pedir", { p_ids: [id] });
    if (error) setError(error.message); else cargar();
  }

  const soporta = agenteSoportaDisco(agenteVersion);
  const esperando = !!diag && (diag.pedido || diag.en_curso) && (!diag.analizado || !diag.pedido_fecha || diag.analizado < diag.pedido_fecha);
  const datos = diag?.datos;

  const boton = esAdmin && soporta && (
    <button className="btn-secondary px-3 py-1.5 text-sm disabled:opacity-50" disabled={esperando} onClick={(e) => { e.stopPropagation(); pedir(); }}>
      {esperando ? (diag?.en_curso ? "Analizando en el equipo…" : "Pedido: se analiza en el próximo reporte") : datos ? "Volver a analizar" : "Analizar disco"}
    </button>
  );

  if (cargando) return <p className="text-sm text-ink/40">Cargando diagnóstico del disco…</p>;

  if (!soporta && !datos) {
    return (
      <div className="text-sm text-ink/60">
        El diagnóstico del disco necesita el agente {"2.1"} o superior (este equipo tiene {agenteVersion ?? "?"}). Reinstalá el agente desde Monitoreo → Agente.
      </div>
    );
  }

  if (!datos) {
    return (
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-ink/60">
          {esperando ? "El agente va a analizar el disco C en su próximo reporte (tarda unos minutos)." : "Todavía no hay un análisis del disco C de este equipo."}
        </p>
        {boton}
        {error && <p className="text-sm text-red-600 w-full">{error}</p>}
      </div>
    );
  }

  if (datos.estado === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-red-600">El análisis falló en el equipo: {datos.detalle}</p>
        {boton}
      </div>
    );
  }

  const v = diagnosticar(datos);
  const lista = ocupantes(datos);
  const f = datos.fisico ?? {};
  const perfiles = (datos.rutas ?? []).filter((r) => /^c:\\users\\[^\\]+$/i.test(r.ruta) && r.gb >= 1).sort((a, b) => b.gb - a.gb);
  const visibles = verTodo ? lista : lista.slice(0, 8);

  return (
    <div className="space-y-4 text-sm" onClick={(e) => e.stopPropagation()}>
      <div className={`border rounded-xl p-3 ${ESTILO_NIVEL[v.nivel]}`}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="font-semibold">{v.titulo}</p>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">{v.motivos.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
          {boton}
        </div>
      </div>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2">
        <div><dt className="text-ink/50 text-xs">Disco C</dt><dd>{gb(v.libreGb)} libres de {gb(datos.volumen?.total_gb)} ({v.usoPct ?? "—"}% usado)</dd></div>
        <div><dt className="text-ink/50 text-xs">Se recupera limpiando</dt><dd className="text-emerald-700">≈ {gb(v.recuperableGb)}</dd></div>
        <div><dt className="text-ink/50 text-xs">Revisando con el usuario</dt><dd className="text-amber-800">hasta ≈ {gb(v.conUsuarioGb)} más</dd></div>
        <div><dt className="text-ink/50 text-xs">Analizado</dt><dd>{diag?.analizado ? hace(diag.analizado) : "—"}{datos.duracion_seg ? ` · ${Math.round(datos.duracion_seg / 60) || 1} min` : ""}</dd></div>
        <div><dt className="text-ink/50 text-xs">Disco físico</dt><dd>{[f.tipo, f.bus, f.modelo].filter((x) => x && x !== "Unspecified").join(" · ") || "Sin datos"}{f.tamano_gb ? ` · ${gb(f.tamano_gb)}` : ""}</dd></div>
        <div><dt className="text-ink/50 text-xs">Salud</dt>
          <dd className={f.salud && !/healthy/i.test(f.salud) ? "text-red-600 font-medium" : ""}>
            {f.salud ? (/healthy/i.test(f.salud) ? "Sano" : f.salud) : "Sin datos (máquina virtual o controlador sin soporte)"}
            {f.smart_falla ? " · alerta SMART" : ""}
          </dd>
        </div>
        <div><dt className="text-ink/50 text-xs">Desgaste / temperatura</dt><dd>{f.desgaste_pct != null ? `${f.desgaste_pct} %` : "—"} · {f.temperatura ? `${f.temperatura} °C` : "—"}</dd></div>
        <div><dt className="text-ink/50 text-xs">Horas de uso / errores</dt><dd>{f.horas_uso != null ? `${f.horas_uso.toLocaleString("es-AR")} h` : "—"} · {(f.errores_lectura ?? 0) + (f.errores_escritura ?? 0)} errores</dd></div>
      </dl>

      {lista.length > 0 && (
        <div>
          <p className="text-xs text-ink/50 mb-1">Qué ocupa el disco y qué hacer</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-ink/50"><th className="py-1 pr-3">Qué es</th><th className="py-1 pr-3 text-right">Tamaño</th><th className="py-1 pr-3">Tipo</th><th className="py-1">Acción</th></tr></thead>
              <tbody>
                {visibles.map((o) => (
                  <tr key={o.ruta + o.nombre} className="border-t border-line/[0.06] align-top">
                    <td className="py-1.5 pr-3"><div>{o.nombre}</div><div className="text-[11px] text-ink/40 break-all">{o.ruta}</div></td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">{gb(o.gb)}</td>
                    <td className="py-1.5 pr-3"><span className={`pill whitespace-nowrap ${CLASE[o.clase].c}`}>{CLASE[o.clase].t}</span></td>
                    <td className="py-1.5 text-ink/70">{o.accion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lista.length > 8 && (
            <button className="text-xs text-brand-600 hover:underline mt-1" onClick={() => setVerTodo(!verTodo)}>{verTodo ? "Ver menos" : `Ver los ${lista.length}`}</button>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        <div>
          <p className="text-xs text-ink/50 mb-1">Carpetas de C: más grandes</p>
          <ul className="space-y-0.5">{(datos.raiz ?? []).slice(0, 8).map((r) => <li key={r.ruta} className="flex justify-between gap-2"><span className="truncate">{r.ruta.replace(/^c:/, "C:")}</span><span className="tabular-nums text-ink/60">{gb(r.gb)}</span></li>)}</ul>
        </div>
        <div>
          <p className="text-xs text-ink/50 mb-1">Perfiles de usuario</p>
          <ul className="space-y-0.5">{perfiles.length ? perfiles.slice(0, 8).map((r) => <li key={r.ruta} className="flex justify-between gap-2"><span className="truncate">{r.ruta.replace(/^c:\\users\\/i, "")}</span><span className="tabular-nums text-ink/60">{gb(r.gb)}</span></li>) : <li className="text-ink/40">Ninguno de más de 1 GB</li>}</ul>
        </div>
        <div>
          <p className="text-xs text-ink/50 mb-1">Archivos de más de 1 GB</p>
          <ul className="space-y-0.5">{(datos.grandes ?? []).length ? (datos.grandes ?? []).slice(0, 8).map((r) => <li key={r.ruta} className="flex justify-between gap-2" title={r.ruta}><span className="truncate">{r.ruta.split("\\").pop()}</span><span className="tabular-nums text-ink/60">{gb(r.gb)}</span></li>) : <li className="text-ink/40">Ninguno</li>}</ul>
        </div>
      </div>

      {(datos.sin_acceso ?? 0) > 0 && <p className="text-[11px] text-ink/40">{datos.sin_acceso} carpetas no se pudieron leer (protegidas por Windows): los tamaños pueden ser algo menores a los reales.</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="sr-only">Diagnóstico del disco de {hostname}</p>
    </div>
  );
}
