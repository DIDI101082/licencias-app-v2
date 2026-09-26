"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import MapaAutomatico from "@/components/MapaAutomatico";

type Mapa = { id: number; nombre: string; url: string; alto: number; orden: number };

// Los mapas se cargan desde el navegador de cada usuario: PRTG no necesita estar expuesto a internet,
// se ve desde la oficina o conectado por VPN.
function MapasPrtg() {
  const { esAdmin } = usePerfil();
  const [mapas, setMapas] = useState<Mapa[]>([]);
  const [activo, setActivo] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);
  const [editar, setEditar] = useState(false);
  const [form, setForm] = useState({ nombre: "", url: "", alto: 800 });
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  const cargar = () =>
    createClient().from("red_mapas").select("*").order("orden").order("id").then(({ data, error }) => {
      if (error) setError(error.message.includes("red_mapas") ? "Falta ejecutar red.sql en Supabase." : error.message);
      const lista = (data ?? []) as Mapa[];
      setMapas(lista);
      setActivo((a) => (a && lista.some((m) => m.id === a) ? a : lista[0]?.id ?? null));
      setCargando(false);
    });
  useEffect(() => { cargar(); }, []);

  const mapa = mapas.find((m) => m.id === activo);
  const inseguro = mapa?.url.toLowerCase().startsWith("http://");

  async function agregar(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const url = form.url.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return setError("La dirección tiene que empezar con https://");
    const { error } = await createClient().from("red_mapas").insert({ nombre: form.nombre.trim(), url, alto: form.alto, orden: mapas.length });
    if (error) return setError(error.message);
    setForm({ nombre: "", url: "", alto: 800 }); setEditar(false); cargar();
  }
  async function quitar(m: Mapa) {
    if (!confirm(`¿Quitar el mapa "${m.nombre}" de la app? En PRTG no se borra nada.`)) return;
    await createClient().from("red_mapas").delete().eq("id", m.id); cargar();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <p className="text-ink/60 text-sm">Mapas publicados desde PRTG. Se actualizan solos con el estado de cada sensor.</p>
        <div className="flex gap-2 flex-wrap">
          {mapa && <button className="btn-secondary" onClick={() => setRecarga((n) => n + 1)}>Actualizar</button>}
          {mapa && <a className="btn-secondary" href={mapa.url} target="_blank" rel="noopener noreferrer">Abrir en PRTG</a>}
          {esAdmin && <button className="btn-secondary" onClick={() => setEditar(!editar)} aria-expanded={editar}>Configurar mapas</button>}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      {esAdmin && (editar || (!cargando && mapas.length === 0)) && (
        <div className="card p-5 space-y-4">
          <div>
            <h2 className="font-medium text-ink">Agregar un mapa de PRTG</h2>
            <ol className="text-sm text-ink/70 mt-2 space-y-1 list-decimal pl-5">
              <li>En PRTG: <b>Mapas → Agregar mapa</b> (o editá uno existente) y armá el mapa con los dispositivos que quieras ver.</li>
              <li>En la configuración del mapa, en <b>Acceso público</b>, elegí <b>Permitir acceso público</b>. PRTG genera una clave secreta.</li>
              <li>En la pestaña <b>Get HTML</b> (Obtener HTML), copiá la <b>dirección para acceso directo</b> y pegala acá.</li>
            </ol>
          </div>
          <form onSubmit={agregar} className="grid md:grid-cols-6 gap-3 items-end">
            <div className="md:col-span-2">
              <label className="label">Nombre</label>
              <input className="input" required value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} placeholder="Oficina central" />
            </div>
            <div className="md:col-span-3">
              <label className="label">Dirección del mapa público</label>
              <input className="input" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://prtg.accusys.local/public/mapshow.htm?id=…&mapid=…" />
            </div>
            <div>
              <label className="label">Alto (px)</label>
              <input type="number" min={300} max={3000} className="input" value={form.alto} onChange={(e) => setForm({ ...form, alto: Number(e.target.value) })} />
            </div>
            <div className="md:col-span-6"><button className="btn-primary">Agregar mapa</button></div>
          </form>
          {mapas.length > 0 && (
            <ul className="text-sm divide-y divide-line/[0.05]">
              {mapas.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0"><b>{m.nombre}</b> <span className="text-ink/50 text-xs break-all">{m.url.replace(/([?&](mapid|key)=)[^&]+/i, "$1•••")}</span></span>
                  <button className="text-xs text-ink/40 hover:text-red-600 shrink-0" onClick={() => quitar(m)}>Quitar</button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink/50">
            La dirección lleva la clave secreta del mapa: solo la ven quienes tienen esta solapa. Si alguna vez se filtra, generá una clave
            nueva en PRTG y actualizá el mapa acá.
          </p>
        </div>
      )}

      {mapas.length > 1 && (
        <div role="tablist" className="flex gap-1 border-b border-line/[0.08]">
          {mapas.map((m) => (
            <button key={m.id} role="tab" aria-selected={m.id === activo} onClick={() => setActivo(m.id)}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${m.id === activo ? "border-brand-600 text-brand-700" : "border-transparent text-ink/60 hover:text-ink"}`}>
              {m.nombre}
            </button>
          ))}
        </div>
      )}

      {mapa && (
        <>
          {inseguro && (
            <p className="text-sm text-amber-800 bg-amber-500/10 rounded-md px-3 py-2">
              Este mapa usa <b>http://</b>. Como la app funciona con https, el navegador va a bloquearlo. Habilitá HTTPS en PRTG (Herramienta
              de administración de PRTG → Servidor web) y actualizá la dirección.
            </p>
          )}
          <div className="card overflow-hidden">
            <iframe
              key={`${mapa.id}-${recarga}`}
              src={mapa.url}
              title={`Mapa de PRTG: ${mapa.nombre}`}
              className="w-full block bg-white"
              style={{ height: mapa.alto }}
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
            />
          </div>
          <p className="text-xs text-ink/50">
            ¿No se ve el mapa? El servidor de PRTG solo se alcanza desde la red de la oficina o por VPN. Si PRTG usa un certificado propio,
            abrí una vez el mapa con <b>Abrir en PRTG</b> y aceptá el certificado; después se ve también acá.
          </p>
        </>
      )}

      {!cargando && mapas.length === 0 && !esAdmin && (
        <div className="card p-6 text-sm text-ink/60">Todavía no hay mapas configurados. Un administrador los carga desde esta pantalla.</div>
      )}
    </div>
  );
}

export default function MonitoreoRed() {
  const [vista, setVista] = useState<"auto" | "prtg">("auto");
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-ink">Monitoreo de red</h1>
        <p className="text-ink/60 text-sm mt-1">Estado de los equipos monitoreados por PRTG, agrupados por sede.</p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-line/[0.08]">
        {([["auto", "Mapa automático"], ["prtg", "Mapas de PRTG"]] as const).map(([k, t]) => (
          <button key={k} role="tab" aria-selected={vista === k} onClick={() => setVista(k)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${vista === k ? "border-brand-600 text-brand-700" : "border-transparent text-ink/60 hover:text-ink"}`}>
            {t}
          </button>
        ))}
      </div>
      {vista === "auto" ? <MapaAutomatico /> : <MapasPrtg />}
    </div>
  );
}
