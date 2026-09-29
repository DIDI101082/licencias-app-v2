"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import PuenteAD, { type EstadoAD } from "@/components/PuenteAD";
import { hace } from "@/lib/monitoreo";

type Dominio = {
  dns: string | null; netbios: string | null; nivel_dominio: string | null; nivel_bosque: string | null; pdc: string | null; papelera: boolean | null;
  krbtgt_pwd: string | null; pwd_min: number | null; pwd_max_dias: number | null; pwd_historial: number | null; pwd_complejidad: boolean | null;
  bloqueo_umbral: number | null; actualizado: string | null;
};
type Dc = { nombre: string; host: string | null; so: string | null; sitio: string | null; gc: boolean | null; ip: string | null; roles: string | null; ultimo_reporte: string | null; version_puente: string | null; avisos: string[] };
type Hallazgo = { ambito: string; clave: string; tipo: string; severidad: string; titulo: string; detalle: string };
type Priv = { clave: string; grupo: string; privilegiado: boolean; sam: string; nombre: string | null; tipo: string | null; desde: string; habilitado: boolean | null; ultimo_logon: string | null; pwd_cambiada: string | null; pwd_no_vence: boolean | null; spn: boolean | null };
type Usuario = {
  sam: string; upn: string | null; nombre: string | null; mail: string | null; habilitado: boolean; ultimo_logon: string | null; pwd_cambiada: string | null;
  creado: string | null; pwd_no_vence: boolean; pwd_no_requerida: boolean; reversible: boolean; sin_preauth: boolean; delegacion: boolean; spn: boolean;
  admin_count: boolean; bloqueado: boolean; departamento: string | null; cargo: string | null;
};
type Equipo = { nombre: string; so: string | null; version: string | null; habilitado: boolean; ultimo_logon: string | null; creado: string | null; delegacion: boolean; es_dc: boolean; laps: boolean | null };
type Evento = { id: number; dc: string; fecha: string; evento: number | null; tipo: string; usuario: string | null; actor: string | null; grupo: string | null; ip: string | null; equipo: string | null; motivo: string | null };

type Vista = "resumen" | "hallazgos" | "privilegiados" | "usuarios" | "equipos" | "eventos";
const VISTAS: [Vista, string][] = [
  ["resumen", "Resumen"], ["hallazgos", "Hallazgos"], ["privilegiados", "Administradores"], ["usuarios", "Usuarios"], ["equipos", "Equipos"], ["eventos", "Eventos"],
];
const SEV: Record<string, { t: string; c: string; o: number }> = {
  critica: { t: "Crítica", c: "bg-red-600 text-white", o: 0 },
  alta: { t: "Alta", c: "bg-orange-500/15 text-orange-700", o: 1 },
  media: { t: "Media", c: "bg-amber-500/15 text-amber-700", o: 2 },
  baja: { t: "Baja", c: "bg-line/[0.05] text-ink/60", o: 3 },
};
const EVENTO: Record<string, { t: string; c: string }> = {
  usuario_creado: { t: "Usuario creado", c: "bg-emerald-50 text-emerald-700" },
  usuario_habilitado: { t: "Usuario habilitado", c: "bg-emerald-50 text-emerald-700" },
  usuario_deshabilitado: { t: "Usuario deshabilitado", c: "bg-line/[0.05] text-ink/60" },
  usuario_eliminado: { t: "Usuario eliminado", c: "bg-line/[0.05] text-ink/60" },
  contrasena_restablecida: { t: "Contraseña restablecida", c: "bg-line/[0.05] text-ink/70" },
  miembro_agregado: { t: "Agregado a grupo", c: "bg-orange-500/15 text-orange-700" },
  miembro_quitado: { t: "Quitado de grupo", c: "bg-line/[0.05] text-ink/60" },
  bloqueo: { t: "Cuenta bloqueada", c: "bg-amber-500/15 text-amber-700" },
  fallo_inicio: { t: "Inicio fallido", c: "bg-red-50 text-red-700" },
  fallo_kerberos: { t: "Contraseña incorrecta (Kerberos)", c: "bg-red-50 text-red-700" },
  fallo_ntlm: { t: "Contraseña incorrecta (NTLM)", c: "bg-red-50 text-red-700" },
  log_borrado: { t: "Log de seguridad borrado", c: "bg-red-600 text-white" },
  politica_dominio: { t: "Política del dominio cambiada", c: "bg-orange-500/15 text-orange-700" },
  dsrm: { t: "Contraseña DSRM cambiada", c: "bg-orange-500/15 text-orange-700" },
};
const FALLOS = ["fallo_inicio", "fallo_kerberos", "fallo_ntlm"];
// Códigos de error de Windows más comunes en los inicios fallidos
const MOTIVO: Record<string, string> = {
  "0x18": "contraseña incorrecta", "0xc000006a": "contraseña incorrecta", "0xc0000064": "usuario inexistente", "0x6": "usuario inexistente",
  "0xc0000234": "cuenta bloqueada", "0x12": "cuenta deshabilitada o bloqueada", "0xc0000072": "cuenta deshabilitada", "0xc0000071": "contraseña vencida",
  "0x17": "contraseña vencida", "0xc0000193": "cuenta vencida", "0xc000006f": "fuera del horario permitido", "0xc0000070": "equipo no permitido",
  "0xc0000224": "debe cambiar la contraseña",
};
const NIVEL = (n: string | null) => (n ? n.replace(/^Windows(\d{4})(R2)?(Domain|Forest)$/, "Windows Server $1 $2").replace(/\s+$/, "").replace(/\s+/g, " ") : "—");

const fecha = (f: string | null) => (f ? new Date(f).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", hour12: false }) : "—");
const dia = (f: string | null) => (f ? new Date(f).toLocaleDateString("es-AR") : "—");
const diasDesde = (f: string | null, ahora: number) => (f ? Math.floor((ahora - Date.parse(f)) / 86400000) : null);

function Contenido() {
  const { esAdmin } = usePerfil();
  const params = useSearchParams();
  const router = useRouter();
  const vista = (VISTAS.some(([k]) => k === params.get("vista")) ? params.get("vista") : "resumen") as Vista;
  const ir = (q: string) => router.replace(`/inventario/ad${q ? `?${q}` : ""}`, { scroll: false });

  const [estado, setEstado] = useState<EstadoAD | null>(null);
  const [dominio, setDominio] = useState<Dominio | null>(null);
  const [dcs, setDcs] = useState<Dc[]>([]);
  const [hallazgos, setHallazgos] = useState<Hallazgo[]>([]);
  const [priv, setPriv] = useState<Priv[]>([]);
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const [texto, setTexto] = useState("");
  const [filtroU, setFiltroU] = useState("habilitados");
  const [filtroE, setFiltroE] = useState("todos");
  const [filtroEv, setFiltroEv] = useState("");
  const [sevMin, setSevMin] = useState("");

  const cargar = useCallback(async () => {
    const sb = createClient();
    const [e, d, c, h, p, u, q, v] = await Promise.all([
      sb.rpc("ad_estado"),
      sb.from("ad_dominio").select("*").maybeSingle(),
      sb.from("ad_dcs").select("*").order("nombre"),
      sb.from("ad_hallazgos").select("*"),
      sb.from("ad_privilegiados").select("*"),
      sb.from("ad_usuarios").select("*").order("sam").limit(10000),
      sb.from("ad_equipos").select("*").order("nombre").limit(10000),
      sb.from("ad_eventos").select("*").order("fecha", { ascending: false }).limit(2000),
    ]);
    const err = e.error ?? d.error;
    setError(err ? (/ad_/.test(err.message) ? "Falta ejecutar supabase/ad.sql en Supabase." : err.message) : null);
    setEstado((e.data as EstadoAD) ?? null);
    setDominio((d.data as Dominio) ?? null);
    setDcs((c.data ?? []) as Dc[]);
    setHallazgos((h.data ?? []) as Hallazgo[]);
    setPriv((p.data ?? []) as Priv[]);
    setUsuarios((u.data ?? []) as Usuario[]);
    setEquipos((q.data ?? []) as Equipo[]);
    setEventos((v.data ?? []) as Evento[]);
    setAhora(Date.now());
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); const t = setInterval(cargar, 120000); return () => clearInterval(t); }, [cargar]);

  const q = texto.trim().toLowerCase();
  const coincide = (...v: (string | null | undefined)[]) => !q || v.some((x) => x?.toLowerCase().includes(q));
  const graves = hallazgos.filter((h) => h.severidad === "critica" || h.severidad === "alta");
  const habilitados = usuarios.filter((u) => u.habilitado);
  const privUsuarios = useMemo(() => new Set(priv.filter((p) => p.privilegiado && (p.tipo ?? "user") === "user").map((p) => p.sam)), [priv]);
  const dias = estado?.dias_inactivo ?? 90;
  const inactivos = habilitados.filter((u) => (diasDesde(u.ultimo_logon ?? u.creado, ahora) ?? 0) > dias);
  const fallos24 = eventos.filter((e) => FALLOS.includes(e.tipo) && Date.parse(e.fecha) > ahora - 86400000);
  const bloqueos24 = eventos.filter((e) => e.tipo === "bloqueo" && Date.parse(e.fecha) > ahora - 86400000);
  const reporteViejo = estado?.ultimo_reporte ? ahora - Date.parse(estado.ultimo_reporte) > (estado.minutos_sin_reporte ?? 30) * 60000 : false;
  const nombreDe = (sam: string) => usuarios.find((u) => u.sam === sam)?.nombre ?? sam;

  const tarjetas = [
    { t: "Hallazgos críticos o altos", n: graves.length, c: graves.length ? "text-red-600" : "text-ink", ir: "vista=hallazgos" },
    { t: "Cuentas con privilegios de administración", n: privUsuarios.size, c: privUsuarios.size > 6 ? "text-amber-700" : "text-ink", ir: "vista=privilegiados" },
    { t: `Usuarios habilitados sin uso (+${dias} días)`, n: inactivos.length, c: inactivos.length ? "text-amber-700" : "text-ink", ir: "vista=usuarios" },
    { t: "Intentos fallidos (24 h)", n: fallos24.length, c: fallos24.length > 50 ? "text-amber-700" : "text-ink", ir: "vista=eventos" },
    { t: "Cuentas bloqueadas (24 h)", n: new Set(bloqueos24.map((b) => b.usuario)).size, c: bloqueos24.length ? "text-amber-700" : "text-ink", ir: "vista=eventos" },
  ];

  // Fallos agrupados (para ver rápido quién o desde dónde)
  const fallosPor = (clave: (e: Evento) => string | null) => {
    const m = new Map<string, { n: number; usuarios: Set<string>; ultima: string }>();
    fallos24.forEach((e) => {
      const k = clave(e); if (!k) return;
      const x = m.get(k) ?? { n: 0, usuarios: new Set<string>(), ultima: e.fecha };
      x.n++; if (e.usuario) x.usuarios.add(e.usuario); if (e.fecha > x.ultima) x.ultima = e.fecha;
      m.set(k, x);
    });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  };

  const vacio = (cols: number, t: string) => <tr><td colSpan={cols} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : t}</td></tr>;
  const si = (b: boolean | null | undefined, t: string, c = "bg-amber-500/15 text-amber-700") => (b ? <span className={`pill ${c} mr-1`}>{t}</span> : null);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Active Directory</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Quién tiene privilegios en el dominio, cuentas de riesgo o que deberían estar dadas de baja, y los eventos de seguridad de los
            controladores de dominio: altas, cambios de grupos, bloqueos e intentos fallidos.
          </p>
        </div>
        {esAdmin && estado && <button className="btn-secondary" onClick={() => setConfig(!config)}>{config ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {estado && !estado.configurado && !config && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía no está instalado el puente de Active Directory. {esAdmin ? "Tocá “Configurar” para generarlo e instalarlo en los controladores de dominio." : "Pedile a un administrador que lo configure."}
        </div>
      )}
      {config && esAdmin && estado && <PuenteAD estado={estado} alCambiar={cargar} />}

      {estado?.configurado && (
        <div className={`card p-3 text-sm flex flex-wrap gap-x-6 gap-y-1 ${reporteViejo || !estado.ultimo_reporte ? "bg-amber-500/10" : ""}`}>
          <span className={reporteViejo ? "text-red-600" : ""}>
            <b>Último reporte:</b> {estado.ultimo_reporte ? hace(estado.ultimo_reporte, ahora) : "todavía no reportó (¿instalaste el puente?)"}
          </span>
          <span><b>Inventario:</b> {estado.ultimo_inventario ? hace(estado.ultimo_inventario, ahora) : "—"}</span>
          <span className={estado.alertas ? "text-emerald-700" : "text-ink/50"}><b>Alertas:</b> {estado.alertas ? "activadas" : "apagadas"}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {tarjetas.map((t) => (
          <button key={t.t} onClick={() => ir(t.ir)} className="card p-5 text-left hover:border-brand-300 transition-colors">
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
        {vista !== "resumen" && <input type="search" className="input max-w-xs" placeholder="Buscar usuario, equipo, grupo, IP…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />}
      </div>

      {/* Resumen */}
      {vista === "resumen" && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="card p-5 space-y-3">
            <h2 className="font-display text-lg text-ink">Dominio</h2>
            {!dominio?.dns ? <p className="text-sm text-ink/50">{cargando ? "Cargando…" : "Sin datos todavía."}</p> : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink/55">Nombre</dt><dd>{dominio.dns} <span className="text-ink/45">({dominio.netbios})</span></dd>
                <dt className="text-ink/55">Nivel funcional</dt><dd>Dominio {NIVEL(dominio.nivel_dominio)} · Bosque {NIVEL(dominio.nivel_bosque)}</dd>
                <dt className="text-ink/55">Maestro PDC</dt><dd>{dominio.pdc ?? "—"}</dd>
                <dt className="text-ink/55">Papelera de reciclaje</dt><dd>{dominio.papelera ? "Activada" : <span className="text-amber-700">Desactivada</span>}</dd>
                <dt className="text-ink/55">Contraseña de krbtgt</dt>
                <dd className={(diasDesde(dominio.krbtgt_pwd, ahora) ?? 0) > 180 ? "text-amber-700" : ""}>{dominio.krbtgt_pwd ? `hace ${diasDesde(dominio.krbtgt_pwd, ahora)} días` : "—"}</dd>
              </dl>
            )}
            {dominio?.dns && (
              <>
                <h3 className="text-sm font-medium text-ink pt-2">Política de contraseñas</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-ink/55">Largo mínimo</dt><dd className={(dominio.pwd_min ?? 0) < 12 ? "text-amber-700" : ""}>{dominio.pwd_min ?? "—"} caracteres</dd>
                  <dt className="text-ink/55">Complejidad</dt><dd>{dominio.pwd_complejidad ? "Exigida" : <span className="text-amber-700">No exigida</span>}</dd>
                  <dt className="text-ink/55">Vencimiento</dt><dd>{dominio.pwd_max_dias ? `${dominio.pwd_max_dias} días` : "No vence"}</dd>
                  <dt className="text-ink/55">Historial</dt><dd>{dominio.pwd_historial ?? "—"} contraseñas</dd>
                  <dt className="text-ink/55">Bloqueo</dt><dd>{dominio.bloqueo_umbral ? `a los ${dominio.bloqueo_umbral} intentos` : <span className="text-red-600">Sin bloqueo</span>}</dd>
                </dl>
              </>
            )}
          </div>
          <div className="card p-5 space-y-3">
            <h2 className="font-display text-lg text-ink">Controladores de dominio</h2>
            {!dcs.length && <p className="text-sm text-ink/50">{cargando ? "Cargando…" : "Sin datos todavía."}</p>}
            <ul className="space-y-3">
              {dcs.map((d) => {
                const viejo = !d.ultimo_reporte || ahora - Date.parse(d.ultimo_reporte) > (estado?.minutos_sin_reporte ?? 30) * 60000;
                return (
                  <li key={d.nombre} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{d.nombre}</span>
                      {d.ultimo_reporte
                        ? <span className={`pill ${viejo ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>Puente {viejo ? "sin reportar" : "OK"} · {hace(d.ultimo_reporte, ahora)}</span>
                        : <span className="pill bg-amber-500/15 text-amber-700">Sin puente</span>}
                    </div>
                    <div className="text-ink/55">{[d.so, d.ip, d.sitio, d.gc ? "Catálogo global" : null].filter(Boolean).join(" · ") || "—"}</div>
                    {d.roles && <div className="text-xs text-ink/45">Roles FSMO: {d.roles}</div>}
                    {(d.avisos ?? []).length > 0 && <div className="text-xs text-amber-700">Avisos: {d.avisos.join(" · ")}</div>}
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-line/[0.06] pt-3 text-sm text-ink/60">
              {usuarios.length} usuarios ({habilitados.length} habilitados) · {equipos.length} equipos
            </div>
          </div>
        </div>
      )}

      {/* Hallazgos */}
      {vista === "hallazgos" && (
        <div className="space-y-3">
          <div className="flex gap-2 items-center">
            <select className="input w-auto" value={sevMin} onChange={(e) => setSevMin(e.target.value)} aria-label="Severidad">
              <option value="">Todas las severidades</option>
              <option value="alta">Críticas y altas</option>
              <option value="media">Hasta media</option>
            </select>
            <span className="text-sm text-ink/50">{hallazgos.length} hallazgos</span>
          </div>
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Severidad</th><th>Hallazgo</th></tr></thead>
              <tbody>
                {!hallazgos.length && vacio(2, "Sin hallazgos. Se calculan con cada inventario del dominio.")}
                {hallazgos
                  .filter((h) => (!sevMin || SEV[h.severidad]?.o <= SEV[sevMin].o) && coincide(h.titulo, h.detalle, h.clave))
                  .sort((a, b) => (SEV[a.severidad]?.o ?? 9) - (SEV[b.severidad]?.o ?? 9) || a.titulo.localeCompare(b.titulo))
                  .map((h) => (
                    <tr key={`${h.tipo}:${h.clave}`}>
                      <td><span className={`pill ${SEV[h.severidad]?.c ?? ""}`}>{SEV[h.severidad]?.t ?? h.severidad}</span></td>
                      <td className="text-sm"><div className="font-medium text-ink">{h.titulo}</div><div className="text-ink/60">{h.detalle}</div></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Grupos privilegiados */}
      {vista === "privilegiados" && (
        <div className="space-y-4">
          {!priv.length && <div className="card p-8 text-center text-ink/40">{cargando ? "Cargando…" : "Sin datos todavía."}</div>}
          {[...new Set(priv.map((p) => p.clave))].map((clave) => {
            const filas = priv.filter((p) => p.clave === clave && coincide(p.sam, p.nombre, p.grupo));
            if (!filas.length) return null;
            return (
              <div key={clave} className="card overflow-x-auto">
                <div className="px-4 pt-4 flex items-baseline gap-2">
                  <span className="font-medium text-ink">{filas[0].grupo}</span>
                  <span className="text-xs text-ink/45">{filas.length} {filas.length === 1 ? "miembro" : "miembros"}{!filas[0].privilegiado ? " · grupo de protección (no da privilegios)" : ""}</span>
                </div>
                <table className="data w-full">
                  <thead><tr><th>Cuenta</th><th>Estado</th><th>Último inicio de sesión</th><th>Contraseña</th><th>En el grupo desde</th></tr></thead>
                  <tbody>
                    {filas.map((p) => (
                      <tr key={p.sam}>
                        <td className="text-sm"><span className="font-medium">{p.nombre ?? p.sam}</span>{p.nombre && p.nombre !== p.sam && <span className="text-ink/45"> · {p.sam}</span>}
                          {p.tipo && p.tipo !== "user" && <span className="pill bg-line/[0.05] text-ink/55 ml-1">{p.tipo === "group" ? "Grupo" : p.tipo === "computer" ? "Equipo" : p.tipo}</span>}
                        </td>
                        <td>{p.habilitado == null ? "—" : p.habilitado ? <span className="pill bg-emerald-50 text-emerald-700">Habilitada</span> : <span className="pill bg-line/[0.05] text-ink/55">Deshabilitada</span>}
                          {si(p.spn, "SPN", "bg-red-50 text-red-700")}</td>
                        <td className={`text-sm whitespace-nowrap ${(diasDesde(p.ultimo_logon, ahora) ?? 0) > dias ? "text-amber-700" : "text-ink/70"}`}>{p.ultimo_logon ? dia(p.ultimo_logon) : p.tipo === "user" ? "Nunca" : "—"}</td>
                        <td className="text-sm text-ink/70 whitespace-nowrap">{p.pwd_cambiada ? `hace ${diasDesde(p.pwd_cambiada, ahora)} días` : "—"}{p.pwd_no_vence && <span className="pill bg-amber-500/15 text-amber-700 ml-1">No vence</span>}</td>
                        <td className="text-sm text-ink/55 whitespace-nowrap">{dia(p.desde)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          <p className="text-xs text-ink/50">
            Incluye los miembros por grupos anidados. &ldquo;En el grupo desde&rdquo; es la primera vez que la app lo vio en el grupo. Cualquier alta nueva
            en estos grupos genera una alerta crítica.
          </p>
        </div>
      )}

      {/* Usuarios */}
      {vista === "usuarios" && (
        <div className="space-y-3">
          <select className="input w-auto" value={filtroU} onChange={(e) => setFiltroU(e.target.value)} aria-label="Filtro">
            <option value="habilitados">Habilitados</option>
            <option value="inactivos">Habilitados sin uso (+{dias} días)</option>
            <option value="riesgo">Con alguna marca de riesgo</option>
            <option value="bloqueados">Bloqueados</option>
            <option value="deshabilitados">Deshabilitados</option>
            <option value="todos">Todos</option>
          </select>
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Usuario</th><th>Área</th><th>Último inicio de sesión</th><th>Contraseña</th><th>Marcas</th></tr></thead>
              <tbody>
                {(() => {
                  const lista = usuarios.filter((u) =>
                    (filtroU === "todos" || (filtroU === "habilitados" && u.habilitado) || (filtroU === "deshabilitados" && !u.habilitado) ||
                     (filtroU === "bloqueados" && u.bloqueado) || (filtroU === "inactivos" && inactivos.includes(u)) ||
                     (filtroU === "riesgo" && u.habilitado && (u.pwd_no_requerida || u.reversible || u.sin_preauth || u.delegacion || u.spn || u.pwd_no_vence))) &&
                    coincide(u.sam, u.nombre, u.mail, u.upn, u.departamento, u.cargo));
                  if (!lista.length) return vacio(5, "Sin usuarios con ese filtro.");
                  return lista.slice(0, 1000).map((u) => {
                    const d = diasDesde(u.ultimo_logon, ahora);
                    return (
                      <tr key={u.sam} className={u.habilitado ? "" : "opacity-60"}>
                        <td className="text-sm"><div className="font-medium text-ink">{u.nombre ?? u.sam}
                          {privUsuarios.has(u.sam) && <span className="pill bg-orange-500/15 text-orange-700 ml-1">Admin</span>}</div>
                          <div className="text-xs text-ink/50">{u.sam}{u.mail ? ` · ${u.mail}` : ""}</div></td>
                        <td className="text-sm text-ink/70">{[u.departamento, u.cargo].filter(Boolean).join(" · ") || "—"}</td>
                        <td className={`text-sm whitespace-nowrap ${d != null && d > dias && u.habilitado ? "text-amber-700" : "text-ink/70"}`}>{u.ultimo_logon ? `${dia(u.ultimo_logon)} (hace ${d} días)` : "Nunca"}</td>
                        <td className="text-sm text-ink/70 whitespace-nowrap">{u.pwd_cambiada ? `hace ${diasDesde(u.pwd_cambiada, ahora)} días` : "—"}</td>
                        <td className="text-sm">
                          {!u.habilitado && <span className="pill bg-line/[0.05] text-ink/55 mr-1">Deshabilitado</span>}
                          {si(u.bloqueado, "Bloqueado")}
                          {si(u.pwd_no_vence, "No vence")}
                          {si(u.pwd_no_requerida, "Sin contraseña requerida", "bg-red-50 text-red-700")}
                          {si(u.reversible, "Cifrado reversible", "bg-red-50 text-red-700")}
                          {si(u.sin_preauth, "Sin preautenticación", "bg-red-50 text-red-700")}
                          {si(u.delegacion, "Delegación", "bg-red-50 text-red-700")}
                          {si(u.spn, "SPN")}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Equipos */}
      {vista === "equipos" && (
        <div className="space-y-3">
          <select className="input w-auto" value={filtroE} onChange={(e) => setFiltroE(e.target.value)} aria-label="Filtro">
            <option value="todos">Todos</option>
            <option value="servidores">Servidores</option>
            <option value="puestos">Puestos de trabajo</option>
            <option value="inactivos">Sin uso (+{dias} días)</option>
            <option value="sin_soporte">Sistema sin soporte</option>
          </select>
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Equipo</th><th>Sistema operativo</th><th>Último contacto</th><th>Marcas</th></tr></thead>
              <tbody>
                {(() => {
                  const sinSoporte = (e: Equipo) => /(windows (xp|vista|7|8)\b|server (2003|2008|2012))/i.test(e.so ?? "");
                  const lista = equipos.filter((e) =>
                    (filtroE === "todos" || (filtroE === "servidores" && /server/i.test(e.so ?? "")) || (filtroE === "puestos" && !/server/i.test(e.so ?? "")) ||
                     (filtroE === "inactivos" && e.habilitado && (diasDesde(e.ultimo_logon ?? e.creado, ahora) ?? 0) > dias) || (filtroE === "sin_soporte" && sinSoporte(e))) &&
                    coincide(e.nombre, e.so));
                  if (!lista.length) return vacio(4, "Sin equipos con ese filtro.");
                  return lista.slice(0, 1000).map((e) => (
                    <tr key={e.nombre} className={e.habilitado ? "" : "opacity-60"}>
                      <td className="text-sm font-medium">{e.nombre}{e.es_dc && <span className="pill bg-brand-500/10 text-brand-700 ml-1">DC</span>}</td>
                      <td className={`text-sm ${sinSoporte(e) ? "text-red-600" : "text-ink/70"}`}>{e.so ?? "—"}{e.version ? <span className="text-ink/45"> · {e.version}</span> : null}</td>
                      <td className="text-sm text-ink/70 whitespace-nowrap">{e.ultimo_logon ? dia(e.ultimo_logon) : "Nunca"}</td>
                      <td className="text-sm">
                        {!e.habilitado && <span className="pill bg-line/[0.05] text-ink/55 mr-1">Deshabilitado</span>}
                        {e.delegacion && !e.es_dc && <span className="pill bg-red-50 text-red-700 mr-1">Delegación sin restricciones</span>}
                        {e.laps === true && <span className="pill bg-emerald-50 text-emerald-700 mr-1">LAPS</span>}
                        {e.laps === false && !e.es_dc && <span className="pill bg-line/[0.05] text-ink/55 mr-1">Sin LAPS</span>}
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Eventos */}
      {vista === "eventos" && (
        <div className="space-y-4">
          {fallos24.length > 0 && (
            <div className="grid lg:grid-cols-2 gap-4">
              {([["Intentos fallidos por usuario (24 h)", (e: Evento) => e.usuario], ["Intentos fallidos por origen (24 h)", (e: Evento) => e.ip ?? e.equipo]] as [string, (e: Evento) => string | null][]).map(([t, fn]) => (
                <div key={t} className="card overflow-x-auto">
                  <div className="px-4 pt-4 font-medium text-ink">{t}</div>
                  <table className="data w-full">
                    <tbody>
                      {fallosPor(fn).map(([k, x]) => (
                        <tr key={k}>
                          <td className="text-sm font-medium">{k}</td>
                          <td className={`text-sm tabular-nums ${x.n >= (estado?.umbral_fallos ?? 20) ? "text-red-600 font-medium" : ""}`}>{x.n}</td>
                          <td className="text-xs text-ink/60">{t.includes("origen") ? `${x.usuarios.size} ${x.usuarios.size === 1 ? "usuario" : "usuarios distintos"}` : ""}</td>
                          <td className="text-sm text-ink/60 whitespace-nowrap">{hace(x.ultima, ahora)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 items-center">
            <select className="input w-auto" value={filtroEv} onChange={(e) => setFiltroEv(e.target.value)} aria-label="Tipo de evento">
              <option value="">Todos los eventos</option>
              <option value="cambios">Cambios en cuentas y grupos</option>
              <option value="fallos">Intentos fallidos</option>
              <option value="bloqueo">Bloqueos</option>
              <option value="criticos">Log borrado, DSRM y política</option>
            </select>
          </div>
          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Fecha</th><th>Evento</th><th>Cuenta</th><th>Detalle</th><th>DC</th></tr></thead>
              <tbody>
                {(() => {
                  const lista = eventos.filter((e) =>
                    (!filtroEv || (filtroEv === "fallos" && FALLOS.includes(e.tipo)) || (filtroEv === "bloqueo" && e.tipo === "bloqueo") ||
                     (filtroEv === "criticos" && ["log_borrado", "dsrm", "politica_dominio"].includes(e.tipo)) ||
                     (filtroEv === "cambios" && !FALLOS.includes(e.tipo) && !["bloqueo", "log_borrado", "dsrm", "politica_dominio"].includes(e.tipo))) &&
                    coincide(e.usuario, e.actor, e.grupo, e.ip, e.equipo, EVENTO[e.tipo]?.t));
                  if (!lista.length) return vacio(5, "Sin eventos. Si el puente reporta pero no hay eventos, revisá la auditoría de los DC (Configurar).");
                  return lista.slice(0, 1000).map((e) => (
                    <tr key={e.id}>
                      <td className="text-sm text-ink/70 whitespace-nowrap">{fecha(e.fecha)}</td>
                      <td><span className={`pill ${EVENTO[e.tipo]?.c ?? "bg-line/[0.05] text-ink/60"}`}>{EVENTO[e.tipo]?.t ?? e.tipo}</span></td>
                      <td className="text-sm font-medium">{e.usuario ? nombreDe(e.usuario) : "—"}</td>
                      <td className="text-sm text-ink/70">
                        {[e.grupo && `Grupo ${e.grupo}`, e.actor && `por ${e.actor}`, e.ip && `desde ${e.ip}`, e.equipo && `equipo ${e.equipo}`,
                          e.motivo === "inventario" ? "detectado en el inventario" : e.motivo ? (MOTIVO[e.motivo.toLowerCase()] ?? `código ${e.motivo}`) : null]
                          .filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="text-sm text-ink/55">{e.dc}</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ActiveDirectory() {
  return <Suspense><Contenido /></Suspense>;
}
