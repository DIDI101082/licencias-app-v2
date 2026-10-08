"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { COLOR, INTERNET, NODO, diagramar } from "@/lib/topologia";

// Esquema físico de la red, armado solo con lo que ya informan los puentes:
//   enlaces WAN y FortiGate (puente FortiGate) → switches (SNMP: vecinos LLDP/CDP) → servidores y antenas (tabla MAC + UniFi).
type Tipo = "fg" | "sw" | "srv" | "ap" | "otro" | "resto";
type Estado = "ok" | "caido" | "desconocido";
type Nodo = { id: number; tipo: Tipo; nombre: string; sub: string; estado: Estado; lineas: string[]; supuesto?: boolean };
type Wan = { equipo: string; interfaz: string; nombre: string | null; bajada_mbps: number | null; subida_mbps: number | null; respaldo: boolean; conectado: boolean | null };

const ROTULO: Record<Tipo, string> = { fg: "FortiGate", sw: "Switch", srv: "Servidor", ap: "Antena", otro: "Vecino", resto: "Otros equipos" };
const BORDE: Record<Tipo, string> = { fg: "#EF4444", sw: "rgb(var(--c-brand))", srv: "#8B5CF6", ap: "#0EA5E9", otro: "rgb(var(--c-line) / 0.3)", resto: "rgb(var(--c-line) / 0.3)" };
const LINEA = "rgb(var(--c-line) / 0.25)";
const PILL = { h: 26, g: 6 };
const corto = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const norm = (s?: string | null) => (s ?? "").toLowerCase().split(".")[0].trim();
const parecido = (v: string, nombres: (string | null | undefined)[]) =>
  v.length >= 3 && nombres.map(norm).some((n) => n.length >= 3 && (v === n || v.includes(n) || n.includes(v)));

export default function EsquemaFisico() {
  const [d, setD] = useState<{ fgs: any[]; wans: Wan[]; ifs: any[]; sws: any[]; puertos: any[]; disp: any[]; unifi: any[]; srvs: any[] } | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [escala, setEscala] = useState(1);

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("fg_equipos").select("nombre,hostname,modelo,version,ha_modo,ha_sincronizado,responde"),
      sb.from("fg_enlaces").select("equipo,interfaz,nombre,bajada_mbps,subida_mbps,respaldo,conectado"),
      sb.from("fg_interfaces").select("equipo,nombre,alias,rol,ip,estado"),
      sb.from("sw_switches").select("id,nombre,ip,zona,responde,sys_nombre,activo").eq("activo", true),
      sb.from("sw_puertos_vista").select("switch_id,ifindex,nombre,alias,oper_up,es_troncal,vecino,vecino_puerto"),
      sb.from("sw_dispositivos_vista").select("mac,switch_id,ifindex,puerto,dispositivo_id,agente_hostname,unifi_nombre,conocido_descripcion"),
      sb.from("unifi_equipos").select("mac,nombre,modelo,tipo,ip,estado,clientes"),
      sb.from("srv_servidores").select("nombre,rol,dispositivo_id,activo"),
    ]).then(([fg, en, ifs, sw, pu, di, un, sr]) => {
      const a: string[] = [];
      if (fg.error) a.push("No se pudo leer el FortiGate (falta el puente o el permiso de la solapa).");
      if (sw.error || pu.error) a.push("No se pudieron leer los switches (falta el puente SNMP o el permiso de la solapa).");
      if (sr.error) a.push("No se pudieron leer los servidores: se muestran solo como equipos conectados.");
      setAvisos(a);
      setD({ fgs: fg.data ?? [], wans: (en.data ?? []) as Wan[], ifs: ifs.data ?? [], sws: sw.data ?? [], puertos: pu.data ?? [], disp: di.data ?? [], unifi: un.data ?? [], srvs: sr.data ?? [] });
    });
  }, []);

  const m = useMemo(() => {
    if (!d) return null;
    const nodos = new Map<number, Nodo>();
    const padre = new Map<number, number>();
    const idSw = (id: number) => 1000 + id;

    // FortiGate (los que tienen más enlaces WAN primero) y sus WAN
    const wansDe = (eq: string): Wan[] => {
      const l = d.wans.filter((w) => w.equipo === eq);
      if (l.length) return l;
      return d.ifs.filter((i) => i.equipo === eq && /wan/i.test(`${i.rol ?? ""} ${i.nombre ?? ""}`))
        .map((i) => ({ equipo: eq, interfaz: i.nombre, nombre: i.alias || null, bajada_mbps: null, subida_mbps: null, respaldo: false, conectado: i.estado ? /up/i.test(i.estado) : null }));
    };
    const fgs = [...d.fgs].sort((a, b) => wansDe(b.nombre).length - wansDe(a.nombre).length || a.nombre.localeCompare(b.nombre));
    const idFg = new Map<string, number>();
    fgs.forEach((f, i) => {
      idFg.set(f.nombre, i + 1); padre.set(i + 1, INTERNET);
      nodos.set(i + 1, { id: i + 1, tipo: "fg", nombre: f.nombre, sub: [f.modelo, f.version].filter(Boolean).join(" · "), estado: f.responde === false ? "caido" : f.responde ? "ok" : "desconocido",
        lineas: [f.hostname && `Hostname: ${f.hostname}`, f.ha_modo && `HA: ${f.ha_modo}${f.ha_sincronizado === false ? " (sin sincronizar)" : ""}`,
          ...wansDe(f.nombre).map((w) => `WAN ${w.interfaz}: ${w.nombre ?? "sin nombre"}${w.conectado === false ? " (caído)" : ""}`)].filter(Boolean) as string[] });
    });

    // Switches: quién es vecino de quién (LLDP / CDP)
    const nombrePuerto = (p: any) => p.alias ? `${p.nombre ?? p.ifindex} (${p.alias})` : `${p.nombre ?? p.ifindex}`;
    const haciaFg = new Map<number, { fg: number; puerto: string }>();
    const vecinos = new Map<number, { otro: number; puerto: string }[]>();
    const hojas = new Map<number, Map<string, Nodo>>();
    let sig = 100000;
    const hoja = (sw: number, tipo: Tipo, nombre: string, sub: string, estado: Estado, lineas: string[]) => {
      const l = hojas.get(sw) ?? new Map<string, Nodo>();
      const k = norm(nombre);
      if (!l.has(k)) l.set(k, { id: sig++, tipo, nombre, sub, estado, lineas });
      hojas.set(sw, l);
    };
    const apDe = (nombre: string) => d.unifi.find((u) => u.nombre && parecido(norm(nombre), [u.nombre]));
    const srvPorDisp = new Map(d.srvs.filter((s) => s.dispositivo_id).map((s) => [s.dispositivo_id, s]));
    const puertoEstado = (p: any): Estado => (p.oper_up === false ? "caido" : p.oper_up ? "ok" : "desconocido");

    for (const p of d.puertos) {
      const v = norm(p.vecino);
      if (!v) continue;
      const fg = fgs.find((f) => parecido(v, [f.hostname, f.nombre]));
      if (fg) { if (!haciaFg.has(p.switch_id)) haciaFg.set(p.switch_id, { fg: idFg.get(fg.nombre)!, puerto: nombrePuerto(p) }); continue; }
      const otro = d.sws.find((s) => s.id !== p.switch_id && parecido(v, [s.sys_nombre, s.nombre]));
      if (otro) {
        vecinos.set(p.switch_id, [...(vecinos.get(p.switch_id) ?? []), { otro: otro.id, puerto: nombrePuerto(p) }]);
        vecinos.set(otro.id, [...(vecinos.get(otro.id) ?? []), { otro: p.switch_id, puerto: p.vecino_puerto ?? "" }]);
        continue;
      }
      const ap = apDe(p.vecino);
      const srv = d.srvs.find((s) => parecido(v, [s.nombre]));
      if (ap) hoja(p.switch_id, ap.tipo === "uap" ? "ap" : "otro", ap.nombre, `Puerto ${nombrePuerto(p)}`, ap.estado === 1 ? "ok" : "caido", [ap.modelo && `Modelo: ${ap.modelo}`, ap.ip && `IP: ${ap.ip}`, ap.clientes != null && `Clientes: ${ap.clientes}`].filter(Boolean) as string[]);
      else if (srv) hoja(p.switch_id, "srv", srv.nombre, `Puerto ${nombrePuerto(p)}`, puertoEstado(p), [srv.rol && `Rol: ${srv.rol}`].filter(Boolean) as string[]);
      else hoja(p.switch_id, "otro", p.vecino, `Puerto ${nombrePuerto(p)}`, puertoEstado(p), ["Vecino informado por LLDP/CDP; no coincide con un switch, antena ni servidor cargado."]);
    }

    // Equipos en puertos de acceso (tabla MAC): servidores y antenas con nombre; el resto se cuenta
    const resto = new Map<number, number>();
    for (const x of d.disp) {
      const srv = x.dispositivo_id ? srvPorDisp.get(x.dispositivo_id) : undefined;
      const sub = `Puerto ${x.puerto ?? x.ifindex}`;
      if (srv) hoja(x.switch_id, "srv", srv.nombre, sub, "ok", [srv.rol && `Rol: ${srv.rol}`, `MAC: ${x.mac}`].filter(Boolean) as string[]);
      else if (x.unifi_nombre) {
        const u = d.unifi.find((k) => k.mac === x.mac);
        hoja(x.switch_id, !u || u.tipo === "uap" ? "ap" : "otro", x.unifi_nombre, sub, u && u.estado !== 1 ? "caido" : "ok", [u?.modelo && `Modelo: ${u.modelo}`, u?.ip && `IP: ${u.ip}`, u?.clientes != null && `Clientes: ${u.clientes}`, `MAC: ${x.mac}`].filter(Boolean) as string[]);
      } else resto.set(x.switch_id, (resto.get(x.switch_id) ?? 0) + 1);
    }

    // Árbol de switches: primero los que ven al FortiGate; el resto cuelga de su vecino. Sin vecino detectado: enlace supuesto.
    const fgDefecto = fgs.length ? 1 : INTERNET;
    const puesto = new Set<number>();
    const colgar = (sw: any, de: number, puerto: string, supuesto: boolean) => {
      puesto.add(sw.id); padre.set(idSw(sw.id), de);
      nodos.set(idSw(sw.id), { id: idSw(sw.id), tipo: "sw", nombre: sw.nombre, sub: sw.ip, estado: sw.responde === false ? "caido" : sw.responde ? "ok" : "desconocido", supuesto,
        lineas: [sw.zona && `Zona: ${sw.zona}`, sw.sys_nombre && `Nombre SNMP: ${sw.sys_nombre}`, supuesto ? "Enlace supuesto: ningún vecino LLDP/CDP lo une al resto." : puerto && `Sube por el puerto ${puerto}`].filter(Boolean) as string[] });
      const cola = [sw.id];
      while (cola.length) {
        const a = cola.shift()!;
        for (const v of vecinos.get(a) ?? []) {
          const s = d.sws.find((k) => k.id === v.otro);
          if (!s || puesto.has(s.id)) continue;
          puesto.add(s.id); padre.set(idSw(s.id), idSw(a));
          const sube = (vecinos.get(s.id) ?? []).find((k) => k.otro === a)?.puerto ?? "";
          nodos.set(idSw(s.id), { id: idSw(s.id), tipo: "sw", nombre: s.nombre, sub: s.ip, estado: s.responde === false ? "caido" : s.responde ? "ok" : "desconocido",
            lineas: [s.zona && `Zona: ${s.zona}`, s.sys_nombre && `Nombre SNMP: ${s.sys_nombre}`, `Conectado a ${d.sws.find((k) => k.id === a)?.nombre}${sube ? ` por el puerto ${sube}` : ""}`].filter(Boolean) as string[] });
          cola.push(s.id);
        }
      }
    };
    for (const s of d.sws) { const f = haciaFg.get(s.id); if (f && !puesto.has(s.id)) colgar(s, f.fg, f.puerto, false); }
    for (const s of [...d.sws].sort((a, b) => (vecinos.get(b.id)?.length ?? 0) - (vecinos.get(a.id)?.length ?? 0))) if (!puesto.has(s.id)) colgar(s, fgDefecto, "", true);

    for (const s of d.sws) {
      for (const h of Array.from(hojas.get(s.id)?.values() ?? [])) { nodos.set(h.id, h); padre.set(h.id, idSw(s.id)); }
      const n = resto.get(s.id) ?? 0;
      if (n) { const id = sig++; nodos.set(id, { id, tipo: "resto", nombre: `${n} ${n === 1 ? "equipo más" : "equipos más"}`, sub: "PC, impresoras, etc.", estado: "desconocido", lineas: ["Equipos en puertos de acceso. El detalle está en Infraestructura → Switches."] }); padre.set(id, idSw(s.id)); }
    }

    const peso: Record<Tipo, number> = { fg: 0, sw: 1, srv: 2, ap: 3, otro: 4, resto: 5 };
    const dibujo = diagramar(padre, (a, b) => {
      const x = nodos.get(a), y = nodos.get(b);
      return (peso[x?.tipo ?? "otro"] - peso[y?.tipo ?? "otro"]) || (x?.nombre ?? "").localeCompare(y?.nombre ?? "", "es", { numeric: true });
    });
    const maxWan = Math.max(0, ...fgs.map((f) => wansDe(f.nombre).length));
    const arriba = fgs.length ? Math.max(0, maxWan * (PILL.h + PILL.g) + 40 - (NODO.h + NODO.gy)) : 0;
    const vistas = new Set(Array.from(nodos.values()).map((n) => norm(n.nombre)));
    return {
      nodos, dibujo, fgs, wansDe, idFg, arriba,
      cuenta: (t: Tipo) => Array.from(nodos.values()).filter((n) => n.tipo === t).length,
      supuestos: Array.from(nodos.values()).filter((n) => n.supuesto).length,
      apsSueltas: d.unifi.filter((u) => u.tipo === "uap" && !vistas.has(norm(u.nombre))).length,
      srvSueltos: d.srvs.filter((s) => s.activo !== false && !vistas.has(norm(s.nombre))).length,
    };
  }, [d]);

  if (!d || !m) return <div className="card p-6 text-sm text-ink/50">Cargando…</div>;
  if (!m.fgs.length && !d.sws.length) {
    return <div className="card p-6 text-sm text-ink/60">{avisos[0] ?? "Todavía no hay FortiGate ni switches informando a la app. El esquema se arma solo cuando los puentes del FortiGate y de los switches están configurados."}</div>;
  }

  const { dibujo, nodos } = m;
  const pos = new Map(dibujo.nodos.map((n) => [n.id, n]));
  const elegido = sel !== null ? nodos.get(sel) : undefined;
  const hayFg = m.fgs.length > 0;
  const W = dibujo.ancho + 40, H = dibujo.alto + 40 + m.arriba;

  return (
    <div className="space-y-4">
      {avisos.map((a) => <p key={a} role="alert" className="text-sm text-amber-800 bg-amber-500/10 rounded-md px-3 py-2">{a}</p>)}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {([["Enlaces WAN", m.fgs.reduce((s, f) => s + m.wansDe(f.nombre).length, 0)], ["FortiGate", m.fgs.length], ["Switches", m.cuenta("sw")], ["Servidores", m.cuenta("srv")], ["Antenas", m.cuenta("ap")]] as const).map(([t, n]) => (
          <div key={t} className="card p-4"><div className="text-xs text-ink/50">{t}</div><div className="font-display text-3xl mt-1 text-ink">{n}</div></div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-line/[0.06] text-xs text-ink/60 flex-wrap">
          <span className="flex items-center gap-3 flex-wrap">
            {(["fg", "sw", "srv", "ap"] as const).map((t) => (
              <span key={t} className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm inline-block" style={{ background: BORDE[t] }} aria-hidden />{ROTULO[t]}</span>
            ))}
            <span className="flex items-center gap-1"><i className="w-5 inline-block border-t-2 border-dashed border-line/40" aria-hidden />Enlace supuesto</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full inline-block" style={{ background: COLOR.caido }} aria-hidden />Caído</span>
            <span className="text-ink/40">· Tocá un equipo para ver el detalle</span>
          </span>
          <span className="flex items-center gap-1">
            <button className="btn-secondary px-2 py-1" onClick={() => setEscala((e) => Math.max(0.4, +(e - 0.1).toFixed(1)))} aria-label="Alejar">−</button>
            <span className="w-10 text-center tabular-nums">{Math.round(escala * 100)}%</span>
            <button className="btn-secondary px-2 py-1" onClick={() => setEscala((e) => Math.min(1.5, +(e + 0.1).toFixed(1)))} aria-label="Acercar">+</button>
          </span>
        </div>
        <div className="overflow-auto bg-canvas" style={{ maxHeight: "74vh" }}>
          <svg width={W * escala} height={H * escala} viewBox={`-20 ${-20 - m.arriba} ${W} ${H}`} role="img"
            aria-label="Esquema físico de la red: enlaces WAN, FortiGate, switches, servidores y antenas" className="block mx-auto">
            {dibujo.cajas.map((c) => (
              <g key={`caja-${c.padre}`}>
                <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={14} fill="rgb(var(--c-surface))" stroke="rgb(var(--c-line) / 0.16)" strokeDasharray="5 4" />
                <text x={c.x + 12} y={c.y + 18} fontSize={11} fill="rgb(var(--c-ink) / 0.6)">{c.ids.length} equipos</text>
              </g>
            ))}
            {dibujo.lineas.filter((l) => !(hayFg && l.desde === INTERNET)).map((l, i) => {
              const hijo = l.hasta === "caja" ? undefined : nodos.get(l.hasta);
              const mid = (l.y1 + l.y2) / 2;
              return <path key={i} d={`M ${l.x1} ${l.y1} C ${l.x1} ${mid}, ${l.x2} ${mid}, ${l.x2} ${l.y2}`} fill="none"
                stroke={hijo?.estado === "caido" ? COLOR.caido : LINEA} strokeWidth={hijo?.tipo === "sw" ? 2.5 : 1.5} strokeDasharray={hijo?.supuesto ? "6 4" : undefined} />;
            })}
            {/* Enlaces WAN que entran a cada FortiGate */}
            {m.fgs.map((f) => {
              const p = pos.get(m.idFg.get(f.nombre)!);
              const wans = m.wansDe(f.nombre);
              if (!p) return null;
              const base = p.y - 22;
              const top = base - wans.length * (PILL.h + PILL.g) + PILL.g;
              const cx = p.x + NODO.w / 2;
              return (
                <g key={`wan-${f.nombre}`}>
                  <text x={cx} y={(wans.length ? top : base) - 8} textAnchor="middle" fontSize={12} fontWeight={700} fill="rgb(var(--c-brand))">Internet</text>
                  <path d={`M ${cx} ${wans.length ? base : base - 2} L ${cx} ${p.y}`} stroke={LINEA} strokeWidth={2.5} />
                  {wans.map((w, i) => {
                    const mb = w.bajada_mbps ? `${w.bajada_mbps}/${w.subida_mbps ?? "?"} Mb` : "";
                    return (
                      <g key={w.interfaz} transform={`translate(${p.x},${top + i * (PILL.h + PILL.g)})`}>
                        <title>{`${w.interfaz}${w.nombre ? ` · ${w.nombre}` : ""}${w.respaldo ? " · respaldo" : ""}${w.conectado === false ? " · caído" : ""}`}</title>
                        <rect width={NODO.w} height={PILL.h} rx={PILL.h / 2} fill="rgb(var(--c-surface))" stroke={w.conectado === false ? COLOR.caido : "rgb(var(--c-line) / 0.2)"} />
                        <circle cx={13} cy={PILL.h / 2} r={4} fill={w.conectado === false ? COLOR.caido : w.conectado ? COLOR.ok : COLOR.desconocido} />
                        <text x={24} y={17} fontSize={11.5} fontWeight={600} fill="rgb(var(--c-ink))">{corto(w.nombre ?? w.interfaz, mb ? 13 : 22)}{w.respaldo ? " ↺" : ""}</text>
                        {mb && <text x={NODO.w - 10} y={17} fontSize={10} textAnchor="end" fill="rgb(var(--c-ink) / 0.6)">{mb}</text>}
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {dibujo.nodos.map((n) => {
              if (n.id === INTERNET) {
                if (hayFg) return null;
                return (
                  <g key="internet" transform={`translate(${n.x},${n.y})`}>
                    <rect width={NODO.w} height={NODO.h} rx={NODO.h / 2} fill="rgb(var(--c-surface))" stroke="rgb(var(--c-line) / 0.2)" />
                    <text x={NODO.w / 2} y={NODO.h / 2 + 5} textAnchor="middle" fontSize={15} fontWeight={700} fill="rgb(var(--c-brand))">Internet</text>
                  </g>
                );
              }
              const e = nodos.get(n.id);
              if (!e) return null;
              const activo = sel === n.id;
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} role="button" tabIndex={0} style={{ cursor: "pointer" }} aria-pressed={activo}
                  aria-label={`${ROTULO[e.tipo]} ${e.nombre}${e.estado === "caido" ? ", caído" : ""}`}
                  onClick={() => setSel(activo ? null : n.id)} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSel(activo ? null : n.id); } }}>
                  <rect width={NODO.w} height={NODO.h} rx={10} fill="rgb(var(--c-surface))" stroke={activo ? "rgb(var(--c-brand))" : e.estado === "caido" ? COLOR.caido : "rgb(var(--c-line) / 0.16)"} strokeWidth={activo || e.estado === "caido" ? 2 : 1} />
                  <rect width={6} height={NODO.h} rx={3} fill={BORDE[e.tipo]} />
                  <text x={16} y={18} fontSize={9.5} fill="rgb(var(--c-ink) / 0.5)" style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>{ROTULO[e.tipo]}</text>
                  <text x={16} y={34} fontSize={13} fontWeight={600} fill="rgb(var(--c-ink))">{corto(e.nombre, 21)}</text>
                  <text x={16} y={49} fontSize={10.5} fill="rgb(var(--c-ink) / 0.6)" fontFamily="ui-monospace, monospace">{corto(e.sub, 24)}</text>
                  <circle cx={NODO.w - 12} cy={13} r={4} fill={COLOR[e.estado] ?? COLOR.desconocido} />
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {elegido && (
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-ink/50">{ROTULO[elegido.tipo]}</p>
          <h2 className="font-display font-bold text-ink text-lg">{elegido.nombre}</h2>
          <p className="text-sm text-ink/60 font-mono">{elegido.sub}</p>
          {elegido.lineas.length > 0 && <ul className="text-sm text-ink/70 mt-2 space-y-0.5">{elegido.lineas.map((l) => <li key={l}>{l}</li>)}</ul>}
        </div>
      )}

      <ul className="text-xs text-ink/50 space-y-1">
        {m.supuestos > 0 && <li>{m.supuestos} {m.supuestos === 1 ? "switch tiene" : "switches tienen"} el enlace supuesto (línea punteada): ningún vecino LLDP/CDP los une al FortiGate o a otro switch.</li>}
        {m.srvSueltos > 0 && <li>{m.srvSueltos} {m.srvSueltos === 1 ? "servidor cargado no aparece" : "servidores cargados no aparecen"}: para ubicarlos en una boca hace falta conocer su MAC (agente instalado) o que anuncien LLDP.</li>}
        {m.apsSueltas > 0 && <li>{m.apsSueltas} {m.apsSueltas === 1 ? "antena no se ve" : "antenas no se ven"} en ningún switch monitoreado.</li>}
      </ul>
    </div>
  );
}
