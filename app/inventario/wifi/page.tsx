"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteUnifi, { type EstadoUnifi } from "@/components/PuenteUnifi";
import { hace } from "@/lib/monitoreo";

type Cliente = {
  mac: string; sitio: string | null; hostname: string | null; nombre: string | null; ip: string | null; ssid: string | null;
  ap_mac: string | null; cableado: boolean; invitado: boolean; fabricante: string | null; senal: number | null; mac_aleatoria: boolean;
  conectado: boolean; primera_vez: string; ultima_vez: string; dispositivo_id: string | null; equipo_id: string | null;
  conocido_descripcion: string | null; agente_hostname: string | null; inventario_codigo: string | null; ap_nombre: string | null;
  conocido: boolean; corporativa: boolean;
};
type Vecina = {
  bssid: string; sitio: string | null; ssid: string | null; canal: number | null; senal: number | null; seguridad: string | null;
  fabricante: string | null; visto_por: string | null; es_rogue: boolean; suplanta: boolean; primera_vez: string; ultima_vez: string;
};
type Equipo = {
  mac: string; sitio: string | null; nombre: string | null; modelo: string | null; tipo: string | null; ip: string | null;
  firmware: string | null; estado: number | null; actualizable: boolean | null; clientes: number | null; actualizado: string;
  serie?: string | null; zona?: string | null; inventario_id?: string | null; inventario_codigo?: string | null;
};
type Categoria = { id: number; nombre: string; grupo: string | null };
type Red = { sitio: string; ssid: string; seguridad: string | null; wpa: string | null; wpa3: boolean | null; wpa3_transicion: boolean | null; invitados: boolean; habilitada: boolean; oculta: boolean | null };
type Conocido = { mac: string; descripcion: string; aprobado_por: string | null; aprobado_en: string };

type Vista = "desconocidos" | "conectados" | "vecinas" | "equipos" | "conocidos";
const VISTAS: [Vista, string][] = [
  ["desconocidos", "Desconocidos"], ["conectados", "Todos los conectados"], ["vecinas", "Redes vecinas"],
  ["equipos", "Equipos y redes UniFi"], ["conocidos", "Aprobados"],
];
const TIPO_EQUIPO: Record<string, string> = { uap: "Antena", usw: "Switch", udm: "Gateway", ugw: "Gateway", uxg: "Gateway" };
const RECIENTE = 2 * 3600000;   // una red vecina cuenta como "vista ahora" si apareció en las últimas 2 horas

function Contenido() {
  const { esAdmin, puedeEditar } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (VISTAS.some(([k]) => k === params.get("vista")) ? params.get("vista") : "desconocidos") as Vista;
  const irA = (v: Vista) => router.replace(`/inventario/wifi${v === "desconocidos" ? "" : `?vista=${v}`}`, { scroll: false });

  const [estado, setEstado] = useState<EstadoUnifi | null>(null);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [vecinas, setVecinas] = useState<Vecina[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [redes, setRedes] = useState<Red[]>([]);
  const [conocidos, setConocidos] = useState<Conocido[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const [texto, setTexto] = useState("");
  const [todasVecinas, setTodasVecinas] = useState(false);
  const [aprobando, setAprobando] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState("");
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [cargandoInv, setCargandoInv] = useState<string | null>(null);
  const [categoria, setCategoria] = useState("");
  const [zonas, setZonas] = useState<Record<string, string>>({});

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, c, v, q, r, k] = await Promise.all([
      sb.rpc("unifi_estado"),
      sb.from("unifi_clientes_vista").select("*").order("conectado", { ascending: false }).order("ultima_vez", { ascending: false }).limit(3000),
      sb.from("unifi_vecinas").select("*").order("ultima_vez", { ascending: false }).limit(3000),
      sb.from("unifi_equipos_vista").select("*").order("nombre").then(async (r) => (r.error ? await sb.from("unifi_equipos").select("*").order("nombre") : r)),
      sb.from("unifi_redes").select("*").order("sitio").order("ssid"),
      sb.from("unifi_conocidos").select("*").order("aprobado_en", { ascending: false }),
    ]);
    const err = e.error ?? c.error;
    setError(err ? (/unifi/.test(err.message) ? "Falta ejecutar supabase/unifi.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoUnifi) ?? null);
    setClientes((c.data ?? []) as Cliente[]);
    setVecinas((v.data ?? []) as Vecina[]);
    setEquipos((q.data ?? []) as Equipo[]);
    setRedes((r.data ?? []) as Red[]);
    setConocidos((k.data ?? []) as Conocido[]);
    sb.from("inv_categorias").select("id, nombre, grupo").order("grupo").order("nombre").then(({ data }) => setCategorias((data ?? []) as Categoria[]));
    setAhora(Date.now());
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  const conectados = useMemo(() => clientes.filter((c) => c.conectado), [clientes]);
  const desconocidos = useMemo(() => conectados.filter((c) => c.corporativa && !c.conocido), [conectados]);
  const recientes = (v: Vecina) => ahora - Date.parse(v.ultima_vez) < RECIENTE;
  const falsas = vecinas.filter((v) => v.suplanta && recientes(v));
  const intrusas = vecinas.filter((v) => v.es_rogue && !v.suplanta && recientes(v));
  const antenas = equipos.filter((q) => q.tipo === "uap");
  const antenasOn = antenas.filter((q) => q.estado === 1).length;
  const nombreAp = (mac: string | null) => {
    const ap = equipos.find((q) => q.mac === mac);
    return ap ? [ap.zona, ap.nombre].filter(Boolean).join(" · ") : mac ?? "—";
  };

  async function guardarZona(q: Equipo) {
    const valor = zonas[q.mac];
    if (valor === undefined || valor === (q.zona ?? "")) return;
    const { error } = await createClient().rpc("unifi_zona_guardar", { p_mac: q.mac, p_zona: valor });
    if (error) return setError(/unifi_zona_guardar/.test(error.message) ? "Falta ejecutar supabase/unifi-extra.sql en Supabase." : error.message);
    cargar();
  }

  async function cargarEnInventario(q: Equipo) {
    if (!categoria) return;
    const { error } = await createClient().from("inv_equipos").insert({
      categoria_id: Number(categoria), marca: "Ubiquiti", modelo: q.modelo, numero_serie: q.serie ?? null,
      hostname: q.nombre, ip: q.ip, mac: q.mac,
    });
    if (error) {
      return setError(error.code === "23505" ? `Ya hay un equipo con el N° de serie ${q.serie}.`
        : error.message.includes("row-level security") ? "No tenés permiso para cargar equipos en el inventario." : error.message);
    }
    setCargandoInv(null); setCategoria(""); cargar();
  }

  const reporteViejo = estado?.ultimo_reporte ? ahora - Date.parse(estado.ultimo_reporte) > (estado.minutos_sin_reporte ?? 20) * 60000 : false;
  const q = texto.trim().toLowerCase();
  const coincide = (...v: (string | null | undefined)[]) => !q || v.some((x) => x?.toLowerCase().includes(q));

  async function aprobar(mac: string) {
    if (!descripcion.trim()) return;
    const { error } = await createClient().from("unifi_conocidos").upsert({ mac, descripcion: descripcion.trim() });
    if (error) return setError(error.message);
    setAprobando(null); setDescripcion(""); cargar();
  }
  async function quitarConocido(mac: string) {
    const { error } = await createClient().from("unifi_conocidos").delete().eq("mac", mac);
    if (error) setError(error.message); else cargar();
  }

  const tarjetas: { v: Vista; t: string; n: string | number; c: string }[] = [
    { v: "desconocidos", t: "Desconocidos en la red de la empresa", n: desconocidos.length, c: desconocidos.length ? "text-red-600" : "text-ink" },
    { v: "vecinas", t: "Posibles redes WiFi falsas", n: falsas.length, c: falsas.length ? "text-red-600" : "text-ink" },
    { v: "vecinas", t: "Antenas no autorizadas en la red", n: intrusas.length, c: intrusas.length ? "text-red-600" : "text-ink" },
    { v: "equipos", t: "Antenas en línea", n: antenas.length ? `${antenasOn} de ${antenas.length}` : "—", c: antenasOn < antenas.length ? "text-amber-700" : "text-ink" },
  ];

  const filaCliente = (c: Cliente, conEstado: boolean) => (
    <tr key={c.mac}>
      <td>
        <div className="font-medium text-ink">{c.hostname ?? c.nombre ?? <span className="text-ink/50 font-normal">Sin nombre</span>}</div>
        <div className="text-xs text-ink/50">{c.fabricante ?? "Fabricante desconocido"}</div>
      </td>
      <td className="whitespace-nowrap">
        <span className="font-mono text-xs">{c.mac}</span>
        {c.mac_aleatoria && <div><span className="pill bg-line/[0.05] text-ink/60" title="Dirección MAC privada o aleatoria: la usan sobre todo celulares y tablets personales">MAC aleatoria</span></div>}
      </td>
      <td className="text-sm">
        {c.cableado ? "Cable" : c.ssid ?? "—"}
        {c.invitado && <span className="pill bg-amber-500/10 text-amber-700 ml-1">Invitados</span>}
        {!c.cableado && <div className="text-xs text-ink/50">{c.ap_nombre ?? nombreAp(c.ap_mac)}{c.senal != null ? ` · ${c.senal} dBm` : ""}</div>}
      </td>
      <td className="text-sm text-ink/70 whitespace-nowrap">{c.ip ?? "—"}</td>
      <td className="text-sm text-ink/60 whitespace-nowrap">
        {c.conectado ? <span className="text-emerald-700">Conectado</span> : hace(c.ultima_vez, ahora)}
        <div className="text-xs text-ink/45">Primera vez {hace(c.primera_vez, ahora)}</div>
      </td>
      {conEstado && (
        <td className="text-sm">
          {c.agente_hostname ? <Link href="/inventario/monitoreo" className="pill bg-emerald-50 text-emerald-700">Agente: {c.agente_hostname}</Link>
            : c.inventario_codigo ? <span className="pill bg-emerald-50 text-emerald-700">Inventario {c.inventario_codigo}</span>
            : c.conocido_descripcion ? <span className="pill bg-emerald-50 text-emerald-700" title="Aprobado como conocido">{c.conocido_descripcion}</span>
            : c.equipo_id ? <span className="pill bg-emerald-50 text-emerald-700">En inventario</span>
            : c.corporativa ? <span className="pill bg-red-50 text-red-600">Desconocido</span>
            : <span className="pill bg-line/[0.05] text-ink/55">Red de invitados</span>}
        </td>
      )}
      <td className="text-right">
        {puedeEditar && !c.conocido && (
          aprobando === c.mac ? (
            <form className="flex gap-1 justify-end" onSubmit={(e) => { e.preventDefault(); aprobar(c.mac); }}>
              <input autoFocus className="input py-1 w-48" placeholder="Qué es (ej. Impresora piso 5)" value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)} aria-label={`Descripción de ${c.mac}`} />
              <button className="btn-primary py-1" disabled={!descripcion.trim()}>Guardar</button>
              <button type="button" className="btn-secondary py-1" onClick={() => { setAprobando(null); setDescripcion(""); }}>Cancelar</button>
            </form>
          ) : (
            <button className="text-sm text-brand-600 hover:underline whitespace-nowrap" onClick={() => { setAprobando(c.mac); setDescripcion(c.hostname ?? ""); }}>
              Marcar como conocido
            </button>
          )
        )}
      </td>
    </tr>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">WiFi y red UniFi</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Lo que ven las antenas de la UDM Pro: dispositivos que no reconocemos en la red de la empresa, redes que imitan el nombre de
            las nuestras y antenas conectadas sin autorización. Se actualiza cada pocos minutos.
          </p>
        </div>
        {esAdmin && estado && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {estado && !estado.configurado && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está conectada la UDM Pro. {esAdmin ? "Tocá “Configurar” para generar el puente." : "Pedile a un administrador que la conecte."}
        </div>
      )}
      {config && esAdmin && estado && <PuenteUnifi estado={estado} alCambiar={cargar} />}

      {estado?.configurado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${reporteViejo || !estado.ultimo_reporte ? "bg-amber-500/10" : ""}`}>
          <span><b>UDM:</b> {estado.udm_url ?? "—"}</span>
          <span className={reporteViejo ? "text-red-600" : ""}>
            <b>Último reporte:</b> {estado.ultimo_reporte ? hace(estado.ultimo_reporte, ahora) : "todavía no reportó (¿instalaste el puente?)"}
          </span>
          {estado.resumen && <span className="text-ink/60">{estado.resumen.clientes} clientes · {estado.resumen.equipos} equipos UniFi · {estado.resumen.vecinas} redes vecinas</span>}
          <span className={estado.alertas ? "text-emerald-700" : "text-ink/50"}><b>Alertas:</b> {estado.alertas ? "activadas" : "apagadas"}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {tarjetas.map((t) => (
          <button key={t.t} onClick={() => irA(t.v)} className={`card p-5 text-left transition-colors ${vista === t.v ? "border-brand-500" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div role="tablist" aria-label="Vistas" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1">
          {VISTAS.map(([k, t]) => (
            <button key={k} role="tab" aria-selected={vista === k} onClick={() => irA(k)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${vista === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
        <input type="search" className="input max-w-xs" placeholder="Buscar nombre, MAC, IP, red…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
      </div>

      {(vista === "desconocidos" || vista === "conectados") && (() => {
        const filas = (vista === "desconocidos" ? desconocidos : conectados)
          .filter((c) => coincide(c.hostname, c.nombre, c.mac, c.ip, c.ssid, c.fabricante, c.agente_hostname, c.conocido_descripcion));
        return (
          <>
            {vista === "desconocidos" && (
              <p className="text-sm text-ink/60">
                Conectados ahora al WiFi de la empresa o por cable, que no coinciden con ningún equipo con agente, ningún equipo del inventario
                ni la lista de aprobados. Los de <b>MAC aleatoria</b> suelen ser celulares personales. Si reconocés alguno, marcalo como conocido.
              </p>
            )}
            <div className="card overflow-x-auto">
              <table className="data w-full">
                <thead><tr><th>Dispositivo</th><th>MAC</th><th>Red</th><th>IP</th><th>Visto</th>{vista === "conectados" && <th>Estado</th>}<th></th></tr></thead>
                <tbody>
                  {cargando && <tr><td colSpan={7} className="text-center text-ink/40 py-10">Cargando…</td></tr>}
                  {!cargando && !filas.length && (
                    <tr><td colSpan={7} className="text-center py-10">
                      <span className={vista === "desconocidos" && estado?.ultimo_reporte ? "text-emerald-700" : "text-ink/40"}>
                        {!estado?.ultimo_reporte ? "Sin datos todavía." : vista === "desconocidos" ? "No hay dispositivos desconocidos conectados." : "Ningún cliente coincide."}
                      </span>
                    </td></tr>
                  )}
                  {filas.map((c) => filaCliente(c, vista === "conectados"))}
                </tbody>
              </table>
            </div>
          </>
        );
      })()}

      {vista === "vecinas" && (() => {
        const base = todasVecinas ? vecinas : vecinas.filter((v) => recientes(v) || v.suplanta || v.es_rogue);
        const filas = base
          .filter((v) => coincide(v.ssid, v.bssid, v.fabricante, nombreAp(v.visto_por)))
          .sort((a, b) => Number(b.suplanta) - Number(a.suplanta) || Number(b.es_rogue) - Number(a.es_rogue) || (b.senal ?? -999) - (a.senal ?? -999));
        return (
          <>
            <div className="flex flex-wrap gap-3 items-center justify-between">
              <p className="text-sm text-ink/60 max-w-3xl">
                Redes que detectan nuestras antenas. <b>Posible red falsa</b>: usa el mismo nombre que una red de la empresa pero no es de
                nuestras antenas; es la técnica típica para robar contraseñas. <b>Conectada a nuestra red</b>: UniFi la ve también del lado del
                cable, es decir, alguien enchufó un router o antena propia.
              </p>
              <label className="flex items-center gap-2 text-sm text-ink/60">
                <input type="checkbox" checked={todasVecinas} onChange={(e) => setTodasVecinas(e.target.checked)} /> Incluir las no vistas en las últimas 2 horas
              </label>
            </div>
            <div className="card overflow-x-auto">
              <table className="data w-full">
                <thead><tr><th>Red</th><th>Estado</th><th>BSSID</th><th>Seguridad</th><th>Canal</th><th>Señal</th><th>Detectada por</th><th>Última vez</th></tr></thead>
                <tbody>
                  {!filas.length && <tr><td colSpan={8} className="text-center text-ink/40 py-10">{cargando ? "Cargando…" : "Sin redes vecinas."}</td></tr>}
                  {filas.map((v) => (
                    <tr key={v.bssid} className={!recientes(v) ? "opacity-60" : ""}>
                      <td>
                        <div className="font-medium text-ink">{v.ssid ?? <span className="text-ink/50 font-normal">Red oculta</span>}</div>
                        <div className="text-xs text-ink/50">{v.fabricante ?? ""}</div>
                      </td>
                      <td>
                        {v.suplanta ? <span className="pill bg-red-600 text-white">Posible red falsa</span>
                          : v.es_rogue ? <span className="pill bg-red-50 text-red-600">Conectada a nuestra red</span>
                          : <span className="pill bg-line/[0.05] text-ink/55">Vecina</span>}
                      </td>
                      <td className="font-mono text-xs whitespace-nowrap">{v.bssid}</td>
                      <td className={`text-sm ${v.seguridad === "open" ? "text-amber-700" : "text-ink/70"}`}>{v.seguridad === "open" ? "Abierta" : v.seguridad ?? "—"}</td>
                      <td className="text-sm text-ink/70 tabular-nums">{v.canal ?? "—"}</td>
                      <td className="text-sm text-ink/70 tabular-nums whitespace-nowrap">{v.senal != null ? `${v.senal} dBm` : "—"}</td>
                      <td className="text-sm text-ink/70">{nombreAp(v.visto_por)}</td>
                      <td className="text-sm text-ink/60 whitespace-nowrap">{hace(v.ultima_vez, ahora)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      })()}

      {vista === "equipos" && (
        <div className="space-y-6">
          <div className="card overflow-x-auto">
            <div className="p-5 pb-2"><h2 className="font-medium text-ink">Redes WiFi de la empresa</h2></div>
            <table className="data w-full">
              <thead><tr><th>Red</th><th>Sitio</th><th>Seguridad</th><th>WPA3</th><th>Tipo</th><th>Estado</th></tr></thead>
              <tbody>
                {!redes.length && <tr><td colSpan={6} className="text-center text-ink/40 py-6">Sin datos todavía.</td></tr>}
                {redes.filter((r) => coincide(r.ssid, r.sitio)).map((r) => {
                  const abierta = r.seguridad === "open";
                  return (
                    <tr key={r.sitio + r.ssid} className={r.habilitada ? "" : "opacity-50"}>
                      <td className="font-medium text-ink">{r.ssid}{r.oculta ? <span className="text-xs text-ink/50 font-normal"> · oculta</span> : null}</td>
                      <td className="text-sm text-ink/70">{r.sitio}</td>
                      <td className={`text-sm ${abierta ? "text-red-600 font-medium" : "text-ink/70"}`}>{abierta ? "Abierta, sin contraseña" : [r.seguridad, r.wpa].filter(Boolean).join(" · ")}</td>
                      <td className="text-sm">{r.wpa3 ? (r.wpa3_transicion ? "Sí (modo mixto)" : "Sí") : <span className="text-amber-700">No</span>}</td>
                      <td className="text-sm text-ink/70">{r.invitados ? "Invitados" : "Empresa"}</td>
                      <td className="text-sm text-ink/70">{r.habilitada ? "Activa" : "Desactivada"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card overflow-x-auto">
            <div className="p-5 pb-2">
              <h2 className="font-medium text-ink">Equipos UniFi</h2>
              {esAdmin && <p className="text-sm text-ink/60 mt-1">Poné la <b>zona</b> de cada antena (por ejemplo “Piso 5” o “Córdoba”): con eso Oficina / Home office muestra en qué piso está cada equipo y la ocupación por piso.</p>}
            </div>
            <table className="data w-full">
              <thead><tr><th>Equipo</th><th>Zona</th><th>Tipo</th><th>IP</th><th>Firmware</th><th>Clientes</th><th>Estado</th><th>Inventario</th></tr></thead>
              <tbody>
                {!equipos.length && <tr><td colSpan={8} className="text-center text-ink/40 py-6">Sin datos todavía.</td></tr>}
                {equipos.filter((x) => coincide(x.nombre, x.modelo, x.ip, x.mac, x.zona)).map((x) => (
                  <tr key={x.mac}>
                    <td><div className="font-medium text-ink">{x.nombre ?? x.mac}</div><div className="text-xs text-ink/50">{[x.modelo, x.sitio].filter(Boolean).join(" · ")}</div></td>
                    <td className="text-sm">
                      {esAdmin && x.tipo === "uap" ? (
                        <input className="input py-1 w-36" placeholder="Ej. Piso 5" value={zonas[x.mac] ?? x.zona ?? ""} aria-label={`Zona de ${x.nombre ?? x.mac}`}
                          onChange={(e) => setZonas({ ...zonas, [x.mac]: e.target.value })} onBlur={() => guardarZona(x)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                      ) : <span className="text-ink/70">{x.zona ?? "—"}</span>}
                    </td>
                    <td className="text-sm text-ink/70">{TIPO_EQUIPO[x.tipo ?? ""] ?? x.tipo ?? "—"}</td>
                    <td className="text-sm text-ink/70">{x.ip ?? "—"}</td>
                    <td className="text-sm">
                      <span className="text-ink/70">{x.firmware ?? "—"}</span>
                      {x.actualizable && <div><span className="pill bg-amber-500/10 text-amber-700">Actualización disponible</span></div>}
                    </td>
                    <td className="text-sm text-ink/70 tabular-nums">{x.clientes ?? "—"}</td>
                    <td>{x.estado === 1 ? <span className="pill bg-emerald-50 text-emerald-700">En línea</span> : <span className="pill bg-red-50 text-red-600">Desconectado</span>}</td>
                    <td className="text-sm">
                      {x.inventario_codigo ? (
                        <Link href={`/inventario/equipos/${x.inventario_id}`} className="tag-inv">{x.inventario_codigo}</Link>
                      ) : puedeEditar && categorias.length > 0 && x.inventario_id === null ? (
                        cargandoInv === x.mac ? (
                          <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); cargarEnInventario(x); }}>
                            <select className="input py-1 w-40" value={categoria} onChange={(e) => setCategoria(e.target.value)} aria-label="Categoría">
                              <option value="">Categoría…</option>
                              {categorias.map((c) => <option key={c.id} value={c.id}>{c.grupo ? `${c.grupo} · ` : ""}{c.nombre}</option>)}
                            </select>
                            <button className="btn-primary py-1" disabled={!categoria}>Cargar</button>
                            <button type="button" className="btn-secondary py-1" onClick={() => setCargandoInv(null)}>Cancelar</button>
                          </form>
                        ) : (
                          <button className="text-brand-600 hover:underline whitespace-nowrap" onClick={() => { setCargandoInv(x.mac); setCategoria(""); }}>Cargar en inventario</button>
                        )
                      ) : <span className="text-ink/40">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {vista === "conocidos" && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Dispositivo</th><th>MAC</th><th>Aprobado por</th><th></th></tr></thead>
            <tbody>
              {!conocidos.length && <tr><td colSpan={4} className="text-center text-ink/40 py-6">Todavía no aprobaste ningún dispositivo.</td></tr>}
              {conocidos.filter((k) => coincide(k.descripcion, k.mac)).map((k) => (
                <tr key={k.mac}>
                  <td className="text-ink">{k.descripcion}</td>
                  <td className="font-mono text-xs">{k.mac}</td>
                  <td className="text-sm text-ink/60">{k.aprobado_por ?? "—"} · {new Date(k.aprobado_en).toLocaleDateString("es-AR")}</td>
                  <td className="text-right">{puedeEditar && <button className="text-sm text-ink/50 hover:text-red-600" onClick={() => quitarConocido(k.mac)}>Quitar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function WifiUnifi() {
  return <Suspense><Contenido /></Suspense>;
}
