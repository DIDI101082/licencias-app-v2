"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";

type Cap = { id: number; nombre: string; descripcion: string | null; obligatoria: boolean; vigencia_meses: number | null };
type Estado = { empleado_id: string; empleado: string; area: string | null; capacitacion_id: number; ultima: string | null; vence: string | null; estado: "al_dia" | "vencida" | "pendiente" };
type Emp = { id: string; nombre: string; apellido: string; area: string | null };
type Campana = { id: number; nombre: string; fecha: string; plantilla: string | null; enviados: number; clics: number; credenciales: number; reportaron: number; notas: string | null };
type Resultado = { campana_id: number; empleado_id: string; clic: boolean; credenciales: boolean; reporto: boolean };

const fd = (f: string | null) => (f ? new Date(f + "T12:00:00").toLocaleDateString("es-AR") : "—");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const ESTADO: Record<string, { t: string; c: string }> = {
  al_dia: { t: "Al día", c: "bg-emerald-50 text-emerald-700" },
  vencida: { t: "Vencida", c: "bg-amber-50 text-amber-700" },
  pendiente: { t: "Pendiente", c: "bg-red-50 text-red-600" },
};

export default function Concientizacion() {
  return <Suspense><Contenido /></Suspense>;
}

function Contenido() {
  const params = useSearchParams();
  const router = useRouter();
  const vista = params.get("vista") === "phishing" ? "phishing" : "capacitaciones";
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-ink">Concientización</h1>
        <p className="text-ink/60 text-sm mt-1">
          Capacitaciones de seguridad por empleado y resultados de simulaciones de phishing. La mayoría de los incidentes
          empiezan con una persona engañada: medir quién está capacitado y quién cae en las simulaciones permite reforzar donde hace falta.
        </p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-line/[0.08]">
        {([["capacitaciones", "Capacitaciones"], ["phishing", "Simulaciones de phishing"]] as const).map(([k, t]) => (
          <button key={k} role="tab" aria-selected={vista === k} onClick={() => router.replace(`/inventario/concientizacion?vista=${k}`)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${vista === k ? "border-brand-600 text-brand-700" : "border-transparent text-ink/60 hover:text-ink"}`}>{t}</button>
        ))}
      </div>
      {vista === "capacitaciones" ? <Capacitaciones /> : <Phishing />}
    </div>
  );
}

function useEmpleados() {
  const [e, setE] = useState<Emp[]>([]);
  useEffect(() => { createClient().from("empleados").select("id, nombre, apellido, area").eq("activo", true).order("apellido").then(({ data }) => setE(data ?? [])); }, []);
  return e;
}

// Selector de personas con búsqueda y "todo el área"
function ElegirPersonas({ empleados, elegidos, onCambio }: { empleados: Emp[]; elegidos: Set<string>; onCambio: (s: Set<string>) => void }) {
  const [q, setQ] = useState("");
  const areas = Array.from(new Set(empleados.map((e) => e.area).filter(Boolean))) as string[];
  const vis = empleados.filter((e) => !q || `${e.nombre} ${e.apellido} ${e.area ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const alternar = (id: string) => { const s = new Set(elegidos); s.has(id) ? s.delete(id) : s.add(id); onCambio(s); };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        <input className="input w-56" placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value="" onChange={(e) => {
          const s = new Set(elegidos);
          empleados.filter((x) => e.target.value === "*" || x.area === e.target.value).forEach((x) => s.add(x.id));
          onCambio(s);
        }}>
          <option value="">Agregar grupo…</option><option value="*">Todos los empleados</option>
          {areas.map((a) => <option key={a} value={a}>Área: {a}</option>)}
        </select>
        <span className="text-xs text-ink/50">{elegidos.size} elegidos</span>
        {elegidos.size > 0 && <button className="text-xs text-ink/50 hover:text-ink" onClick={() => onCambio(new Set())}>Limpiar</button>}
      </div>
      <div className="max-h-56 overflow-y-auto border border-line/[0.08] rounded-lg divide-y divide-line/[0.05]">
        {vis.map((e) => (
          <label key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-line/[0.03]">
            <input type="checkbox" checked={elegidos.has(e.id)} onChange={() => alternar(e.id)} />
            <span className="flex-1">{e.apellido}, {e.nombre}</span><span className="text-xs text-ink/40">{e.area}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function Capacitaciones() {
  const { puedeEditar } = usePerfil();
  const empleados = useEmpleados();
  const [caps, setCaps] = useState<Cap[]>([]);
  const [estados, setEstados] = useState<Estado[]>([]);
  const [capSel, setCapSel] = useState<number | null>(null);
  const [filtro, setFiltro] = useState<"todos" | "pendiente" | "vencida" | "al_dia">("pendiente");
  const [registrar, setRegistrar] = useState(false);
  const [nueva, setNueva] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = async () => {
    const sb = createClient();
    const [c, e] = await Promise.all([sb.from("capacitaciones").select("*").order("id"), sb.from("capacitaciones_v_estado").select("*")]);
    if (c.error) return setError(c.error.message.includes("capacitaciones") ? "Falta ejecutar concientizacion.sql en Supabase." : c.error.message);
    setCaps((c.data ?? []) as Cap[]); setEstados((e.data ?? []) as Estado[]);
    setCapSel((x) => x ?? (c.data?.[0]?.id ?? null));
  };
  useEffect(() => { cargar(); }, []);

  const deLaCap = estados.filter((e) => e.capacitacion_id === capSel);
  const cuenta = (s: string) => deLaCap.filter((e) => e.estado === s).length;
  const lista = deLaCap.filter((e) => filtro === "todos" || e.estado === filtro).sort((a, b) => a.empleado.localeCompare(b.empleado));
  const cap = caps.find((c) => c.id === capSel);
  const porArea = useMemo(() => {
    const m = new Map<string, { total: number; ok: number }>();
    for (const e of deLaCap) { const k = e.area ?? "Sin área"; const v = m.get(k) ?? { total: 0, ok: 0 }; v.total++; if (e.estado === "al_dia") v.ok++; m.set(k, v); }
    return Array.from(m.entries()).sort((a, b) => a[1].ok / a[1].total - b[1].ok / b[1].total);
  }, [deLaCap]);

  if (error) return <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <select className="input w-auto" value={capSel ?? ""} onChange={(e) => setCapSel(Number(e.target.value))}>
          {caps.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.obligatoria ? "" : " (opcional)"}</option>)}
        </select>
        {puedeEditar && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setNueva(!nueva)}>Nueva capacitación</button>
            {cap && <button className="btn-primary" onClick={() => setRegistrar(!registrar)}>Registrar asistencia</button>}
          </div>
        )}
      </div>
      {cap && <p className="text-sm text-ink/60">{cap.descripcion} {cap.vigencia_meses ? `Vence a los ${cap.vigencia_meses} meses.` : "No vence."}{!cap.obligatoria && " Opcional: no cuenta para el cumplimiento."}</p>}

      {nueva && <NuevaCapacitacion onListo={() => { setNueva(false); cargar(); }} />}
      {registrar && cap && <RegistrarAsistencia cap={cap} empleados={empleados} onListo={() => { setRegistrar(false); cargar(); }} />}

      {cap?.obligatoria && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card p-4"><div className="text-xs text-ink/50">Cobertura</div><div className="font-display text-3xl mt-1 text-ink">{pct(cuenta("al_dia"), deLaCap.length)}</div></div>
            {(["al_dia", "vencida", "pendiente"] as const).map((s) => (
              <button key={s} onClick={() => setFiltro(s)} className={`card p-4 text-left ${filtro === s ? "ring-2 ring-brand-600" : ""}`}>
                <div className="text-xs text-ink/50">{ESTADO[s].t}</div>
                <div className={`font-display text-3xl mt-1 ${s === "pendiente" && cuenta(s) ? "text-red-600" : "text-ink"}`}>{cuenta(s)}</div>
              </button>
            ))}
          </div>
          <div className="grid lg:grid-cols-3 gap-4">
            <div className="card overflow-hidden lg:col-span-2">
              <div className="flex gap-1 p-3 border-b border-line/[0.08] text-sm">
                {(["pendiente", "vencida", "al_dia", "todos"] as const).map((k) => (
                  <button key={k} onClick={() => setFiltro(k)} className={`px-3 py-1 rounded-full ${filtro === k ? "bg-brand-600 text-white" : "text-ink/60 hover:bg-line/[0.05]"}`}>{k === "todos" ? "Todos" : ESTADO[k].t}</button>
                ))}
              </div>
              <table className="data w-full">
                <thead><tr><th>Empleado</th><th>Área</th><th>Última vez</th><th>Vence</th><th>Estado</th></tr></thead>
                <tbody>
                  {!lista.length && <tr><td colSpan={5} className="text-center text-ink/50 py-6">Nadie en este estado.</td></tr>}
                  {lista.map((e) => (
                    <tr key={e.empleado_id}>
                      <td className="text-ink">{e.empleado}</td><td className="text-sm text-ink/60">{e.area ?? "—"}</td>
                      <td className="text-sm text-ink/70">{fd(e.ultima)}</td><td className="text-sm text-ink/70">{fd(e.vence)}</td>
                      <td><span className={`pill ${ESTADO[e.estado].c}`}>{ESTADO[e.estado].t}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card p-5">
              <h2 className="font-medium text-ink mb-3">Cobertura por área</h2>
              <ul className="space-y-2.5">
                {porArea.map(([a, v]) => (
                  <li key={a} className="text-sm">
                    <div className="flex justify-between"><span className="text-ink/80">{a}</span><span className="text-ink/60 tabular-nums">{v.ok}/{v.total}</span></div>
                    <div className="h-1.5 rounded-full bg-line/[0.06] mt-1 overflow-hidden"><div className="h-full bg-brand-600" style={{ width: `${(v.ok / v.total) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NuevaCapacitacion({ onListo }: { onListo: () => void }) {
  const [v, setV] = useState({ nombre: "", descripcion: "", obligatoria: true, vigencia_meses: "12" });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card p-4 space-y-3">
      <div className="grid md:grid-cols-2 gap-3">
        <label className="block text-sm">Nombre<input className="input mt-1" value={v.nombre} onChange={(e) => setV({ ...v, nombre: e.target.value })} /></label>
        <label className="block text-sm">Vigencia
          <select className="input mt-1" value={v.vigencia_meses} onChange={(e) => setV({ ...v, vigencia_meses: e.target.value })}>
            <option value="6">6 meses</option><option value="12">1 año</option><option value="24">2 años</option><option value="">No vence</option>
          </select>
        </label>
      </div>
      <label className="block text-sm">Descripción<input className="input mt-1" value={v.descripcion} onChange={(e) => setV({ ...v, descripcion: e.target.value })} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.obligatoria} onChange={(e) => setV({ ...v, obligatoria: e.target.checked })} /> Obligatoria para todos</label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary" disabled={!v.nombre.trim()} onClick={async () => {
        const { error } = await createClient().from("capacitaciones").insert({
          nombre: v.nombre.trim(), descripcion: v.descripcion.trim() || null, obligatoria: v.obligatoria,
          vigencia_meses: v.vigencia_meses ? Number(v.vigencia_meses) : null,
        });
        if (error) setError(error.message); else onListo();
      }}>Crear</button>
    </div>
  );
}

function RegistrarAsistencia({ cap, empleados, onListo }: { cap: Cap; empleados: Emp[]; onListo: () => void }) {
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="text-sm font-medium text-ink flex-1">¿Quiénes completaron “{cap.nombre}”?</div>
        <label className="text-sm">Fecha<input type="date" className="input mt-1" value={fecha} onChange={(e) => setFecha(e.target.value)} /></label>
      </div>
      <ElegirPersonas empleados={empleados} elegidos={elegidos} onCambio={setElegidos} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary" disabled={!elegidos.size} onClick={async () => {
        const { error } = await createClient().from("capacitaciones_completadas")
          .upsert(Array.from(elegidos).map((id) => ({ capacitacion_id: cap.id, empleado_id: id, fecha })), { onConflict: "capacitacion_id,empleado_id,fecha" });
        if (error) setError(error.message); else onListo();
      }}>Registrar {elegidos.size || ""}</button>
    </div>
  );
}

function Phishing() {
  const { puedeEditar } = usePerfil();
  const empleados = useEmpleados();
  const [camps, setCamps] = useState<Campana[]>([]);
  const [res, setRes] = useState<Resultado[]>([]);
  const [nueva, setNueva] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = async () => {
    const sb = createClient();
    const [c, r] = await Promise.all([sb.from("phishing_campanas").select("*").order("fecha", { ascending: false }), sb.from("phishing_resultados").select("*")]);
    if (c.error) return setError(c.error.message.includes("phishing") ? "Falta ejecutar concientizacion.sql en Supabase." : c.error.message);
    setCamps((c.data ?? []) as Campana[]); setRes((r.data ?? []) as Resultado[]);
  };
  useEffect(() => { cargar(); }, []);

  // Personas que cayeron en más de una simulación: prioridad para reforzar
  const reincidentes = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of res) if (r.clic || r.credenciales) m.set(r.empleado_id, (m.get(r.empleado_id) ?? 0) + 1);
    return Array.from(m.entries()).filter(([, n]) => n > 1).map(([id, n]) => ({ e: empleados.find((x) => x.id === id), n })).filter((x) => x.e).sort((a, b) => b.n - a.n);
  }, [res, empleados]);

  if (error) return <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>;
  const ult = camps[0];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2">
        <p className="text-sm text-ink/60">Cargá el resultado de cada simulación (la hagas con Microsoft Attack Simulator, GoPhish u otra herramienta).</p>
        {puedeEditar && <button className="btn-primary" onClick={() => setNueva(!nueva)}>Cargar campaña</button>}
      </div>
      {nueva && <NuevaCampana empleados={empleados} onListo={() => { setNueva(false); cargar(); }} />}

      {ult && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card p-4"><div className="text-xs text-ink/50">Última campaña</div><div className="text-sm text-ink mt-2 font-medium">{ult.nombre}</div><div className="text-xs text-ink/50">{fd(ult.fecha)}</div></div>
          <div className="card p-4"><div className="text-xs text-ink/50">Hicieron clic</div><div className={`font-display text-3xl mt-1 ${ult.clics ? "text-red-600" : "text-ink"}`}>{pct(ult.clics, ult.enviados)}</div></div>
          <div className="card p-4"><div className="text-xs text-ink/50">Ingresaron la contraseña</div><div className={`font-display text-3xl mt-1 ${ult.credenciales ? "text-red-600" : "text-ink"}`}>{pct(ult.credenciales, ult.enviados)}</div></div>
          <div className="card p-4"><div className="text-xs text-ink/50">Lo reportaron</div><div className="font-display text-3xl mt-1 text-emerald-700">{pct(ult.reportaron, ult.enviados)}</div></div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card overflow-hidden lg:col-span-2">
          <table className="data w-full">
            <thead><tr><th>Campaña</th><th>Enviados</th><th>Clic</th><th>Contraseña</th><th>Reportaron</th>{puedeEditar && <th></th>}</tr></thead>
            <tbody>
              {!camps.length && <tr><td colSpan={6} className="text-center text-ink/50 py-6">Todavía no hay campañas cargadas.</td></tr>}
              {camps.map((c) => (
                <tr key={c.id}>
                  <td><div className="text-ink font-medium">{c.nombre}</div><div className="text-xs text-ink/50">{fd(c.fecha)}{c.plantilla ? ` · ${c.plantilla}` : ""}</div></td>
                  <td className="tabular-nums text-sm">{c.enviados}</td>
                  <td className="tabular-nums text-sm">{c.clics} <span className="text-ink/40">({pct(c.clics, c.enviados)})</span></td>
                  <td className="tabular-nums text-sm">{c.credenciales} <span className="text-ink/40">({pct(c.credenciales, c.enviados)})</span></td>
                  <td className="tabular-nums text-sm">{c.reportaron} <span className="text-ink/40">({pct(c.reportaron, c.enviados)})</span></td>
                  {puedeEditar && <td className="text-right"><button className="text-xs text-ink/40 hover:text-red-600" onClick={async () => {
                    if (!confirm(`¿Borrar la campaña "${c.nombre}"?`)) return;
                    const { error } = await createClient().from("phishing_campanas").delete().eq("id", c.id);
                    if (error) setError(error.message); else cargar();
                  }}>Borrar</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-1">Cayeron más de una vez</h2>
          <p className="text-xs text-ink/50 mb-3">Solo con campañas cargadas por persona. Conviene una capacitación individual.</p>
          {!reincidentes.length ? <p className="text-sm text-ink/50">Nadie por ahora.</p> : (
            <ul className="space-y-1.5 text-sm">
              {reincidentes.map(({ e, n }) => <li key={e!.id} className="flex justify-between"><span>{e!.apellido}, {e!.nombre}</span><span className="text-red-600 tabular-nums">{n} veces</span></li>)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function NuevaCampana({ empleados, onListo }: { empleados: Emp[]; onListo: () => void }) {
  const [v, setV] = useState({ nombre: "", fecha: new Date().toISOString().slice(0, 10), plantilla: "", enviados: "", clics: "", credenciales: "", reportaron: "" });
  const [porPersona, setPorPersona] = useState(false);
  const [destinatarios, setDestinatarios] = useState<Set<string>>(new Set());
  const [clic, setClic] = useState<Set<string>>(new Set());
  const [cred, setCred] = useState<Set<string>>(new Set());
  const [rep, setRep] = useState<Set<string>>(new Set());
  const [paso, setPaso] = useState<"dest" | "clic" | "cred" | "rep">("dest");
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  const destEmp = empleados.filter((e) => destinatarios.has(e.id));

  async function guardar() {
    setError(null);
    const tot = porPersona
      ? { enviados: destinatarios.size, clics: Array.from(clic).filter((x) => destinatarios.has(x)).length, credenciales: Array.from(cred).filter((x) => destinatarios.has(x)).length, reportaron: Array.from(rep).filter((x) => destinatarios.has(x)).length }
      : { enviados: Number(v.enviados) || 0, clics: Number(v.clics) || 0, credenciales: Number(v.credenciales) || 0, reportaron: Number(v.reportaron) || 0 };
    const sb = createClient();
    const { data, error } = await sb.from("phishing_campanas").insert({ nombre: v.nombre.trim(), fecha: v.fecha, plantilla: v.plantilla.trim() || null, ...tot }).select("id").single();
    if (error) return setError(error.message);
    if (porPersona && destinatarios.size) {
      const { error: e2 } = await sb.from("phishing_resultados").insert(Array.from(destinatarios).map((id) => ({
        campana_id: data.id, empleado_id: id, clic: clic.has(id) || cred.has(id), credenciales: cred.has(id), reporto: rep.has(id),
      })));
      if (e2) return setError(e2.message);
    }
    onListo();
  }

  return (
    <div className="card p-4 space-y-3">
      <div className="grid md:grid-cols-3 gap-3">
        <label className="block text-sm">Nombre<input className="input mt-1" value={v.nombre} onChange={set("nombre")} placeholder="Ej.: Simulación octubre" /></label>
        <label className="block text-sm">Fecha<input type="date" className="input mt-1" value={v.fecha} onChange={set("fecha")} /></label>
        <label className="block text-sm">Qué simulaba<input className="input mt-1" value={v.plantilla} onChange={set("plantilla")} placeholder="Ej.: factura falsa" /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={porPersona} onChange={(e) => setPorPersona(e.target.checked)} /> Cargar resultados por persona (permite detectar reincidentes)</label>
      {!porPersona ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(["enviados", "clics", "credenciales", "reportaron"] as const).map((k) => (
            <label key={k} className="block text-sm">{{ enviados: "Enviados", clics: "Hicieron clic", credenciales: "Ingresaron contraseña", reportaron: "Reportaron" }[k]}
              <input type="number" min={0} className="input mt-1" value={v[k]} onChange={set(k)} /></label>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-1 text-sm">
            {([["dest", `1. Destinatarios (${destinatarios.size})`], ["clic", `2. Hicieron clic (${clic.size})`], ["cred", `3. Contraseña (${cred.size})`], ["rep", `4. Reportaron (${rep.size})`]] as const).map(([k, t]) => (
              <button key={k} onClick={() => setPaso(k)} disabled={k !== "dest" && !destinatarios.size}
                className={`px-3 py-1 rounded-full ${paso === k ? "bg-brand-600 text-white" : "text-ink/60 hover:bg-line/[0.05]"}`}>{t}</button>
            ))}
          </div>
          {paso === "dest" && <ElegirPersonas empleados={empleados} elegidos={destinatarios} onCambio={setDestinatarios} />}
          {paso === "clic" && <ElegirPersonas empleados={destEmp} elegidos={clic} onCambio={setClic} />}
          {paso === "cred" && <ElegirPersonas empleados={destEmp} elegidos={cred} onCambio={setCred} />}
          {paso === "rep" && <ElegirPersonas empleados={destEmp} elegidos={rep} onCambio={setRep} />}
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary" disabled={!v.nombre.trim() || (porPersona && !destinatarios.size)} onClick={guardar}>Guardar campaña</button>
    </div>
  );
}
