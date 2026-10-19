"use client";

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { hace } from "@/lib/monitoreo";
import { exportarExcel } from "@/lib/excel";

// ---------------------------------------------------------------------------------------------
// Tipos (los devuelven cf_estado() y cf_listar())
// ---------------------------------------------------------------------------------------------
type Nivel = "ok" | "aviso" | "mal" | "na" | "sin_dato";
type Control = { k: string; titulo: string; nivel: Nivel; valor: unknown; texto: string };
type Cuenta = { k: string; n: number };
type Eventos = {
  total: number; mitigados: number; por_accion: Cuenta[]; paises: Cuenta[]; ips: (Cuenta & { pais: string | null })[];
  fuentes: Cuenta[]; rutas: Cuenta[]; por_hora: { h: string; n: number }[];
};
type Zona = {
  id: string; nombre: string; estado: string | null; pausada: boolean; plan: string | null; ns: string[];
  ssl: string | null; min_tls: string | null; dnssec: string | null; cert_vence: string | null; cert_emisor: string | null; cert_tipo: string | null;
  eventos: Eventos | null; eventos_fecha: string | null; errores: Record<string, string>; actualizado: string;
  registros: number; con_proxy: number; controles: Control[];
};
type Estado = {
  activo: boolean; alertar_cambios: boolean; alertar_logins: boolean; alertar_config: boolean; alertar_ataques: boolean;
  umbral_mitigados: number; dias_cert: number; cuenta_nombre: string | null; ultima_ejecucion: string | null; ultimo_ok: string | null;
  ultimo_error: string | null; auditoria_error: string | null; auditoria_hasta: string | null; avisos: string[]; duracion_s: number | null;
  clave_configurada: boolean; zonas: Zona[];
};
type Registro = {
  id: string; zona: string; nombre: string; tipo: string; contenido: string; proxied: boolean; proxiable: boolean; ttl: number | null;
  comentario: string | null; modificado: string | null; primera_vez: string; expuesto: boolean;
  justificacion: string | null; justif_por: string | null; justif_fecha: string | null;
};
type EventoAud = {
  id: string; fecha: string; actor: string | null; actor_tipo: string | null; ip: string | null; contexto: string | null; accion: string;
  resultado: string | null; producto: string | null; recurso_tipo: string | null; recurso_id: string | null; zona: string | null;
  categoria: string; descripcion: string | null; detalle: string | null; avisar: boolean;
};
type DiaTrafico = { zona: string; dia: string; solicitudes: number; cacheadas: number; amenazas: number; bytes: number; visitantes: number };

type Vista = "resumen" | "dns" | "seguridad" | "cambios" | "trafico";
const VISTAS: [Vista, string][] = [["resumen", "Resumen"], ["seguridad", "Seguridad"], ["dns", "Registros DNS"], ["cambios", "Cambios y accesos"], ["trafico", "Tráfico y ataques"]];

const NIVEL: Record<Nivel, { t: string; pill: string; punto: string; o: number }> = {
  mal: { t: "Corregir", pill: "bg-red-50 text-red-700", punto: "bg-red-500", o: 0 },
  aviso: { t: "Mejorar", pill: "bg-amber-500/15 text-amber-700", punto: "bg-amber-500", o: 1 },
  ok: { t: "Bien", pill: "bg-emerald-50 text-emerald-700", punto: "bg-emerald-500", o: 2 },
  sin_dato: { t: "Sin dato", pill: "bg-line/[0.05] text-ink/50", punto: "bg-line/30", o: 3 },
  na: { t: "No aplica", pill: "bg-line/[0.05] text-ink/45", punto: "bg-line/20", o: 4 },
};
const CATEGORIA: Record<string, string> = {
  acceso: "Inicio de sesión", permisos: "Permisos y tokens", dns: "DNS", seguridad: "Reglas de seguridad",
  configuracion: "Configuración", zona: "Zona", otro: "Otro",
};
const ACCION: Record<string, { t: string; c: string }> = {
  create: { t: "Alta", c: "bg-emerald-50 text-emerald-700" },
  update: { t: "Cambio", c: "bg-sky-500/15 text-sky-700" },
  delete: { t: "Baja", c: "bg-red-50 text-red-700" },
  login: { t: "Ingreso", c: "bg-line/[0.05] text-ink/70" },
};
const ACCION_FW: Record<string, string> = {
  block: "Bloqueada", challenge: "Desafío", jschallenge: "Desafío JS", managed_challenge: "Desafío administrado",
  connection_close: "Conexión cerrada", force_connection_close: "Conexión cerrada", log: "Solo registrada", skip: "Omitida", allow: "Permitida", bypass: "Exceptuada",
};
const FUENTE: Record<string, string> = {
  waf: "WAF", firewallManaged: "Reglas administradas", firewallCustom: "Reglas propias", firewallrules: "Reglas de firewall", ratelimit: "Límite de solicitudes",
  securitylevel: "Nivel de seguridad", bic: "Integridad del navegador", hot: "Protección de hotlinks", ip: "Lista de IPs", country: "Por país", asn: "Por ASN",
  uablock: "User agent", zonelockdown: "Bloqueo de zona", botFight: "Bot Fight", botManagement: "Gestión de bots", l7ddos: "DDoS (capa 7)",
  validation: "Validación", dlp: "DLP", apiShield: "API Shield",
};
const CONTEXTO: Record<string, string> = { dash: "panel web", api_token: "API (token)", api_key: "API (clave global)", api: "API", oauth: "OAuth" };

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("es-AR"));
const bytes = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} kB`).replace(".", ",");
const fecha = (f: string) => new Date(f).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const diaCorto = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
const peor = (cs: Control[]) => cs.reduce<Nivel>((p, c) => (NIVEL[c.nivel].o < NIVEL[p].o ? c.nivel : p), "ok");

function Punto({ n, titulo }: { n: Nivel; titulo?: string }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${NIVEL[n].punto}`} title={titulo ?? NIVEL[n].t} aria-label={titulo ?? NIVEL[n].t} />;
}

// Barras de una sola serie (sin leyenda: el título nombra la serie). Tooltip nativo por barra.
function Barras({ datos, alto = 120, etiqueta }: { datos: { k: string; n: number; titulo: string }[]; alto?: number; etiqueta: (k: string) => string }) {
  const max = Math.max(1, ...datos.map((d) => d.n));
  if (!datos.length) return <p className="text-sm text-ink/40 py-6 text-center">Sin datos.</p>;
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height: alto }} role="img" aria-label={datos.map((d) => d.titulo).join("; ")}>
        {datos.map((d) => (
          <div key={d.k} className="flex-1 h-full flex items-end group" title={d.titulo}>
            <div className="w-full rounded-t bg-brand-600/80 group-hover:bg-brand-600 transition-colors" style={{ height: `${Math.max(d.n ? 2 : 0, (d.n / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-[2px] mt-1 text-[10px] text-ink/45">
        {datos.map((d, i) => <div key={d.k} className="flex-1 text-center truncate">{datos.length <= 10 || i % Math.ceil(datos.length / 8) === 0 ? etiqueta(d.k) : ""}</div>)}
      </div>
    </div>
  );
}

function Ranking({ titulo, filas, fmt }: { titulo: string; filas: { k: string; n: number; extra?: string | null }[]; fmt?: (k: string) => string }) {
  const max = Math.max(1, ...filas.map((f) => f.n));
  return (
    <div className="card p-4">
      <div className="text-sm font-medium text-ink mb-2">{titulo}</div>
      {!filas.length && <p className="text-sm text-ink/40">Sin eventos.</p>}
      <ul className="space-y-1.5">
        {filas.slice(0, 8).map((f) => (
          <li key={f.k} className="text-sm">
            <div className="flex justify-between gap-3"><span className="truncate text-ink/80" title={f.k}>{fmt ? fmt(f.k) : f.k}{f.extra && <span className="text-ink/45"> · {f.extra}</span>}</span><span className="tabular-nums text-ink/60">{num(f.n)}</span></div>
            <div className="h-1 rounded bg-line/[0.06] mt-0.5"><div className="h-1 rounded bg-brand-600/60" style={{ width: `${(f.n / max) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Configuración (solo administradores)
// ---------------------------------------------------------------------------------------------
function Configuracion({ estado, alCambiar }: { estado: Estado; alCambiar: () => void }) {
  const [f, setF] = useState({
    activo: estado.activo, alertar_cambios: estado.alertar_cambios, alertar_logins: estado.alertar_logins, alertar_config: estado.alertar_config,
    alertar_ataques: estado.alertar_ataques, umbral_mitigados: estado.umbral_mitigados, dias_cert: estado.dias_cert,
  });
  const [aviso, setAviso] = useState<{ ok: boolean; t: string } | null>(null);

  async function guardar() {
    const { error } = await createClient().rpc("cf_guardar", { p: f });
    setAviso(error ? { ok: false, t: error.message } : { ok: true, t: "Guardado." });
    if (!error) alCambiar();
  }

  return (
    <div className="card p-5 space-y-4">
      <h2 className="font-medium text-ink">Configuración de Cloudflare</h2>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-3xl">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} />Leer Cloudflare cada 15 minutos</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.alertar_cambios} onChange={(e) => setF({ ...f, alertar_cambios: e.target.checked })} />Avisar cada cambio en la cuenta</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.alertar_logins} onChange={(e) => setF({ ...f, alertar_logins: e.target.checked })} />Avisar cada inicio de sesión (los fallidos se avisan siempre)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.alertar_config} onChange={(e) => setF({ ...f, alertar_config: e.target.checked })} />Avisar configuración débil y certificados por vencer</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.alertar_ataques} onChange={(e) => setF({ ...f, alertar_ataques: e.target.checked })} />Avisar picos de ataques</label>
        <label className="flex items-center gap-2">Pico: más de
          <input type="number" min={1} className="input w-28" value={f.umbral_mitigados} onChange={(e) => setF({ ...f, umbral_mitigados: Number(e.target.value) })} />
          solicitudes frenadas en 24 h</label>
        <label className="flex items-center gap-2">Avisar certificados que vencen en
          <input type="number" min={1} max={90} className="input w-20" value={f.dias_cert} onChange={(e) => setF({ ...f, dias_cert: Number(e.target.value) })} />
          días o menos</label>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={guardar}>Guardar</button>
        {aviso && <p role="status" className={`text-sm ${aviso.ok ? "text-emerald-700" : "text-red-600"}`}>{aviso.t}</p>}
      </div>
      <details className="text-sm text-ink/70" open={!estado.ultima_ejecucion}>
        <summary className="cursor-pointer font-medium text-ink">Cómo se conecta (token de solo lectura)</summary>
        <ol className="list-decimal pl-5 space-y-1.5 mt-2 max-w-3xl">
          <li>En Cloudflare: <b>My Profile → API Tokens → Create Token → Create Custom Token</b>. Nombre sugerido: <code>accusys-cyber-lectura</code>.</li>
          <li>Permisos, todos en <b>Read</b>:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li><b>Account</b> → Account Settings (auditoría de la cuenta e inicios de sesión)</li>
              <li><b>Zone</b> → Zone, Zone Settings, DNS, SSL and Certificates, Analytics</li>
            </ul>
          </li>
          <li><b>Account Resources</b>: la cuenta de Accusys. <b>Zone Resources</b>: <i>All zones from an account</i> → la cuenta de Accusys.</li>
          <li>Opcional: en <b>Client IP Address Filtering</b> no hace falta poner nada (Vercel no tiene IP fija). Poné una fecha de vencimiento si la política lo pide: la app avisa cuando se acerca.</li>
          <li>En Vercel (proyecto accusys-cyber → Settings → Environment Variables) cargá <code>CLOUDFLARE_API_TOKEN</code> con el token. Si el token ve más de una cuenta, cargá también <code>CLOUDFLARE_ACCOUNT_ID</code>.</li>
          <li>Publicá de nuevo (Redeploy) y tocá <b>Leer ahora</b>. La primera lectura trae 30 días de auditoría como historial, sin avisar.</li>
        </ol>
        <p className="mt-2 text-xs text-ink/50">El token no se guarda en la base y no tiene permisos de escritura: la app no puede cambiar nada en Cloudflare.
          Usa la misma clave <code>CRON_SECRET</code> que las demás tareas programadas.</p>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------------------------
function Contenido() {
  const { esAdmin } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (VISTAS.some(([k]) => k === params.get("vista")) ? params.get("vista") : "resumen") as Vista;
  const ir = (q: string) => router.replace(`/inventario/cloudflare${q ? `?${q}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<Estado | null>(null);
  const [dns, setDns] = useState<Registro[]>([]);
  const [auditoria, setAuditoria] = useState<EventoAud[]>([]);
  const [trafico, setTrafico] = useState<DiaTrafico[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; t: string } | null>(null);
  const [ahora, setAhora] = useState(Date.now());
  const [zona, setZona] = useState("");
  const [texto, setTexto] = useState("");
  const [filtroDns, setFiltroDns] = useState<"" | "expuestos" | "justificados" | "proxy" | "solo_dns">("");
  const [tipo, setTipo] = useState("");
  const [cat, setCat] = useState("");
  const [abierta, setAbierta] = useState<string | null>(null);
  const [justificando, setJustificando] = useState<{ nombre: string; tipo: string; nota: string } | null>(null);

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, l] = await Promise.all([sb.rpc("cf_estado"), sb.rpc("cf_listar")]);
    const err = e.error ?? l.error;
    setError(err ? (/cf_(estado|listar)/.test(err.message) ? "Falta ejecutar supabase/cloudflare.sql en Supabase." : err.message) : null);
    setEstado((e.data as Estado) ?? null);
    const d = (l.data ?? {}) as { dns?: Registro[]; auditoria?: EventoAud[]; trafico?: DiaTrafico[] };
    setDns(d.dns ?? []); setAuditoria(d.auditoria ?? []); setTrafico(d.trafico ?? []);
    setAhora(Date.now());
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 300000); return () => clearInterval(t); }, [cargar]);

  async function leerAhora() {
    setLeyendo(true); setResultado(null);
    const r = await fetch("/api/cloudflare/auto", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setLeyendo(false);
    if (!r.ok) setResultado({ ok: false, t: j.error ?? "No se pudo leer Cloudflare" });
    else if (j.omitido) setResultado({ ok: false, t: j.omitido });
    else setResultado({
      ok: true, t: `Listo: ${j.zonas} zona(s), ${j.registros} registros DNS y ${j.auditoria} evento(s) de auditoría nuevos.`
        + (j.errores?.length ? ` Partes sin leer: ${j.errores.map((x: any) => `${x.zona} (${Object.keys(x).filter((k) => k !== "zona").join(", ")})`).join("; ")}.` : ""),
    });
    cargar();
  }

  async function justificar() {
    if (!justificando) return;
    const { error } = await createClient().rpc("cf_justificar", { p_nombre: justificando.nombre, p_tipo: justificando.tipo, p_nota: justificando.nota });
    if (error) { alert(error.message); return; }
    setJustificando(null); cargar();
  }
  async function quitarJustificacion(r: Registro) {
    if (!confirm(`¿Quitar la justificación de ${r.nombre}? Vuelve a contar como IP expuesta.`)) return;
    const { error } = await createClient().rpc("cf_quitar_justificacion", { p_nombre: r.nombre, p_tipo: r.tipo });
    if (error) { alert(error.message); return; }
    cargar();
  }

  const zonas = estado?.zonas ?? [];
  const deZona = (n: string | null) => !zona || n === zona;
  const q = texto.trim().toLowerCase();

  const controles = zonas.flatMap((z) => z.controles.map((c) => ({ ...c, zona: z.nombre })));
  const corregir = controles.filter((c) => c.nivel === "mal");
  const mejorar = controles.filter((c) => c.nivel === "aviso");
  const expuestos = dns.filter((r) => r.expuesto && !r.justificacion);
  const cambios7 = auditoria.filter((a) => a.accion !== "login" && Date.parse(a.fecha) > ahora - 7 * 86400000);
  const fallidos7 = auditoria.filter((a) => a.accion === "login" && a.resultado === "failure" && Date.parse(a.fecha) > ahora - 7 * 86400000);
  const mitigados24 = zonas.reduce((s, z) => s + (z.eventos?.mitigados ?? 0), 0);
  const retraso = estado?.ultimo_ok ? ahora - Date.parse(estado.ultimo_ok) : null;
  const atrasada = !!estado?.activo && !!estado.ultima_ejecucion && (retraso == null || retraso > 45 * 60000);

  const tarjetas = [
    { t: "Dominios", n: num(zonas.length), c: "text-ink", v: "resumen" as Vista, f: () => {} },
    { t: "Configuración a corregir", n: num(corregir.length), c: corregir.length ? "text-red-600" : "text-ink", v: "seguridad" as Vista, f: () => {} },
    { t: "Registros con IP expuesta", n: num(expuestos.length), c: expuestos.length ? "text-amber-700" : "text-ink", v: "dns" as Vista, f: () => setFiltroDns("expuestos") },
    { t: "Cambios en 7 días", n: num(cambios7.length), c: "text-ink", v: "cambios" as Vista, f: () => setCat("") },
    { t: "Ingresos fallidos en 7 días", n: num(fallidos7.length), c: fallidos7.length ? "text-red-600" : "text-ink", v: "cambios" as Vista, f: () => setCat("fallidos") },
    { t: "Solicitudes frenadas (24 h)", n: num(mitigados24), c: estado && mitigados24 >= estado.umbral_mitigados ? "text-amber-700" : "text-ink", v: "trafico" as Vista, f: () => {} },
  ];

  const listaDns = useMemo(() => dns.filter((r) =>
    deZona(r.zona) && (!tipo || r.tipo === tipo) &&
    (!filtroDns || (filtroDns === "expuestos" ? r.expuesto && !r.justificacion : filtroDns === "justificados" ? !!r.justificacion : filtroDns === "proxy" ? r.proxied : !r.proxied)) &&
    (!q || r.nombre.includes(q) || r.contenido.toLowerCase().includes(q) || (r.comentario ?? "").toLowerCase().includes(q))),
  [dns, zona, tipo, filtroDns, q]);

  const listaAud = useMemo(() => auditoria.filter((a) =>
    deZona(a.zona) &&
    (!cat || (cat === "fallidos" ? a.accion === "login" && a.resultado === "failure" : a.categoria === cat)) &&
    (!q || [a.actor, a.ip, a.detalle, a.descripcion, a.zona, a.recurso_tipo, a.producto].some((x) => x?.toLowerCase().includes(q)))),
  [auditoria, zona, cat, q]);

  const tiposDns = useMemo(() => Array.from(new Set(dns.map((r) => r.tipo))).sort(), [dns]);

  const exportarDns = () => exportarExcel(`cloudflare-dns-${new Date().toISOString().slice(0, 10)}`,
    ["Dominio", "Nombre", "Tipo", "Contenido", "Proxy de Cloudflare", "IP expuesta", "Justificación", "Justificado por", "TTL", "Comentario", "Modificado"],
    listaDns.map((r) => [r.zona, r.nombre, r.tipo, r.contenido, r.proxied ? "Sí" : "No (solo DNS)", r.expuesto ? "Sí" : "No", r.justificacion ?? "", r.justif_por ?? "",
      r.ttl === 1 ? "Automático" : r.ttl ?? "", r.comentario ?? "", r.modificado ? new Date(r.modificado).toLocaleDateString("es-AR") : ""]),
    { Nombre: 40, Contenido: 40, Justificación: 50 });
  const exportarAud = () => exportarExcel(`cloudflare-cambios-${new Date().toISOString().slice(0, 10)}`,
    ["Fecha", "Tipo", "Acción", "Resultado", "Quién", "IP", "Desde", "Dominio", "Detalle", "Recurso"],
    listaAud.map((a) => [new Date(a.fecha).toLocaleString("es-AR"), CATEGORIA[a.categoria] ?? a.categoria, ACCION[a.accion]?.t ?? a.accion,
      a.resultado === "failure" ? "Falló" : "Ok", a.actor ?? "", a.ip ?? "", CONTEXTO[a.contexto ?? ""] ?? a.contexto ?? "", a.zona ?? "",
      a.detalle ?? a.descripcion ?? "", [a.producto, a.recurso_tipo].filter(Boolean).join(" · ")]),
    { Quién: 32, Detalle: 60, Recurso: 30 });

  // Tráfico: suma por día de las zonas visibles
  const porDia = useMemo(() => {
    const m = new Map<string, DiaTrafico>();
    for (const t of trafico.filter((x) => deZona(x.zona))) {
      const a = m.get(t.dia) ?? { zona: "", dia: t.dia, solicitudes: 0, cacheadas: 0, amenazas: 0, bytes: 0, visitantes: 0 };
      a.solicitudes += t.solicitudes; a.cacheadas += t.cacheadas; a.amenazas += t.amenazas; a.bytes += t.bytes; a.visitantes += t.visitantes;
      m.set(t.dia, a);
    }
    return Array.from(m.values()).sort((a, b) => a.dia.localeCompare(b.dia)).slice(-14);
  }, [trafico, zona]);

  // Eventos del firewall de las zonas visibles, sumados
  const ev = useMemo(() => {
    const suma = (k: "paises" | "fuentes" | "rutas" | "por_accion") => {
      const m = new Map<string, number>();
      zonas.filter((z) => deZona(z.nombre)).forEach((z) => (z.eventos?.[k] ?? []).forEach((x) => m.set(x.k, (m.get(x.k) ?? 0) + x.n)));
      return Array.from(m, ([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
    };
    const ips = zonas.filter((z) => deZona(z.nombre)).flatMap((z) => (z.eventos?.ips ?? []).map((x) => ({ k: x.k, n: x.n, extra: [x.pais, zona ? null : z.nombre].filter(Boolean).join(" · ") })))
      .sort((a, b) => b.n - a.n);
    const horas = new Map<string, number>();
    zonas.filter((z) => deZona(z.nombre)).forEach((z) => (z.eventos?.por_hora ?? []).forEach((x) => horas.set(x.h, (horas.get(x.h) ?? 0) + x.n)));
    return {
      paises: suma("paises"), fuentes: suma("fuentes"), rutas: suma("rutas"), acciones: suma("por_accion"), ips,
      horas: Array.from(horas, ([h, n]) => ({ h, n })).sort((a, b) => a.h.localeCompare(b.h)),
      mitigados: zonas.filter((z) => deZona(z.nombre)).reduce((s, z) => s + (z.eventos?.mitigados ?? 0), 0),
      sinDatos: zonas.filter((z) => deZona(z.nombre) && !z.eventos).map((z) => ({ z: z.nombre, e: z.errores?.eventos })),
    };
  }, [zonas, zona]);

  const filtroZona = (
    <select className="input w-auto max-w-[16rem]" value={zona} onChange={(e) => setZona(e.target.value)} aria-label="Dominio">
      <option value="">Todos los dominios</option>
      {zonas.map((z) => <option key={z.id} value={z.nombre}>{z.nombre}</option>)}
    </select>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Cloudflare</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Dominios, registros DNS, configuración de seguridad, quién cambió qué en la cuenta y los ataques que frena Cloudflare.
            Se lee cada 15 minutos con un token de solo lectura: la app no puede cambiar nada en Cloudflare.
          </p>
        </div>
        {esAdmin && estado && (
          <div className="flex gap-2">
            {estado.clave_configurada && <button className="btn-secondary" onClick={leerAhora} disabled={leyendo}>{leyendo ? "Leyendo… (hasta 1 min)" : "Leer ahora"}</button>}
            <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {resultado && <p role="status" className={`text-sm rounded-md px-3 py-2 ${resultado.ok ? "text-emerald-800 bg-emerald-50" : "text-red-700 bg-red-50"}`}>{resultado.t}</p>}
      {estado && !estado.ultima_ejecucion && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no se leyó Cloudflare. {esAdmin ? "Tocá “Configurar” para ver cómo crear el token de solo lectura y cargarlo en Vercel." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <Configuracion estado={estado} alCambiar={cargar} />}

      {estado?.ultima_ejecucion && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${atrasada || estado.ultimo_error ? "bg-amber-500/10" : ""}`}>
          <span className={atrasada ? "text-red-600" : ""}><b>Última lectura:</b> {estado.ultimo_ok ? hace(estado.ultimo_ok, ahora) : "nunca terminó bien"}
            {!estado.activo && <span className="text-ink/50"> · lectura automática apagada</span>}</span>
          {estado.cuenta_nombre && <span><b>Cuenta:</b> {estado.cuenta_nombre}</span>}
          {estado.ultimo_error && <span className="text-red-600 basis-full"><b>Error:</b> {estado.ultimo_error}</span>}
          {estado.auditoria_error && <span className="text-amber-800 basis-full"><b>Auditoría:</b> {estado.auditoria_error}</span>}
          {(estado.avisos ?? []).length > 0 && <span className="text-amber-800 basis-full"><b>Avisos:</b> {estado.avisos.join(" · ")}</span>}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {tarjetas.map((t) => (
          <button key={t.t} onClick={() => { t.f(); ir(t.v === "resumen" ? "" : `vista=${t.v}`); }}
            className="card p-5 text-left transition-colors hover:border-brand-300">
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div role="tablist" aria-label="Vistas" className="flex flex-wrap gap-1 rounded-xl bg-line/[0.05] p-1">
          {VISTAS.map(([k, t]) => (
            <button key={k} role="tab" aria-selected={vista === k} onClick={() => ir(k === "resumen" ? "" : `vista=${k}`)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${vista === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
        {vista !== "resumen" && vista !== "seguridad" && (
          <div className="flex flex-wrap gap-2 items-center">
            {filtroZona}
            {vista === "dns" && (
              <>
                <select className="input w-auto" value={filtroDns} onChange={(e) => setFiltroDns(e.target.value as typeof filtroDns)} aria-label="Filtro">
                  <option value="">Todos</option><option value="expuestos">IP expuesta sin justificar</option><option value="justificados">Justificados</option>
                  <option value="proxy">Con proxy</option><option value="solo_dns">Solo DNS</option>
                </select>
                <select className="input w-auto" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo">
                  <option value="">Todos los tipos</option>{tiposDns.map((t) => <option key={t}>{t}</option>)}
                </select>
              </>
            )}
            {vista === "cambios" && (
              <select className="input w-auto" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Tipo de evento">
                <option value="">Todos los eventos</option><option value="fallidos">Ingresos fallidos</option>
                {Object.entries(CATEGORIA).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            )}
            {(vista === "dns" || vista === "cambios") && <input type="search" className="input max-w-xs" placeholder="Buscar…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />}
            {vista === "dns" && <button className="btn-secondary" onClick={exportarDns} disabled={!listaDns.length}>Exportar a Excel</button>}
            {vista === "cambios" && <button className="btn-secondary" onClick={exportarAud} disabled={!listaAud.length}>Exportar a Excel</button>}
          </div>
        )}
      </div>

      {/* Resumen: una tarjeta por dominio */}
      {vista === "resumen" && (
        <div className="space-y-4">
          {!zonas.length && <div className="card p-8 text-center text-ink/40 text-sm">{cargando ? "Cargando…" : "Sin dominios todavía. Aparecen con la primera lectura."}</div>}
          <div className="grid md:grid-cols-2 gap-4">
            {zonas.map((z) => {
              const p = peor(z.controles);
              const malos = z.controles.filter((c) => c.nivel === "mal" || c.nivel === "aviso");
              return (
                <div key={z.id} className="card p-5 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-ink text-lg">{z.nombre}</div>
                      <div className="text-xs text-ink/50 mt-0.5">{[z.plan, z.con_proxy ? `${z.con_proxy} de ${z.registros} registros con proxy` : `${z.registros} registros · solo DNS`].filter(Boolean).join(" · ")}</div>
                    </div>
                    <span className={`pill ${NIVEL[p].pill}`}>{p === "ok" ? "Todo bien" : NIVEL[p].t}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink/70">
                    {z.controles.filter((c) => c.nivel !== "na").map((c) => <span key={c.k} className="inline-flex items-center gap-1.5"><Punto n={c.nivel} titulo={c.texto} />{c.titulo}</span>)}
                  </div>
                  {malos.length > 0 && (
                    <ul className="text-sm space-y-1">
                      {malos.sort((a, b) => NIVEL[a.nivel].o - NIVEL[b.nivel].o).map((c) => (
                        <li key={c.k} className="flex gap-2"><span className="mt-1.5"><Punto n={c.nivel} /></span><span><b className="text-ink">{c.titulo}:</b> <span className="text-ink/70">{c.texto}</span></span></li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink/55 border-t border-line/[0.06] pt-2">
                    <span>Frenadas 24 h: <b className="text-ink/80">{z.eventos ? num(z.eventos.mitigados) : "sin dato"}</b></span>
                    <span>Cambios 7 días: <b className="text-ink/80">{cambios7.filter((a) => a.zona === z.nombre).length}</b></span>
                    {Object.keys(z.errores ?? {}).length > 0 && <span className="text-amber-700" title={Object.entries(z.errores).map(([k, v]) => `${k}: ${v}`).join("\n")}>No se pudo leer: {Object.keys(z.errores).join(", ")}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Seguridad: semáforo dominio × control */}
      {vista === "seguridad" && (
        <div className="space-y-3">
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead>
                <tr><th>Dominio</th>{(zonas[0]?.controles ?? []).map((c) => <th key={c.k} className="text-center whitespace-nowrap">{c.titulo}</th>)}<th></th></tr>
              </thead>
              <tbody>
                {!zonas.length && <tr><td colSpan={10} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : "Sin datos todavía."}</td></tr>}
                {zonas.map((z) => (
                  <Fragment key={z.id}>
                    <tr className="cursor-pointer" onClick={() => setAbierta(abierta === z.id ? null : z.id)}>
                      <td className="text-sm font-medium whitespace-nowrap">{z.nombre}</td>
                      {z.controles.map((c) => (
                        <td key={c.k} className="text-center" title={c.texto}>
                          <span className="inline-flex items-center gap-1.5 text-xs text-ink/70"><Punto n={c.nivel} titulo={c.texto} />
                            {c.nivel === "na" ? "—" : (c.k === "ssl" || c.k === "min_tls") ? String(c.valor ?? "—") : c.k === "expuestos" ? String(c.valor) : NIVEL[c.nivel].t}
                          </span>
                        </td>
                      ))}
                      <td className="text-xs text-brand-600 whitespace-nowrap">{abierta === z.id ? "Ocultar" : "Detalle"}</td>
                    </tr>
                    {abierta === z.id && (
                      <tr>
                        <td colSpan={z.controles.length + 2} className="bg-line/[0.02]">
                          <ul className="text-sm space-y-1.5 py-1">
                            {z.controles.map((c) => (
                              <li key={c.k} className="flex gap-2"><span className="mt-1.5"><Punto n={c.nivel} /></span>
                                <span><b className="text-ink">{c.titulo}:</b> <span className="text-ink/70">{c.texto}</span></span></li>
                            ))}
                          </ul>
                          {z.ns?.length > 0 && <p className="text-xs text-ink/50 mt-2">Nameservers: {z.ns.join(", ")}</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink/60">
            {(["mal", "aviso", "ok", "sin_dato", "na"] as Nivel[]).map((n) => <span key={n} className="inline-flex items-center gap-1.5"><Punto n={n} />{NIVEL[n].t}</span>)}
          </div>
          <p className="text-xs text-ink/50 max-w-4xl">
            SSL, TLS, HTTPS forzado, HSTS y certificado solo aplican a los registros que pasan por el proxy de Cloudflare (nube naranja): si un dominio
            usa Cloudflare solo como DNS, el tráfico va directo al servidor y esa configuración no se usa. «Corregir» abre una alerta; «Mejorar» queda acá como recomendación.
          </p>
        </div>
      )}

      {/* Registros DNS */}
      {vista === "dns" && (
        <div className="space-y-3">
          {justificando && (
            <div className="card p-4 space-y-3 border border-amber-500/30">
              <div className="font-medium text-ink">Justificar <span className="font-mono">{justificando.nombre}</span> ({justificando.tipo})</div>
              <p className="text-sm text-ink/70">Deja de contar como IP expuesta. Usalo para servicios que no pueden ir por el proxy de Cloudflare (VPN, correo, FTP, etc.).</p>
              <input className="input w-full" placeholder="Motivo (por ejemplo: VPN de FortiClient, no admite proxy)" value={justificando.nota}
                onChange={(e) => setJustificando({ ...justificando, nota: e.target.value })} />
              <div className="flex gap-2"><button className="btn-primary" onClick={justificar}>Justificar</button><button className="btn-secondary" onClick={() => setJustificando(null)}>Cancelar</button></div>
            </div>
          )}
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Nombre</th><th>Tipo</th><th>Apunta a</th><th>Proxy</th><th>Modificado</th>{esAdmin && <th></th>}</tr></thead>
              <tbody>
                {!listaDns.length && <tr><td colSpan={6} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : dns.length ? "Sin registros con ese filtro." : "Sin datos todavía."}</td></tr>}
                {listaDns.slice(0, 1000).map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm"><div className="font-medium text-ink">{r.nombre}</div>
                      {!zona && <div className="text-xs text-ink/45">{r.zona}</div>}
                      {r.comentario && <div className="text-xs text-ink/55">{r.comentario}</div>}
                      {r.justificacion && <div className="text-xs text-ink/55">Justificado: {r.justificacion}{r.justif_por && ` · ${r.justif_por}`}</div>}</td>
                    <td className="text-sm text-ink/70">{r.tipo}</td>
                    <td className="text-sm text-ink/70 font-mono break-all max-w-md">{r.contenido}</td>
                    <td className="text-sm whitespace-nowrap">
                      {r.proxied ? <span className="pill bg-orange-500/15 text-orange-700">Con proxy</span>
                        : r.expuesto && !r.justificacion ? <span className="pill bg-amber-500/15 text-amber-700" title="Cualquiera ve la IP real del servidor y puede atacarlo sin pasar por Cloudflare">Solo DNS · IP expuesta</span>
                        : <span className="pill bg-line/[0.05] text-ink/60">Solo DNS</span>}
                    </td>
                    <td className="text-sm text-ink/60 whitespace-nowrap">{r.modificado ? new Date(r.modificado).toLocaleDateString("es-AR") : "—"}</td>
                    {esAdmin && (
                      <td className="text-right whitespace-nowrap">
                        {r.justificacion ? <button className="text-xs text-ink/60 hover:underline" onClick={() => quitarJustificacion(r)}>Quitar justificación</button>
                          : r.expuesto ? <button className="text-xs text-ink/60 hover:underline" onClick={() => setJustificando({ nombre: r.nombre, tipo: r.tipo, nota: "" })}>Justificar</button> : null}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {listaDns.length > 1000 && <p className="text-xs text-ink/50">Se muestran los primeros 1000 de {listaDns.length}. Usá los filtros o exportá a Excel.</p>}
          <p className="text-xs text-ink/50 max-w-4xl">
            «IP expuesta»: registros A o AAAA que apuntan a una IP pública sin el proxy de Cloudflare. Muestran la dirección real del servidor y
            permiten atacarlo sin pasar por la protección de Cloudflare. Algunos son necesarios (VPN, correo): justificalos para que no cuenten.
          </p>
        </div>
      )}

      {/* Cambios y accesos */}
      {vista === "cambios" && (
        <div className="space-y-3">
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Fecha</th><th>Evento</th><th>Detalle</th><th>Quién</th><th>Desde</th></tr></thead>
              <tbody>
                {!listaAud.length && <tr><td colSpan={5} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : auditoria.length ? "Nada coincide con el filtro." : "Sin eventos en los últimos 90 días."}</td></tr>}
                {listaAud.slice(0, 500).map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm whitespace-nowrap">{fecha(a.fecha)} <span className="text-xs text-ink/50">· {hace(a.fecha, ahora)}</span></td>
                    <td className="text-sm whitespace-nowrap">
                      <span className={`pill ${a.resultado === "failure" ? "bg-red-50 text-red-700" : ACCION[a.accion]?.c ?? "bg-line/[0.05] text-ink/70"}`}>
                        {a.accion === "login" ? (a.resultado === "failure" ? "Ingreso fallido" : "Ingreso") : ACCION[a.accion]?.t ?? a.accion}
                      </span>
                      <span className="text-xs text-ink/55 ml-1.5">{CATEGORIA[a.categoria] ?? a.categoria}</span>
                      {a.resultado === "failure" && a.accion !== "login" && <span className="text-xs text-red-600 ml-1">falló</span>}
                    </td>
                    <td className="text-sm max-w-md">
                      <div className="text-ink/80 break-words">{a.detalle ?? a.descripcion ?? [a.producto, a.recurso_tipo].filter(Boolean).join(" · ")}</div>
                      {a.zona && !zona && <div className="text-xs text-ink/45">{a.zona}</div>}
                    </td>
                    <td className="text-sm">{a.actor ?? <span className="text-ink/40">—</span>}{a.actor_tipo && a.actor_tipo !== "user" && <span className="text-xs text-ink/45"> · {a.actor_tipo}</span>}</td>
                    <td className="text-sm whitespace-nowrap"><span className="font-mono text-ink/70">{a.ip ?? "—"}</span>
                      {a.contexto && <div className="text-xs text-ink/50">{CONTEXTO[a.contexto] ?? a.contexto}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink/50 max-w-4xl">
            Sale de la auditoría de la cuenta de Cloudflare (se guarda 2 años; acá se muestran los últimos 90 días). No figuran las consultas de
            solo lectura, como las que hace esta app. Cada cambio nuevo y cada ingreso fallido abre una alerta y avisa por Teams.
          </p>
        </div>
      )}

      {/* Tráfico y ataques */}
      {vista === "trafico" && (
        <div className="space-y-4">
          {ev.sinDatos.length > 0 && (
            <div className="card p-3 text-sm bg-amber-500/10">
              Sin eventos del firewall para: {ev.sinDatos.map((x) => x.z).join(", ")}.
              {ev.sinDatos.some((x) => /disponible|plan/i.test(x.e ?? "")) ? " El plan de esas zonas no da acceso a las analíticas de seguridad por API." : ev.sinDatos.some((x) => x.e) ? ` ${ev.sinDatos.find((x) => x.e)?.e}` : ""}
            </div>
          )}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="flex justify-between items-baseline mb-3">
                <div className="text-sm font-medium text-ink">Solicitudes frenadas por hora (24 h)</div>
                <div className="text-sm text-ink/60 tabular-nums">{num(ev.mitigados)} en total</div>
              </div>
              <Barras datos={ev.horas.map((h) => ({ k: h.h, n: h.n, titulo: `${new Date(h.h).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}: ${num(h.n)} frenadas` }))}
                etiqueta={(k) => `${new Date(k).getHours()}h`} />
            </div>
            <div className="card p-4">
              <div className="flex justify-between items-baseline mb-3">
                <div className="text-sm font-medium text-ink">Solicitudes por día</div>
                <div className="text-sm text-ink/60 tabular-nums">{num(porDia.reduce((s, d) => s + d.solicitudes, 0))} en {porDia.length} días</div>
              </div>
              <Barras datos={porDia.map((d) => ({ k: d.dia, n: d.solicitudes, titulo: `${diaCorto(d.dia)}: ${num(d.solicitudes)} solicitudes · ${num(d.amenazas)} amenazas · ${num(d.visitantes)} visitantes · ${bytes(d.bytes)}` }))}
                etiqueta={(k) => diaCorto(k).split(" ")[1] ?? k} />
            </div>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <Ranking titulo="Países de origen (frenadas)" filas={ev.paises} />
            <Ranking titulo="IPs que más se frenaron" filas={ev.ips} />
            <Ranking titulo="Qué las frenó" filas={ev.fuentes} fmt={(k) => FUENTE[k] ?? k} />
            <Ranking titulo="Rutas más atacadas" filas={ev.rutas} />
          </div>
          <div className="card p-4">
            <div className="text-sm font-medium text-ink mb-2">Todos los eventos del firewall por acción (24 h)</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {!ev.acciones.length && <span className="text-ink/40">Sin eventos.</span>}
              {ev.acciones.map((a) => <span key={a.k}>{ACCION_FW[a.k] ?? a.k}: <b className="tabular-nums">{num(a.n)}</b></span>)}
            </div>
          </div>
          {porDia.length > 0 && (
            <div className="card overflow-x-auto">
              <table className="data w-full">
                <thead><tr><th>Día</th><th className="text-right">Solicitudes</th><th className="text-right">Desde caché</th><th className="text-right">Amenazas</th><th className="text-right">Visitantes</th><th className="text-right">Datos</th></tr></thead>
                <tbody>
                  {[...porDia].reverse().map((d) => (
                    <tr key={d.dia}>
                      <td className="text-sm whitespace-nowrap">{diaCorto(d.dia)}</td>
                      <td className="text-sm text-right tabular-nums">{num(d.solicitudes)}</td>
                      <td className="text-sm text-right tabular-nums text-ink/70">{d.solicitudes ? `${Math.round((d.cacheadas / d.solicitudes) * 100)}%` : "—"}</td>
                      <td className={`text-sm text-right tabular-nums ${d.amenazas ? "text-amber-700" : "text-ink/60"}`}>{num(d.amenazas)}</td>
                      <td className="text-sm text-right tabular-nums text-ink/70">{num(d.visitantes)}</td>
                      <td className="text-sm text-right tabular-nums text-ink/70">{bytes(d.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-ink/50 max-w-4xl">
            «Frenadas» suma las solicitudes bloqueadas, desafiadas o con la conexión cerrada por Cloudflare. Los eventos que solo se registran
            o que se omiten se ven en el total por acción. Solo cuentan los registros que pasan por el proxy de Cloudflare.
          </p>
        </div>
      )}
    </div>
  );
}

export default function CloudflarePage() {
  return <Suspense><Contenido /></Suspense>;
}
