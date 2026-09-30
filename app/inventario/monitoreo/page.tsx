"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import BarraDisco from "@/components/BarraDisco";
import { textoUbicacion, ATRIBUCION_GEO } from "@/lib/geo";
import { conectado, hace, discoCritico, encendidoDesde, MINUTOS_CONECTADO, tipoEquipo, tipoDeducido, TIPOS_EQUIPO, type Disco, type TipoEquipo } from "@/lib/monitoreo";
import { claseCodigo } from "@/lib/inventario";
import EquiposParaAsignar from "@/components/EquiposParaAsignar";
import EquiposSinAgente from "@/components/EquiposSinAgente";
import { ThFiltro, FiltrosActivos, useFiltrosColumna } from "@/components/FiltroColumna";

type Dispositivo = Record<string, any> & { discos: Disco[]; ultimo_reporte: string };

// Equipos por página en la tabla
const POR_PAGINA = 50;

// Solo las columnas que usa esta pantalla (sin datos pesados de seguridad ni el hash de la clave del agente)
const COLUMNAS = [
  "id", "hostname", "usuario", "dominio", "ip", "mac", "ip_publica", "ip_registro", "numero_serie", "fabricante", "modelo",
  "tipo", "so_nombre", "so_version", "so_build", "so_arquitectura", "procesador", "nucleos", "ram_total_gb", "ram_libre_gb",
  "discos", "almacenamiento", "arranque", "bateria_pct", "antivirus_activo", "av_productos", "agente_version", "apps_cantidad",
  "geo_ciudad", "geo_region", "geo_pais", "geo_pais_codigo", "geo_isp",
  "estado_registro", "asignacion_omitida", "equipo_id", "primer_reporte", "ultimo_reporte",
  "inv_equipos(id, codigo, estado, empleado_id)", "inv_codigos_instalacion(descripcion)",
].join(", ");
const CAMPOS = new Set(COLUMNAS.split(", "));

export default function Monitoreo() {
  const { esAdmin } = usePerfil();
  const [todos, setTodos] = useState<Dispositivo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ahora, setAhora] = useState(Date.now());
  const [filtro, setFiltro] = useState<"todos" | "conectados" | "desconectados" | "disco" | "sin_vincular">("todos");
  const [tipo, setTipo] = useState<TipoEquipo | "todos">("todos");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [pagina, setPagina] = useState(1);
  const tablaRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(() =>
    createClient().from("inv_dispositivos").select(COLUMNAS).order("hostname")
      .then(({ data }) => { setTodos((data ?? []) as unknown as Dispositivo[]); setCargando(false); }), []);

  useEffect(() => {
    const sb = createClient();
    cargar();

    // Cada reporte de un agente llega acá sin recargar la página. Para no volver a traer
    // todos los equipos con cada reporte, se actualiza solo la fila que cambió; la lista
    // completa se recarga (agrupada) solo si aparece o se quita un equipo o cambia su vínculo al inventario.
    let pendiente: ReturnType<typeof setTimeout> | undefined;
    const recargarLuego = () => { clearTimeout(pendiente); pendiente = setTimeout(cargar, 2000); };
    const canal = sb
      .channel("inv-dispositivos")
      .on("postgres_changes", { event: "*", schema: "public", table: "inv_dispositivos" }, (p) => {
        const nuevo = p.new as Dispositivo | undefined;
        if (p.eventType !== "UPDATE" || !nuevo?.id) return recargarLuego();
        setTodos((prev) => {
          const actual = prev.find((d) => d.id === nuevo.id);
          if (!actual || actual.equipo_id !== nuevo.equipo_id) { recargarLuego(); return prev; }
          const cambios = Object.fromEntries(Object.entries(nuevo).filter(([k]) => CAMPOS.has(k)));
          return prev.map((d) => (d.id === nuevo.id ? { ...d, ...cambios } : d));
        });
      })
      .subscribe();
    const reloj = setInterval(() => setAhora(Date.now()), 30000);
    return () => { sb.removeChannel(canal); clearInterval(reloj); clearTimeout(pendiente); };
  }, [cargar]);

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

  // Separación por tipo: notebooks, PCs de escritorio, servidores y otros
  const porTipo = useMemo(() => {
    const n: Record<TipoEquipo, number> = { notebook: 0, pc: 0, servidor: 0, otro: 0 };
    lista.forEach((d) => { n[tipoEquipo(d)]++; });
    return n;
  }, [lista]);
  const delTipo = useMemo(() => (tipo === "todos" ? lista : lista.filter((d) => tipoEquipo(d) === tipo)), [lista, tipo]);

  const cuentas = useMemo(() => ({
    conectados: delTipo.filter((d) => conectado(d.ultimo_reporte, ahora)).length,
    desconectados: delTipo.filter((d) => !conectado(d.ultimo_reporte, ahora)).length,
    disco: delTipo.filter((d) => discoCritico(d.discos)).length,
    sin_vincular: delTipo.filter((d) => !d.equipo_id).length,
  }), [delTipo, ahora]);

  async function cambiarTipo(d: Dispositivo, valor: string) {
    setError(null);
    const { error } = await createClient().from("inv_dispositivos").update({ tipo: valor || null }).eq("id", d.id);
    if (error) setError(/tipo/.test(error.message) ? "Falta ejecutar supabase/tipo-dispositivo.sql en Supabase." : error.message);
  }

  const filtrados = delTipo.filter((d) => {
    const on = conectado(d.ultimo_reporte, ahora);
    if (filtro === "conectados" && !on) return false;
    if (filtro === "desconectados" && on) return false;
    if (filtro === "disco" && !discoCritico(d.discos)) return false;
    if (filtro === "sin_vincular" && d.equipo_id) return false;
    const q = texto.trim().toLowerCase();
    return !q || [d.hostname, d.usuario, d.ip, d.numero_serie, d.modelo, d.so_nombre, d.inv_equipos?.codigo]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });

  // Filtros por columna (tipo Excel), sobre lo que ya dejaron las tarjetas, la solapa y el buscador
  const fc = useFiltrosColumna(filtrados, {
    equipo: (d) => d.hostname,
    inventario: (d) => d.inv_equipos?.codigo ?? "Sin cargar en inventario",
    sistema: (d) => d.so_nombre?.replace("Microsoft ", ""),
    ram: (d) => (d.ram_total_gb ? `${Math.round(d.ram_total_gb)} GB` : null),
    discos: (d) => (discoCritico(d.discos) ? "Disco casi lleno" : "Espacio OK"),
    reporte: (d) => (conectado(d.ultimo_reporte, ahora) ? "Conectado" : "Desconectado"),
  });
  const enTabla = fc.filtradas;

  // Paginación: al cambiar cualquier filtro se vuelve a la primera página
  useEffect(() => { setPagina(1); }, [filtro, tipo, texto, fc.filtros]);
  const paginas = Math.max(1, Math.ceil(enTabla.length / POR_PAGINA));
  const paginaActual = Math.min(pagina, paginas);
  const visibles = enTabla.slice((paginaActual - 1) * POR_PAGINA, paginaActual * POR_PAGINA);
  function irAPagina(n: number) {
    setPagina(n);
    setAbierto(null);
    tablaRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Devuelve el id del equipo creado (o null si no se pudo)
  async function crearEnInventario(d: Dispositivo): Promise<string | null> {
    setError(null);
    const sb = createClient();
    const t = tipoEquipo(d);
    const categoria = t === "servidor" ? "Servidor" : t === "notebook" ? "Notebook" : "PC de escritorio";
    const { data: cat } = await sb.from("inv_categorias").select("id").eq("nombre", categoria).maybeSingle();
    if (!cat) {
      setError(`No existe la categoría “${categoria}”. Creala en Inventario IT → Categorías y ubicaciones y volvé a intentar.`);
      return null;
    }
    const { data: eq, error } = await sb.from("inv_equipos").insert({
      categoria_id: cat.id, marca: d.fabricante, modelo: d.modelo, numero_serie: d.numero_serie,
      estado: "en_stock", hostname: d.hostname, ip: d.ip, mac: d.mac, procesador: d.procesador,
      ram_gb: d.ram_total_gb ? Math.round(d.ram_total_gb) : null, almacenamiento: d.almacenamiento,
      sistema_operativo: d.so_nombre,
    }).select("id").single();
    if (error) {
      setError(error.code === "23505"
        ? `Ya hay un equipo con el N° de serie ${d.numero_serie}. Va a quedar vinculado solo en el próximo reporte.`
        : error.message);
      return null;
    }
    await sb.from("inv_dispositivos").update({ equipo_id: eq.id }).eq("id", d.id);
    return eq.id as string;
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

      <div role="tablist" aria-label="Tipo de equipo" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1 w-fit max-w-full">
        {([["todos", "Todos", lista.length], ...(Object.keys(TIPOS_EQUIPO) as TipoEquipo[])
            .filter((k) => k !== "otro" || porTipo.otro > 0)
            .map((k) => [k, TIPOS_EQUIPO[k].varios, porTipo[k]] as const)] as const).map(([k, t, n]) => (
          <button key={k} role="tab" aria-selected={tipo === k} onClick={() => setTipo(k as TipoEquipo | "todos")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${tipo === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
            {t} <span className="tabular-nums text-ink/45">{n}</span>
          </button>
        ))}
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

      {esAdmin && <EquiposParaAsignar dispositivos={lista} ahora={ahora} crearEnInventario={crearEnInventario} alCambiar={cargar} />}

      {esAdmin && <EquiposSinAgente />}

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

      <FiltrosActivos ctl={fc} total={filtrados.length} />

      <div ref={tablaRef} className="card overflow-x-auto scroll-mt-4">
        <table className="data w-full" data-paginada>
          <thead>
            <tr>
              <ThFiltro ctl={fc} col="equipo">Equipo</ThFiltro><ThFiltro ctl={fc} col="inventario">Inventario</ThFiltro>
              <ThFiltro ctl={fc} col="sistema">Sistema</ThFiltro><ThFiltro ctl={fc} col="ram">RAM</ThFiltro>
              <ThFiltro ctl={fc} col="discos">Discos</ThFiltro><ThFiltro ctl={fc} col="reporte">Último reporte</ThFiltro>
            </tr>
          </thead>
          <tbody>
            {visibles.map((d) => {
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
                        {tipo === "todos" && (
                          <span className={`pill ${tipoEquipo(d) === "servidor" ? "bg-brand-50 text-brand-700" : "bg-line/[0.05] text-ink/55"}`}>
                            {TIPOS_EQUIPO[tipoEquipo(d)].uno}
                          </span>
                        )}
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
                          <div><dt className="text-ink/50 text-xs">Tipo de equipo</dt>
                            <dd>
                              {esAdmin ? (
                                <select className="input py-1 w-auto" value={d.tipo ?? ""} onChange={(e) => cambiarTipo(d, e.target.value)}
                                  onClick={(e) => e.stopPropagation()} aria-label={`Tipo de ${d.hostname}`}>
                                  <option value="">Automático ({TIPOS_EQUIPO[tipoDeducido(d)].uno})</option>
                                  {(Object.keys(TIPOS_EQUIPO) as TipoEquipo[]).map((k) => <option key={k} value={k}>{TIPOS_EQUIPO[k].uno}</option>)}
                                </select>
                              ) : TIPOS_EQUIPO[tipoEquipo(d)].uno}
                            </dd>
                          </div>
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
            {!cargando && enTabla.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-ink/40 py-10">
                  {lista.length === 0
                    ? esAdmin
                      ? <>Todavía ningún equipo reportó. <Link href="/inventario/monitoreo/agente" className="text-brand-600 hover:underline">Instalá el agente</Link> en una PC para empezar.</>
                      : "Todavía ningún equipo reportó."
                    : tipo !== "todos" && delTipo.length === 0
                      ? `No hay ${TIPOS_EQUIPO[tipo].varios.toLowerCase()} con el agente instalado.`
                      : "Ningún equipo coincide con el filtro."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {enTabla.length > POR_PAGINA && (
        <nav aria-label="Páginas de equipos" className="flex items-center justify-between gap-3 flex-wrap text-sm">
          <span className="text-ink/60">
            Mostrando {(paginaActual - 1) * POR_PAGINA + 1}–{Math.min(paginaActual * POR_PAGINA, enTabla.length)} de {enTabla.length} equipos
          </span>
          <div className="flex items-center gap-1">
            <button className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={paginaActual === 1} onClick={() => irAPagina(paginaActual - 1)}>
              Anterior
            </button>
            {Array.from({ length: paginas }, (_, i) => i + 1).map((n) => (
              <button key={n} onClick={() => irAPagina(n)} aria-current={n === paginaActual ? "page" : undefined}
                className={`min-w-[2.25rem] px-2 py-1.5 rounded-lg tabular-nums transition-colors ${n === paginaActual ? "bg-brand-600 text-white font-medium" : "text-ink/60 hover:bg-line/[0.06] hover:text-ink"}`}>
                {n}
              </button>
            ))}
            <button className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={paginaActual === paginas} onClick={() => irAPagina(paginaActual + 1)}>
              Siguiente
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
