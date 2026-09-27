"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { usePerfil } from "@/components/PerfilContext";
import BarraDisco from "@/components/BarraDisco";
import ServidorForm, { SERVIDOR_VACIO } from "@/components/ServidorForm";
import { encendidoDesde } from "@/lib/monitoreo";
import {
  CRITICIDAD, ENTORNO, ESTADO, haceHoras, pareceServidor, usoRam, useServidores,
  type Dispositivo, type EstadoGeneral, type Fila, type Servidor,
} from "@/lib/servidores";

type Filtro = "todos" | "caido" | "sin_reportar" | "advertencia" | "criticos";

export default function Servidores() {
  const { esAdmin } = usePerfil();
  const { servidores, filas, datos, cargando, error, recargar, ahora } = useServidores();
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState<number | null>(null);
  const [editando, setEditando] = useState<(Partial<Servidor> & { nombre: string }) | null>(null);

  const activos = filas.filter((f) => f.activo);
  const cuenta = (e: EstadoGeneral) => activos.filter((f) => f.estado === e).length;
  const criticos = activos.filter((f) => f.criticidad === "critica").length;

  const lista = useMemo(() => {
    const t = texto.trim().toLowerCase();
    return filas
      .filter((f) => filtro === "todos" ? true : filtro === "criticos" ? f.criticidad === "critica" : f.activo && f.estado === filtro)
      .filter((f) => !t || [f.nombre, f.rol, f.disp?.hostname, f.disp?.ip, f.responsable, f.sede].some((x) => x?.toLowerCase().includes(t)))
      .sort((a, b) => Number(b.activo) - Number(a.activo) || ESTADO[a.estado].orden - ESTADO[b.estado].orden ||
        CRITICIDAD[a.criticidad].orden - CRITICIDAD[b.criticidad].orden || a.nombre.localeCompare(b.nombre));
  }, [filas, filtro, texto]);

  // Equipos del agente con sistema operativo de servidor que todavía no están en la lista
  const vinculados = servidores.map((s) => s.dispositivo_id).filter(Boolean) as string[];
  const candidatos = (datos?.dispositivos ?? []).filter((d) => pareceServidor(d) && !vinculados.includes(d.id));

  const prtgViejo = datos?.prtg?.actualizado ? ahora - Date.parse(datos.prtg.actualizado) > 30 * 60000 : false;

  function agregarDesde(d: Dispositivo) {
    setEditando({ ...SERVIDOR_VACIO, nombre: (d.hostname ?? "").split(".")[0].toUpperCase(), dispositivo_id: d.id });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const tarjetas: { k: Filtro; t: string; n: number; rojo?: boolean }[] = [
    { k: "todos", t: "Servidores activos", n: activos.length },
    { k: "caido", t: "Caídos", n: cuenta("caido"), rojo: true },
    { k: "sin_reportar", t: "Sin reportar", n: cuenta("sin_reportar"), rojo: true },
    { k: "advertencia", t: "Con alertas", n: cuenta("advertencia") },
    { k: "criticos", t: "Críticos", n: criticos },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Servidores</h1>
          <p className="text-ink/60 text-sm mt-1">
            Estado de cada servidor, con la disponibilidad de PRTG y los datos del agente. Se actualiza cada minuto.
          </p>
        </div>
        {esAdmin && !editando && <button className="btn-primary" onClick={() => setEditando({ ...SERVIDOR_VACIO })}>Agregar servidor</button>}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}

      {editando && (
        <ServidorForm
          key={editando.id ?? "nuevo"}
          inicial={{ ...SERVIDOR_VACIO, ...editando }}
          datos={datos}
          ocupados={vinculados.filter((v) => v !== editando.dispositivo_id)}
          onCancelar={() => setEditando(null)}
          onListo={() => { setEditando(null); recargar(); }}
        />
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {tarjetas.map((c) => (
          <button key={c.k} onClick={() => setFiltro(filtro === c.k && c.k !== "todos" ? "todos" : c.k)} aria-pressed={filtro === c.k}
            className={`card p-5 text-left transition-colors ${filtro === c.k ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{c.t}</div>
            <div className={`font-display text-3xl mt-1 ${c.rojo && c.n ? "text-red-600" : "text-ink"}`}>{c.n}</div>
          </button>
        ))}
      </div>

      {prtgViejo && (
        <p className="text-sm text-amber-700 bg-amber-500/10 rounded-md px-3 py-2">
          PRTG no envía datos hace {haceHoras(datos!.prtg!.actualizado, ahora).replace("hace ", "")}: el estado de disponibilidad puede estar desactualizado.
          Revisá el puente en la solapa Red.
        </p>
      )}

      {esAdmin && candidatos.length > 0 && (
        <div className="card p-5">
          <h2 className="font-medium text-ink">Posibles servidores sin agregar</h2>
          <p className="text-sm text-ink/60 mt-1">Equipos con agente y sistema operativo de servidor que todavía no están en la lista.</p>
          <ul className="mt-3 divide-y divide-line/[0.06]">
            {candidatos.slice(0, 8).map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span><span className="font-medium text-ink">{d.hostname}</span> <span className="text-ink/50">· {d.so_nombre}{d.ip ? ` · ${d.ip}` : ""}</span></span>
                <button className="btn-secondary py-1" onClick={() => agregarDesde(d)}>Agregar</button>
              </li>
            ))}
          </ul>
          {candidatos.length > 8 && <p className="text-xs text-ink/50 mt-2">Y {candidatos.length - 8} más.</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <input className="input max-w-xs" placeholder="Buscar por nombre, rol, IP, responsable…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar servidor" />
        {filtro !== "todos" && <button className="text-sm text-ink/50 hover:text-ink" onClick={() => setFiltro("todos")}>Ver todos</button>}
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Servidor</th><th>Criticidad</th><th>Estado</th><th>RAM</th><th>Disco más lleno</th><th>Encendido</th></tr></thead>
          <tbody>
            {cargando && <tr><td colSpan={6} className="text-center text-ink/40 py-10">Cargando…</td></tr>}
            {!cargando && lista.length === 0 && (
              <tr><td colSpan={6} className="text-center text-ink/40 py-10">
                {servidores.length ? "Ningún servidor en esta situación." : esAdmin ? "Todavía no hay servidores. Tocá “Agregar servidor” o agregá uno de los detectados." : "Todavía no hay servidores cargados."}
              </td></tr>
            )}
            {lista.map((f) => (
              <Fragment key={f.id}>
                <tr className={`cursor-pointer hover:bg-line/[0.02] ${f.activo ? "" : "opacity-50"}`} onClick={() => setAbierto(abierto === f.id ? null : f.id)}
                  aria-expanded={abierto === f.id}>
                  <td>
                    <div className="font-medium text-ink">{f.nombre}{!f.activo && <span className="text-xs text-ink/50 font-normal"> · fuera de servicio</span>}</div>
                    <div className="text-xs text-ink/50">{[f.rol, ENTORNO[f.entorno], f.disp?.ip ?? f.prtg?.host].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td><span className={`pill ${CRITICIDAD[f.criticidad].c}`}>{CRITICIDAD[f.criticidad].t}</span></td>
                  <td>
                    <span className={`pill ${ESTADO[f.estado].c}`}>{ESTADO[f.estado].t}</span>
                    {f.motivo && <div className="text-xs text-ink/60 mt-0.5">{f.motivo}</div>}
                  </td>
                  <td className="text-sm text-ink/70 whitespace-nowrap">{usoRam(f.disp) != null ? `${usoRam(f.disp)}% de ${f.disp!.ram_total_gb} GB` : "—"}</td>
                  <td>{discoMasLleno(f) ? <BarraDisco d={discoMasLleno(f)!} /> : <span className="text-ink/40">—</span>}</td>
                  <td className="text-sm text-ink/60 whitespace-nowrap">{f.disp ? encendidoDesde(f.disp.arranque) : "—"}</td>
                </tr>
                {abierto === f.id && (
                  <tr><td colSpan={6} className="bg-line/[0.02]"><Detalle f={f} ahora={ahora} esAdmin={esAdmin} onEditar={() => {
                    setEditando(servidores.find((s) => s.id === f.id) ?? null); window.scrollTo({ top: 0, behavior: "smooth" });
                  }} /></td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Caído y con alertas salen de PRTG; sin reportar, de que el agente no envía datos hace más de 12 minutos. Tocá un servidor para ver el detalle.
      </p>
    </div>
  );
}

function discoMasLleno(f: Fila) {
  const discos = f.disp?.discos ?? [];
  if (!discos.length) return null;
  return [...discos].sort((a, b) => (b.total_gb ? (b.total_gb - b.libre_gb) / b.total_gb : 0) - (a.total_gb ? (a.total_gb - a.libre_gb) / a.total_gb : 0))[0];
}

function Detalle({ f, ahora, esAdmin, onEditar }: { f: Fila; ahora: number; esAdmin: boolean; onEditar: () => void }) {
  return (
    <div className="grid md:grid-cols-3 gap-5 py-2">
      <div className="space-y-1 text-sm">
        <h3 className="font-medium text-ink mb-1">Ficha</h3>
        <Dato t="Responsable" v={f.responsable} />
        <Dato t="Sede" v={f.sede} />
        <Dato t="Sistema operativo" v={f.so} />
        {f.disp && <Dato t="Hardware" v={[f.disp.fabricante, f.disp.modelo].filter(Boolean).join(" ") || null} />}
        {f.disp && <Dato t="Procesador" v={f.disp.procesador ? `${f.disp.procesador}${f.disp.nucleos ? ` · ${f.disp.nucleos} núcleos` : ""}` : null} />}
        {f.disp?.equipo_id && <Link href={`/inventario/equipos/${f.disp.equipo_id}`} className="text-xs text-brand-700 hover:underline">Ver en Inventario IT</Link>}
        {f.notas && <p className="text-ink/70 whitespace-pre-line pt-1">{f.notas}</p>}
        {esAdmin && <button className="btn-secondary mt-3" onClick={onEditar}>Editar</button>}
      </div>

      <div className="space-y-2 text-sm">
        <h3 className="font-medium text-ink mb-1">Agente</h3>
        {!f.disp ? <p className="text-ink/50">Sin agente vinculado.</p> : (
          <>
            <Dato t="Equipo" v={`${f.disp.hostname ?? "—"}${f.disp.agente_version ? ` · agente ${f.disp.agente_version}` : ""}`} />
            <Dato t="Último reporte" v={haceHoras(f.disp.ultimo_reporte, ahora)} />
            <Dato t="Antivirus" v={f.disp.antivirus_activo == null ? null : f.disp.antivirus_activo ? "Activo" : "Inactivo"} alerta={f.disp.antivirus_activo === false} />
            <div className="space-y-2 pt-1">{(f.disp.discos ?? []).map((d) => <BarraDisco key={d.unidad} d={d} />)}</div>
          </>
        )}
      </div>

      <div className="space-y-2 text-sm">
        <h3 className="font-medium text-ink mb-1">PRTG</h3>
        {!f.prtg ? <p className="text-ink/50">{f.prtg_objid ? "El equipo vinculado ya no aparece en PRTG." : "Sin vincular a PRTG."}</p> : (
          <>
            <Dato t="Equipo" v={`${f.prtg.nombre}${f.prtg.grupo ? ` · ${f.prtg.grupo}` : ""}`} />
            <Dato t="Sensores" v={`${f.prtg.ok} OK · ${f.prtg.advertencia} advertencia · ${f.prtg.caido} caídos (de ${f.prtg.total})`} alerta={f.prtg.caido > 0} />
            {f.sensores.length > 0 ? (
              <ul className="space-y-1.5 pt-1">
                {f.sensores.map((s) => (
                  <li key={s.objid} className="text-xs">
                    <span className={`pill mr-1 ${s.estado === "caido" ? "bg-red-50 text-red-600" : "bg-amber-500/10 text-amber-700"}`}>{s.estado === "caido" ? "Caído" : "Advertencia"}</span>
                    <span className="text-ink">{s.nombre}</span>
                    {s.mensaje && <span className="text-ink/50"> · {s.mensaje}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-ink/50">Ningún sensor con problemas.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function Dato({ t, v, alerta }: { t: string; v: string | null | undefined; alerta?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-ink/50 shrink-0 w-32">{t}</span>
      <span className={alerta ? "text-red-600 font-medium" : "text-ink/80"}>{v || "—"}</span>
    </div>
  );
}

