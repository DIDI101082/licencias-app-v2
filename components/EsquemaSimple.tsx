"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Esquema simple de la red, con íconos y por niveles:
//   Internet → enlaces WAN → FortiGate (par en HA) → switches de core → servidores VMware y switches UniFi → antenas.
// Se arma solo: WAN y FortiGate del puente FortiGate, switches de core del puente SNMP, hosts de vCenter y equipos de UniFi.
type Item = { id: string; nombre: string; sub?: string; caido?: boolean; titulo?: string };
type Icono = "wan" | "fw" | "sw" | "srv" | "ap";

const W = 1040, MAX = 7, ICO = 46;
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

export default function EsquemaSimple() {
  const [d, setD] = useState<{ fgs: any[]; wans: any[]; ifs: any[]; sws: any[]; puertos: any[]; hosts: any[]; unifi: any[] } | null>(null);
  const [fgSel, setFgSel] = useState<string | null>(null);

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("fg_equipos").select("nombre,hostname,modelo,version,ha_modo,ha_miembros,ha_peers,ha_sincronizado,responde"),
      sb.from("fg_enlaces").select("equipo,interfaz,nombre,bajada_mbps,subida_mbps,respaldo,conectado"),
      sb.from("fg_interfaces").select("equipo,nombre,alias,rol,estado"),
      sb.from("sw_switches").select("id,nombre,ip,zona,responde,sys_nombre").eq("activo", true).order("nombre"),
      sb.from("sw_puertos_vista").select("switch_id,nombre,vecino,vecino_puerto"),
      sb.from("virt_hosts").select("nombre,modelo,cluster,estado,salud").order("nombre"),
      sb.from("unifi_equipos").select("mac,nombre,modelo,tipo,estado,clientes,sitio").order("nombre"),
    ]).then(([fg, en, ifs, sw, pu, ho, un]) =>
      setD({ fgs: fg.data ?? [], wans: en.data ?? [], ifs: ifs.data ?? [], sws: sw.data ?? [], puertos: pu.data ?? [], hosts: ho.data ?? [], unifi: un.data ?? [] }));
  }, []);

  const m = useMemo(() => {
    if (!d) return null;
    const wansDe = (eq: string): Item[] => {
      const l = d.wans.filter((w) => w.equipo === eq);
      if (l.length) return l.map((w) => ({ id: w.interfaz, nombre: w.nombre || w.interfaz, caido: w.conectado === false,
        sub: [w.nombre ? w.interfaz : "", w.bajada_mbps ? `${w.bajada_mbps}/${w.subida_mbps ?? "?"} Mb` : "", w.respaldo ? "respaldo" : ""].filter(Boolean).join(" · ") }));
      return d.ifs.filter((i) => i.equipo === eq && /wan/i.test(`${i.rol ?? ""} ${i.nombre ?? ""}`))
        .map((i) => ({ id: i.nombre, nombre: i.alias || i.nombre, sub: i.alias ? i.nombre : "", caido: i.estado ? !/up/i.test(i.estado) : false }));
    };
    const fgs = [...d.fgs].sort((a, b) => wansDe(b.nombre).length - wansDe(a.nombre).length || a.nombre.localeCompare(b.nombre));
    const fg = fgs.find((f) => f.nombre === fgSel) ?? fgs[0];
    const unidades = fg ? Math.max(1, Array.isArray(fg.ha_miembros) ? fg.ha_miembros.length : 0, Array.isArray(fg.ha_peers) ? fg.ha_peers.length : 0) : 0;
    // Interfaz del FortiGate por la que baja a los switches (la informa el switch como puerto de su vecino)
    const bajada = fg ? Array.from(new Set(d.puertos.filter((p) => p.vecino && p.vecino_puerto && parecido(norm(p.vecino), [fg.hostname, fg.nombre])).map((p) => String(p.vecino_puerto)))) : [];
    const item = (u: any): Item => ({ id: u.mac, nombre: u.nombre || u.modelo || u.mac, sub: u.modelo ?? "", caido: u.estado !== 1 });
    return {
      fgs, fg, unidades, bajada,
      wans: fg ? wansDe(fg.nombre) : [],
      core: acotar(d.sws.map((s) => ({ id: String(s.id), nombre: s.nombre, sub: s.ip, caido: s.responde === false })), "switches"),
      hosts: acotar(d.hosts.map((h) => ({ id: h.nombre, nombre: h.nombre.split(".")[0], sub: h.modelo ?? h.cluster ?? "", caido: /disconn|notresp|not_resp|red/i.test(`${h.estado ?? ""} ${h.salud ?? ""}`) })), "hosts"),
      usw: acotar(d.unifi.filter((u) => u.tipo === "usw").map(item), "switches"),
      aps: acotar(d.unifi.filter((u) => u.tipo === "uap").map(item), "antenas"),
      totales: { core: d.sws.length, hosts: d.hosts.length, usw: d.unifi.filter((u) => u.tipo === "usw").length, aps: d.unifi.filter((u) => u.tipo === "uap").length },
    };
  }, [d, fgSel]);

  if (!d || !m) return <div className="card p-6 text-sm text-ink/50">Cargando…</div>;
  if (!m.fg && !m.core.length) {
    return <div className="card p-6 text-sm text-ink/60">Todavía no hay FortiGate ni switches informando a la app. El esquema se arma solo cuando los puentes del FortiGate y de los switches están configurados.</div>;
  }

  // Niveles (y del centro de cada fila de íconos)
  const Y = { nube: 46, wan: 150, fw: 296, core: 446, abajo: 590, aps: 730 };
  const cx = W / 2;
  const xWan = repartir(m.wans.length, 120, W - 120, 220);
  const xFw = repartir(m.unidades, cx - 70, cx + 70, 96);
  const xCore = repartir(m.core.length, 60, W - 60);
  const mitad = m.hosts.length && m.usw.length;
  const xHosts = repartir(m.hosts.length, 30, mitad ? cx - 30 : W - 30, 120);
  const xUsw = repartir(m.usw.length, mitad ? cx + 30 : 30, W - 30, 120);
  const baseAps = m.usw.length ? xUsw : xCore;
  const xAps = repartir(m.aps.length, m.usw.length && mitad ? cx + 30 : 30, W - 30, 105);
  const yAps = m.usw.length ? Y.aps : Y.abajo;
  const alto = (m.aps.length && m.usw.length ? Y.aps : m.hosts.length || m.usw.length || m.aps.length ? Y.abajo : m.core.length ? Y.core : Y.fw) + 92;

  // Une una fila con la de abajo con un "peine": bajadas verticales y un tramo horizontal en el medio
  const peine = (arriba: number[], y1: number, abajo: number[], y2: number, clave: string, rotulo?: string) => {
    if (!arriba.length || !abajo.length) return null;
    const ym = (y1 + y2) / 2, xs = [...arriba, ...abajo];
    return (
      <g key={clave} stroke={LINEA} strokeWidth={2} fill="none" strokeLinecap="round">
        {arriba.map((x, i) => <line key={`a${i}`} x1={x} x2={x} y1={y1} y2={ym} />)}
        <line x1={Math.min(...xs)} x2={Math.max(...xs)} y1={ym} y2={ym} />
        {abajo.map((x, i) => <line key={`b${i}`} x1={x} x2={x} y1={ym} y2={y2} />)}
        {rotulo && <text x={(arriba[0] + arriba[arriba.length - 1]) / 2 + 10} y={y1 + 15} fontSize={11} fill={SUAVE} stroke="none">{rotulo}</text>}
      </g>
    );
  };
  const fila = (items: Item[], xs: number[], y: number, tipo: Icono, color: string, ancho = 17) => items.map((it, i) => (
    <g key={`${tipo}-${it.id}`} transform={`translate(${xs[i]},${y})`}>
      <title>{it.titulo ?? `${it.nombre}${it.sub ? ` · ${it.sub}` : ""}${it.caido ? " · caído" : ""}`}</title>
      <Dibujo tipo={tipo} color={it.caido ? ROJO : color} />
      <circle cx={ICO / 2 + 4} cy={-ICO / 2 + 6} r={4} fill={it.caido ? ROJO : VERDE} />
      <text y={ICO / 2 + 16} textAnchor="middle" fontSize={12} fontWeight={600} fill={INK}>{corto(it.nombre, ancho)}</text>
      {it.sub && <text y={ICO / 2 + 30} textAnchor="middle" fontSize={10} fill={SUAVE}>{corto(it.sub, ancho + 4)}</text>}
    </g>
  ));
  const titulo = (texto: string, x: number, y: number) => <text x={x} y={y} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={SUAVE} stroke="rgb(var(--c-canvas))" strokeWidth={6} paintOrder="stroke" style={{ textTransform: "uppercase", letterSpacing: "0.07em" }}>{texto}</text>;
  const haCaido = m.fg?.responde === false;
  const cajaFw = { x: xFw[0] - 96, w: (xFw[xFw.length - 1] ?? cx) - (xFw[0] ?? cx) + 192 };

  return (
    <div className="space-y-4">
      {m.fgs.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="text-ink/60">Firewall:</span>
          <div className="flex rounded-lg border border-line/[0.08] overflow-hidden">
            {m.fgs.map((f) => (
              <button key={f.nombre} onClick={() => setFgSel(f.nombre)} aria-pressed={f.nombre === m.fg?.nombre}
                className={`px-3 py-1.5 font-medium ${f.nombre === m.fg?.nombre ? "bg-brand-600 text-white" : "bg-surface text-ink/70 hover:text-ink"}`}>{f.nombre}</button>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-auto bg-canvas">
        <svg viewBox={`0 0 ${W} ${alto}`} role="img" className="block mx-auto w-full" style={{ minWidth: 760, maxWidth: 1200 }}
          aria-label="Esquema de la red: Internet, enlaces WAN, FortiGate, switches de core, servidores VMware, switches UniFi y antenas">
          {/* Conexiones (debajo de los íconos) */}
          {m.fg && peine([cx], Y.nube + 24, xWan, Y.wan - 14, "nube-wan")}
          {m.fg && peine(m.wans.length ? xWan : [cx], (m.wans.length ? Y.wan + 62 : Y.nube + 24), [cx], Y.fw - 40, "wan-fw")}
          {peine(m.fg ? [cx] : [], Y.fw + 76, xCore, Y.core - 16, "fw-core", m.bajada.length ? `Interfaz ${m.bajada.slice(0, 3).join(", ")}` : undefined)}
          {peine(xCore, Y.core + 58, [...xHosts, ...xUsw], Y.abajo - 30, "core-abajo")}
          {m.usw.length > 0 ? peine(baseAps, Y.abajo + 60, xAps, Y.aps - 22, "usw-ap") : peine(xCore, Y.core + 58, xAps, Y.abajo - 22, "core-ap")}

          {/* Internet */}
          {m.fg && (
            <g transform={`translate(${cx},${Y.nube})`}>
              <path d="M -44 16 a 20 20 0 0 1 4 -39 a 26 26 0 0 1 49 -6 a 21 21 0 0 1 33 20 a 13 13 0 0 1 -4 25 Z" fill={SUP} stroke="rgb(var(--c-brand))" strokeWidth={2} />
              <text y={5} textAnchor="middle" fontSize={13} fontWeight={700} fill="rgb(var(--c-brand))">Internet</text>
            </g>
          )}

          {m.wans.length > 0 && titulo("Enlaces WAN", 60, Y.wan - 30)}
          {fila(m.wans, xWan, Y.wan, "wan", "#F59E0B", 22)}

          {/* FortiGate: una caja punteada cuando es un par en HA */}
          {m.fg && (
            <g>
              {m.unidades > 1 && <rect x={cajaFw.x} y={Y.fw - 40} width={cajaFw.w} height={116} rx={14} fill="none" stroke={haCaido ? ROJO : LINEA} strokeWidth={1.5} strokeDasharray="6 5" />}
              {m.unidades > 1 && <text x={cajaFw.x + cajaFw.w - 10} y={Y.fw - 26} textAnchor="end" fontSize={10} fontWeight={700} fill={m.fg.ha_sincronizado === false ? ROJO : SUAVE}>HA{m.fg.ha_sincronizado === false ? " sin sincronizar" : ""}</text>}
              {xFw.map((x, i) => <g key={i} transform={`translate(${x},${Y.fw})`}><Dibujo tipo="fw" color={haCaido ? ROJO : "#EF4444"} /></g>)}
              {m.unidades > 1 && <line x1={xFw[0] + 26} x2={xFw[xFw.length - 1] - 26} y1={Y.fw} y2={Y.fw} stroke={LINEA} strokeWidth={2} strokeDasharray="3 3" />}
              <text x={cx} y={Y.fw + 36} textAnchor="middle" fontSize={12.5} fontWeight={700} fill={INK}>{m.unidades > 1 ? `${m.unidades} × ` : ""}{corto(m.fg.nombre, 30)}</text>
              <text x={cx} y={Y.fw + 51} textAnchor="middle" fontSize={10.5} fill={SUAVE}>{[m.fg.modelo, m.fg.version && `FortiOS ${m.fg.version}`, m.fg.ha_modo && m.unidades > 1 ? `HA ${m.fg.ha_modo}` : ""].filter(Boolean).join(" · ")}</text>
            </g>
          )}

          {m.core.length > 0 && titulo("Switches de core", 74, Y.core - 34)}
          {fila(m.core, xCore, Y.core, "sw", "rgb(var(--c-brand))")}

          {m.hosts.length > 0 && titulo("Servidores VMware", xHosts.reduce((a, b) => a + b, 0) / xHosts.length, Y.abajo + 78)}
          {fila(m.hosts, xHosts, Y.abajo, "srv", "#8B5CF6", 14)}

          {m.usw.length > 0 && titulo("Switches UniFi", xUsw.reduce((a, b) => a + b, 0) / xUsw.length, Y.abajo - 42)}
          {fila(m.usw, xUsw, Y.abajo, "sw", "#0EA5E9", 14)}

          {m.aps.length > 0 && titulo(`Antenas UniFi (${m.totales.aps})`, xAps.reduce((a, b) => a + b, 0) / xAps.length, yAps + 62)}
          {fila(m.aps.map((a) => ({ ...a, sub: "" })), xAps, yAps, "ap", "#0EA5E9", 13)}
        </svg>
      </div>

      <p className="text-xs text-ink/50">
        Se arma solo: {m.wans.length} enlaces WAN, {m.totales.core} switches de core (los monitoreados por SNMP), {m.totales.hosts} hosts VMware,
        {" "}{m.totales.usw} switches UniFi y {m.totales.aps} antenas. En rojo, lo que está caído. El detalle boca por boca está en la solapa «Detalle por boca».
      </p>
    </div>
  );
}
