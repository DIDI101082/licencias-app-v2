"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { clasificar, nombreFormato, type Clasificacion } from "@/lib/escaneo";
import { eanValido } from "@/lib/productos";
import { claseCodigo } from "@/lib/inventario";

const Escaner = dynamic(() => import("@/components/Escaner"), { ssr: false });

// Accesos rápidos a las categorías de periféricos más comunes
const RAPIDAS = [
  "Monitor", "Teclado", "Mouse", "Combo teclado + mouse", "Auriculares / headset",
  "Webcam", "Docking station", "Parlantes",
];

type Cargado = { id: string; codigo: string; serie: string; asignado?: string };

export default function Escanear() {
  const { perfil, puedeEditar, esAdmin } = usePerfil();
  const areaFija = !esAdmin && perfil?.rol === "lectura_escritura" ? perfil.area : null;

  const [cats, setCats] = useState<any[]>([]);
  const [provs, setProvs] = useState<any[]>([]);
  const [ubis, setUbis] = useState<any[]>([]);
  const [empleados, setEmpleados] = useState<any[]>([]);
  const [cfg, setCfg] = useState<Record<string, any>>({
    categoria_id: "", marca: "", modelo: "", proveedor_id: "", fecha_compra: "", nro_factura: "",
    costo: "", moneda: "ARS", garantia_hasta: "", ubicacion_id: "", empleado_id: "", ean: "", notas: "",
  });
  const [paso, setPaso] = useState<"config" | "caja" | "escanear">("config");
  const [producto, setProducto] = useState<{ titulo: string; imagen: string | null; origen: string } | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [avisoCaja, setAvisoCaja] = useState<string | null>(null);
  const [eanManual, setEanManual] = useState("");
  const [verCompra, setVerCompra] = useState(false);
  const [auto, setAuto] = useState(false);
  const [pendiente, setPendiente] = useState<Clasificacion | null>(null);
  const [manual, setManual] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error" | "duplicado"; texto: string; id?: string } | null>(null);
  const [cargados, setCargados] = useState<Cargado[]>([]);
  const ultimo = useRef<{ texto: string; t: number }>({ texto: "", t: 0 });

  useEffect(() => {
    const sb = createClient();
    sb.from("inv_categorias").select("id, nombre, grupo").order("grupo").order("nombre").then(({ data }) => setCats(data ?? []));
    sb.from("inv_proveedores").select("id, nombre").order("nombre").then(({ data }) => setProvs(data ?? []));
    sb.from("inv_ubicaciones").select("id, nombre").order("nombre").then(({ data }) => setUbis(data ?? []));
    sb.from("empleados").select("id, nombre, apellido, area").eq("activo", true).order("apellido").then(({ data }) => setEmpleados(data ?? []));
  }, []);

  // Busca el producto por el código de la caja y completa tipo, marca y modelo
  const buscarProducto = useCallback(async (ean: string, volverA: "config" | "escanear") => {
    setBuscando(true); setAvisoCaja(null);
    try {
      const r = await fetch(`/api/producto?ean=${encodeURIComponent(ean)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.encontrado) {
        const p = j.producto;
        setCfg((c) => ({
          ...c, ean,
          categoria_id: p.categoria_id ?? c.categoria_id,
          marca: p.marca ?? c.marca, modelo: p.modelo ?? c.modelo, notas: p.titulo ?? c.notas,
        }));
        setProducto({ titulo: p.titulo ?? `${p.marca ?? ""} ${p.modelo ?? ""}`, imagen: p.imagen, origen: j.origen });
        if (!p.categoria_id) setAvisoCaja("Identifiqué el producto pero no el tipo de equipo: elegilo abajo.");
      } else {
        setCfg((c) => ({ ...c, ean }));
        setProducto(null);
        setAvisoCaja(j.error ?? "No encontré este producto en la base pública. Completá tipo, marca y modelo: quedan guardados para la próxima vez que se escanee esta caja.");
      }
    } catch {
      setAvisoCaja("No se pudo buscar el producto. Revisá la conexión y probá de nuevo.");
    }
    setBuscando(false);
    setPaso(volverA);
  }, []);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setCfg((p) => ({ ...p, [k]: e.target.value }));
  const cat = cats.find((c) => String(c.id) === String(cfg.categoria_id));
  const empleado = empleados.find((e) => e.id === cfg.empleado_id);

  const guardar = useCallback(async (serie: string) => {
    const valor = serie.trim();
    if (!valor) return;
    setGuardando(true);
    setAviso(null);
    const sb = createClient();

    // ¿Ya existe? (sin distinguir mayúsculas)
    const escapado = valor.replace(/[\\%_]/g, (m) => "\\" + m);
    const { data: existe } = await sb.from("inv_equipos").select("id, codigo").ilike("numero_serie", escapado).limit(1);
    if (existe?.length) {
      setAviso({ tipo: "duplicado", texto: `El serie ${valor} ya está cargado como ${existe[0].codigo}.`, id: existe[0].id });
      setGuardando(false); setPendiente(null);
      return;
    }

    const num = (v: string) => (v === "" ? null : Number(v));
    const { data, error } = await sb.from("inv_equipos").insert({
      categoria_id: Number(cfg.categoria_id),
      marca: cfg.marca.trim() || null, modelo: cfg.modelo.trim() || null,
      numero_serie: valor, estado: "en_stock", condicion: "nuevo",
      area: areaFija ?? null,
      proveedor_id: num(cfg.proveedor_id), ubicacion_id: num(cfg.ubicacion_id),
      fecha_compra: cfg.fecha_compra || null, nro_factura: cfg.nro_factura.trim() || null,
      costo: num(cfg.costo), moneda: cfg.moneda, garantia_hasta: cfg.garantia_hasta || null,
      ean: cfg.ean || null, notas: cfg.notas.trim() || null,
    }).select("id, codigo").single();

    if (error) {
      setAviso({ tipo: "error", texto: error.message.includes("row-level security") ? "No tenés permiso para cargar equipos." : error.message });
      setGuardando(false); setPendiente(null);
      return;
    }

    let asignado: string | undefined;
    if (cfg.empleado_id) {
      const r = await sb.rpc("inv_asignar_equipo", { p_equipo: data.id, p_empleado: cfg.empleado_id });
      if (!r.error) asignado = `${empleado?.nombre} ${empleado?.apellido}`;
    }

    navigator.vibrate?.(80);
    setCargados((l) => [{ id: data.id, codigo: data.codigo, serie: valor, asignado }, ...l]);
    setAviso({ tipo: "ok", texto: `${data.codigo} guardado${asignado ? ` y asignado a ${asignado}` : ""}.`, id: data.id });
    setPendiente(null); setManual(""); setGuardando(false);
  }, [cfg, areaFija, empleado]);

  const alLeerCaja = useCallback((texto: string, formato: string) => {
    const ahora = Date.now();
    if (ultimo.current.texto === texto && ahora - ultimo.current.t < 4000) return;
    ultimo.current = { texto, t: ahora };
    navigator.vibrate?.(30);
    const digitos = texto.replace(/\D/g, "");
    if (["EAN_13", "EAN_8", "UPC_A", "UPC_E"].includes(formato) || (/^\d{8,14}$/.test(texto.trim()) && eanValido(digitos))) {
      buscarProducto(digitos, "config");
    } else {
      setAvisoCaja(`Eso no es el código de la caja (leí "${texto.slice(0, 40)}"). Buscá el código de barras que tiene solo números, generalmente de 13 dígitos.`);
    }
  }, [buscarProducto]);

  const alLeer = useCallback((texto: string, formato: string) => {
    // Ignorar el mismo código leído dos veces seguidas
    const ahora = Date.now();
    if (ultimo.current.texto === texto && ahora - ultimo.current.t < 4000) return;
    ultimo.current = { texto, t: ahora };
    navigator.vibrate?.(30);
    const c = clasificar(texto, formato);
    if (auto && c.tipo === "serie") guardar(c.valor);
    else setPendiente(c);
  }, [auto, guardar]);

  async function empezar() {
    // Lo que se confirmó para este EAN queda en el catálogo propio para la próxima compra
    if (cfg.ean) {
      await createClient().from("inv_productos").upsert({
        ean: cfg.ean, marca: cfg.marca.trim() || null, modelo: cfg.modelo.trim() || null,
        categoria_id: Number(cfg.categoria_id), titulo: cfg.notas.trim() || `${cfg.marca} ${cfg.modelo}`.trim() || null,
        fuente: producto?.origen === "upcitemdb" ? "upcitemdb" : "manual", actualizado: new Date().toISOString(),
      });
    }
    setAvisoCaja(null);
    setPaso("escanear");
  }

  async function deshacer(item: Cargado) {
    if (!confirm(`¿Borrar ${item.codigo} (serie ${item.serie})?`)) return;
    const { error } = await createClient().from("inv_equipos").delete().eq("id", item.id);
    if (error) return setAviso({ tipo: "error", texto: error.message });
    setCargados((l) => l.filter((x) => x.id !== item.id));
    setAviso(null);
  }

  if (!puedeEditar) {
    return <div className="card p-6 max-w-md text-sm text-ink/60">Necesitás permisos de edición para cargar equipos.</div>;
  }

  // ---------------- Paso 0: escanear la caja ----------------
  if (paso === "caja") {
    return (
      <div className="max-w-xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl text-ink">Código de la caja</h1>
            <p className="text-xs text-ink/60">Es el código de barras con solo números (EAN), no el del número de serie.</p>
          </div>
          <button className="btn-secondary" onClick={() => setPaso("config")}>Volver</button>
        </div>
        <Escaner onLectura={alLeerCaja} pausado={buscando} />
        {buscando && <p className="text-sm text-ink/60" role="status">Buscando el producto…</p>}
        {avisoCaja && <p className="text-sm text-amber-800 bg-amber-500/10 rounded-md px-3 py-2" role="alert">{avisoCaja}</p>}
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const d = eanManual.replace(/\D/g, ""); if (d) buscarProducto(d, "config"); }}>
          <input className="input flex-1" inputMode="numeric" placeholder="O escribí los números del código" value={eanManual} onChange={(e) => setEanManual(e.target.value)} />
          <button className="btn-secondary" disabled={!eanManual.trim() || buscando}>Buscar</button>
        </form>
      </div>
    );
  }

  // ---------------- Paso 1: qué se está cargando ----------------
  if (paso === "config") {
    return (
      <div className="max-w-xl mx-auto space-y-5">
        <div>
          <h1 className="font-display text-2xl text-ink">Cargar con la cámara</h1>
          <p className="text-ink/60 text-sm mt-1">Elegí qué vas a cargar y después escaneá los números de serie uno tras otro.</p>
        </div>

        {producto ? (
          <div className="card p-4 flex gap-3 items-center border-2 border-emerald-500/40">
            {producto.imagen && <img src={producto.imagen} alt="" className="h-16 w-16 object-contain rounded bg-white shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="text-xs text-emerald-700 font-medium">
                {producto.origen === "catalogo" ? "Producto de tu catálogo" : "Producto identificado por el código de la caja"}
              </div>
              <div className="text-sm text-ink line-clamp-2">{producto.titulo}</div>
            </div>
            <button className="text-xs text-ink/50 hover:text-red-600 shrink-0"
              onClick={() => { setProducto(null); setCfg((c) => ({ ...c, ean: "", notas: "" })); }}>Quitar</button>
          </div>
        ) : (
          <button type="button" onClick={() => { setAvisoCaja(null); setPaso("caja"); }}
            className="card p-4 w-full text-left hover:border-brand-300 border-2 border-dashed border-brand-500/40">
            <div className="font-medium text-brand-700">¿Tenés la caja? Escaneá su código de barras</div>
            <div className="text-sm text-ink/60 mt-0.5">Completo automáticamente el tipo, la marca y el modelo.</div>
          </button>
        )}
        {avisoCaja && paso === "config" && <p className="text-sm text-amber-800 bg-amber-500/10 rounded-md px-3 py-2" role="status">{avisoCaja}</p>}

        <div className="card p-4 space-y-3">
          <div className="text-sm font-medium text-ink">Tipo de equipo</div>
          <div className="grid grid-cols-2 gap-2">
            {RAPIDAS.map((n) => {
              const c = cats.find((x) => x.nombre === n);
              if (!c) return null;
              const sel = String(cfg.categoria_id) === String(c.id);
              return (
                <button key={c.id} type="button" onClick={() => setCfg((p) => ({ ...p, categoria_id: c.id }))} aria-pressed={sel}
                  className={`rounded-lg border px-3 py-3 text-sm font-medium text-left ${sel ? "border-brand-500 bg-brand-50 text-brand-700" : "border-black/10 text-ink hover:border-brand-300"}`}>
                  {n}
                </button>
              );
            })}
          </div>
          <select className="input" value={cfg.categoria_id} onChange={set("categoria_id")} aria-label="Otra categoría">
            <option value="">Otra categoría…</option>
            {Array.from(new Set(cats.map((c) => c.grupo))).map((g) => (
              <optgroup key={g} label={g}>{cats.filter((c) => c.grupo === g).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</optgroup>
            ))}
          </select>
        </div>

        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Marca</label><input className="input" value={cfg.marca} onChange={set("marca")} placeholder="Logitech, Dell…" /></div>
            <div><label className="label">Modelo</label><input className="input" value={cfg.modelo} onChange={set("modelo")} /></div>
          </div>
          <div>
            <label className="label">Asignar directamente a (opcional)</label>
            <select className="input" value={cfg.empleado_id} onChange={set("empleado_id")}>
              <option value="">No asignar, queda en stock</option>
              {empleados.map((e) => <option key={e.id} value={e.id}>{e.apellido}, {e.nombre} · {e.area}</option>)}
            </select>
          </div>
          <button type="button" className="text-sm text-brand-600 hover:underline" onClick={() => setVerCompra(!verCompra)} aria-expanded={verCompra}>
            {verCompra ? "Ocultar" : "Agregar"} datos de la compra (proveedor, factura, garantía)
          </button>
          {verCompra && (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label">Proveedor</label>
                <select className="input" value={cfg.proveedor_id} onChange={set("proveedor_id")}>
                  <option value="">Sin proveedor</option>
                  {provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
              </div>
              <div><label className="label">Fecha de compra</label><input type="date" className="input" value={cfg.fecha_compra} onChange={set("fecha_compra")} /></div>
              <div><label className="label">N° de factura</label><input className="input" value={cfg.nro_factura} onChange={set("nro_factura")} /></div>
              <div><label className="label">Costo unitario</label><input type="number" inputMode="decimal" className="input" value={cfg.costo} onChange={set("costo")} /></div>
              <div>
                <label className="label">Moneda</label>
                <select className="input" value={cfg.moneda} onChange={set("moneda")}><option>ARS</option><option>USD</option></select>
              </div>
              <div><label className="label">Garantía hasta</label><input type="date" className="input" value={cfg.garantia_hasta} onChange={set("garantia_hasta")} /></div>
              <div>
                <label className="label">Ubicación</label>
                <select className="input" value={cfg.ubicacion_id} onChange={set("ubicacion_id")}>
                  <option value="">Sin ubicación</option>
                  {ubis.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>

        <button className="btn-primary w-full py-3 text-base" disabled={!cfg.categoria_id} onClick={empezar}>
          {cfg.categoria_id ? `Empezar a escanear ${cat?.nombre?.toLowerCase() ?? ""}` : "Elegí el tipo de equipo"}
        </button>
      </div>
    );
  }

  // ---------------- Paso 2: escanear ----------------
  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl text-ink">{cat?.nombre}{cfg.marca ? ` · ${cfg.marca}` : ""}{cfg.modelo ? ` ${cfg.modelo}` : ""}</h1>
          <p className="text-xs text-ink/60">
            {cargados.length} cargados en esta tanda{empleado ? ` · se asignan a ${empleado.nombre} ${empleado.apellido}` : ""}
          </p>
        </div>
        <button className="btn-secondary" onClick={() => { setPaso("config"); setPendiente(null); }}>Cambiar</button>
      </div>

      {avisoCaja && <p className="text-sm text-amber-800 bg-amber-500/10 rounded-md px-3 py-2" role="status">{avisoCaja}</p>}
      {producto && <p className="text-xs text-emerald-700">Producto: {producto.titulo}</p>}

      <Escaner onLectura={alLeer} pausado={!!pendiente || guardando || buscando} />

      <label className="flex items-center gap-2 text-sm text-ink/70">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Guardar automáticamente cuando lea un número de serie (para cargar muchos seguidos)
      </label>

      {pendiente && (
        <div className="card p-4 space-y-3 border-2 border-brand-500" role="dialog" aria-label="Código leído">
          <div>
            <div className="text-xs text-ink/50">Leído ({nombreFormato(pendiente.formato)})</div>
            <div className="font-display text-2xl text-ink break-all">{pendiente.valor}</div>
            {pendiente.valor !== pendiente.original && <div className="text-xs text-ink/50 break-all">Texto completo: {pendiente.original}</div>}
          </div>
          {pendiente.aviso && <p className="text-sm text-amber-700 bg-amber-500/10 rounded-md px-3 py-2">{pendiente.aviso}</p>}
          {pendiente.tipo === "producto" && (
            <button className="btn-primary w-full py-3" disabled={buscando}
              onClick={async () => { const v = pendiente.valor; setPendiente(null); await buscarProducto(v.replace(/\D/g, ""), "escanear"); }}>
              {buscando ? "Buscando…" : "Usar este código para completar marca y modelo"}
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button className={pendiente.aviso ? "btn-secondary py-3" : "btn-primary py-3"} disabled={guardando} onClick={() => guardar(pendiente.valor)}>
              {guardando ? "Guardando…" : pendiente.aviso ? "Guardar igual" : "Guardar"}
            </button>
            <button className={pendiente.aviso ? "btn-primary py-3" : "btn-secondary py-3"} onClick={() => setPendiente(null)}>
              Seguir escaneando
            </button>
          </div>
        </div>
      )}

      {aviso && (
        <div role="status" className={`rounded-md px-3 py-2 text-sm ${aviso.tipo === "ok" ? "bg-emerald-50 text-emerald-700" : aviso.tipo === "duplicado" ? "bg-amber-500/10 text-amber-800" : "bg-red-50 text-red-600"}`}>
          {aviso.texto}{" "}
          {aviso.id && <Link href={`/inventario/equipos/${aviso.id}`} className="underline">Ver ficha</Link>}
        </div>
      )}

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); guardar(manual); }}>
        <input className="input flex-1" placeholder="O escribí el N° de serie a mano" value={manual}
          onChange={(e) => setManual(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <button className="btn-secondary" disabled={!manual.trim() || guardando}>Guardar</button>
      </form>

      {cargados.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2 text-xs text-ink/50 border-b border-black/[0.06]">Cargados en esta tanda</div>
          <ul className="divide-y divide-black/[0.05]">
            {cargados.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <Link href={`/inventario/equipos/${c.id}`} className={claseCodigo(c.codigo)}>{c.codigo}</Link>
                  <span className="truncate text-ink/70">{c.serie}</span>
                </span>
                <button className="text-xs text-ink/40 hover:text-red-600 shrink-0" onClick={() => deshacer(c)}>Deshacer</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
