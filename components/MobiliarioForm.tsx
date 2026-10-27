"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS_MOB, TIPOS_MOB } from "@/lib/mobiliario";
import { usePerfil } from "./PerfilContext";

type Empleado = { id: string; nombre: string; apellido: string; area: string | null };

const VACIO = {
  tipo: "",
  descripcion: "",
  marca: "",
  modelo: "",
  numero_serie: "",
  color: "",
  numero_inventario: "",
  estado: "en_deposito",
  piso: "",
  sector: "",
  detalle_ubicacion: "",
  empleado_id: "",
  responsable: "",
  fecha_ingreso: "",
  fecha_baja: "",
  motivo_baja: "",
  notas: "",
};

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
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

export default function MobiliarioForm({ mobId }: { mobId?: number }) {
  const router = useRouter();
  const { esAdmin, puedeEditar } = usePerfil();
  const [v, setV] = useState<Record<string, string>>(VACIO);
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    const sb = createClient();
    sb.from("empleados").select("id,nombre,apellido,area").order("apellido").then(({ data }) =>
      setEmpleados((data ?? []) as Empleado[])
    );
    if (mobId) {
      sb.from("mobiliario").select("*").eq("id", mobId).single().then(({ data }) => {
        if (data) {
          setV(
            Object.fromEntries(
              Object.keys(VACIO).map((k) => [k, data[k] != null ? String(data[k]) : ""])
            )
          );
        }
      });
    }
  }, [mobId]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  const esAsignado = v.estado === "asignado";
  const esBaja = v.estado === "dado_de_baja";

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!v.tipo.trim()) { setError("El tipo es obligatorio."); return; }

    setGuardando(true);
    const sb = createClient();

    const datos: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      datos[k] = val === "" ? null : val.trim();
    }
    // Limpiar campos según estado
    if (!esAsignado) datos.empleado_id = null;
    if (!esBaja) { datos.fecha_baja = null; datos.motivo_baja = null; }

    // Obtener usuario actual para el movimiento
    const { data: { user } } = await sb.auth.getUser();

    const res = mobId
      ? await sb.from("mobiliario").update(datos).eq("id", mobId).select("id").single()
      : await sb.from("mobiliario").insert(datos).select("id").single();

    if (res.error) {
      setGuardando(false);
      setError(res.error.message);
      return;
    }

    const id = res.data.id;

    // Registrar movimiento de alta si es nuevo
    if (!mobId) {
      await sb.from("mob_movimientos").insert({
        mobiliario_id: id,
        tipo_movimiento: "alta",
        piso_destino: datos.piso ?? null,
        sector_destino: datos.sector ?? null,
        empleado_destino_id: datos.empleado_id ?? null,
        usuario_id: user?.id ?? null,
        notas: "Alta inicial de mobiliario",
      });
    }

    setGuardando(false);
    router.push(`/mobiliario/${id}`);
    router.refresh();
  }

  return (
    <form onSubmit={guardar} className="space-y-5">
      <Bloque titulo="Identificación">
        <Campo label="Tipo *">
          <select className="input" value={v.tipo} onChange={set("tipo")} required>
            <option value="">Seleccioná un tipo…</option>
            {TIPOS_MOB.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Campo>
        <Campo label="Descripción">
          <input className="input" value={v.descripcion} onChange={set("descripcion")} placeholder="Ej: Escritorio esquinero color gris" />
        </Campo>
        <Campo label="N° de inventario">
          <input className="input" value={v.numero_inventario} onChange={set("numero_inventario")} placeholder="Número interno de inventario" />
        </Campo>
        <Campo label="Marca">
          <input className="input" value={v.marca} onChange={set("marca")} placeholder="Ej: Cannon, Steelcase…" />
        </Campo>
        <Campo label="Modelo">
          <input className="input" value={v.modelo} onChange={set("modelo")} />
        </Campo>
        <Campo label="N° de serie">
          <input className="input" value={v.numero_serie} onChange={set("numero_serie")} />
        </Campo>
        <Campo label="Color">
          <input className="input" value={v.color} onChange={set("color")} placeholder="Ej: Negro, Blanco, Madera…" />
        </Campo>
        <Campo label="Fecha de ingreso">
          <input type="date" className="input" value={v.fecha_ingreso} onChange={set("fecha_ingreso")} />
        </Campo>
        <Campo label="Responsable">
          <input className="input" value={v.responsable} onChange={set("responsable")} placeholder="Persona o área responsable" />
        </Campo>
      </Bloque>

      <Bloque titulo="Ubicación y estado">
        <Campo label="Estado">
          <select className="input" value={v.estado} onChange={set("estado")}>
            {Object.entries(ESTADOS_MOB).map(([k, lbl]) => (
              <option key={k} value={k}>{lbl}</option>
            ))}
          </select>
        </Campo>
        <Campo label="Piso">
          <input className="input" value={v.piso} onChange={set("piso")} placeholder="Ej: PB, 1°, 2°, Subsuelo…" />
        </Campo>
        <Campo label="Sector">
          <input className="input" value={v.sector} onChange={set("sector")} placeholder="Ej: Gerencia, Recepción, Sala A…" />
        </Campo>
        <Campo label="Detalle de ubicación">
          <input className="input" value={v.detalle_ubicacion} onChange={set("detalle_ubicacion")} placeholder="Ej: Frente ventana, espacio 3…" />
        </Campo>

        {esAsignado && (
          <Campo label="Asignado a">
            <select className="input" value={v.empleado_id} onChange={set("empleado_id")}>
              <option value="">Sin asignación personal</option>
              {empleados.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.apellido}, {emp.nombre}{emp.area ? ` — ${emp.area}` : ""}
                </option>
              ))}
            </select>
          </Campo>
        )}

        {esBaja && (
          <>
            <Campo label="Fecha de baja">
              <input type="date" className="input" value={v.fecha_baja} onChange={set("fecha_baja")} />
            </Campo>
            <Campo label="Motivo de baja">
              <input className="input" value={v.motivo_baja} onChange={set("motivo_baja")} placeholder="Ej: Deterioro, obsolescencia, rotura…" />
            </Campo>
          </>
        )}
      </Bloque>

      <div className="card p-5">
        <legend className="font-display font-bold text-ink mb-4">Notas</legend>
        <textarea className="input w-full h-24 resize-y" value={v.notas} onChange={set("notas")} placeholder="Observaciones adicionales…" />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <button type="button" className="btn-secondary" onClick={() => router.back()}>
          Cancelar
        </button>
        <button type="submit" className="btn-primary" disabled={guardando}>
          {guardando ? "Guardando…" : mobId ? "Guardar cambios" : "Registrar mobiliario"}
        </button>
      </div>
    </form>
  );
}
