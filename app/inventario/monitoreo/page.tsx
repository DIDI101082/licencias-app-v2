"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import BarraDisco from "@/components/BarraDisco";
import { textoUbicacion, ATRIBUCION_GEO } from "@/lib/geo";
import { conectado, hace, discoCritico, encendidoDesde, MINUTOS_CONECTADO, type Disco } from "@/lib/monitoreo";
import { claseCodigo } from "@/lib/inventario";

type Dispositivo = Record<string, any> & { discos: Disco[]; ultimo_reporte: string };

export default function Monitoreo() {
  const { esAdmin } = usePerfil();
  const [todos, setTodos] = useState<Dispositivo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ahora, setAhora] = useState(Date.now());
  const [filtro, setFiltro] = useState<"todos" | "conectados" | "desconectados" | "disco" | "sin_vincular">("todos");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sb = createClient();
    const cargar = () =>
      sb.from("inv_dispositivos").select("*, inv_equipos(id, codigo), inv_codigos_instalacion(descripcion)").order("hostname")
        .then(({ data }) => { setTodos((data ?? []) as Dispositivo[]); setCargando(false); });
    cargar();

    // Cada reporte nuevo de un agente llega acá sin recargar la página
    const canal = sb
      .channel("inv-dispositivos")
      .on("postgres_changes", { event: "*", schema: "public", table: "inv_dispositivos" }, () => cargar())
      .subscribe();
    const reloj = setInterval(() => setAhora(Date.now()), 30000);
    return () => { sb.removeChannel(canal); clearInterval(reloj); };
  }, []);

  // Solo los equipos aprobados cuentan; los pendientes y bloqueados se muestran aparte (solo admin)
  const lista = useMemo(() => todos.filter((d) => d.estado_registro === "aprobado"), [todos]);
  const pendientes = todos.filter((d) => d.estado_registro === "pendiente");
  const bloqueados = todos.filter((d) => d.estado_registro === "bloqueado");

  async function cambiarRegistro(d: Dispositivo, estado: "aprobado" | "pendiente" | "bloqueado") {
    setError(null);
    if (estado === "bloqueado" && !confirm(`¿Bloquear ${d.hostname}? El agente de ese equipo no va a poder reportar más.`)) return;
    const { error } = await createClient().from("inv_dispositivos").update({ estado_registro: estado }).eq("id", d.id);
    if (error) setError(error.message);
  }

  async function restablecerClave(d: Dispositivo) {
    if (!confirm(`¿Restablecer la clave de ${d.hostname}? Usalo solo si reinstalaste el agente desde cero en ese equipo: durante las próximas 24 horas, el primer reporte de este equipo recibe una clave nueva.`)) return;
    const { error } = await createClient().from("inv_dispositivos").update({ secreto_hash: null, clave_confirmada: false, clave_restablecida_hasta: new Date(Date.now() + 86400000).toISOString() }).eq("id", d.id);
    if (error) setError(error.message);
  }

  const cuentas = useMemo(() => ({
    conectados: lista.filter((d) => conectado(d.ultimo_reporte, ahora)).length,
    desconectados: lista.filter((d) => !conectado(d.ultimo_reporte, ahora)).length,
    disco: lista.filter((d) => discoCritico(d.discos)).length,
    sin_vincular: lista.filter((d) => !d.equipo_id).length,
  }), [lista, ahora]);

  const filtrados = lista.filter((d) => {
    const on = conectado(d.ultimo_reporte, ahora);
    if (filtro === "conectados" && !on) return false;
    if (filtro === "desconectados" && on) return false;
    if (filtro === "disco" && !discoCritico(d.discos)) return false;
    if (filtro === "sin_vincular" && d.equipo_id) return false;
    const q = texto.trim().toLowerCase();
    return !q || [d.hostname, d.usuario, d.ip, d.numero_serie, d.modelo, d.so_nombre, d.inv_equipos?.codigo]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });

  async function crearEnInventario(d: Dispositivo) {
    setError(null);
    const sb = createClient();
    const categoria = d.bateria_pct != null ? "Notebook" : "PC de escritorio";
    const { data: cat } = await sb.from("inv_categorias").select("id").eq("nombre", categoria).single();
    if (!cat) return setError(`No existe la categoría “${categoria}”.`);
    const { data: eq, error } = await sb.from("inv_equipos").insert({
      categoria_id: cat.id, marca: d.fabricante, modelo: d.modelo, numero_serie: d.numero_serie,
      estado: "en_stock", hostname: d.hostname, ip: d.ip, mac: d.mac, procesador: d.procesador,
      ram_gb: d.ram_total_gb ? Math.round(d.ram_total_gb) : null, almacenamiento: d.almacenamiento,
      sistema_operativo: d.so_nombre,
    }).select("id").single();
    if (error) {
      return setError(error.code === "23505"
        ? `Ya hay un equipo con el N° de serie ${d.numero_serie}. Va a quedar vinculado solo en el próximo reporte.`
        : error.message);
    }
    await sb.from("inv_dispositivos").update({ equipo_id: eq.id }).eq("id", d.id);
  }

  async function quitar(d: Dispositivo) {
    if (!confirm(`¿Quitar ${d.hostname} del monitoreo? Si el agente sigue instalado, va a volver a aparecer en el próximo reporte.`)) return;
    await createClient().from("inv_dispositivos").delete().eq("id", d.id);
  }

  const tarjetas = [
    { k: "conectados", t: "Conectados", n: cuentas.conectados, c: "text-emerald-600" },
    { k: "desconectados", t: "Desconectados", n: cuentas.desconectados, c: "text-ink" },
    { k: "disco", t: "Disco casi lleno", n: cuentas.disco, c: cuentas.disco ? "text-red-600" : "text-ink" },
    { k: "sin_vincular", t: "Sin cargar en inventario", n: cuentas.sin_vincular, c: "text-ink" },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Monitoreo</h1>
          <p className="text-ink/60 text-sm mt-1">
            Datos que envía el agente instalado en cada equipo. Se considera conectado si reportó en los últimos {MINUTOS_CONECTADO} minutos.
          </p>
        </div>
        {esAdmin && <Link href="/inventario/monitoreo/agente" className="btn-secondary">Instalar agente</Link>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {tarjetas.map((t) => (
          <button key={t.k} onClick={() => setFiltro(filtro === t.k ? "todos" : t.k)} aria-pressed={filtro === t.k}
            className={`card p-5 text-left transition-colors ${filtro === t.k ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 ${t.c}`}>{t.n}</div>
          </button>
        ))}
      </div>

      {esAdmin && pendientes.length > 0 && (
        <div className="card p-5 border-2 border-amber-500/50 space-y-3" role="region" aria-label="Equipos pendientes de aprobación">
          <div>
            <h2 className="font-medium text-ink">Equipos pendientes de aprobación ({pendientes.length})</h2>
            <p className="text-sm text-ink/60 mt-1">
              Instalaron el agente pero todavía no aparecen en ninguna pantalla ni guardan datos. Aprobá solo los que reconozcas; si alguno no
              es de la empresa, bloquealo y revisá desde qué IP se registró.
            </p>
          </div>
          <ul className="divide-y divide-line/[0.06]">
            {pendientes.map((d) => (
              <li key={d.id} className="py-3 flex items-start justify-between gap-4 flex-wrap">
                <div className="text-sm min-w-0">
                  <div className="font-medium text-ink">{d.hostname}</div>
                  <div className="text-ink/60">
                    {d.usuario ?? "Sin sesión"} · dominio {d.dominio ?? "—"} · {[d.fabricante, d.modelo].filter(Boolean).join(" ") || "modelo desconocido"}
                    {d.numero_serie ? ` · S/N ${d.numero_serie}` : ""}
                  </div>
                  <div className="text-xs text-ink/50">
                    Se registró el {new Date(d.primer_reporte).toLocaleString("es-AR")} desde la IP pública {d.ip_registro ?? "desconocida"}
                    {d.ip ? ` (IP local ${d.ip})` : ""}
                    {d.inv_codigos_instalacion ? ` · con el instalador "${d.inv_codigos_instalacion.descripcion}"` : ""}
                    {textoUbicacion(d) ? ` · ${textoUbicacion(d)}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="btn-primary" onClick={() => cambiarRegistro(d, "aprobado")}>Aprobar</button>
                  <button className="btn-secondary text-red-600" onClick={() => cambiarRegistro(d, "bloqueado")}>Bloquear</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {esAdmin && bloqueados.length > 0 && (
        <details className="card p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink">Equipos bloqueados ({bloqueados.length})</summary>
          <ul className="mt-3 divide-y divide-line/[0.06]">
            {bloqueados.map((d) => (
              <li key={d.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                <span>
                  <b>{d.hostname}</b> <span className="text-ink/50">{d.usuario ?? ""} · IP de registro {d.ip_registro ?? "desconocida"}</span>
                </span>
                <span className="flex gap-3">
                  <button className="text-brand-600 hover:underline" onClick={() => cambiarRegistro(d, "pendiente")}>Desbloquear</button>
                  <button className="text-ink/50 hover:text-red-600 hover:underline" onClick={() => quitar(d)}>Eliminar</button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <input type="search" className="input" placeholder="Buscar por equipo, usuario, IP, serie, modelo o código IT…"
        value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead>
            <tr><th>Equipo</th><th>Inventario</th><th>Sistema</th><th>RAM</th><th>Discos</th><th>Último reporte</th></tr>
          </thead>
          <tbody>
            {filtrados.map((d) => {
              const on = conectado(d.ultimo_reporte, ahora);
              const ramUso = d.ram_total_gb ? Math.round(((d.ram_total_gb - d.ram_libre_gb) / d.ram_total_gb) * 100) : null;
              return (
                <Fragment key={d.id}>
                  <tr className="hover:bg-line/[0.015] cursor-pointer" onClick={() => setAbierto(abierto === d.id ? null : d.id)}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${on ? "bg-emerald-500" : "bg-line/20"}`}
                          aria-label={on ? "Conectado" : "Desconectado"} title={on ? "Conectado" : "Desconectado"} />
                        <button className="font-medium text-ink hover:underline text-left" aria-expanded={abierto === d.id}>
                          {d.hostname}
                        </button>
                      </div>
                      <div className="text-xs text-ink/50 pl-[18px]">{d.usuario ?? "Sin sesión iniciada"}{d.ip ? ` · ${d.ip}` : ""}</div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {d.inv_equipos ? (
                        <Link href={`/inventario/equipos/${d.inv_equipos.id}`} className={claseCodigo(d.inv_equipos.codigo)}>{d.inv_equipos.codigo}</Link>
                      ) : esAdmin ? (
                        <button className="text-sm text-brand-600 hover:underline" onClick={() => crearEnInventario(d)}>Cargar en inventario</button>
                      ) : (
                        <span className="text-xs text-ink/40">Sin cargar</span>
                      )}
                    </td>
                    <td className="text-ink/70">
                      {d.so_nombre?.replace("Microsoft ", "")}
                      <div className="text-xs text-ink/50">{[d.so_version, d.so_build && `build ${d.so_build}`].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="whitespace-nowrap">
                      {d.ram_total_gb} GB
                      {ramUso != null && <div className={`text-xs ${ramUso >= 90 ? "text-red-600" : "text-ink/50"}`}>{ramUso}% en uso</div>}
                    </td>
                    <td><div className="space-y-1.5">{(d.discos ?? []).map((x) => <BarraDisco key={x.unidad} d={x} />)}</div></td>
                    <td className={`whitespace-nowrap ${on ? "text-emerald-700" : "text-ink/50"}`}>{hace(d.ultimo_reporte, ahora)}</td>
                  </tr>
                  {abierto === d.id && (
                    <tr>
                      <td colSpan={6} className="bg-canvas">
                        <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-sm py-1">
                          <div><dt className="text-ink/50 text-xs">Fabricante y modelo</dt><dd>{d.fabricante} {d.modelo}</dd></div>
                          <div><dt className="text-ink/50 text-xs">N° de serie</dt><dd>{d.numero_serie ?? "—"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Procesador</dt><dd>{d.procesador}{d.nucleos ? ` · ${d.nucleos} núcleos` : ""}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Arquitectura</dt><dd>{d.so_arquitectura ?? "—"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Encendido hace</dt><dd>{encendidoDesde(d.arranque)}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Batería</dt><dd>{d.bateria_pct != null ? `${d.bateria_pct}%` : "Sin batería"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Antivirus</dt>
                            <dd className={(Array.isArray(d.av_productos) ? !d.av_productos.some((p: any) => p.activo) : d.antivirus_activo === false) ? "text-red-600" : ""}>
                              {Array.isArray(d.av_productos)
                                ? (d.av_productos.filter((p: any) => p.activo).map((p: any) => p.nombre).join(", ") || "Sin antivirus activo")
                                : d.antivirus_activo == null ? "Sin datos" : d.antivirus_activo ? "Activo" : "Desactivado"}
                            </dd>
                          </div>
                          <div><dt className="text-ink/50 text-xs">MAC</dt><dd>{d.mac ?? "—"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Dominio</dt><dd>{d.dominio ?? "—"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Reporta desde</dt><dd>{new Date(d.primer_reporte).toLocaleDateString("es-AR")}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Versión del agente</dt><dd>{d.agente_version ?? "—"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Aplicaciones</dt>
                            <dd>
                              {d.apps_cantidad != null
                                ? <Link href={`/inventario/aplicaciones?vista=equipo&equipo=${d.id}`} className="text-brand-600 hover:underline">Ver las {d.apps_cantidad} instaladas</Link>
                                : <span className="text-ink/50">Requiere agente 1.1</span>}
                            </dd>
                          </div>
                          <div><dt className="text-ink/50 text-xs">IP pública</dt><dd>{d.ip_publica ?? "—"}</dd></div>
                          <div className="md:col-span-2">
                            <dt className="text-ink/50 text-xs">Ubicación aproximada</dt>
                            <dd>
                              {textoUbicacion(d) ?? "Sin datos todavía"}
                              {textoUbicacion(d) && (
                                <a href={ATRIBUCION_GEO.url} target="_blank" rel="noopener noreferrer" className="block text-[11px] text-ink/40 underline">{ATRIBUCION_GEO.texto}</a>
                              )}
                            </dd>
                          </div>
                          {esAdmin && (
                            <div className="flex flex-col items-start justify-end gap-1">
                              <button className="text-sm text-ink/50 hover:text-brand-600 hover:underline" onClick={() => restablecerClave(d)}>Restablecer clave del equipo</button>
                              <button className="text-sm text-ink/50 hover:text-red-600 hover:underline" onClick={() => cambiarRegistro(d, "bloqueado")}>Bloquear</button>
                              <button className="text-sm text-ink/50 hover:text-red-600 hover:underline" onClick={() => quitar(d)}>Quitar del monitoreo</button>
                            </div>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!cargando && filtrados.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-ink/40 py-10">
                  {lista.length === 0
                    ? esAdmin
                      ? <>Todavía ningún equipo reportó. <Link href="/inventario/monitoreo/agente" className="text-brand-600 hover:underline">Instalá el agente</Link> en una PC para empezar.</>
                      : "Todavía ningún equipo reportó."
                    : "Ningún equipo coincide con el filtro."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
