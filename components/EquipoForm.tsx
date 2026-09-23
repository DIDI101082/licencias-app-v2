"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS, CONDICIONES } from "@/lib/inventario";
import { usePerfil } from "./PerfilContext";

type Cat = { id: number; nombre: string; grupo: string; requiere_serie: boolean; es_consumible: boolean };
type Opcion = { id: number | string; nombre: string };

const GRUPOS_CON_HARDWARE = ["Puesto de trabajo", "Servidores y datacenter", "Movilidad"];
const GRUPOS_CON_RED = ["Puesto de trabajo", "Servidores y datacenter", "Redes", "Telefonía", "Impresión",
  "Seguridad física", "Salas y videoconferencia", "Energía"];
const NUMERICOS = ["categoria_id", "ubicacion_id", "proveedor_id", "ram_gb", "vida_util_meses", "cantidad", "costo"];

const VACIO: Record<string, any> = {
  categoria_id: "", marca: "", modelo: "", numero_serie: "", estado: "en_stock", condicion: "nuevo",
  area: "", ubicacion_id: "", ubicacion_detalle: "", hostname: "", ip: "", mac: "", procesador: "",
  ram_gb: "", almacenamiento: "", sistema_operativo: "", proveedor_id: "", fecha_compra: "", costo: "",
  moneda: "ARS", nro_factura: "", garantia_hasta: "", vida_util_meses: 36, cantidad: 1, notas: "",
};

function Campo({ label, children, ancho }: { label: string; children: React.ReactNode; ancho?: boolean }) {
  return (
    <div className={ancho ? "md:col-span-3" : ""}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <fieldset className="card p-5">
      <legend className="font-display font-bold text-ink px-1">{titulo}</legend>
      <div className="grid md:grid-cols-3 gap-4">{children}</div>
    </fieldset>
  );
}

export default function EquipoForm({ equipoId }: { equipoId?: string }) {
  const router = useRouter();
  const { perfil, esAdmin } = usePerfil();
  const areaFija = !esAdmin && perfil?.rol === "lectura_escritura" ? perfil.area : null;
  const [v, setV] = useState<Record<string, any>>({ ...VACIO, area: areaFija ?? "" });
  const [cats, setCats] = useState<Cat[]>([]);
  const [ubis, setUbis] = useState<Opcion[]>([]);
  const [provs, setProvs] = useState<Opcion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    const sb = createClient();
    sb.from("inv_categorias").select("*").order("grupo").order("nombre").then(({ data }) => setCats(data ?? []));
    sb.from("inv_ubicaciones").select("id,nombre").order("nombre").then(({ data }) => setUbis(data ?? []));
    sb.from("inv_proveedores").select("id,nombre").order("nombre").then(({ data }) => setProvs(data ?? []));
    if (equipoId) {
      sb.from("inv_equipos").select("*").eq("id", equipoId).single().then(({ data }) => {
        if (data) setV(Object.fromEntries(Object.keys(VACIO).map((k) => [k, data[k] ?? ""])));
      });
    }
  }, [equipoId]);

  const cat = cats.find((c) => String(c.id) === String(v.categoria_id));
  const grupos = Array.from(new Set(cats.map((c) => c.grupo)));
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (cat?.requiere_serie && !String(v.numero_serie).trim()) {
      setError(`La categoría “${cat.nombre}” necesita número de serie.`);
      return;
    }
    setGuardando(true);
    const datos: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      datos[k] = val === "" ? null : NUMERICOS.includes(k) ? Number(val) : typeof val === "string" ? val.trim() : val;
    }
    const sb = createClient();
    const res = equipoId
      ? await sb.from("inv_equipos").update(datos).eq("id", equipoId).select("id").single()
      : await sb.from("inv_equipos").insert(datos).select("id").single();
    setGuardando(false);
    if (res.error) {
      setError(res.error.code === "23505"
        ? "Ya existe un equipo con ese número de serie."
        : res.error.message.includes("row-level security")
          ? "No tenés permiso para guardar equipos de esa área."
          : res.error.message);
      return;
    }
    router.push(`/inventario/equipos/${res.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={guardar} className="space-y-5">
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <Bloque titulo="Qué equipo es">
        <Campo label="Categoría">
          <select required className="input" value={v.categoria_id} onChange={set("categoria_id")}>
            <option value="">Elegí una categoría</option>
            {grupos.map((g) => (
              <optgroup key={g} label={g}>
                {cats.filter((c) => c.grupo === g).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </optgroup>
            ))}
          </select>
        </Campo>
        <Campo label="Marca"><input className="input" value={v.marca} onChange={set("marca")} placeholder="Dell, HP, Lenovo, Cisco…" /></Campo>
        <Campo label="Modelo"><input className="input" value={v.modelo} onChange={set("modelo")} /></Campo>
        <Campo label={`N° de serie${cat?.requiere_serie ? " *" : ""}`}><input className="input" value={v.numero_serie} onChange={set("numero_serie")} /></Campo>
        {cat?.es_consumible && (
          <Campo label="Cantidad"><input type="number" min={1} className="input" value={v.cantidad} onChange={set("cantidad")} /></Campo>
        )}
        <Campo label="Condición">
          <select className="input" value={v.condicion} onChange={set("condicion")}>
            {Object.entries(CONDICIONES).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </Campo>
        <Campo label="Estado">
          <select className="input" value={v.estado} onChange={set("estado")}>
            {Object.entries(ESTADOS)
              .filter(([k]) => k !== "asignado" || v.estado === "asignado")
              .map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </Campo>
      </Bloque>

      <Bloque titulo="Dónde está">
        <Campo label="Área">
          <input className="input disabled:bg-black/[0.03]" value={v.area} onChange={set("area")} disabled={!!areaFija}
            placeholder="Sistemas, Ventas, Administración…" />
        </Campo>
        <Campo label="Ubicación">
          <select className="input" value={v.ubicacion_id} onChange={set("ubicacion_id")}>
            <option value="">Sin ubicación</option>
            {ubis.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
          </select>
        </Campo>
        <Campo label="Detalle de ubicación">
          <input className="input" value={v.ubicacion_detalle} onChange={set("ubicacion_detalle")} placeholder="Rack 2, U14 · Piso 3, puesto 12" />
        </Campo>
      </Bloque>

      {cat && (GRUPOS_CON_HARDWARE.includes(cat.grupo) || GRUPOS_CON_RED.includes(cat.grupo)) && (
        <Bloque titulo="Datos técnicos">
          {GRUPOS_CON_RED.includes(cat.grupo) && <>
            <Campo label="Hostname"><input className="input" value={v.hostname} onChange={set("hostname")} /></Campo>
            <Campo label="IP"><input className="input" value={v.ip} onChange={set("ip")} placeholder="10.0.0.25" /></Campo>
            <Campo label="MAC"><input className="input" value={v.mac} onChange={set("mac")} placeholder="AA:BB:CC:DD:EE:FF" /></Campo>
          </>}
          {GRUPOS_CON_HARDWARE.includes(cat.grupo) && <>
            <Campo label="Procesador"><input className="input" value={v.procesador} onChange={set("procesador")} /></Campo>
            <Campo label="RAM (GB)"><input type="number" min={0} className="input" value={v.ram_gb} onChange={set("ram_gb")} /></Campo>
            <Campo label="Almacenamiento"><input className="input" value={v.almacenamiento} onChange={set("almacenamiento")} placeholder="512 GB SSD" /></Campo>
            <Campo label="Sistema operativo"><input className="input" value={v.sistema_operativo} onChange={set("sistema_operativo")} /></Campo>
          </>}
        </Bloque>
      )}

      <Bloque titulo="Compra y garantía">
        <Campo label="Proveedor">
          <select className="input" value={v.proveedor_id} onChange={set("proveedor_id")}>
            <option value="">Sin proveedor</option>
            {provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </Campo>
        <Campo label="Fecha de compra"><input type="date" className="input" value={v.fecha_compra} onChange={set("fecha_compra")} /></Campo>
        <Campo label="N° de factura"><input className="input" value={v.nro_factura} onChange={set("nro_factura")} /></Campo>
        <Campo label="Costo unitario"><input type="number" min={0} step="0.01" className="input" value={v.costo} onChange={set("costo")} /></Campo>
        <Campo label="Moneda">
          <select className="input" value={v.moneda} onChange={set("moneda")}><option>ARS</option><option>USD</option></select>
        </Campo>
        <Campo label="Garantía hasta"><input type="date" className="input" value={v.garantia_hasta} onChange={set("garantia_hasta")} /></Campo>
        <Campo label="Vida útil (meses)"><input type="number" min={0} className="input" value={v.vida_util_meses} onChange={set("vida_util_meses")} /></Campo>
        <Campo label="Notas" ancho><textarea className="input min-h-[80px]" value={v.notas} onChange={set("notas")} /></Campo>
      </Bloque>

      <div className="flex gap-2">
        <button className="btn-primary" disabled={guardando}>{guardando ? "Guardando…" : equipoId ? "Guardar cambios" : "Cargar equipo"}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancelar</button>
      </div>
    </form>
  );
}
