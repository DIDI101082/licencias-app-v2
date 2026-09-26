"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { fecha, diasHasta } from "@/lib/inventario";

type Venc = {
  origen: "licencia" | "garantia" | "manual"; ref: string; tipo: string; descripcion: string; fecha_vencimiento: string | null;
  aviso_dias: number; responsable: string | null; enlace: string; verificado: string | null; verificacion_error: string | null;
  emisor: string | null; host: string | null;
};

const TIPO: Record<string, string> = {
  licencia: "Licencia", garantia: "Garantía", certificado: "Certificado SSL", dominio: "Dominio",
  secreto: "Secreto / clave", contrato: "Contrato", otro: "Otro",
};
const VACIO = { id: 0, tipo: "certificado", descripcion: "", host: "", fecha_vencimiento: "", aviso_dias: 30, responsable: "", notas: "" };

function estado(v: Venc) {
  const d = diasHasta(v.fecha_vencimiento);
  if (d == null) return { texto: "Sin fecha", clase: "bg-black/[0.05] text-ink/50", orden: 3 };
  if (d < 0) return { texto: `Venció hace ${-d} día${d === -1 ? "" : "s"}`, clase: "bg-red-600 text-white", orden: 0 };
  if (d <= Math.min(7, v.aviso_dias)) return { texto: d === 0 ? "Vence hoy" : `En ${d} día${d === 1 ? "" : "s"}`, clase: "bg-red-50 text-red-600", orden: 1 };
  if (d <= v.aviso_dias) return { texto: `En ${d} días`, clase: "bg-amber-500/10 text-amber-700", orden: 1 };
  return { texto: `En ${d} días`, clase: "bg-emerald-50 text-emerald-700", orden: 2 };
}

export default function Vencimientos() {
  const { puedeEditar } = usePerfil();
  const [items, setItems] = useState<Venc[]>([]);
  const [filtro, setFiltro] = useState("proximos");
  const [tipo, setTipo] = useState("");
  const [form, setForm] = useState<typeof VACIO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [verificando, setVerificando] = useState(false);
  const [cargando, setCargando] = useState(true);

  const cargar = () => createClient().from("vencimientos_v").select("*").order("fecha_vencimiento", { nullsFirst: false })
    .then(({ data, error }) => {
      if (error) setError(error.message.includes("vencimientos") ? "Falta ejecutar vencimientos.sql en Supabase." : error.message);
      setItems((data ?? []) as Venc[]); setCargando(false);
    });
  useEffect(() => { cargar(); }, []);

  const lista = useMemo(() => items
    .filter((v) => !tipo || v.tipo === tipo)
    .filter((v) => {
      const d = diasHasta(v.fecha_vencimiento);
      if (filtro === "proximos") return d == null ? v.origen === "manual" : d <= 90;
      if (filtro === "vencidos") return d != null && d < 0;
      return true;
    })
    .sort((a, b) => estado(a).orden - estado(b).orden || (a.fecha_vencimiento ?? "9").localeCompare(b.fecha_vencimiento ?? "9")),
  [items, filtro, tipo]);

  const vencidos = items.filter((v) => (diasHasta(v.fecha_vencimiento) ?? 1) < 0).length;
  const en30 = items.filter((v) => { const d = diasHasta(v.fecha_vencimiento); return d != null && d >= 0 && d <= 30; }).length;
  const verificables = items.filter((v) => v.origen === "manual" && (v.tipo === "certificado" || v.tipo === "dominio") && v.host).length;

  async function editar(v: Venc) {
    const { data } = await createClient().from("vencimientos").select("*").eq("id", Number(v.ref)).single();
    if (data) setForm({ ...VACIO, ...data, host: data.host ?? "", fecha_vencimiento: data.fecha_vencimiento ?? "", responsable: data.responsable ?? "", notas: data.notas ?? "" });
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    const fila = {
      tipo: form.tipo, descripcion: form.descripcion.trim(), host: form.host.trim() || null,
      fecha_vencimiento: form.fecha_vencimiento || null, aviso_dias: form.aviso_dias,
      responsable: form.responsable.trim() || null, notas: form.notas.trim() || null,
    };
    const sb = createClient();
    const { error } = form.id ? await sb.from("vencimientos").update(fila).eq("id", form.id) : await sb.from("vencimientos").insert(fila);
    if (error) return setError(error.message);
    setForm(null); cargar();
  }

  async function borrar() {
    if (!form?.id || !confirm("¿Quitar este vencimiento?")) return;
    const { error } = await createClient().from("vencimientos").delete().eq("id", form.id);
    if (error) return setError(error.message);
    setForm(null); cargar();
  }

  async function verificar() {
    setVerificando(true); setAviso(null); setError(null);
    const r = await fetch("/api/vencimientos/verificar", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setVerificando(false);
    if (!r.ok) return setError(j.error ?? "No se pudo verificar");
    setAviso(`Verificados ${j.verificados}${j.errores ? `, ${j.errores} con error (ver la columna Detalle)` : ", todos bien"}.`);
    cargar();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Vencimientos</h1>
          <p className="text-ink/60 text-sm mt-1">Licencias, garantías, certificados, dominios, secretos y contratos en un solo lugar.</p>
        </div>
        {puedeEditar && (
          <div className="flex gap-2">
            {verificables > 0 && <button className="btn-secondary" disabled={verificando} onClick={verificar}>{verificando ? "Verificando…" : "Verificar certificados y dominios"}</button>}
            <button className="btn-primary" onClick={() => setForm({ ...VACIO })}>Agregar</button>
          </div>
        )}
      </div>

      {error && <div className="card p-3 text-sm text-red-600 bg-red-50">{error}</div>}
      {aviso && <div className="card p-3 text-sm bg-brand-50 text-ink/80">{aviso}</div>}

      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4"><div className="text-xs text-ink/50">Vencidos</div><div className={`font-display text-3xl mt-1 ${vencidos ? "text-red-600" : "text-ink"}`}>{vencidos}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Vencen en 30 días</div><div className={`font-display text-3xl mt-1 ${en30 ? "text-amber-600" : "text-ink"}`}>{en30}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Total controlados</div><div className="font-display text-3xl mt-1 text-ink">{items.length}</div></div>
      </div>

      {form && (
        <form onSubmit={guardar} className="card p-5 grid sm:grid-cols-2 gap-3">
          <label className="block"><span className="label">Tipo</span>
            <select className="input" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
              {["certificado", "dominio", "secreto", "contrato", "otro"].map((t) => <option key={t} value={t}>{TIPO[t]}</option>)}
            </select></label>
          <label className="block"><span className="label">Descripción</span>
            <input className="input" required value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
              placeholder={form.tipo === "certificado" ? "Web institucional" : form.tipo === "dominio" ? "Dominio principal" : "Soporte FortiGate 200F"} /></label>
          {(form.tipo === "certificado" || form.tipo === "dominio") && (
            <label className="block sm:col-span-2"><span className="label">{form.tipo === "certificado" ? "Sitio a verificar (ej. www.accusys.com.ar o vpn.accusys.com.ar:10443)" : "Dominio (ej. accusys.com.ar)"}</span>
              <input className="input font-mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <span className="text-xs text-ink/50">La fecha se completa sola al tocar “Verificar certificados y dominios”.</span></label>
          )}
          <label className="block"><span className="label">Vence el</span>
            <input type="date" className="input" value={form.fecha_vencimiento} onChange={(e) => setForm({ ...form, fecha_vencimiento: e.target.value })} /></label>
          <label className="block"><span className="label">Avisar con (días de anticipación)</span>
            <input type="number" min={1} max={365} className="input" value={form.aviso_dias} onChange={(e) => setForm({ ...form, aviso_dias: Number(e.target.value) })} /></label>
          <label className="block"><span className="label">Responsable</span>
            <input className="input" value={form.responsable} onChange={(e) => setForm({ ...form, responsable: e.target.value })} placeholder="CAU, Ciberseguridad, proveedor…" /></label>
          <label className="block"><span className="label">Notas (cómo se renueva)</span>
            <input className="input" value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} /></label>
          <div className="sm:col-span-2 flex gap-2 justify-end">
            {form.id > 0 && <button type="button" className="btn-secondary text-red-600 mr-auto" onClick={borrar}>Quitar</button>}
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}>Cancelar</button>
            <button className="btn-primary">Guardar</button>
          </div>
        </form>
      )}

      <div className="flex gap-2 flex-wrap">
        <select className="input w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Período">
          <option value="proximos">Próximos 90 días y vencidos</option><option value="vencidos">Solo vencidos</option><option value="todos">Todos</option>
        </select>
        <select className="input w-auto" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {Object.entries(TIPO).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Estado</th><th>Qué vence</th><th>Tipo</th><th>Fecha</th><th>Responsable</th><th>Detalle</th></tr></thead>
          <tbody>
            {lista.map((v) => {
              const e = estado(v);
              return (
                <tr key={v.origen + v.ref}>
                  <td><span className={`pill ${e.clase}`}>{e.texto}</span></td>
                  <td>
                    {v.origen === "manual" && puedeEditar
                      ? <button className="text-left text-ink font-medium hover:text-brand-700" onClick={() => editar(v)}>{v.descripcion}</button>
                      : <Link href={v.enlace} className="text-ink font-medium hover:text-brand-700">{v.descripcion}</Link>}
                    {v.host && <div className="text-xs text-ink/50 font-mono">{v.host}</div>}
                  </td>
                  <td className="text-ink/70 whitespace-nowrap">{TIPO[v.tipo] ?? v.tipo}</td>
                  <td className="text-ink/70 whitespace-nowrap">{fecha(v.fecha_vencimiento)}</td>
                  <td className="text-ink/70">{v.responsable ?? "—"}</td>
                  <td className="text-xs">
                    {v.verificacion_error ? <span className="text-red-600">{v.verificacion_error}</span>
                      : v.verificado ? <span className="text-ink/60">Verificado {fecha(v.verificado)}{v.emisor ? ` · ${v.emisor}` : ""}</span>
                      : <span className="text-ink/30">—</span>}
                  </td>
                </tr>
              );
            })}
            {!cargando && lista.length === 0 && <tr><td colSpan={6} className="text-center text-ink/40 py-10">Nada vence en este período.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">
        Las licencias y garantías se toman de sus pantallas (se editan allá). Con las alertas activas, llega un aviso a Teams
        cuando algo entra en su período de aviso.
      </p>
    </div>
  );
}
