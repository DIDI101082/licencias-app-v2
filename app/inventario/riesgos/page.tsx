"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { fecha } from "@/lib/inventario";
import { hace } from "@/lib/monitoreo";
import { soporteWindows, estadoAmenaza, archivoAmenaza, SEVERIDAD, SUGERIDOS, DIAS_AVISO_SOPORTE } from "@/lib/riesgos";

type Vista = "amenazas" | "sistemas" | "prohibido";

function Tarjeta({ titulo, n, activa, onClick, peligro = true }: { titulo: string; n: number; activa?: boolean; onClick?: () => void; peligro?: boolean }) {
  return (
    <button onClick={onClick} aria-pressed={activa} disabled={!onClick}
      className={`card p-5 text-left transition-colors ${activa ? "border-brand-500 ring-2 ring-brand-500/20" : onClick ? "hover:border-brand-300" : ""}`}>
      <div className="text-xs text-ink/50 font-medium">{titulo}</div>
      <div className={`font-display text-3xl mt-1 ${n && peligro ? "text-red-600" : n ? "text-ink" : "text-emerald-600"}`}>{n}</div>
    </button>
  );
}

function csv(nombre: string, cab: string[], filas: any[][]) {
  const esc = (v: any) => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + [cab, ...filas].map((f) => f.map(esc).join(";")).join("\n")], { type: "text/csv;charset=utf-8" }));
  a.download = nombre;
  a.click();
}

// ---------------- Amenazas ----------------
function Amenazas() {
  const { puedeEditar } = usePerfil();
  const [amenazas, setAmenazas] = useState<any[]>([]);
  const [disp, setDisp] = useState<any[]>([]);
  const [cargando, setCargando] = useState(true);
  const [filtro, setFiltro] = useState<"pendientes" | "30dias" | "todas">("pendientes");
  const [verRevisadas, setVerRevisadas] = useState(false);
  const [verDefender, setVerDefender] = useState<"alteraciones" | "escaneo" | null>(null);

  const cargar = () => {
    const sb = createClient();
    Promise.all([
      sb.from("inv_amenazas").select("*, inv_dispositivos(id, hostname, usuario)").order("detectada", { ascending: false }).limit(500),
      sb.from("inv_dispositivos").select("id, hostname, usuario, av_productos, av_escaneo_rapido, av_escaneo_completo, av_proteccion_alteraciones, seguridad_actualizado"),
    ]).then(([a, d]) => { setAmenazas(a.data ?? []); setDisp(d.data ?? []); setCargando(false); });
  };
  useEffect(cargar, []);

  const hace30 = Date.now() - 30 * 86400000;
  const pendientes = amenazas.filter((a) => estadoAmenaza(a.estado_id).tipo !== "resuelta" && !a.revisada);
  const ult30 = amenazas.filter((a) => new Date(a.detectada).getTime() > hace30);
  const equipos30 = new Set(ult30.map((a) => a.dispositivo_id)).size;

  const conDefender = disp.filter((d) => d.seguridad_actualizado && (d.av_productos ?? []).some((p: any) => /defender/i.test(p.nombre) && p.activo));
  const sinAlteraciones = conDefender.filter((d) => d.av_proteccion_alteraciones === false);
  const ultimoEscaneo = (d: any) => Math.max(d.av_escaneo_rapido ? new Date(d.av_escaneo_rapido).getTime() : 0, d.av_escaneo_completo ? new Date(d.av_escaneo_completo).getTime() : 0);
  const sinEscaneo = conDefender.filter((d) => ultimoEscaneo(d) < Date.now() - 7 * 86400000);

  const filas = (filtro === "pendientes" ? pendientes : filtro === "30dias" ? ult30 : amenazas)
    .filter((a) => filtro === "pendientes" || verRevisadas || !a.revisada || estadoAmenaza(a.estado_id).tipo === "resuelta");

  async function marcarRevisada(id: number, valor: boolean) {
    await createClient().from("inv_amenazas").update({ revisada: valor }).eq("id", id);
    cargar();
  }

  const listaDefender = verDefender === "alteraciones" ? sinAlteraciones : verDefender === "escaneo" ? sinEscaneo : [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Tarjeta titulo="Sin resolver" n={pendientes.length} activa={filtro === "pendientes"} onClick={() => setFiltro("pendientes")} />
        <Tarjeta titulo="Detecciones en 30 días" n={ult30.length} activa={filtro === "30dias"} onClick={() => setFiltro("30dias")} peligro={false} />
        <Tarjeta titulo="Equipos afectados en 30 días" n={equipos30} peligro={false} />
        <Tarjeta titulo="Protección contra alteraciones apagada" n={sinAlteraciones.length} activa={verDefender === "alteraciones"}
          onClick={() => setVerDefender(verDefender === "alteraciones" ? null : "alteraciones")} />
        <Tarjeta titulo="Sin escaneo en 7 días" n={sinEscaneo.length} activa={verDefender === "escaneo"}
          onClick={() => setVerDefender(verDefender === "escaneo" ? null : "escaneo")} />
      </div>

      {verDefender && (
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-2">
            {verDefender === "alteraciones" ? "Equipos con la protección contra alteraciones apagada" : "Equipos sin escaneo de Defender en los últimos 7 días"}
          </h2>
          <p className="text-sm text-ink/60 mb-3">
            {verDefender === "alteraciones"
              ? "Sin esta protección, un usuario o un malware con permisos de administrador puede apagar Defender. Se activa desde Seguridad de Windows o de forma centralizada con Intune."
              : "Defender debería hacer al menos un escaneo rápido por semana. Suele pasar en equipos que están siempre apagados fuera de horario."}
          </p>
          {listaDefender.length === 0 ? <p className="text-sm text-emerald-700">Ningún equipo en esta situación.</p> : (
            <ul className="text-sm space-y-1">
              {listaDefender.map((d) => (
                <li key={d.id}>
                  <b>{d.hostname}</b> <span className="text-ink/50">{d.usuario ?? ""}</span>
                  {verDefender === "escaneo" && <span className="text-ink/50"> · último escaneo: {ultimoEscaneo(d) ? hace(new Date(ultimoEscaneo(d)).toISOString()) : "nunca"}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1">
          {([["pendientes", "Sin resolver"], ["30dias", "Últimos 30 días"], ["todas", "Todas (90 días)"]] as const).map(([k, t]) => (
            <button key={k} onClick={() => setFiltro(k)} aria-pressed={filtro === k}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${filtro === k ? "bg-white text-brand-700 shadow-sm" : "text-ink/60 hover:text-ink"}`}>{t}</button>
          ))}
        </div>
        <div className="flex gap-3 items-center">
          {filtro !== "pendientes" && (
            <label className="text-sm text-ink/60 flex items-center gap-2">
              <input type="checkbox" checked={verRevisadas} onChange={(e) => setVerRevisadas(e.target.checked)} /> Incluir revisadas
            </label>
          )}
          <button className="btn-secondary" disabled={!filas.length}
            onClick={() => csv("amenazas-defender.csv", ["Detectada", "Equipo", "Usuario", "Amenaza", "Severidad", "Estado", "Archivo", "Proceso", "Revisada"],
              filas.map((a) => [new Date(a.detectada).toLocaleString("es-AR"), a.inv_dispositivos?.hostname, a.usuario, a.nombre,
                SEVERIDAD[a.severidad ?? 0]?.texto, estadoAmenaza(a.estado_id).texto, archivoAmenaza(a.recursos), a.proceso, a.revisada ? "Sí" : "No"]))}>
            Exportar a Excel
          </button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Detectada</th><th>Equipo</th><th>Amenaza</th><th>Estado</th><th>Archivo</th>{puedeEditar && <th></th>}</tr></thead>
          <tbody>
            {filas.map((a) => {
              const est = estadoAmenaza(a.estado_id);
              const sev = SEVERIDAD[a.severidad ?? 0] ?? SEVERIDAD[0];
              return (
                <tr key={a.id} className={a.revisada ? "opacity-60" : ""}>
                  <td className="whitespace-nowrap text-ink/70">{new Date(a.detectada).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>
                    <span className="font-medium text-ink">{a.inv_dispositivos?.hostname}</span>
                    <div className="text-xs text-ink/50">{a.usuario || a.inv_dispositivos?.usuario || ""}</div>
                  </td>
                  <td>
                    <div className="text-ink break-all">{a.nombre ?? "Amenaza sin nombre"}</div>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      <span className={`pill ${sev.clase}`}>{sev.texto}</span>
                      {a.ejecutada && <span className="pill bg-red-600 text-white">Llegó a ejecutarse</span>}
                    </div>
                  </td>
                  <td><span className={`pill ${est.clase}`}>{est.texto}</span></td>
                  <td className="text-xs text-ink/60 max-w-[280px] break-all">
                    {archivoAmenaza(a.recursos)}
                    {a.proceso && a.proceso !== "Unknown" && <div className="text-ink/40 mt-0.5">Vía {a.proceso.split("\\").pop()}</div>}
                  </td>
                  {puedeEditar && (
                    <td className="text-right whitespace-nowrap">
                      {est.tipo !== "resuelta" && (
                        <button className="text-sm text-brand-600 hover:underline" onClick={() => marcarRevisada(a.id, !a.revisada)}>
                          {a.revisada ? "Reabrir" : "Marcar revisada"}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={6} className="text-center py-10">
                <span className={filtro === "pendientes" ? "text-emerald-700" : "text-ink/40"}>
                  {filtro === "pendientes" ? "No hay amenazas sin resolver." : "Sin detecciones en este período."}
                </span>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        “Sin resolver” incluye amenazas que Defender no pudo eliminar o que un usuario permitió. Las que Defender puso en cuarentena o eliminó
        se consideran resueltas. Marcá como revisada una amenaza cuando ya la hayas investigado.
      </p>
    </div>
  );
}

// ---------------- Sistemas sin soporte ----------------
function Sistemas() {
  const [disp, setDisp] = useState<any[]>([]);
  const [cargando, setCargando] = useState(true);
  const [filtro, setFiltro] = useState<"problema" | "aviso" | null>(null);

  useEffect(() => {
    createClient().from("inv_dispositivos").select("id, hostname, usuario, so_nombre, so_version, so_build, ultimo_reporte, inv_equipos(id, codigo)")
      .order("hostname").then(({ data }) => { setDisp(data ?? []); setCargando(false); });
  }, []);

  const filas = useMemo(() => disp.map((d) => ({ ...d, sp: soporteWindows(d.so_nombre, d.so_version, d.so_build) })), [disp]);
  const orden = { problema: 0, aviso: 1, sin_datos: 2, ok: 3 } as const;
  const visibles = filas.filter((d) => !filtro || d.sp.nivel === filtro).sort((a, b) => orden[a.sp.nivel as keyof typeof orden] - orden[b.sp.nivel as keyof typeof orden]);
  const n = (k: string) => filas.filter((d) => d.sp.nivel === k).length;
  const clase: Record<string, string> = {
    problema: "bg-red-50 text-red-600", aviso: "bg-amber-500/10 text-amber-700", ok: "bg-emerald-50 text-emerald-700", sin_datos: "bg-black/[0.05] text-ink/50",
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <Tarjeta titulo="Sin soporte de Microsoft" n={n("problema")} activa={filtro === "problema"} onClick={() => setFiltro(filtro === "problema" ? null : "problema")} />
        <Tarjeta titulo={`El soporte vence en ${DIAS_AVISO_SOPORTE} días`} n={n("aviso")} activa={filtro === "aviso"} onClick={() => setFiltro(filtro === "aviso" ? null : "aviso")} />
        <Tarjeta titulo="Con soporte" n={n("ok")} peligro={false} />
      </div>
      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Equipo</th><th>Sistema</th><th>Soporte</th><th>Qué hacer</th></tr></thead>
          <tbody>
            {visibles.map((d) => (
              <tr key={d.id}>
                <td>
                  <span className="font-medium text-ink">{d.hostname}</span>
                  {d.inv_equipos && <Link href={`/inventario/equipos/${d.inv_equipos.id}`} className="tag-inv ml-2">{d.inv_equipos.codigo}</Link>}
                  <div className="text-xs text-ink/50">{d.usuario ?? ""}</div>
                </td>
                <td className="text-ink/70">
                  {d.so_nombre?.replace("Microsoft ", "")}
                  <div className="text-xs text-ink/50">{[d.so_version, d.so_build && `build ${d.so_build}`].filter(Boolean).join(" · ")}</div>
                </td>
                <td>
                  <span className={`pill ${clase[d.sp.nivel]}`}>{d.sp.texto}</span>
                  {d.sp.fin && <div className="text-xs text-ink/50 mt-1">{d.sp.nivel === "problema" ? "Terminó" : "Hasta"} el {fecha(d.sp.fin)}</div>}
                </td>
                <td className="text-sm text-ink/70 max-w-[320px]">{d.sp.accion}</td>
              </tr>
            ))}
            {!cargando && visibles.length === 0 && <tr><td colSpan={4} className="text-center text-ink/40 py-10">Ningún equipo en esta categoría.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Fechas de fin de soporte publicadas por Microsoft. Windows 10 dejó de recibir parches el 14/10/2025; si contrataste Actualizaciones de
        Seguridad Extendidas (ESU) para algunos equipos, igual aparecen acá, porque esa licencia no se puede detectar desde el equipo.
      </p>
    </div>
  );
}

// ---------------- Software prohibido ----------------
function Prohibido() {
  const { esAdmin } = usePerfil();
  const [reglas, setReglas] = useState<any[]>([]);
  const [hallazgos, setHallazgos] = useState<any[]>([]);
  const [nuevo, setNuevo] = useState({ patron: "", motivo: "" });
  const [error, setError] = useState<string | null>(null);
  const [verReglas, setVerReglas] = useState(false);

  const cargar = () => {
    const sb = createClient();
    Promise.all([
      sb.from("inv_software_prohibido").select("*").order("patron"),
      sb.from("inv_v_software_prohibido").select("*").order("hostname"),
    ]).then(([r, h]) => { setReglas(r.data ?? []); setHallazgos(h.data ?? []); });
  };
  useEffect(cargar, []);

  async function agregar(lista: { patron: string; motivo: string }[]) {
    setError(null);
    const { error } = await createClient().from("inv_software_prohibido").upsert(lista, { onConflict: "patron", ignoreDuplicates: true });
    if (error) return setError(error.message);
    setNuevo({ patron: "", motivo: "" });
    cargar();
  }
  async function quitar(id: number) {
    await createClient().from("inv_software_prohibido").delete().eq("id", id);
    cargar();
  }

  const equipos = new Set(hallazgos.map((h) => h.dispositivo_id)).size;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <Tarjeta titulo="Instalaciones de software prohibido" n={hallazgos.length} />
        <Tarjeta titulo="Equipos afectados" n={equipos} />
        <Tarjeta titulo="Reglas activas" n={reglas.length} peligro={false} onClick={() => setVerReglas(!verReglas)} activa={verReglas} />
      </div>

      {(verReglas || reglas.length === 0) && (
        <div className="card p-5 space-y-3">
          <div>
            <h2 className="font-medium text-ink">Lista de software prohibido</h2>
            <p className="text-sm text-ink/60 mt-1">
              Se marca toda aplicación cuyo nombre contenga el texto de la regla, sin importar mayúsculas. Por ejemplo, “torrent” encuentra
              uTorrent, BitTorrent y qBittorrent.
            </p>
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
          {reglas.length === 0 && !esAdmin && <p className="text-sm text-ink/50">Todavía no hay reglas cargadas.</p>}
          {reglas.length > 0 && (
            <ul className="divide-y divide-black/[0.05]">
              {reglas.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span><b>{r.patron}</b>{r.motivo && <span className="text-ink/60"> · {r.motivo}</span>}</span>
                  {esAdmin && <button className="text-ink/40 hover:text-red-600 text-sm" onClick={() => quitar(r.id)}>Quitar</button>}
                </li>
              ))}
            </ul>
          )}
          {esAdmin && (
            <>
              <form className="flex gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); if (nuevo.patron.trim()) agregar([{ patron: nuevo.patron.trim(), motivo: nuevo.motivo.trim() }]); }}>
                <input className="input w-48" placeholder="Nombre o parte del nombre" value={nuevo.patron} onChange={(e) => setNuevo({ ...nuevo, patron: e.target.value })} />
                <input className="input flex-1 min-w-[200px]" placeholder="Motivo (opcional)" value={nuevo.motivo} onChange={(e) => setNuevo({ ...nuevo, motivo: e.target.value })} />
                <button className="btn-secondary">Agregar regla</button>
              </form>
              <button className="text-sm text-brand-600 hover:underline" onClick={() => agregar(SUGERIDOS.map(([patron, motivo]) => ({ patron, motivo })))}>
                Agregar la lista sugerida ({SUGERIDOS.length} reglas: accesos remotos, torrents, VPN gratuitas y activadores piratas)
              </button>
            </>
          )}
        </div>
      )}

      {reglas.length > 0 && (
        <>
          <div className="flex justify-end">
            <button className="btn-secondary" disabled={!hallazgos.length}
              onClick={() => csv("software-prohibido.csv", ["Equipo", "Usuario", "Aplicación", "Versión", "Regla", "Motivo", "Detectada desde"],
                hallazgos.map((h) => [h.hostname, h.usuario, h.aplicacion, h.version, h.patron, h.motivo, fecha(h.primera_vez)]))}>
              Exportar a Excel
            </button>
          </div>
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Equipo</th><th>Aplicación</th><th>Motivo</th><th>Detectada desde</th></tr></thead>
              <tbody>
                {hallazgos.map((h, i) => (
                  <tr key={i}>
                    <td>
                      <Link href={`/inventario/aplicaciones?vista=equipo&equipo=${h.dispositivo_id}`} className="font-medium text-brand-600 hover:underline">{h.hostname}</Link>
                      <div className="text-xs text-ink/50">{h.usuario ?? ""}</div>
                    </td>
                    <td className="text-ink">{h.aplicacion}<div className="text-xs text-ink/50">{h.version || ""}</div></td>
                    <td className="text-sm text-ink/70">{h.motivo || `Coincide con “${h.patron}”`}</td>
                    <td className="text-ink/60 whitespace-nowrap">{fecha(h.primera_vez)}</td>
                  </tr>
                ))}
                {hallazgos.length === 0 && (
                  <tr><td colSpan={4} className="text-center text-emerald-700 py-10">Ningún equipo tiene software de la lista.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Contenido() {
  const params = useSearchParams();
  const router = useRouter();
  const vista = (params.get("vista") as Vista) || "amenazas";
  const pestañas: [Vista, string][] = [["amenazas", "Amenazas de Defender"], ["sistemas", "Sistemas sin soporte"], ["prohibido", "Software prohibido"]];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Riesgos</h1>
        <p className="text-ink/60 text-sm mt-1">Amenazas detectadas, sistemas operativos sin parches de Microsoft y software no permitido.</p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-black/[0.08]">
        {pestañas.map(([k, t]) => (
          <button key={k} role="tab" aria-selected={vista === k} onClick={() => router.replace(`/inventario/riesgos?vista=${k}`)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${vista === k ? "border-brand-600 text-brand-700" : "border-transparent text-ink/60 hover:text-ink"}`}>
            {t}
          </button>
        ))}
      </div>
      {vista === "amenazas" && <Amenazas />}
      {vista === "sistemas" && <Sistemas />}
      {vista === "prohibido" && <Prohibido />}
    </div>
  );
}

export default function Riesgos() {
  return <Suspense><Contenido /></Suspense>;
}
