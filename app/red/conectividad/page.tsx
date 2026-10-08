"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import EsquemaFisico from "@/components/EsquemaFisico";
import EsquemaSimple from "@/components/EsquemaSimple";

// Mapa de conectividad: desde dónde se conectan los equipos, por dónde pasan y a qué servidores llegan.
// Cuatro vistas: el esquema físico (WAN → FortiGate → switches → servidores y antenas), lo que permite el firewall (políticas del FortiGate), lo que se usó (accesos a servidores) y la carga manual.
type Columna = "origen" | "paso" | "destino";
type Estado = "permitido" | "restringido" | "revisar";
type Nodo = { id: number; columna: Columna; nombre: string; detalle: string | null; grupo: string | null; orden: number };
type Enlace = { id: number; origen_id: number; via_id: number | null; destino_id: number; servicio: string | null; estado: Estado; nota: string | null };

const COLUMNAS: { id: Columna; titulo: string; ayuda: string; ejemplo: string }[] = [
  { id: "origen", titulo: "Desde dónde", ayuda: "Oficinas, VLAN de usuarios, home office", ejemplo: "Piso 4 · cableada" },
  { id: "paso", titulo: "Por dónde", ayuda: "Firewall, VPN, ZTNA, servidor de salto", ejemplo: "VPN FortiClient" },
  { id: "destino", titulo: "A qué llegan", ayuda: "Servidores y servicios", ejemplo: "SRV-FILES01" },
];
const ESTADOS: Record<Estado, { texto: string; color: string; pill: string }> = {
  permitido: { texto: "Permitido", color: "#10B981", pill: "bg-emerald-50 text-emerald-700" },
  restringido: { texto: "Con aprobación", color: "#F59E0B", pill: "bg-amber-500/10 text-amber-700" },
  revisar: { texto: "A revisar", color: "#EF4444", pill: "bg-red-50 text-red-600" },
};
const N = { w: 210, h: 50, gy: 12, gcol: 150, titulo: 34, grupo: 22 };
const corto = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
type Modo = "simple" | "fisico" | "firewall" | "accesos" | "manual";
const MODOS: { id: Modo; titulo: string; ayuda: string }[] = [
  { id: "simple", titulo: "Esquema", ayuda: "Vista general: los enlaces WAN que entran al FortiGate, los switches de core y lo que cuelga de ellos (servidores VMware, switches UniFi y antenas)." },
  { id: "fisico", titulo: "Detalle por boca", ayuda: "Qué enlaces WAN entran a cada FortiGate, a qué switches baja y qué servidores y antenas cuelgan de cada switch. Se arma solo con lo que informan el FortiGate, los switches y UniFi." },
  { id: "firewall", titulo: "Permitido por el firewall", ayuda: "Se arma solo con las políticas activas de cada FortiGate. En rojo, las que dejan pasar cualquier servicio (ALL)." },
  { id: "accesos", titulo: "Accesos observados", ayuda: "Se arma solo con los inicios de sesión de los últimos 30 días en los servidores que tienen el agente." },
  { id: "manual", titulo: "Manual", ayuda: "Lo que cargó un administrador." },
];
type Politica = { equipo: string; id: number; nombre: string | null; desde: string | null; hacia: string | null; origen: string | null; destino: string | null; servicio: string | null; hits: number | null };
type Acceso = { hostname: string | null; usuario: string; logon_type: number | null; ip: string | null; origen: string | null };
type Red = { nombre: string; sede: string; cidr: string; tipo: string };

const ipNum = (ip: string) => { const p = ip.split(".").map(Number); return p.length === 4 && p.every((x) => x >= 0 && x <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null; };
function enRed(ip: string, cidr: string) {
  const [base, bits] = cidr.split("/"); const a = ipNum(ip), b = ipNum(base); const n = Number(bits ?? 32);
  if (a === null || b === null) return false;
  const masc = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & masc) >>> 0) === ((b & masc) >>> 0);
}
const unir = (l: string[], max: number) => { const u = Array.from(new Set(l.filter(Boolean))); return u.length > max ? `${u.slice(0, max).join(", ")} +${u.length - max}` : u.join(", "); };

// Arma puntos y conexiones a partir de filas "origen → paso → destino" (se agrupan las repetidas)
function armar(filas: { o: [string, string, string]; v: [string, string] | null; d: [string, string, string]; servicio: string; estado: Estado; peso: number }[], nota: (n: number, peso: number) => string) {
  const nodos = new Map<string, Nodo>();
  const nodo = (columna: Columna, nombre: string, detalle: string, grupo: string) => {
    const k = `${columna}|${grupo}|${nombre}|${detalle}`;
    if (!nodos.has(k)) nodos.set(k, { id: -(nodos.size + 1), columna, nombre, detalle: detalle || null, grupo: grupo || null, orden: 0 });
    return nodos.get(k)!.id;
  };
  const grupos = new Map<string, { o: number; v: number | null; d: number; servicios: string[]; estado: Estado; n: number; peso: number }>();
  for (const f of filas) {
    const o = nodo("origen", ...f.o), v = f.v ? nodo("paso", f.v[0], f.v[1], "") : null, d = nodo("destino", ...f.d);
    const k = `${o}|${v}|${d}`;
    const g = grupos.get(k) ?? { o, v, d, servicios: [], estado: "permitido" as Estado, n: 0, peso: 0 };
    g.servicios.push(f.servicio); g.n++; g.peso += f.peso; if (f.estado === "revisar") g.estado = "revisar";
    grupos.set(k, g);
  }
  const enlaces: Enlace[] = Array.from(grupos.values()).map((g, i) => ({
    id: -(i + 1), origen_id: g.o, via_id: g.v, destino_id: g.d, servicio: unir(g.servicios, 4) || null, estado: g.estado, nota: nota(g.n, g.peso),
  }));
  const lista = Array.from(nodos.values()).sort((a, b) => (a.grupo ?? "").localeCompare(b.grupo ?? "") || a.nombre.localeCompare(b.nombre));
  return { nodos: lista, enlaces };
}

const falta = (m: string) => (m.includes("red_conect") ? "Falta ejecutar conectividad.sql en Supabase." : m);

export default function MapaConectividad() {
  const { esAdmin } = usePerfil();
  const [nodosM, setNodos] = useState<Nodo[]>([]);
  const [enlacesM, setEnlaces] = useState<Enlace[]>([]);
  const [modo, setModo] = useState<Modo>("simple");
  const [politicas, setPoliticas] = useState<Politica[]>([]);
  const [accesos, setAccesos] = useState<Acceso[]>([]);
  const [redes, setRedes] = useState<Red[]>([]);
  const [sinDatos, setSinDatos] = useState<Partial<Record<Modo, string>>>({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [texto, setTexto] = useState("");
  const [filtro, setFiltro] = useState<Estado | "">("");
  const [editar, setEditar] = useState(false);
  const [fNodo, setFNodo] = useState({ columna: "origen" as Columna, nombre: "", detalle: "", grupo: "" });
  const [fEnlace, setFEnlace] = useState({ origen: "", via: "", destino: "", servicio: "", estado: "permitido" as Estado, nota: "" });

  async function cargar() {
    const sb = createClient();
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    const [n, e, pol, acc, red] = await Promise.all([
      sb.from("red_conect_nodos").select("*").order("grupo").order("orden").order("nombre"),
      sb.from("red_conect_enlaces").select("*").order("id"),
      sb.from("fg_politicas").select("equipo,id,nombre,desde,hacia,origen,destino,servicio,hits").eq("estado", "enable").eq("accion", "accept").limit(2000),
      sb.from("srv_accesos").select("hostname,usuario,logon_type,ip,origen").eq("tipo", "inicio").gte("fecha", desde).order("fecha", { ascending: false }).limit(5000),
      sb.from("inv_redes").select("nombre,sede,cidr,tipo"),
    ]);
    setPoliticas((pol.data ?? []) as Politica[]); setAccesos((acc.data ?? []) as Acceso[]); setRedes((red.data ?? []) as Red[]);
    setSinDatos({
      firewall: pol.error ? "No se pudieron leer las políticas del FortiGate (¿tenés la solapa de red y el puente del FortiGate configurado?)." : undefined,
      accesos: acc.error ? "No se pudieron leer los accesos a servidores (hace falta tener habilitada la solapa Servidores)." : undefined,
    });
    const err = n.error ?? e.error;
    if (err) setError(falta(err.message));
    setNodos((n.data ?? []) as Nodo[]); setEnlaces((e.data ?? []) as Enlace[]); setCargando(false);
  }
  useEffect(() => { cargar(); }, []);

  // Vistas automáticas: se calculan con lo que la app ya tiene cargado
  const auto = useMemo(() => {
    const firewall = armar(politicas.map((p) => {
      const todo = (v: string | null) => !v || /^all$/i.test(v.trim());
      return {
        o: [todo(p.origen) ? `Toda la red ${p.desde ?? ""}`.trim() : p.origen!, p.desde ?? "", p.equipo] as [string, string, string],
        v: [p.equipo, "FortiGate"] as [string, string],
        d: [todo(p.destino) ? `Toda la red ${p.hacia ?? ""}`.trim() : p.destino!, p.hacia ?? "", p.equipo] as [string, string, string],
        servicio: p.servicio ?? "", estado: (/(^|,\s*)all($|,)/i.test(p.servicio ?? "") ? "revisar" : "permitido") as Estado, peso: Number(p.hits ?? 0),
      };
    }), (n, hits) => `${n} ${n === 1 ? "política" : "políticas"} · ${hits.toLocaleString("es-AR")} usos`);
    const vpn = redes.find((r) => r.tipo === "vpn");
    const observados = armar(accesos.filter((a) => a.hostname).map((a) => {
      const ip = (a.ip ?? "").trim();
      const red = ip ? redes.find((r) => enRed(ip, r.cidr)) : undefined;
      const local = !ip || ip === "-" || ip === "127.0.0.1" || ip === "::1";
      return {
        o: (red ? [red.nombre, red.cidr, red.sede] : local ? ["Consola del servidor", "", "Sin red"] : ["Red no identificada", ip, "Sin red"]) as [string, string, string],
        v: red?.tipo === "vpn" && vpn ? [vpn.nombre, "VPN"] as [string, string] : null,
        d: [a.hostname!, "", "Servidores"] as [string, string, string],
        servicio: a.logon_type === 10 ? "RDP" : a.logon_type === 2 ? "Consola" : a.logon_type === 11 ? "Credenciales en caché" : "", estado: (red || local ? "permitido" : "revisar") as Estado, peso: 1,
      };
    }), (n) => `${n} ${n === 1 ? "inicio de sesión" : "inicios de sesión"} en 30 días`);
    return { firewall, accesos: observados };
  }, [politicas, accesos, redes]);
  const { nodos, enlaces } = modo === "manual" ? { nodos: nodosM, enlaces: enlacesM } : modo === "fisico" || modo === "simple" ? { nodos: [] as Nodo[], enlaces: [] as Enlace[] } : auto[modo];
  const edita = esAdmin && editar && modo === "manual";

  const porId = useMemo(() => new Map(nodos.map((n) => [n.id, n])), [nodos]);

  // Diagramado: tres columnas, cada una agrupada por sede / VLAN
  const dibujo = useMemo(() => {
    const pos = new Map<number, { x: number; y: number }>();
    const rotulos: { x: number; y: number; texto: string }[] = [];
    let alto = 0;
    COLUMNAS.forEach((c, i) => {
      const x = i * (N.w + N.gcol);
      let y = N.titulo;
      let grupo: string | null | undefined;
      for (const n of nodos.filter((k) => k.columna === c.id)) {
        if ((n.grupo ?? "") !== (grupo ?? "") || grupo === undefined) {
          grupo = n.grupo ?? "";
          if (grupo) { rotulos.push({ x, y: y + 14, texto: grupo }); y += N.grupo; }
        }
        pos.set(n.id, { x, y });
        y += N.h + N.gy;
      }
      alto = Math.max(alto, y);
    });
    return { pos, rotulos, ancho: 3 * N.w + 2 * N.gcol, alto: Math.max(alto, 160) };
  }, [nodos]);

  const q = texto.trim().toLowerCase();
  const visibles = enlaces.filter((e) => {
    if (filtro && e.estado !== filtro) return false;
    if (sel !== null && ![e.origen_id, e.via_id, e.destino_id].includes(sel)) return false;
    if (!q) return true;
    return [porId.get(e.origen_id), e.via_id ? porId.get(e.via_id) : undefined, porId.get(e.destino_id)]
      .some((n) => n && [n.nombre, n.detalle, n.grupo].some((v) => v?.toLowerCase().includes(q))) || !!e.servicio?.toLowerCase().includes(q);
  });
  const resaltar = sel !== null || !!q || !!filtro;
  const idsVisibles = new Set(visibles.flatMap((e) => [e.origen_id, e.via_id ?? -1, e.destino_id]));
  const nodoActivo = (n: Nodo) => !resaltar || n.id === sel || idsVisibles.has(n.id);

  const curva = (a: number, b: number) => {
    const p = dibujo.pos.get(a), d = dibujo.pos.get(b);
    if (!p || !d) return "";
    const x1 = p.x + N.w, y1 = p.y + N.h / 2, x2 = d.x, y2 = d.y + N.h / 2, m = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${m} ${y1}, ${m} ${y2}, ${x2} ${y2}`;
  };

  async function agregarNodo(ev: React.FormEvent) {
    ev.preventDefault(); setError(null); setAviso(null);
    const { error } = await createClient().from("red_conect_nodos").insert({
      columna: fNodo.columna, nombre: fNodo.nombre.trim(), detalle: fNodo.detalle.trim() || null, grupo: fNodo.grupo.trim() || null,
    });
    if (error) return setError(error.code === "23505" ? "Ya hay un punto con ese nombre en esa columna." : falta(error.message));
    setFNodo({ ...fNodo, nombre: "", detalle: "" }); cargar();
  }
  async function agregarEnlace(ev: React.FormEvent) {
    ev.preventDefault(); setError(null); setAviso(null);
    const { error } = await createClient().from("red_conect_enlaces").insert({
      origen_id: Number(fEnlace.origen), via_id: fEnlace.via ? Number(fEnlace.via) : null, destino_id: Number(fEnlace.destino),
      servicio: fEnlace.servicio.trim() || null, estado: fEnlace.estado, nota: fEnlace.nota.trim() || null,
    });
    if (error) return setError(falta(error.message));
    setFEnlace({ ...fEnlace, destino: "", servicio: "", nota: "" }); cargar();
  }
  async function quitarNodo(n: Nodo) {
    const usados = enlacesM.filter((e) => e.origen_id === n.id || e.destino_id === n.id).length;
    if (!confirm(`¿Quitar "${n.nombre}" del mapa?${usados ? ` Se borran también sus ${usados} conexiones.` : ""}`)) return;
    const { error } = await createClient().from("red_conect_nodos").delete().eq("id", n.id);
    if (error) return setError(error.message);
    setSel(null); cargar();
  }
  async function quitarEnlace(id: number) {
    const { error } = await createClient().from("red_conect_enlaces").delete().eq("id", id);
    if (error) return setError(error.message);
    cargar();
  }
  async function cambiarEstado(id: number, estado: Estado) {
    const { error } = await createClient().from("red_conect_enlaces").update({ estado }).eq("id", id);
    if (error) return setError(error.message);
    cargar();
  }
  // Atajo: trae como puntos del mapa lo que ya está cargado en otras solapas (no crea conexiones)
  async function traer(columna: Columna) {
    setError(null); setAviso(null);
    const sb = createClient();
    const { data, error } = columna === "destino"
      ? await sb.from("srv_servidores").select("nombre, rol, sede").eq("activo", true)
      : await sb.from("inv_redes").select("nombre, sede, cidr, tipo").neq("tipo", "servidores");
    if (error) return setError(`No se pudo leer ${columna === "destino" ? "los servidores" : "las redes"}: ${error.message}`);
    const ya = new Set(nodos.filter((n) => n.columna === columna).map((n) => n.nombre.toLowerCase()));
    const nuevos = (data ?? []).filter((r: any) => r.nombre && !ya.has(String(r.nombre).toLowerCase())).map((r: any) => ({
      columna, nombre: r.nombre, detalle: columna === "destino" ? r.rol ?? null : r.cidr ?? null, grupo: r.sede ?? null,
    }));
    if (!nuevos.length) return setAviso("No hay nada nuevo para traer.");
    const ins = await sb.from("red_conect_nodos").insert(nuevos);
    if (ins.error) return setError(falta(ins.error.message));
    setAviso(`Se sumaron ${nuevos.length} puntos. Ahora cargá las conexiones.`); cargar();
  }

  const de = (c: Columna) => nodos.filter((n) => n.columna === c);
  const elegido = sel !== null ? porId.get(sel) : undefined;
  const cuenta = (e: Estado) => enlaces.filter((x) => x.estado === e).length;
  const vacio = !cargando && nodos.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Mapa de conectividad</h1>
          <p className="text-ink/60 text-sm mt-1">Cómo está conectada la red y desde dónde se llega a los servidores.</p>
        </div>
        {esAdmin && modo === "manual" && <button className="btn-secondary" onClick={() => setEditar(!editar)} aria-expanded={editar}>{editar ? "Cerrar edición" : "Editar mapa"}</button>}
      </div>

      <div role="tablist" className="flex gap-1 border-b border-line/[0.08] flex-wrap">
        {MODOS.map((m) => (
          <button key={m.id} role="tab" aria-selected={modo === m.id} onClick={() => { setModo(m.id); setSel(null); setFiltro(""); }}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${modo === m.id ? "border-brand-600 text-brand-700" : "border-transparent text-ink/60 hover:text-ink"}`}>{m.titulo}</button>
        ))}
      </div>
      <p className="text-sm text-ink/60">{MODOS.find((m) => m.id === modo)!.ayuda}</p>

      {error && modo === "manual" && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      {aviso && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-md px-3 py-2">{aviso}</p>}

      {modo === "simple" && <EsquemaSimple />}
      {modo === "fisico" && <EsquemaFisico />}

      {modo !== "fisico" && modo !== "simple" && <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4"><div className="text-xs text-ink/50">Conexiones</div><div className="font-display text-3xl mt-1 text-ink">{enlaces.length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Permitidas</div><div className="font-display text-3xl mt-1 text-emerald-600">{cuenta("permitido")}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">{modo === "manual" ? "Con aprobación" : "Puntos en el mapa"}</div><div className={`font-display text-3xl mt-1 ${modo === "manual" ? "text-amber-600" : "text-ink"}`}>{modo === "manual" ? cuenta("restringido") : nodos.length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">A revisar</div><div className={`font-display text-3xl mt-1 ${cuenta("revisar") ? "text-red-600" : "text-ink"}`}>{cuenta("revisar")}</div></div>
      </div>}

      {esAdmin && modo === "manual" && (editar || vacio) && (
        <div className="card p-5 space-y-5">
          <div>
            <h2 className="font-medium text-ink">1. Puntos del mapa</h2>
            <form onSubmit={agregarNodo} className="grid md:grid-cols-12 gap-3 items-end mt-3">
              <div className="md:col-span-2">
                <label className="label" htmlFor="n-col">Columna</label>
                <select id="n-col" className="input" value={fNodo.columna} onChange={(e) => setFNodo({ ...fNodo, columna: e.target.value as Columna })}>
                  {COLUMNAS.map((c) => <option key={c.id} value={c.id}>{c.titulo}</option>)}
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="label" htmlFor="n-nom">Nombre</label>
                <input id="n-nom" className="input" required value={fNodo.nombre} onChange={(e) => setFNodo({ ...fNodo, nombre: e.target.value })}
                  placeholder={COLUMNAS.find((c) => c.id === fNodo.columna)!.ejemplo} />
              </div>
              <div className="md:col-span-3">
                <label className="label" htmlFor="n-det">IP, rango o VLAN</label>
                <input id="n-det" className="input" value={fNodo.detalle} onChange={(e) => setFNodo({ ...fNodo, detalle: e.target.value })} placeholder="192.168.203.0/24" />
              </div>
              <div className="md:col-span-2">
                <label className="label" htmlFor="n-gru">Sede o grupo</label>
                <input id="n-gru" className="input" value={fNodo.grupo} onChange={(e) => setFNodo({ ...fNodo, grupo: e.target.value })} placeholder="Oficina central" />
              </div>
              <div className="md:col-span-2"><button className="btn-primary w-full">Agregar punto</button></div>
            </form>
            <p className="text-xs text-ink/50 mt-2">
              Atajos: <button type="button" className="text-brand-600 hover:underline" onClick={() => traer("origen")}>traer las redes de Oficina</button>
              {" · "}<button type="button" className="text-brand-600 hover:underline" onClick={() => traer("destino")}>traer los servidores cargados</button>
            </p>
          </div>

          <div>
            <h2 className="font-medium text-ink">2. Conexiones</h2>
            {de("origen").length === 0 || de("destino").length === 0 ? (
              <p className="text-sm text-ink/60 mt-2">Cargá al menos un punto en «Desde dónde» y otro en «A qué llegan» para poder conectarlos.</p>
            ) : (
              <form onSubmit={agregarEnlace} className="grid md:grid-cols-12 gap-3 items-end mt-3">
                <div className="md:col-span-3">
                  <label className="label" htmlFor="e-ori">Desde</label>
                  <select id="e-ori" className="input" required value={fEnlace.origen} onChange={(e) => setFEnlace({ ...fEnlace, origen: e.target.value })}>
                    <option value="">Elegir…</option>
                    {de("origen").map((n) => <option key={n.id} value={n.id}>{n.nombre}</option>)}
                  </select>
                </div>
                <div className="md:col-span-3">
                  <label className="label" htmlFor="e-via">Pasa por</label>
                  <select id="e-via" className="input" value={fEnlace.via} onChange={(e) => setFEnlace({ ...fEnlace, via: e.target.value })}>
                    <option value="">Directo</option>
                    {de("paso").map((n) => <option key={n.id} value={n.id}>{n.nombre}</option>)}
                  </select>
                </div>
                <div className="md:col-span-3">
                  <label className="label" htmlFor="e-des">Llega a</label>
                  <select id="e-des" className="input" required value={fEnlace.destino} onChange={(e) => setFEnlace({ ...fEnlace, destino: e.target.value })}>
                    <option value="">Elegir…</option>
                    {de("destino").map((n) => <option key={n.id} value={n.id}>{n.nombre}</option>)}
                  </select>
                </div>
                <div className="md:col-span-3">
                  <label className="label" htmlFor="e-ser">Servicio / puerto</label>
                  <input id="e-ser" className="input" value={fEnlace.servicio} onChange={(e) => setFEnlace({ ...fEnlace, servicio: e.target.value })} placeholder="RDP 3389" />
                </div>
                <div className="md:col-span-3">
                  <label className="label" htmlFor="e-est">Estado</label>
                  <select id="e-est" className="input" value={fEnlace.estado} onChange={(e) => setFEnlace({ ...fEnlace, estado: e.target.value as Estado })}>
                    {(Object.keys(ESTADOS) as Estado[]).map((k) => <option key={k} value={k}>{ESTADOS[k].texto}</option>)}
                  </select>
                </div>
                <div className="md:col-span-7">
                  <label className="label" htmlFor="e-not">Nota</label>
                  <input id="e-not" className="input" value={fEnlace.nota} onChange={(e) => setFEnlace({ ...fEnlace, nota: e.target.value })} placeholder="Solo el área de CAU" />
                </div>
                <div className="md:col-span-2"><button className="btn-primary w-full">Conectar</button></div>
              </form>
            )}
          </div>
        </div>
      )}

      {vacio && modo === "manual" && !esAdmin && <div className="card p-6 text-sm text-ink/60">Todavía no hay nada cargado en el mapa. Un administrador lo arma desde esta pantalla.</div>}
      {vacio && modo === "firewall" && <div className="card p-6 text-sm text-ink/60">{sinDatos.firewall ?? "Todavía no hay políticas del FortiGate en la app. Llegan con el puente del FortiGate (Perímetro → FortiGate)."}</div>}
      {vacio && modo === "accesos" && <div className="card p-6 text-sm text-ink/60">{sinDatos.accesos ?? "Todavía no hay inicios de sesión registrados. Los informa el agente instalado en cada servidor (Infraestructura → Accesos a servidores)."}</div>}

      {nodos.length > 0 && (
        <>
          <div className="flex gap-3 items-center flex-wrap">
            <input type="search" className="input flex-1 min-w-[220px]" placeholder="Buscar equipo, servidor, IP o servicio" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
            <select className="input w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value as Estado | "")} aria-label="Filtrar por estado">
              <option value="">Todos los estados</option>
              {(Object.keys(ESTADOS) as Estado[]).map((k) => <option key={k} value={k}>{ESTADOS[k].texto}</option>)}
            </select>
            {sel !== null && <button className="btn-secondary" onClick={() => setSel(null)}>Ver todo</button>}
          </div>

          <div className="card overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 border-b border-line/[0.06] text-xs text-ink/60 flex-wrap">
              {(Object.keys(ESTADOS) as Estado[]).filter((k) => modo === "manual" || k !== "restringido").map((k) => (
                <span key={k} className="flex items-center gap-1"><i className="h-0.5 w-5 inline-block" style={{ background: ESTADOS[k].color }} aria-hidden />{ESTADOS[k].texto}</span>
              ))}
              <span className="flex items-center gap-1"><i className="w-5 inline-block border-t-2 border-dashed border-line/40" aria-hidden />Directo (sin paso intermedio)</span>
              <span className="text-ink/40">· Tocá un punto para ver solo sus conexiones</span>
            </div>
            <div className="overflow-auto bg-canvas" style={{ maxHeight: "72vh" }}>
              <svg width={dibujo.ancho + 40} height={dibujo.alto + 30} viewBox={`-20 -10 ${dibujo.ancho + 40} ${dibujo.alto + 30}`}
                role="img" aria-label="Mapa de conectividad entre equipos y servidores" className="block mx-auto">
                {COLUMNAS.map((c, i) => (
                  <text key={c.id} x={i * (N.w + N.gcol)} y={14} fontSize={12} fontWeight={700} fill="rgb(var(--c-ink) / 0.7)" style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>{c.titulo}</text>
                ))}
                {dibujo.rotulos.map((r, i) => <text key={i} x={r.x} y={r.y} fontSize={10.5} fill="rgb(var(--c-ink) / 0.45)">{corto(r.texto, 34)}</text>)}
                {enlaces.map((e) => {
                  const activo = !resaltar || visibles.includes(e);
                  const color = ESTADOS[e.estado]?.color ?? "#9CA3AF";
                  const comun = { fill: "none", stroke: color, strokeWidth: activo && resaltar ? 2.5 : 1.5, opacity: activo ? 0.9 : 0.08 };
                  return (
                    <g key={e.id}>
                      {e.via_id && dibujo.pos.has(e.via_id)
                        ? <><path d={curva(e.origen_id, e.via_id)} {...comun} /><path d={curva(e.via_id, e.destino_id)} {...comun} /></>
                        : <path d={curva(e.origen_id, e.destino_id)} {...comun} strokeDasharray="6 4" />}
                    </g>
                  );
                })}
                {nodos.map((n) => {
                  const p = dibujo.pos.get(n.id);
                  if (!p) return null;
                  const activo = sel === n.id;
                  return (
                    <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={nodoActivo(n) ? 1 : 0.3} role="button" tabIndex={0} style={{ cursor: "pointer" }}
                      aria-label={`${n.nombre}${n.detalle ? `, ${n.detalle}` : ""}`} aria-pressed={activo}
                      onClick={() => setSel(activo ? null : n.id)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSel(activo ? null : n.id); } }}>
                      <rect width={N.w} height={N.h} rx={n.columna === "paso" ? N.h / 2 : 10} fill="rgb(var(--c-surface))"
                        stroke={activo ? "rgb(var(--c-brand))" : "rgb(var(--c-line) / 0.18)"} strokeWidth={activo ? 2 : 1} />
                      <text x={n.columna === "paso" ? N.w / 2 : 14} y={n.detalle ? 21 : 30} textAnchor={n.columna === "paso" ? "middle" : "start"} fontSize={13} fontWeight={600} fill="rgb(var(--c-ink))">{corto(n.nombre, 26)}</text>
                      {n.detalle && <text x={n.columna === "paso" ? N.w / 2 : 14} y={38} textAnchor={n.columna === "paso" ? "middle" : "start"} fontSize={10.5} fill="rgb(var(--c-ink) / 0.6)" fontFamily="ui-monospace, monospace">{corto(n.detalle, 30)}</text>}
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          {elegido && (
            <div className="card p-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="font-display font-bold text-ink">{elegido.nombre}</h2>
                <p className="text-sm text-ink/60">
                  {COLUMNAS.find((c) => c.id === elegido.columna)!.titulo}{elegido.detalle ? <> · <span className="font-mono">{elegido.detalle}</span></> : null}{elegido.grupo ? ` · ${elegido.grupo}` : ""}
                </p>
              </div>
              {edita && <button className="text-sm text-ink/50 hover:text-red-600" onClick={() => quitarNodo(elegido)}>Quitar del mapa</button>}
            </div>
          )}

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Detalle de las conexiones</caption>
              <thead>
                <tr className="text-left text-xs text-ink/50 border-b border-line/[0.06]">
                  <th scope="col" className="px-4 py-2 font-medium">Desde</th><th scope="col" className="px-4 py-2 font-medium">Pasa por</th>
                  <th scope="col" className="px-4 py-2 font-medium">Llega a</th><th scope="col" className="px-4 py-2 font-medium">Servicio</th>
                  <th scope="col" className="px-4 py-2 font-medium">Estado</th><th scope="col" className="px-4 py-2 font-medium">Nota</th>
                  {edita && <th scope="col" className="px-4 py-2"><span className="sr-only">Acciones</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/[0.05]">
                {visibles.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2 text-ink">{porId.get(e.origen_id)?.nombre ?? "—"}</td>
                    <td className="px-4 py-2 text-ink/70">{e.via_id ? porId.get(e.via_id)?.nombre ?? "—" : "Directo"}</td>
                    <td className="px-4 py-2 text-ink font-medium">{porId.get(e.destino_id)?.nombre ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink/70">{e.servicio ?? "—"}</td>
                    <td className="px-4 py-2">
                      {edita ? (
                        <select className="input w-auto py-1" value={e.estado} onChange={(ev) => cambiarEstado(e.id, ev.target.value as Estado)} aria-label="Estado de la conexión">
                          {(Object.keys(ESTADOS) as Estado[]).map((k) => <option key={k} value={k}>{ESTADOS[k].texto}</option>)}
                        </select>
                      ) : <span className={`pill ${ESTADOS[e.estado]?.pill ?? ""}`}>{ESTADOS[e.estado]?.texto ?? e.estado}</span>}
                    </td>
                    <td className="px-4 py-2 text-ink/60">{e.nota ?? ""}</td>
                    {edita && <td className="px-4 py-2 text-right"><button className="text-xs text-ink/40 hover:text-red-600" onClick={() => quitarEnlace(e.id)}>Quitar</button></td>}
                  </tr>
                ))}
                {visibles.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-ink/50">{enlaces.length ? "Ninguna conexión coincide con lo elegido." : "Todavía no hay conexiones cargadas."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
