"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

// Esquema simple de la red, con íconos, uno por sede (por cada FortiGate):
//   Internet → enlaces WAN → FortiGate (par en HA) → switches de core → switches de piso, VMware y antenas.
// Se arma solo (puentes del FortiGate, switches SNMP, vCenter y UniFi) y un administrador puede corregir de dónde
// cuelga cada equipo (tabla red_esquema).
type Item = { id: string; nombre: string; sub?: string; caido?: boolean; titulo?: string };
type Icono = "wan" | "fw" | "sw" | "srv" | "ap";

const MAX = 7, ICO = 46;
const INK = "rgb(var(--c-ink))", SUAVE = "rgb(var(--c-ink) / 0.6)", LINEA = "rgb(var(--c-line) / 0.32)", SUP = "rgb(var(--c-surface))";
const ROJO = "#EF4444", VERDE = "#10B981";
const corto = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const norm = (s?: string | null) => (s ?? "").toLowerCase().split(".")[0].trim();
const parecido = (v: string, l: (string | null | undefined)[]) => v.length >= 3 && l.map(norm).some((n) => n.length >= 3 && (v === n || v.includes(n) || n.includes(v)));

// Deja como mucho MAX íconos por fila; el resto se resume en uno
function acotar(l: Item[], que: string): Item[] {
  if (l.length <= MAX) return l;
  const resto = l.slice(MAX - 1);
  return [...l.slice(0, MAX - 1), { id: `mas-${que}`, nombre: `+${resto.length} ${que}`, titulo: resto.map((x) => x.nombre).join(", "), caido: resto.some((x) => x.caido) }];
}
// Posiciones x de n elementos centrados dentro de [x0, x1]
function repartir(n: number, x0: number, x1: number, paso = 150) {
  const p = Math.min(paso, (x1 - x0) / Math.max(n, 1));
  const ini = (x0 + x1) / 2 - (p * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => ini + i * p);
}

function Dibujo({ tipo, color }: { tipo: Icono; color: string }) {
  const s = { fill: SUP, stroke: color, strokeWidth: 2, strokeLinejoin: "round" as const };
  if (tipo === "fw") return (
    <g>
      <rect x={-23} y={-18} width={46} height={36} rx={4} {...s} />
      {[-6, 6].map((y) => <line key={y} x1={-23} x2={23} y1={y} y2={y} stroke={color} strokeWidth={1.5} />)}
      {[[-8, -18, -6], [8, -18, -6], [0, -6, 6], [-12, 6, 18], [12, 6, 18]].map(([x, a, b], i) => <line key={i} x1={x} x2={x} y1={a} y2={b} stroke={color} strokeWidth={1.5} />)}
    </g>
  );
  if (tipo === "sw") return (
    <g>
      <rect x={-26} y={-11} width={52} height={22} rx={4} {...s} />
      {[-18, -10, -2, 6, 14].map((x) => <rect key={x} x={x} y={-3} width={5} height={6} rx={1} fill={color} />)}
    </g>
  );
  if (tipo === "srv") return (
    <g>
      <rect x={-15} y={-23} width={30} height={46} rx={4} {...s} />
      {[-14, -6, 2].map((y) => <line key={y} x1={-9} x2={9} y1={y} y2={y} stroke={color} strokeWidth={2} strokeLinecap="round" />)}
      <circle cx={0} cy={14} r={2.5} fill={color} />
    </g>
  );
  if (tipo === "ap") return (
    <g>
      <circle r={17} {...s} />
      <circle r={3} cy={5} fill={color} />
      <path d="M -7 -1 A 9 9 0 0 1 7 -1 M -11 -6 A 15 15 0 0 1 11 -6" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </g>
  );
  return (
    <g>
      <rect x={-24} y={-9} width={48} height={18} rx={9} {...s} />
      <circle cx={-12} r={2.5} fill={color} /><line x1={-4} x2={14} y1={0} y2={0} stroke={color} strokeWidth={2} strokeLinecap="round" />
    </g>
  );
}

// ---------- Árbol: de dónde cuelga cada equipo ----------
// Claves: "fg:<nombre>" (FortiGate; lo que cuelga directo de él es el core), "sw:<id>" (switch SNMP), "u:<mac>" (UniFi), "vm" (VMware).
type Eq = { key: string; tipo: "sw" | "usw" | "ap" | "vm"; nombre: string; sub: string; caido: boolean; pista: string; zona: string };
type Rama = { id: string; icono: Icono; color: string; nombre: string; sub: string; caido: boolean; titulo?: string; hijos: Rama[] };

const sinAcento = (s?: string | null) => (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const GENERICAS = /^(fg|fgt|fgvm|forti|fortigate|fw|firewall|ha|cluster|accusys|\d+[a-z]?)$/;
const PASO = 150, ALTO_NIVEL = 150;

export default function EsquemaSimple() {
  const { esAdmin } = usePerfil();
  const [d, setD] = useState<{ fgs: any[]; wans: any[]; ifs: any[]; sws: any[]; puertos: any[]; disp: any[]; hosts: any[]; unifi: any[]; manual: Record<string, string> } | null>(null);
  const [editar, setEditar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("fg_equipos").select("nombre,hostname,modelo,version,ha_modo,ha_miembros,ha_peers,ha_sincronizado,responde"),
      sb.from("fg_enlaces").select("equipo,interfaz,nombre,bajada_mbps,subida_mbps,respaldo,conectado"),
      sb.from("fg_interfaces").select("equipo,nombre,alias,rol,estado"),
      sb.from("sw_switches").select("*").eq("activo", true).order("nombre"),
      sb.from("sw_puertos_vista").select("switch_id,nombre,vecino,vecino_puerto"),
      sb.from("sw_dispositivos_vista").select("mac,switch_id,unifi_nombre"),
      sb.from("virt_hosts").select("nombre,modelo,cluster,estado,salud").order("nombre"),
      sb.from("unifi_equipos").select("*").order("nombre"),
      sb.from("red_esquema").select("clave,padre"),
    ]).then(([fg, en, ifs, sw, pu, di, ho, un, ma]) =>
      setD({ fgs: fg.data ?? [], wans: en.data ?? [], ifs: ifs.data ?? [], sws: sw.data ?? [], puertos: pu.data ?? [], disp: di.data ?? [], hosts: ho.data ?? [], unifi: un.data ?? [],
        manual: Object.fromEntries((ma.data ?? []).map((r: any) => [r.clave, r.padre])) }));
  }, [recarga]);

  async function guardar(clave: string, padre: string) {
    setError(null);
    const sb = createClient();
    const { error } = padre ? await sb.from("red_esquema").upsert({ clave, padre }) : await sb.from("red_esquema").delete().eq("clave", clave);
    if (error) return setError(error.message.includes("red_esquema") ? "Falta ejecutar conectividad.sql en Supabase para poder ajustar el esquema a mano." : error.message);
    setRecarga((n) => n + 1);
  }

  const m = useMemo(() => {
    if (!d) return null;
    const itf = (eq: string, n: string) => d.ifs.find((i) => i.equipo === eq && i.nombre === n);
    // Solo los enlaces a Internet (igual que la pantalla del FortiGate): rol WAN, o con lo contratado cargado
    const wansDe = (eq: string): Item[] => {
      const l = d.wans.filter((w) => w.equipo === eq && (itf(eq, w.interfaz)?.rol === "wan" || w.bajada_mbps != null || w.respaldo));
      if (l.length) return l.map((w) => ({ id: w.interfaz, nombre: w.nombre || itf(eq, w.interfaz)?.alias || w.interfaz, caido: w.conectado === false,
        sub: [w.nombre ? w.interfaz : "", w.bajada_mbps ? `${w.bajada_mbps}/${w.subida_mbps ?? "?"} Mb` : "", w.respaldo ? "respaldo" : ""].filter(Boolean).join(" · ") }));
      return d.ifs.filter((i) => i.equipo === eq && (i.rol === "wan" || /^wan\d*$/i.test(i.nombre ?? "")))
        .map((i) => ({ id: i.nombre, nombre: i.alias || i.nombre, sub: i.alias ? i.nombre : "", caido: i.estado ? !/up/i.test(i.estado) : false }));
    };
    const num = (f: any) => Number(String(f.modelo ?? "").match(/\d+/)?.[0] ?? 0);
    const fgs = [...d.fgs].sort((a, b) => wansDe(b.nombre).length - wansDe(a.nombre).length || num(b) - num(a) || a.nombre.localeCompare(b.nombre));
    const fgKey = (f: any) => `fg:${f.nombre}`;
    const defecto = fgs[0] ? fgKey(fgs[0]) : "";

    // A qué sede (FortiGate) apunta un texto: por alguna palabra del nombre del FortiGate; Córdoba/CBA como caso conocido
    const palabras = (f: any) => sinAcento(`${f.nombre} ${f.hostname ?? ""}`).split(/[^a-z0-9]+/).filter((p) => p.length >= 3 && !GENERICAS.test(p));
    const sedeDe = (texto: string): string | null => {
      const t = sinAcento(texto);
      const f = fgs.find((x) => palabras(x).some((p) => t.includes(p)))
        ?? (/cordoba|cba/.test(t) ? fgs.find((x) => /cordoba|cba|60f/.test(sinAcento(`${x.nombre} ${x.hostname ?? ""} ${x.modelo ?? ""}`))) : undefined);
      return f ? fgKey(f) : null;
    };

    // Equipos
    const eqs: Eq[] = [
      ...d.sws.map((s) => ({ key: `sw:${s.id}`, tipo: "sw" as const, nombre: s.nombre, sub: s.ip ?? "", caido: s.responde === false, pista: `${s.nombre} ${s.sys_nombre ?? ""} ${s.zona ?? ""} ${s.notas ?? ""}`, zona: norm(s.zona) })),
      ...d.unifi.filter((u) => u.tipo === "usw" || u.tipo === "uap").map((u) => ({ key: `u:${u.mac}`, tipo: (u.tipo === "usw" ? "usw" : "ap") as "usw" | "ap", nombre: u.nombre || u.modelo || u.mac, sub: u.modelo ?? "", caido: u.estado !== 1, pista: `${u.nombre ?? ""} ${u.sitio ?? ""} ${u.zona ?? ""}`, zona: norm(u.zona) })),
      ...(d.hosts.length ? [{ key: "vm", tipo: "vm" as const, nombre: "Servidores VMware", sub: `${d.hosts.length} ${d.hosts.length === 1 ? "host" : "hosts"}`, caido: d.hosts.some((h) => /disconn|notresp|not_resp|red/i.test(`${h.estado ?? ""} ${h.salud ?? ""}`)), pista: "", zona: "" }] : []),
    ];
    const porKey = new Map(eqs.map((e) => [e.key, e]));

    // ---- Automático ----
    const auto = new Map<string, string>();
    const swPorNombre = (v: string, salvo?: number) => d.sws.find((s) => s.id !== salvo && parecido(v, [s.sys_nombre, s.nombre]));
    const vecinos = new Map<number, number[]>();
    for (const p of d.puertos) {
      const v = norm(p.vecino); if (!v) continue;
      const f = fgs.find((x) => parecido(v, [x.hostname, x.nombre]));
      if (f) { if (!auto.has(`sw:${p.switch_id}`)) auto.set(`sw:${p.switch_id}`, fgKey(f)); continue; }
      const o = swPorNombre(v, p.switch_id);
      if (o) { vecinos.set(p.switch_id, [...(vecinos.get(p.switch_id) ?? []), o.id]); vecinos.set(o.id, [...(vecinos.get(o.id) ?? []), p.switch_id]); }
    }
    // Un switch con "core" en el nombre es core de su sede
    for (const s of d.sws) if (!auto.has(`sw:${s.id}`) && /core/i.test(`${s.nombre} ${s.sys_nombre ?? ""} ${s.notas ?? ""}`) && defecto) auto.set(`sw:${s.id}`, sedeDe(`${s.nombre} ${s.zona ?? ""} ${s.notas ?? ""}`) ?? defecto);
    // El resto cuelga de su vecino LLDP/CDP
    const cola = d.sws.filter((s) => auto.has(`sw:${s.id}`)).map((s) => s.id);
    while (cola.length) { const a = cola.shift()!; for (const b of vecinos.get(a) ?? []) if (!auto.has(`sw:${b}`)) { auto.set(`sw:${b}`, `sw:${a}`); cola.push(b); } }
    const coreDe = (sede: string) => d.sws.map((s) => `sw:${s.id}`).find((k) => auto.get(k) === sede) ?? sede;
    for (const s of d.sws) if (!auto.has(`sw:${s.id}`) && defecto) auto.set(`sw:${s.id}`, coreDe(sedeDe(`${s.nombre} ${s.zona ?? ""} ${s.notas ?? ""}`) ?? defecto));
    // UniFi: el switch que ve su MAC o que lo tiene de vecino; si no, el de su misma zona; si no, el core de su sede
    const vistoEn = new Map<string, number>(d.disp.map((x) => [x.mac, x.switch_id]));
    for (const u of d.unifi) {
      const k = `u:${u.mac}`; if (!porKey.has(k) || !defecto) continue;
      const lldp = u.nombre ? d.puertos.find((p) => p.vecino && parecido(norm(p.vecino), [u.nombre])) : undefined;
      const sw = vistoEn.get(u.mac) ?? lldp?.switch_id;
      const zona = norm(u.zona);
      // Una antena prefiere el switch UniFi de su zona; si no hay, el switch de piso de esa zona
      const deZona = (t: Eq["tipo"]) => eqs.find((e) => e.key !== k && e.tipo === t && e.zona === zona);
      const mismo = zona ? (u.tipo === "uap" ? deZona("usw") : undefined) ?? deZona("sw") : undefined;
      auto.set(k, sw != null ? `sw:${sw}` : mismo ? mismo.key : coreDe(sedeDe(`${u.nombre ?? ""} ${u.sitio ?? ""} ${u.zona ?? ""}`) ?? defecto));
    }
    if (porKey.has("vm") && defecto) auto.set("vm", coreDe(defecto));

    // ---- Manual por encima del automático (si arma un ciclo o apunta a algo que ya no existe, se ignora) ----
    const valido = (k: string) => k.startsWith("fg:") ? fgs.some((f) => fgKey(f) === k) : porKey.has(k) && porKey.get(k)!.tipo !== "ap" && porKey.get(k)!.tipo !== "vm";
    const padre = new Map<string, string>(auto);
    const esManual = new Set<string>();
    for (const [k, p] of Object.entries(d.manual)) if (porKey.has(k) && p !== k && valido(p)) { padre.set(k, p); esManual.add(k); }
    const sedeFinal = (k: string): string | null => { let x = k; for (let i = 0; i < 25; i++) { const p = padre.get(x); if (!p) return null; if (p.startsWith("fg:")) return p; x = p; } return null; };
    for (const k of Array.from(esManual)) if (!sedeFinal(k)) { esManual.delete(k); const a = auto.get(k); if (a) padre.set(k, a); else padre.delete(k); }

    const hijosDe = (k: string) => eqs.filter((e) => padre.get(e.key) === k);
    const rama = (e: Eq): Rama => ({
      id: e.key, icono: e.tipo === "vm" ? "srv" : "sw", color: e.tipo === "vm" ? "#8B5CF6" : e.tipo === "usw" ? "#0EA5E9" : "rgb(var(--c-brand))",
      nombre: e.nombre, sub: e.sub, caido: e.caido, titulo: e.tipo === "vm" ? d.hosts.map((h) => h.nombre.split(".")[0]).join(", ") : undefined, hijos: ramas([e.key]),
    });
    // Lo que cuelga de uno o varios padres: switches y VMware de a uno; las antenas, agrupadas en un solo ícono
    const ramas = (padres: string[]): Rama[] => {
      const h = padres.flatMap(hijosDe);
      const aps = h.filter((e) => e.tipo === "ap");
      const caidas = aps.filter((a) => a.caido).length;
      return [
        ...h.filter((e) => e.tipo === "vm").map(rama),
        ...h.filter((e) => e.tipo === "sw" || e.tipo === "usw").sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true })).map(rama),
        ...(aps.length ? [{ id: `aps-${padres[0]}`, icono: "ap" as Icono, color: "#0EA5E9", nombre: `${aps.length} ${aps.length === 1 ? "antena" : "antenas"}`, sub: caidas ? `${caidas} ${caidas === 1 ? "caída" : "caídas"}` : "WiFi UniFi", caido: caidas > 0, titulo: aps.map((a) => `${a.nombre}${a.caido ? " (caída)" : ""}`).join(", "), hijos: [] }] : []),
      ];
    };
    const sedes = fgs.map((f) => {
      const core = hijosDe(fgKey(f)).filter((e) => e.tipo === "sw" || e.tipo === "usw");
      const sueltos = hijosDe(fgKey(f)).filter((e) => e.tipo === "ap" || e.tipo === "vm").map((e) => e.key);
      return {
        fg: f, wans: acotar(wansDe(f.nombre), "enlaces"), core,
        unidades: Math.max(1, Array.isArray(f.ha_miembros) ? f.ha_miembros.length : 0, Array.isArray(f.ha_peers) ? f.ha_peers.length : 0),
        bajada: Array.from(new Set(d.puertos.filter((p) => p.vecino && p.vecino_puerto && parecido(norm(p.vecino), [f.hostname, f.nombre])).map((p) => String(p.vecino_puerto)))),
        ramas: ramas([...core.map((c) => c.key), ...(sueltos.length ? [fgKey(f)] : [])].filter((k, i, l) => l.indexOf(k) === i)).filter((r) => !core.some((c) => c.key === r.id)),
      };
    });
    const destinos = [...fgs.map((f) => ({ key: fgKey(f), texto: `Core de ${f.nombre} (directo al FortiGate)` })),
      ...eqs.filter((e) => e.tipo === "sw" || e.tipo === "usw").map((e) => ({ key: e.key, texto: e.nombre }))];
    const nombreDe = (k?: string) => (k ? destinos.find((x) => x.key === k)?.texto ?? "—" : "sin ubicar");
    return { sedes, eqs, padre, auto, esManual, destinos, nombreDe, sinFg: !fgs.length };
  }, [d]);

  if (!d || !m) return <div className="card p-6 text-sm text-ink/50">Cargando…</div>;
  if (m.sinFg) return <div className="card p-6 text-sm text-ink/60">Todavía no hay ningún FortiGate informando a la app. El esquema se arma a partir del puente del FortiGate (Perímetro → FortiGate).</div>;

  const grupos: [string, Eq[]][] = [["Switches", m.eqs.filter((e) => e.tipo === "sw")], ["Switches UniFi", m.eqs.filter((e) => e.tipo === "usw")], ["Servidores", m.eqs.filter((e) => e.tipo === "vm")], ["Antenas", m.eqs.filter((e) => e.tipo === "ap")]];

  return (
    <div className="space-y-5">
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {m.sedes.map((s) => <Sede key={s.fg.nombre} s={s} />)}

      {esAdmin && (
        <div className="card p-4">
          <button className="text-sm font-medium text-brand-600 hover:underline" onClick={() => setEditar(!editar)} aria-expanded={editar}>
            {editar ? "Cerrar" : "Ajustar de dónde cuelga cada equipo"}
          </button>
          {editar && (
            <div className="mt-3 space-y-4">
              <p className="text-xs text-ink/50">«Automático» usa lo que informan los puentes (vecinos LLDP/CDP, tabla MAC, zona). Lo que cuelga directo del FortiGate es el core de esa sede.</p>
              {grupos.filter(([, l]) => l.length).map(([t, l]) => (
                <div key={t}>
                  <h3 className="text-xs uppercase tracking-wide font-semibold text-ink/50 mb-1.5">{t}</h3>
                  <ul className="grid md:grid-cols-2 gap-x-6 gap-y-1.5">
                    {l.map((e) => (
                      <li key={e.key} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate text-ink">{e.nombre}{e.tipo !== "vm" && e.sub ? <span className="text-ink/50 text-xs"> · {e.sub}</span> : null}</span>
                        <select className="input w-auto max-w-[55%] py-1" value={m.esManual.has(e.key) ? m.padre.get(e.key) : ""} onChange={(ev) => guardar(e.key, ev.target.value)} aria-label={`De dónde cuelga ${e.nombre}`}>
                          <option value="">Automático: {m.nombreDe(m.auto.get(e.key))}</option>
                          {m.destinos.filter((x) => x.key !== e.key).map((x) => <option key={x.key} value={x.key}>{x.texto}</option>)}
                        </select>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-ink/50">Se arma solo con lo que informan el FortiGate, los switches, vCenter y UniFi. En rojo, lo que está caído. Pasá el mouse por las antenas o por VMware para ver la lista. El detalle boca por boca está en «Detalle por boca».</p>
    </div>
  );
}

// ---------- Dibujo de una sede ----------
function Sede({ s }: { s: { fg: any; wans: Item[]; core: Eq[]; unidades: number; bajada: string[]; ramas: Rama[] } }) {
  const ancho = (r: Rama): number => Math.max(PASO, r.hijos.reduce((t, h) => t + ancho(h), 0));
  const profundidad = (r: Rama): number => 1 + Math.max(0, ...r.hijos.map(profundidad));
  const anchoRamas = s.ramas.reduce((t, r) => t + ancho(r), 0);
  const W = Math.max(820, anchoRamas + 80, s.wans.length * 200 + 120);
  const cx = W / 2;
  const Y = { nube: 46, wan: 150, fw: 296, core: 446 };
  const niveles = Math.max(0, ...s.ramas.map(profundidad));
  const yRama = (n: number) => Y.core + 144 + n * ALTO_NIVEL;
  const H = (niveles ? yRama(niveles - 1) : s.core.length ? Y.core : Y.fw) + 96;

  const xWan = repartir(s.wans.length, 120, W - 120, 220);
  const xFw = repartir(s.unidades, cx - 70, cx + 70, 96);
  const xCore = repartir(s.core.length, 60, W - 60, s.core.length === 2 ? 130 : 150);
  const coreHa = s.core.length >= 2;
  const caja = (xs: number[]) => ({ x: (xs[0] ?? cx) - 96, w: (xs[xs.length - 1] ?? cx) - (xs[0] ?? cx) + 192 });
  const cFw = caja(xFw), cCore = caja(xCore);
  const fwCaido = s.fg.responde === false;

  const peine = (arriba: number[], y1: number, abajo: number[], y2: number, clave: string, rotulo?: string) => {
    if (!arriba.length || !abajo.length) return null;
    const ym = (y1 + y2) / 2, xs = [...arriba, ...abajo];
    return (
      <g key={clave} stroke={LINEA} strokeWidth={2} fill="none" strokeLinecap="round">
        {arriba.map((x, i) => <line key={`a${i}`} x1={x} x2={x} y1={y1} y2={ym} />)}
        <line x1={Math.min(...xs)} x2={Math.max(...xs)} y1={ym} y2={ym} />
        {abajo.map((x, i) => <line key={`b${i}`} x1={x} x2={x} y1={ym} y2={y2} />)}
        {rotulo && <text x={arriba[0] + 10} y={y1 + 15} fontSize={11} fill={SUAVE} stroke="none">{rotulo}</text>}
      </g>
    );
  };
  const equipo = (x: number, y: number, tipo: Icono, color: string, it: { id: string; nombre: string; sub?: string; caido?: boolean; titulo?: string }, largo = 17) => (
    <g key={`${tipo}-${it.id}`} transform={`translate(${x},${y})`}>
      <title>{it.titulo ?? `${it.nombre}${it.sub ? ` · ${it.sub}` : ""}${it.caido ? " · caído" : ""}`}</title>
      <Dibujo tipo={tipo} color={it.caido ? ROJO : color} />
      <circle cx={ICO / 2 + 4} cy={-ICO / 2 + 6} r={4} fill={it.caido ? ROJO : VERDE} />
      <text y={ICO / 2 + 16} textAnchor="middle" fontSize={12} fontWeight={600} fill={INK}>{corto(it.nombre, largo)}</text>
      {it.sub && <text y={ICO / 2 + 30} textAnchor="middle" fontSize={10} fill={it.caido && tipo === "ap" ? ROJO : SUAVE}>{corto(it.sub, largo + 4)}</text>}
    </g>
  );
  // Ramas: cada una ocupa el ancho de lo que tiene debajo
  const piezas: JSX.Element[] = [];
  const ubicar = (l: Rama[], x0: number, nivel: number, xPadre: number[], yPadre: number, clave: string) => {
    const xs: number[] = []; let x = x0;
    for (const r of l) { const w = ancho(r); xs.push(x + w / 2); x += w; }
    const p = peine(xPadre, yPadre, xs, yRama(nivel) - 30, `p-${clave}`);
    if (p) piezas.push(p);
    l.forEach((r, i) => {
      piezas.push(equipo(xs[i], yRama(nivel), r.icono, r.color, r, 18));
      if (r.hijos.length) ubicar(r.hijos, xs[i] - ancho(r) / 2, nivel + 1, [xs[i]], yRama(nivel) + 60, r.id);
    });
  };
  const yBajo = s.core.length ? Y.core + 74 : Y.fw + 76;
  ubicar(s.ramas, cx - anchoRamas / 2, 0, s.core.length ? (coreHa ? [cx] : xCore) : [cx], yBajo, "raiz");

  return (
    <section className="card overflow-hidden" aria-label={`Esquema de ${s.fg.nombre}`}>
      <h2 className="px-4 py-2.5 border-b border-line/[0.06] font-display font-bold text-ink flex items-center gap-2">
        <span className="w-1 h-4 bg-[#F2C230] inline-block" aria-hidden />{s.fg.nombre}
        <span className="text-xs font-normal text-ink/50">{[s.fg.modelo, s.unidades > 1 ? "en HA" : ""].filter(Boolean).join(" ")}</span>
      </h2>
      <div className="overflow-auto bg-canvas">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" className="block mx-auto" style={{ width: W, maxWidth: W > 1100 ? "none" : "100%", minWidth: Math.min(W, 760) }}
          aria-label={`Esquema de red de ${s.fg.nombre}: enlaces de Internet, FortiGate, switches de core y lo que cuelga de ellos`}>
          {peine([cx], Y.nube + 24, xWan, Y.wan - 14, "nube-wan")}
          {peine(s.wans.length ? xWan : [cx], s.wans.length ? Y.wan + 62 : Y.nube + 24, [cx], Y.fw - 40, "wan-fw")}
          {peine([cx], Y.fw + 76, coreHa ? [cx] : xCore, Y.core - (coreHa ? 40 : 16), "fw-core", s.bajada.length ? `Trunk ${s.bajada.slice(0, 3).join(", ")}` : s.core.length ? "Trunk" : undefined)}
          {piezas}

          <g transform={`translate(${cx},${Y.nube})`}>
            <path d="M -44 16 a 20 20 0 0 1 4 -39 a 26 26 0 0 1 49 -6 a 21 21 0 0 1 33 20 a 13 13 0 0 1 -4 25 Z" fill={SUP} stroke="rgb(var(--c-brand))" strokeWidth={2} />
            <text y={5} textAnchor="middle" fontSize={13} fontWeight={700} fill="rgb(var(--c-brand))">Internet</text>
          </g>
          {s.wans.map((w, i) => equipo(xWan[i], Y.wan, "wan", "#F59E0B", w, 22))}

          {s.unidades > 1 && <rect x={cFw.x} y={Y.fw - 40} width={cFw.w} height={116} rx={14} fill="none" stroke={fwCaido ? ROJO : LINEA} strokeWidth={1.5} strokeDasharray="6 5" />}
          {s.unidades > 1 && <text x={cFw.x + cFw.w - 10} y={Y.fw - 26} textAnchor="end" fontSize={10} fontWeight={700} fill={s.fg.ha_sincronizado === false ? ROJO : SUAVE}>HA{s.fg.ha_sincronizado === false ? " sin sincronizar" : ""}</text>}
          {xFw.map((x, i) => <g key={i} transform={`translate(${x},${Y.fw})`}><Dibujo tipo="fw" color="#EF4444" /></g>)}
          {s.unidades > 1 && <line x1={xFw[0] + 26} x2={xFw[xFw.length - 1] - 26} y1={Y.fw} y2={Y.fw} stroke={LINEA} strokeWidth={2} strokeDasharray="3 3" />}
          <text x={cx} y={Y.fw + 36} textAnchor="middle" fontSize={12.5} fontWeight={700} fill={INK}>{s.unidades > 1 ? `${s.unidades} × ` : ""}{corto(s.fg.nombre, 30)}</text>
          <text x={cx} y={Y.fw + 51} textAnchor="middle" fontSize={10.5} fill={SUAVE}>{[s.fg.modelo, s.fg.version && `FortiOS ${s.fg.version}`].filter(Boolean).join(" · ")}</text>

          {coreHa && <rect x={cCore.x} y={Y.core - 40} width={cCore.w} height={114} rx={14} fill="none" stroke={LINEA} strokeWidth={1.5} strokeDasharray="6 5" />}
          {coreHa && <text x={cCore.x + cCore.w - 10} y={Y.core - 26} textAnchor="end" fontSize={10} fontWeight={700} fill={SUAVE}>CORE · HA</text>}
          {coreHa && <line x1={xCore[0] + 30} x2={xCore[xCore.length - 1] - 30} y1={Y.core} y2={Y.core} stroke={LINEA} strokeWidth={2} strokeDasharray="3 3" />}
          {s.core.map((c, i) => equipo(xCore[i], Y.core, "sw", c.tipo === "usw" ? "#0EA5E9" : "rgb(var(--c-brand))", { id: c.key, nombre: c.nombre, sub: c.sub, caido: c.caido }))}
        </svg>
      </div>
    </section>
  );
}
