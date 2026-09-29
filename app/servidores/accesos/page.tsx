"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { hace } from "@/lib/monitoreo";

type Sesion = {
  id: number; dispositivo_id: string; servidor: string; hostname: string | null; fecha: string; usuario: string; dominio: string | null;
  logon_type: number | null; ip: string | null; origen: string | null; fin: string | null; autorizado: boolean | null;
  cuenta_local: boolean; fuera_horario: boolean; primer_acceso: boolean;
};
type Fallo = { id: number; dispositivo_id: string; hostname: string | null; fecha: string; usuario: string; dominio: string | null; logon_type: number | null; ip: string | null; origen: string | null; motivo: string | null };
type Equipo = { dispositivo_id: string; servidor: string; hostname: string | null; ultimo_evento: string; autorizados: number };
type Autorizado = { dispositivo_id: string; usuario: string; agregado_en: string };
type Config = { alertas: boolean; alertar_primer_acceso: boolean; alertar_fuera_horario: boolean; hora_desde: number; hora_hasta: number; fines_de_semana: boolean; umbral_fallos: number };

const TIPO: Record<number, string> = { 2: "Consola", 10: "Escritorio remoto", 11: "Consola (sin conexión al dominio)", 3: "Red" };
const MOTIVO: Record<string, string> = {
  "0xc000006a": "contraseña incorrecta", "0xc0000064": "usuario inexistente", "0xc0000234": "cuenta bloqueada", "0xc0000072": "cuenta deshabilitada",
  "0xc0000071": "contraseña vencida", "0xc000006f": "fuera del horario permitido", "0xc0000070": "equipo no permitido", "0xc0000193": "cuenta vencida",
  "0xc0000224": "debe cambiar la contraseña", "0xc000015b": "sin permiso para este tipo de inicio",
};
const fecha = (f: string) => new Date(f).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", hour12: false });
function duracion(desde: string, hasta: string | null, ahora: number) {
  const min = Math.max(0, Math.round(((hasta ? Date.parse(hasta) : ahora) - Date.parse(desde)) / 60000));
  const t = min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
  return hasta ? t : `abierta · ${t}`;
}

export default function Accesos() {
  const { esAdmin } = usePerfil();
  const [sesiones, setSesiones] = useState<Sesion[]>([]);
  const [fallos, setFallos] = useState<Fallo[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [autorizados, setAutorizados] = useState<Autorizado[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ahora, setAhora] = useState(Date.now());
  const [dias, setDias] = useState(7);
  const [servidor, setServidor] = useState("");
  const [texto, setTexto] = useState("");
  const [soloMarcas, setSoloMarcas] = useState(false);
  const [verConfig, setVerConfig] = useState(false);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [nuevoAut, setNuevoAut] = useState("");
  const [servAut, setServAut] = useState("");

  const cargar = useCallback(async () => {
    const sb = createClient();
    const desde = new Date(Date.now() - dias * 86400000).toISOString();
    const [s, f, e, a, c] = await Promise.all([
      sb.from("srv_sesiones").select("*").gte("fecha", desde).order("fecha", { ascending: false }).limit(3000),
      sb.from("srv_accesos").select("id,dispositivo_id,hostname,fecha,usuario,dominio,logon_type,ip,origen,motivo").eq("tipo", "fallo").gte("fecha", desde)
        .order("fecha", { ascending: false }).limit(3000),
      sb.from("srv_accesos_equipos").select("*"),
      sb.from("srv_autorizados").select("*").order("usuario"),
      sb.from("srv_accesos_config").select("*").maybeSingle(),
    ]);
    const err = s.error ?? c.error;
    setError(err ? (/srv_/.test(err.message) ? "Falta ejecutar supabase/srv-accesos.sql en Supabase." : err.message) : null);
    setSesiones((s.data ?? []) as Sesion[]);
    setFallos((f.data ?? []) as Fallo[]);
    setEquipos(((e.data ?? []) as Equipo[]).sort((x, y) => x.servidor.localeCompare(y.servidor)));
    setAutorizados((a.data ?? []) as Autorizado[]);
    setConfig((c.data as Config) ?? null);
    setAhora(Date.now());
    setCargando(false);
  }, [dias]);
  useEffect(() => { cargar(); const t = setInterval(cargar, 120000); return () => clearInterval(t); }, [cargar]);
  useEffect(() => { if (!servAut && equipos.length) setServAut(equipos[0].dispositivo_id); }, [equipos, servAut]);

  const q = texto.trim().toLowerCase();
  const coincide = (...v: (string | null | undefined)[]) => !q || v.some((x) => x?.toLowerCase().includes(q));
  const marcas = (s: Sesion) => s.autorizado === false || s.cuenta_local || s.fuera_horario || s.primer_acceso;
  const dia = (f: string) => Date.parse(f) > ahora - 86400000;

  const lista = useMemo(() => sesiones.filter((s) => (!servidor || s.dispositivo_id === servidor) && (!soloMarcas || marcas(s)) &&
    coincide(s.usuario, s.dominio, s.servidor, s.ip, s.origen)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [sesiones, servidor, soloMarcas, q]);
  const fallosFiltrados = fallos.filter((f) => (!servidor || f.dispositivo_id === servidor) && coincide(f.usuario, f.hostname, f.ip, f.origen));
  const fallosAgrupados = useMemo(() => {
    const m = new Map<string, { servidor: string; usuario: string; origen: string; n: number; ultima: string; motivo: string | null }>();
    fallosFiltrados.forEach((f) => {
      const origen = f.ip ?? f.origen ?? "—";
      const k = `${f.dispositivo_id}|${f.usuario.toLowerCase()}|${origen}`;
      const x = m.get(k) ?? { servidor: equipos.find((e) => e.dispositivo_id === f.dispositivo_id)?.servidor ?? f.hostname ?? "—", usuario: f.usuario, origen, n: 0, ultima: f.fecha, motivo: f.motivo };
      x.n++; if (f.fecha > x.ultima) x.ultima = f.fecha;
      m.set(k, x);
    });
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 30);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallos, servidor, q, equipos]);

  const tarjetas = [
    { t: "Inicios de sesión (24 h)", n: sesiones.filter((s) => dia(s.fecha)).length, c: "text-ink" },
    { t: "Sesiones abiertas ahora", n: sesiones.filter((s) => !s.fin && Date.parse(s.fecha) > ahora - 3 * 86400000).length, c: "text-ink" },
    { t: "Intentos fallidos (24 h)", n: fallos.filter((f) => dia(f.fecha)).length, c: fallos.some((f) => dia(f.fecha)) ? "text-amber-700" : "text-ink" },
    { t: `No autorizados (${dias} días)`, n: sesiones.filter((s) => s.autorizado === false).length, c: sesiones.some((s) => s.autorizado === false) ? "text-red-600" : "text-ink" },
    { t: `Cuentas locales o genéricas (${dias} días)`, n: sesiones.filter((s) => s.cuenta_local).length, c: sesiones.some((s) => s.cuenta_local) ? "text-red-600" : "text-ink" },
  ];

  async function guardarConfig() {
    if (!cfg) return;
    setAviso(null);
    const { error } = await createClient().rpc("srv_accesos_config_guardar", { p: cfg });
    setAviso(error ? { ok: false, texto: error.message } : { ok: true, texto: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos)." });
    if (!error) cargar();
  }
  async function autorizar(disp: string, usuario: string, agregar: boolean) {
    const { error } = await createClient().rpc("srv_autorizado_guardar", { p_dispositivo: disp, p_usuario: usuario, p_agregar: agregar });
    if (error) setError(error.message); else { setNuevoAut(""); cargar(); }
  }
  async function desdeHistorial(disp: string) {
    const { data, error } = await createClient().rpc("srv_autorizados_desde_historial", { p_dispositivo: disp, p_dias: 30 });
    if (error) setError(error.message); else { setAviso({ ok: true, texto: `Se agregaron ${data} usuarios. Revisá la lista y quitá los que no deberían entrar.` }); cargar(); }
  }

  const autDe = autorizados.filter((a) => a.dispositivo_id === servAut);
  const usuariosVistos = [...new Set(sesiones.filter((s) => s.dispositivo_id === servAut).map((s) => s.usuario.toLowerCase()))];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Accesos a servidores</h1>
          <p className="text-ink/60 text-sm mt-1 max-w-3xl">
            Quién entró a cada servidor por consola o Escritorio remoto, desde dónde y cuánto tiempo, y los intentos fallidos. Lo informa el agente
            de Accusys Cyber instalado en cada servidor.
          </p>
        </div>
        {esAdmin && config && <button className="btn-secondary" onClick={() => { setVerConfig(!verConfig); setCfg(config); }}>{verConfig ? "Cerrar configuración" : "Configurar"}</button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}

      {!cargando && !error && !equipos.length && (
        <div className="card p-4 text-sm bg-amber-500/10">
          Todavía ningún servidor envió accesos. Instalá en cada servidor el agente <b>versión 1.9 o posterior</b> (Inventario → Monitoreo → Agente →
          Códigos de instalación) y aprobalo. Los accesos de los últimos 7 días aparecen en la primera ejecución.
        </div>
      )}

      {verConfig && cfg && (
        <div className="card p-5 space-y-5">
          <section className="space-y-3">
            <h2 className="font-display text-lg text-ink">Alertas</h2>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={cfg.alertas} onChange={(e) => setCfg({ ...cfg, alertas: e.target.checked })} />
              Enviar alertas de accesos (no autorizados, cuentas locales o genéricas e intentos fallidos)
            </label>
            <label className="flex items-center gap-2 text-sm pl-6">
              <input type="checkbox" disabled={!cfg.alertas} checked={cfg.alertar_primer_acceso} onChange={(e) => setCfg({ ...cfg, alertar_primer_acceso: e.target.checked })} />
              Avisar la primera vez que un usuario entra a un servidor
            </label>
            <label className="flex items-center gap-2 text-sm pl-6">
              <input type="checkbox" disabled={!cfg.alertas} checked={cfg.alertar_fuera_horario} onChange={(e) => setCfg({ ...cfg, alertar_fuera_horario: e.target.checked })} />
              Avisar los accesos fuera de horario
            </label>
            <div className="flex flex-wrap gap-3 items-end">
              <label className="block text-sm">Horario desde
                <input type="number" min={0} max={23} className="input mt-1 w-24" value={cfg.hora_desde} onChange={(e) => setCfg({ ...cfg, hora_desde: Number(e.target.value) })} /></label>
              <label className="block text-sm">hasta
                <input type="number" min={1} max={24} className="input mt-1 w-24" value={cfg.hora_hasta} onChange={(e) => setCfg({ ...cfg, hora_hasta: Number(e.target.value) })} /></label>
              <label className="flex items-center gap-2 text-sm pb-2">
                <input type="checkbox" checked={cfg.fines_de_semana} onChange={(e) => setCfg({ ...cfg, fines_de_semana: e.target.checked })} />
                Los fines de semana también son horario normal
              </label>
              <label className="block text-sm">Intentos fallidos por hora
                <input type="number" min={3} max={1000} className="input mt-1 w-28" value={cfg.umbral_fallos} onChange={(e) => setCfg({ ...cfg, umbral_fallos: Number(e.target.value) })} /></label>
            </div>
            <button className="btn-secondary" onClick={guardarConfig}>Guardar</button>
          </section>

          <section className="space-y-3 border-t border-line/[0.06] pt-5">
            <h2 className="font-display text-lg text-ink">Usuarios autorizados por servidor</h2>
            <p className="text-sm text-ink/60">
              Si un servidor tiene lista, cualquier acceso de alguien que no esté genera una alerta. Sin lista, ese servidor no se controla. Podés
              escribir el usuario solo (<code>jperez</code>) o con dominio (<code>accusys\jperez</code>).
            </p>
            {!equipos.length ? <p className="text-sm text-ink/50">Todavía no hay servidores con accesos.</p> : (
              <>
                <div className="flex flex-wrap gap-2 items-end">
                  <select className="input w-auto" value={servAut} onChange={(e) => setServAut(e.target.value)} aria-label="Servidor">
                    {equipos.map((e) => <option key={e.dispositivo_id} value={e.dispositivo_id}>{e.servidor} ({e.autorizados} autorizados)</option>)}
                  </select>
                  <input className="input w-56" list="acc-usuarios" placeholder="usuario" value={nuevoAut} onChange={(e) => setNuevoAut(e.target.value)} aria-label="Usuario a autorizar" />
                  <datalist id="acc-usuarios">{usuariosVistos.map((u) => <option key={u} value={u} />)}</datalist>
                  <button className="btn-secondary" disabled={!nuevoAut.trim()} onClick={() => autorizar(servAut, nuevoAut, true)}>Autorizar</button>
                  <button className="btn-secondary" onClick={() => desdeHistorial(servAut)}>Cargar quienes entraron en 30 días</button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!autDe.length && <span className="text-sm text-ink/50">Sin lista: este servidor no se controla.</span>}
                  {autDe.map((a) => (
                    <span key={a.usuario} className="pill bg-line/[0.05] text-ink/80">
                      {a.usuario}
                      <button className="ml-1.5 text-ink/40 hover:text-red-600" aria-label={`Quitar ${a.usuario}`} onClick={() => autorizar(a.dispositivo_id, a.usuario, false)}>×</button>
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {tarjetas.map((t) => (
          <div key={t.t} className="card p-5">
            <div className="text-xs text-ink/50 font-medium">{t.t}</div>
            <div className={`font-display text-3xl mt-1 tabular-nums ${t.c}`}>{t.n}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select className="input w-auto" value={servidor} onChange={(e) => setServidor(e.target.value)} aria-label="Servidor">
          <option value="">Todos los servidores</option>
          {equipos.map((e) => <option key={e.dispositivo_id} value={e.dispositivo_id}>{e.servidor}</option>)}
        </select>
        <select className="input w-auto" value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Período">
          <option value={1}>Últimas 24 horas</option><option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option><option value={90}>Últimos 90 días</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-ink/70">
          <input type="checkbox" checked={soloMarcas} onChange={(e) => setSoloMarcas(e.target.checked)} /> Solo accesos con alguna marca
        </label>
        <input type="search" className="input max-w-xs ml-auto" placeholder="Buscar usuario, servidor, IP…" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Inicio</th><th>Servidor</th><th>Usuario</th><th>Tipo</th><th>Desde</th><th>Duración</th><th>Marcas</th></tr></thead>
          <tbody>
            {!lista.length && <tr><td colSpan={7} className="text-center text-ink/40 py-8">{cargando ? "Cargando…" : "Sin accesos en el período."}</td></tr>}
            {lista.slice(0, 1000).map((s) => (
              <tr key={s.id}>
                <td className="text-sm text-ink/70 whitespace-nowrap">{fecha(s.fecha)}</td>
                <td className="text-sm font-medium">{s.servidor}</td>
                <td className="text-sm">{s.usuario}{s.dominio && <span className="text-ink/45"> · {s.dominio}</span>}</td>
                <td className="text-sm text-ink/70">{s.logon_type != null ? TIPO[s.logon_type] ?? `Tipo ${s.logon_type}` : "—"}</td>
                <td className="text-sm text-ink/70">{[s.ip, s.origen].filter(Boolean).join(" · ") || "—"}</td>
                <td className={`text-sm whitespace-nowrap ${s.fin ? "text-ink/70" : "text-emerald-700"}`}>{duracion(s.fecha, s.fin, ahora)}</td>
                <td className="text-sm">
                  {s.autorizado === false && <span className="pill bg-red-600 text-white mr-1">No autorizado</span>}
                  {s.cuenta_local && <span className="pill bg-red-50 text-red-700 mr-1">Cuenta local o genérica</span>}
                  {s.primer_acceso && <span className="pill bg-orange-500/15 text-orange-700 mr-1">Primer acceso</span>}
                  {s.fuera_horario && <span className="pill bg-amber-500/15 text-amber-700 mr-1">Fuera de horario</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card overflow-x-auto">
        <div className="px-4 pt-4 font-medium text-ink">Intentos fallidos</div>
        <table className="data w-full">
          <thead><tr><th>Servidor</th><th>Usuario</th><th>Desde</th><th>Intentos</th><th>Motivo</th><th>Último</th></tr></thead>
          <tbody>
            {!fallosAgrupados.length && <tr><td colSpan={6} className="text-center text-ink/40 py-6">{cargando ? "Cargando…" : "Sin intentos fallidos en el período."}</td></tr>}
            {fallosAgrupados.map((f, i) => (
              <tr key={i}>
                <td className="text-sm font-medium">{f.servidor}</td>
                <td className="text-sm">{f.usuario}</td>
                <td className="text-sm text-ink/70">{f.origen}</td>
                <td className={`text-sm tabular-nums ${f.n >= (config?.umbral_fallos ?? 10) ? "text-red-600 font-medium" : ""}`}>{f.n}</td>
                <td className="text-sm text-ink/70">{f.motivo ? MOTIVO[f.motivo.toLowerCase()] ?? f.motivo : "—"}</td>
                <td className="text-sm text-ink/60 whitespace-nowrap">{hace(f.ultima, ahora)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Se registran los inicios por consola y Escritorio remoto (no los accesos a carpetas compartidas). &ldquo;Primer acceso&rdquo; marca la primera vez que
        un usuario entra a ese servidor desde que el agente reporta. Los datos se guardan 180 días.
      </p>
    </div>
  );
}
