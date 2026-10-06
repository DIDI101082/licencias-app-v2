"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteDns, { type EstadoDns } from "@/components/PuenteDns";
import { hace } from "@/lib/monitoreo";
import { exportarExcel } from "@/lib/excel";

type Estado = "activo" | "revisar" | "sin_uso";
type Registro = {
  id: number; zona: string; nombre: string; fqdn: string; tipo: "A" | "AAAA" | "CNAME" | "PTR"; dato: string; ip: string | null;
  estatico: boolean; ts: string | null; ttl: number | null; responde: boolean | null; via: string | null;
  ultima_respuesta: string | null; ultimo_chequeo: string | null; primera_vez: string; estado: Estado; motivo: string;
  en_ad: boolean | null; ad_habilitado: boolean | null; ad_logon: string | null; agente: string | null; mismos: number;
};
type Zona = {
  nombre: string; tipo: string | null; integrada: boolean | null; inversa: boolean; dinamica: string | null; aging: boolean | null;
  leida: boolean; registros: number | null;
};

type Vista = "registros" | "zonas";
const ESTADO: Record<Estado, { t: string; c: string; o: number }> = {
  sin_uso: { t: "Sin uso", c: "bg-red-50 text-red-700", o: 0 },
  revisar: { t: "A revisar", c: "bg-amber-500/15 text-amber-700", o: 1 },
  activo: { t: "Activo", c: "bg-emerald-50 text-emerald-700", o: 2 },
};
const DINAMICA: Record<string, string> = { Secure: "Solo seguras", NonsecureAndSecure: "Seguras y no seguras", None: "No permite" };
const VIA = (v: string | null) => (v === "ping" ? "ping" : v === "rechazo" ? "rechaza conexiones" : v === "dns" ? "resuelve" : v?.startsWith("tcp:") ? `puerto ${v.slice(4)}` : "");
const dia = (f: string | null) => (f ? new Date(f).toLocaleDateString("es-AR") : "—");

function Contenido() {
  const { esAdmin } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (params.get("vista") === "zonas" ? "zonas" : "registros") as Vista;
  const ir = (q: string) => router.replace(`/red/dns${q ? `?${q}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<EstadoDns | null>(null);
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [zonas, setZonas] = useState<Zona[]>([]);
  const [dias, setDias] = useState(30);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const [texto, setTexto] = useState("");
  const [filtro, setFiltro] = useState<Estado | "duplicadas" | "">("");
  const [tipo, setTipo] = useState("");
  const [zona, setZona] = useState("");
  const [origen, setOrigen] = useState("");

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, l] = await Promise.all([sb.rpc("dns_estado"), sb.rpc("dns_listar")]);
    const err = e.error ?? l.error;
    setError(err ? (/dns_(estado|listar)/.test(err.message) ? "Falta ejecutar supabase/dns.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoDns) ?? null);
    const d = (l.data ?? {}) as { registros?: Registro[]; zonas?: Zona[]; dias?: number };
    setRegistros(d.registros ?? []);
    setZonas(d.zonas ?? []);
    setDias(d.dias ?? 30);
    setAhora(Date.now());
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 300000); return () => clearInterval(t); }, [cargar]);

  const cuenta = (e: Estado) => registros.filter((r) => r.estado === e).length;
  const duplicadas = useMemo(() => registros.filter((r) => r.mismos > 1), [registros]);
  const q = texto.trim().toLowerCase();
  const lista = useMemo(() => registros
    .filter((r) =>
      (!filtro || (filtro === "duplicadas" ? r.mismos > 1 : r.estado === filtro)) &&
      (!tipo || r.tipo === tipo) && (!zona || r.zona === zona) &&
      (!origen || (origen === "estatico") === r.estatico) &&
      (!q || r.fqdn.includes(q) || r.dato.includes(q) || (r.ip ?? "").includes(q)))
    .sort((a, b) => (filtro === "duplicadas" ? a.dato.localeCompare(b.dato, undefined, { numeric: true }) : 0) || ESTADO[a.estado].o - ESTADO[b.estado].o || a.fqdn.localeCompare(b.fqdn)),
    [registros, filtro, tipo, zona, origen, q]);

  // El puente debería reportar cada "intervalo": se avisa si pasaron más de tres
  const limite = Math.max((estado?.intervalo_min ?? 60) * 3, 90) * 60000;
  const reporteViejo = estado?.ultimo_reporte ? ahora - Date.parse(estado.ultimo_reporte) > limite : false;
  const sinAging = zonas.filter((z) => !z.inversa && z.aging === false && z.dinamica && z.dinamica !== "None");

  const tarjetas: { t: string; n: number; c: string; f: Estado | "duplicadas" | "" }[] = [
    { t: "Registros", n: registros.length, c: "text-ink", f: "" },
    { t: "Activos", n: cuenta("activo"), c: "text-emerald-700", f: "activo" },
    { t: "A revisar", n: cuenta("revisar"), c: cuenta("revisar") ? "text-amber-700" : "text-ink", f: "revisar" },
    { t: `Sin uso (+${dias} días)`, n: cuenta("sin_uso"), c: cuenta("sin_uso") ? "text-red-600" : "text-ink", f: "sin_uso" },
    { t: "Nombres que comparten IP", n: duplicadas.length, c: duplicadas.length ? "text-amber-700" : "text-ink", f: "duplicadas" },
  ];

  const exportar = () => exportarExcel(`dns-interno-${new Date().toISOString().slice(0, 10)}`,
    ["Nombre", "Zona", "Tipo", "Apunta a", "Estado", "Motivo", "Origen", "Fecha del registro", "Responde", "Última respuesta", "En Active Directory", "Último inicio de sesión (AD)", "Agente de inventario", "Visto por primera vez"],
    lista.map((r) => [r.fqdn, r.zona, r.tipo, r.dato, ESTADO[r.estado].t, r.motivo, r.estatico ? "Estático" : "Dinámico", r.ts ? dia(r.ts) : "",
      r.responde == null ? "" : r.responde ? `Sí (${VIA(r.via)})` : "No", r.ultima_respuesta ? dia(r.ultima_respuesta) : r.responde == null ? "" : "Nunca",
      r.en_ad == null ? "" : r.en_ad ? (r.ad_habilitado ? "Sí" : "Deshabilitado") : "No", r.ad_logon ? dia(r.ad_logon) : "", r.agente ? dia(r.agente) : "", dia(r.primera_vez)]),
    { Nombre: 38, "Apunta a": 30, Motivo: 70 });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">DNS interno</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Qué registros del DNS interno siguen en uso y cuáles quedaron de equipos que ya no existen. Se decide con tres señales: la fecha del
            registro, si la IP responde, y el cruce con Active Directory y el inventario. La app solo informa: no borra nada en el DNS.
          </p>
        </div>
        {esAdmin && estado && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {estado && !estado.configurado && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está instalado el puente de DNS. {esAdmin ? "Tocá “Configurar” para generarlo e instalarlo en un controlador de dominio." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <PuenteDns estado={estado} alCambiar={cargar} />}

      {estado?.configurado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${reporteViejo || !estado.ultimo_reporte ? "bg-amber-500/10" : ""}`}>
          <span className={reporteViejo ? "text-red-600" : ""}>
            <b>Último reporte:</b> {estado.ultimo_reporte ? hace(estado.ultimo_reporte, ahora) : "todavía no reportó (¿instalaste el puente?)"}
          </span>
          {estado.servidor && <span><b>Servidor DNS:</b> {estado.servidor}</span>}
          <span><b>Zonas:</b> {zonas.length}</span>
          {(estado.avisos ?? []).length > 0 && <span className="text-amber-700 basis-full"><b>Avisos del puente:</b> {estado.avisos.join(" · ")}</span>}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {tarjetas.map((t) => (
          <button key={t.t} onClick={() => { setFiltro(t.f); if (vista !== "registros") ir(""); }}
            className={`card p-5 text-left transition-colors ${vista === "registros" && filtro === t.f ? "ring-2 ring-brand-600" : "hover:border-brand-300"}`}>
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div role="tablist" aria-label="Vistas" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1">
          {([["registros", "Registros"], ["zonas", "Zonas"]] as [Vista, string][]).map(([k, t]) => (
            <button key={k} role="tab" aria-selected={vista === k} onClick={() => ir(k === "registros" ? "" : `vista=${k}`)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${vista === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
        {vista === "registros" && (
          <div className="flex flex-wrap gap-2 items-center">
            <select className="input w-auto" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo">
              <option value="">Todos los tipos</option><option value="A">A</option><option value="AAAA">AAAA</option>
              <option value="CNAME">CNAME (alias)</option><option value="PTR">PTR (inverso)</option>
            </select>
            <select className="input w-auto" value={origen} onChange={(e) => setOrigen(e.target.value)} aria-label="Origen">
              <option value="">Estáticos y dinámicos</option><option value="estatico">Estáticos</option><option value="dinamico">Dinámicos</option>
            </select>
            <select className="input w-auto max-w-[16rem]" value={zona} onChange={(e) => setZona(e.target.value)} aria-label="Zona">
              <option value="">Todas las zonas</option>
              {zonas.map((z) => <option key={z.nombre} value={z.nombre}>{z.nombre}</option>)}
            </select>
            <input type="search" className="input max-w-xs" placeholder="Buscar nombre o IP…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
            <button className="btn-secondary" onClick={exportar} disabled={!lista.length}>Exportar a Excel</button>
          </div>
        )}
      </div>

      {vista === "registros" && (
        <div className="space-y-3">
          {filtro === "duplicadas" && (
            <p className="text-sm text-ink/60">
              Varios nombres apuntan a la misma IP. Puede ser a propósito (un servidor con varios nombres) o un registro viejo que quedó cuando la IP
              pasó a otro equipo: en ese caso el nombre viejo responde, pero ya no es ese equipo.
            </p>
          )}
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Nombre</th><th>Tipo</th><th>Apunta a</th><th>Estado</th><th>Origen</th><th>Responde</th><th>Active Directory</th></tr></thead>
              <tbody>
                {!lista.length && (
                  <tr><td colSpan={7} className="text-center text-ink/40 py-8">
                    {cargando ? "Cargando…" : registros.length ? "Sin registros con ese filtro." : "Sin datos todavía. Aparecen con el primer reporte del puente."}
                  </td></tr>
                )}
                {lista.slice(0, 1000).map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm"><div className="font-medium text-ink">{r.fqdn}</div>
                      <div className="text-xs text-ink/55 max-w-xl">{r.motivo}</div></td>
                    <td className="text-sm text-ink/70">{r.tipo}</td>
                    <td className="text-sm text-ink/70 whitespace-nowrap">{r.dato}
                      {r.mismos > 1 && <span className="pill bg-amber-500/15 text-amber-700 ml-1" title="Nombres que apuntan a esta IP">{r.mismos} nombres</span>}</td>
                    <td><span className={`pill ${ESTADO[r.estado].c}`}>{ESTADO[r.estado].t}</span></td>
                    <td className="text-sm text-ink/70 whitespace-nowrap">{r.estatico ? "Estático" : <>Dinámico{r.ts && <span className="text-ink/45"> · {dia(r.ts)}</span>}</>}</td>
                    <td className="text-sm whitespace-nowrap">
                      {r.responde == null ? <span className="text-ink/40">—</span>
                        : r.responde ? <span className="text-emerald-700">Sí <span className="text-ink/45">· {VIA(r.via)}</span></span>
                        : <span className="text-ink/60">No{r.tipo !== "CNAME" && <span className="text-ink/45"> · {r.ultima_respuesta ? `última vez ${hace(r.ultima_respuesta, ahora)}` : "nunca respondió"}</span>}</span>}
                    </td>
                    <td className="text-sm whitespace-nowrap">
                      {r.en_ad == null ? <span className="text-ink/40">—</span>
                        : !r.en_ad ? <span className="text-ink/50">{r.agente ? `Sin equipo · agente ${hace(r.agente, ahora)}` : "No figura"}</span>
                        : <span className={r.ad_habilitado ? "text-ink/70" : "text-amber-700"}>{r.ad_habilitado ? "Equipo" : "Deshabilitado"}
                            <span className="text-ink/45"> · {r.ad_logon ? `sesión ${dia(r.ad_logon)}` : "sin sesiones"}</span></span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lista.length > 1000 && <p className="text-xs text-ink/50">Se muestran los primeros 1000 de {lista.length}. Usá los filtros o exportá a Excel para verlos todos.</p>}
          <p className="text-xs text-ink/50 max-w-4xl">
            Antes de borrar un registro &ldquo;sin uso&rdquo; conviene confirmarlo: un equipo que bloquea el ping y todos los puertos probados, o que el
            servidor del puente no alcanza por red, se ve igual que uno que no existe. Los registros estáticos no tienen fecha: para ellos cuentan
            solo la respuesta de la IP y el cruce con Active Directory y el inventario.
          </p>
        </div>
      )}

      {vista === "zonas" && (
        <div className="space-y-3">
          {sinAging.length > 0 && (
            <div className="card p-4 text-sm bg-amber-500/10">
              <b>{sinAging.length === 1 ? "Una zona acepta" : `${sinAging.length} zonas aceptan`} registros dinámicos sin caducidad:</b> {sinAging.map((z) => z.nombre).join(", ")}.
              Sin caducidad (aging / scavenging), el DNS no limpia los registros de equipos que ya no existen y la fecha de los registros dinámicos
              deja de ser confiable, así que la app no la usa como señal de &ldquo;sin uso&rdquo; en esas zonas.
            </div>
          )}
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Zona</th><th>Tipo</th><th>Registros</th><th>Sin uso</th><th>Actualizaciones dinámicas</th><th>Caducidad</th></tr></thead>
              <tbody>
                {!zonas.length && <tr><td colSpan={6} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : "Sin datos todavía."}</td></tr>}
                {zonas.map((z) => {
                  const sinUso = registros.filter((r) => r.zona === z.nombre && r.estado === "sin_uso").length;
                  return (
                    <tr key={z.nombre}>
                      <td className="text-sm font-medium">
                        <button className="hover:underline text-left" onClick={() => { setZona(z.nombre); setFiltro(""); ir(""); }}>{z.nombre}</button>
                        {!z.leida && <span className="pill bg-red-50 text-red-700 ml-1">No se pudo leer</span>}
                      </td>
                      <td className="text-sm text-ink/70">{z.inversa ? "Inversa" : "Directa"}{z.integrada ? " · integrada en AD" : ""}</td>
                      <td className="text-sm tabular-nums">{z.registros ?? "—"}</td>
                      <td className={`text-sm tabular-nums ${sinUso ? "text-red-600 font-medium" : "text-ink/50"}`}>{sinUso}</td>
                      <td className={`text-sm ${z.dinamica === "NonsecureAndSecure" ? "text-amber-700" : "text-ink/70"}`}>{z.dinamica ? (DINAMICA[z.dinamica] ?? z.dinamica) : "—"}</td>
                      <td className="text-sm">{z.aging == null ? "—" : z.aging ? <span className="text-emerald-700">Activada</span> : <span className="text-amber-700">Desactivada</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink/50">Se leen las zonas primarias de este servidor. No se incluyen las zonas internas de Active Directory (_msdcs) ni los registros de servicio.</p>
        </div>
      )}
    </div>
  );
}

export default function DnsInterno() {
  return <Suspense><Contenido /></Suspense>;
}
