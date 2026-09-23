"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import BarraDisco from "@/components/BarraDisco";
import { conectado, hace, discoCritico, encendidoDesde, MINUTOS_CONECTADO, type Disco } from "@/lib/monitoreo";
import { claseCodigo } from "@/lib/inventario";

type Dispositivo = Record<string, any> & { discos: Disco[]; ultimo_reporte: string };

export default function Monitoreo() {
  const { esAdmin } = usePerfil();
  const [lista, setLista] = useState<Dispositivo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ahora, setAhora] = useState(Date.now());
  const [filtro, setFiltro] = useState<"todos" | "conectados" | "desconectados" | "disco" | "sin_vincular">("todos");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sb = createClient();
    const cargar = () =>
      sb.from("inv_dispositivos").select("*, inv_equipos(id, codigo)").order("hostname")
        .then(({ data }) => { setLista((data ?? []) as Dispositivo[]); setCargando(false); });
    cargar();

    // Cada reporte nuevo de un agente llega acá sin recargar la página
    const canal = sb
      .channel("inv-dispositivos")
      .on("postgres_changes", { event: "*", schema: "public", table: "inv_dispositivos" }, () => cargar())
      .subscribe();
    const reloj = setInterval(() => setAhora(Date.now()), 30000);
    return () => { sb.removeChannel(canal); clearInterval(reloj); };
  }, []);

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
                  <tr className="hover:bg-black/[0.015] cursor-pointer" onClick={() => setAbierto(abierto === d.id ? null : d.id)}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${on ? "bg-emerald-500" : "bg-black/20"}`}
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
                      <td colSpan={6} className="bg-[#F5F7FB]">
                        <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-sm py-1">
                          <div><dt className="text-ink/50 text-xs">Fabricante y modelo</dt><dd>{d.fabricante} {d.modelo}</dd></div>
                          <div><dt className="text-ink/50 text-xs">N° de serie</dt><dd>{d.numero_serie ?? "—"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Procesador</dt><dd>{d.procesador}{d.nucleos ? ` · ${d.nucleos} núcleos` : ""}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Arquitectura</dt><dd>{d.so_arquitectura ?? "—"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Encendido hace</dt><dd>{encendidoDesde(d.arranque)}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Batería</dt><dd>{d.bateria_pct != null ? `${d.bateria_pct}%` : "Sin batería"}</dd></div>
                          <div><dt className="text-ink/50 text-xs">Antivirus</dt>
                            <dd className={d.antivirus_activo === false ? "text-red-600" : ""}>
                              {d.antivirus_activo == null ? "Sin datos" : d.antivirus_activo ? "Activo" : "Desactivado"}
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
                          {esAdmin && (
                            <div className="flex items-end">
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
