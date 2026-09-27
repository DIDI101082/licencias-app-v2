"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import {
  BACKUP, CRITICIDAD, fechaCorta, fechaHora, haceHoras, useServidores, type Fila,
} from "@/lib/servidores";

type Prueba = {
  id: number; servidor_id: number; fecha: string; resultado: "exitosa" | "parcial" | "fallida";
  duracion_min: number | null; notas: string | null; registrado_email: string | null;
};
const RESULTADO = {
  exitosa: { t: "Exitosa", c: "bg-emerald-50 text-emerald-700" },
  parcial: { t: "Parcial", c: "bg-amber-500/10 text-amber-700" },
  fallida: { t: "Fallida", c: "bg-red-600 text-white" },
};
const DIA_RES: Record<string, string> = { Success: "bg-emerald-500", Warning: "bg-amber-400", Failed: "bg-red-600" };
const PEOR = ["Failed", "Warning", "Success"];

type Filtro = "todos" | "problema" | "sin_backup" | "prueba";

export default function BackupsServidores() {
  const { esAdmin, puedeEditar } = usePerfil();
  const { filas, datos, config, cargando, error, recargar, ahora } = useServidores();
  const [pruebas, setPruebas] = useState<Prueba[]>([]);
  const [registrando, setRegistrando] = useState<number | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [msg, setMsg] = useState<string | null>(null);

  const cargarPruebas = () =>
    createClient().from("srv_pruebas_restore").select("*").order("fecha", { ascending: false }).order("id", { ascending: false }).limit(50)
      .then(({ data }) => setPruebas((data ?? []) as Prueba[]));
  useEffect(() => { cargarPruebas(); }, []);

  const activos = filas.filter((f) => f.activo && f.requiere_backup);
  const veeam = datos?.veeam;
  const veeamViejo = veeam?.ultimo_reporte ? ahora - Date.parse(veeam.ultimo_reporte) > (veeam.horas_max_sin_reporte ?? 3) * 3600000 : false;
  const sinObjetos = !!veeam?.trabajos.length && veeam.trabajos.every((t) => t.objetos == null);

  const dias = Array.from({ length: 14 }, (_, i) => new Date(ahora - (13 - i) * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }));
  const resultadoDia = (f: Fila, dia: string) => {
    const r = (veeam?.historial ?? []).filter((h) => h.fecha === dia && f.trabajos.some((t) => t.nombre === h.nombre)).map((h) => h.resultado);
    return PEOR.find((p) => r.includes(p)) ?? null;
  };

  const problema = (f: Fila) => f.backup === "fuera_rpo" || f.backup === "fallo";
  const tarjetas: { k: Filtro; t: string; n: number; rojo?: boolean }[] = [
    { k: "todos", t: "Al día", n: activos.filter((f) => f.backup === "ok").length },
    { k: "problema", t: "Fuera de RPO o con fallas", n: activos.filter(problema).length, rojo: true },
    { k: "sin_backup", t: "Sin backup", n: activos.filter((f) => f.backup === "sin_backup").length, rojo: true },
    { k: "prueba", t: "Prueba de restauración pendiente", n: activos.filter((f) => f.pruebaVencida).length },
  ];

  const lista = useMemo(() => filas
    .filter((f) => f.activo)
    .filter((f) => filtro === "todos" ? true : filtro === "problema" ? problema(f) : filtro === "sin_backup" ? f.backup === "sin_backup" : f.pruebaVencida)
    .sort((a, b) => BACKUP[a.backup].orden - BACKUP[b.backup].orden || CRITICIDAD[a.criticidad].orden - CRITICIDAD[b.criticidad].orden || a.nombre.localeCompare(b.nombre)),
  [filas, filtro]);
  const nombreDe = (id: number) => filas.find((f) => f.id === id)?.nombre ?? "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Backups por servidor</h1>
        <p className="text-ink/60 text-sm mt-1">
          Si cada servidor tiene un backup reciente dentro de su RPO y cuándo se probó restaurarlo por última vez.
          El detalle de cada trabajo de Veeam está en <Link href="/inventario/backups" className="text-brand-700 hover:underline">Seguridad → Backups</Link>.
        </p>
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}
      {msg && <div className="card p-3 text-sm text-red-600 bg-red-50">{msg}</div>}

      {veeam && !veeam.configurado && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Veeam todavía no está conectado. Se configura en Seguridad → Backups → Configurar.
        </div>
      )}
      {veeam?.configurado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${veeamViejo ? "bg-red-50" : ""}`}>
          <span className={veeamViejo ? "text-red-600" : ""}><b>Último reporte de Veeam:</b> {fechaHora(veeam.ultimo_reporte)} ({haceHoras(veeam.ultimo_reporte, ahora)})</span>
          <span><b>Trabajos informados:</b> {veeam.trabajos.length}</span>
        </div>
      )}
      {sinObjetos && (
        <p className="text-sm text-ink/70 bg-brand-50 rounded-md px-3 py-2">
          El script de Veeam instalado no informa qué VMs incluye cada trabajo, así que los servidores no se vinculan solos.
          Generá el script de nuevo en Seguridad → Backups → Configurar y reemplazá el archivo en el servidor de Veeam (sale con token nuevo,
          así que el anterior deja de funcionar), o asigná los trabajos a mano editando cada servidor.
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {tarjetas.map((c) => (
          <button key={c.k} onClick={() => setFiltro(filtro === c.k ? "todos" : c.k)} aria-pressed={filtro === c.k}
            className={`card p-5 text-left transition-colors ${filtro === c.k && c.k !== "todos" ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{c.t}</div>
            <div className={`font-display text-3xl mt-1 ${c.rojo && c.n ? "text-red-600" : c.k === "todos" ? "text-emerald-700" : "text-ink"}`}>{c.n}</div>
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Servidor</th><th>Backup</th><th>Trabajos de Veeam</th><th>Últimos 14 días</th><th>Prueba de restauración</th></tr></thead>
          <tbody>
            {cargando && <tr><td colSpan={5} className="text-center text-ink/40 py-10">Cargando…</td></tr>}
            {!cargando && !lista.length && <tr><td colSpan={5} className="text-center text-ink/40 py-10">Ningún servidor en esta situación.</td></tr>}
            {lista.map((f) => (
              <Fragment key={f.id}>
                <tr>
                  <td>
                    <div className="font-medium text-ink">{f.nombre}</div>
                    <span className={`pill mt-0.5 ${CRITICIDAD[f.criticidad].c}`}>{CRITICIDAD[f.criticidad].t}</span>
                  </td>
                  <td className="text-sm">
                    <span className={`pill ${BACKUP[f.backup].c}`}>{BACKUP[f.backup].t}</span>
                    {f.requiere_backup && f.backup !== "sin_backup" && f.backup !== "sin_veeam" && (
                      <div className={`text-xs mt-0.5 ${f.backup === "fuera_rpo" ? "text-red-600" : "text-ink/60"}`}>
                        último exitoso {haceHoras(f.ultimoExito, ahora)} · RPO {f.rpo_horas} h
                      </div>
                    )}
                  </td>
                  <td className="text-sm">
                    {!f.requiere_backup ? <span className="text-ink/40">—</span> : !f.trabajos.length ? <span className="text-ink/40">Ninguno</span> : (
                      <ul className="space-y-0.5">
                        {f.trabajos.map((t) => (
                          <li key={t.nombre} className="text-xs">
                            <span className={t.ultimo_resultado === "Failed" ? "text-red-600" : "text-ink/80"}>{t.nombre}</span>
                            {t.automatico && <span className="text-ink/40" title="Vinculado solo porque el trabajo incluye una VM o equipo con este nombre"> · automático</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {f.trabajos.length > 0 && (
                      <div className="flex gap-0.5">
                        {dias.map((d) => {
                          const r = resultadoDia(f, d);
                          return <span key={d} title={`${d.split("-").reverse().join("/")}: ${r === "Success" ? "exitoso" : r === "Warning" ? "con advertencias" : r === "Failed" ? "falló" : "sin ejecución"}`}
                            className={`h-4 w-2.5 rounded-sm ${r ? DIA_RES[r] : "bg-line/[0.08]"}`} />;
                        })}
                      </div>
                    )}
                  </td>
                  <td className="text-sm">
                    {!f.requiere_backup ? <span className="text-ink/40">—</span> : (
                      <>
                        {f.ultimaPrueba ? (
                          <div className="flex items-center gap-2">
                            <span className={`pill ${RESULTADO[f.ultimaPrueba.resultado].c}`}>{RESULTADO[f.ultimaPrueba.resultado].t}</span>
                            <span className={f.pruebaVencida ? "text-red-600 text-xs" : "text-ink/60 text-xs"}>{fechaCorta(f.ultimaPrueba.fecha)}</span>
                          </div>
                        ) : <span className={f.pruebaVencida ? "text-red-600 text-xs" : "text-ink/40 text-xs"}>Nunca</span>}
                        {puedeEditar && (
                          <button className="text-xs text-brand-700 hover:underline mt-0.5" onClick={() => setRegistrando(registrando === f.id ? null : f.id)}>
                            {registrando === f.id ? "Cancelar" : "Registrar prueba"}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
                {registrando === f.id && (
                  <tr><td colSpan={5} className="bg-line/[0.02]">
                    <RegistrarPrueba servidor={f} onListo={() => { setRegistrando(null); cargarPruebas(); recargar(); }} onError={setMsg} />
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card overflow-x-auto">
        <div className="p-5 pb-2">
          <h2 className="font-medium text-ink">Pruebas de restauración registradas</h2>
          <p className="text-sm text-ink/60 mt-1">
            Un backup que nunca se restauró no está probado. En servidores críticos y altos, se alerta si pasan más de {config.dias_prueba_restore} días
            sin una prueba exitosa.
          </p>
        </div>
        <table className="data w-full">
          <thead><tr><th>Fecha</th><th>Servidor</th><th>Resultado</th><th>Duración</th><th>Notas</th><th>Registró</th>{esAdmin && <th></th>}</tr></thead>
          <tbody>
            {!pruebas.length && <tr><td colSpan={7} className="text-center text-ink/40 py-6">Todavía no hay pruebas registradas.</td></tr>}
            {pruebas.map((p) => (
              <tr key={p.id}>
                <td className="text-sm whitespace-nowrap">{fechaCorta(p.fecha)}</td>
                <td className="text-sm text-ink">{nombreDe(p.servidor_id)}</td>
                <td><span className={`pill ${RESULTADO[p.resultado].c}`}>{RESULTADO[p.resultado].t}</span></td>
                <td className="text-sm text-ink/70">{p.duracion_min != null ? `${p.duracion_min} min` : "—"}</td>
                <td className="text-sm text-ink/70 max-w-sm">{p.notas ?? "—"}</td>
                <td className="text-xs text-ink/50">{p.registrado_email ?? "—"}</td>
                {esAdmin && (
                  <td className="text-right">
                    <button className="text-xs text-ink/40 hover:text-red-600" onClick={async () => {
                      if (!confirm("¿Borrar esta prueba registrada?")) return;
                      const { error } = await createClient().from("srv_pruebas_restore").delete().eq("id", p.id);
                      if (error) setMsg(error.message); else { cargarPruebas(); recargar(); }
                    }}>Borrar</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RegistrarPrueba({ servidor, onListo, onError }: { servidor: Fila; onListo: () => void; onError: (m: string) => void }) {
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const [f, setF] = useState({ fecha: hoy, resultado: "exitosa", duracion_min: "", notas: "" });
  const [guardando, setGuardando] = useState(false);

  async function guardar(e: React.FormEvent) {
    e.preventDefault(); setGuardando(true);
    const { error } = await createClient().from("srv_pruebas_restore").insert({
      servidor_id: servidor.id, fecha: f.fecha, resultado: f.resultado,
      duracion_min: f.duracion_min === "" ? null : Number(f.duracion_min), notas: f.notas.trim() || null,
    });
    setGuardando(false);
    if (error) return onError(error.message);
    onListo();
  }

  return (
    <form onSubmit={guardar} className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end py-1">
      <div><label className="label">Fecha</label><input type="date" required max={hoy} className="input" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></div>
      <div><label className="label">Resultado</label>
        <select className="input" value={f.resultado} onChange={(e) => setF({ ...f, resultado: e.target.value })}>
          <option value="exitosa">Exitosa</option><option value="parcial">Parcial</option><option value="fallida">Fallida</option>
        </select></div>
      <div><label className="label">Duración (min)</label><input type="number" min={0} className="input" value={f.duracion_min} onChange={(e) => setF({ ...f, duracion_min: e.target.value })} /></div>
      <div className="col-span-2 md:col-span-2"><label className="label">Notas</label>
        <input className="input" value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} placeholder="Qué se restauró, dónde, qué se verificó" /></div>
      <div><button className="btn-primary w-full" disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</button></div>
    </form>
  );
}
