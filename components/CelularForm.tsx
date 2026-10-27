"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ESTADOS_CEL } from "@/lib/celulares";

type Empleado = { id: string; nombre: string; apellido: string; area: string | null };

const VACIO = {
  marca: "",
  modelo: "",
  imei: "",
  imei2: "",
  numero_linea: "",
  operadora: "",
  numero_sim: "",
  plan: "",
  color: "",
  almacenamiento: "",
  numero_inventario: "",
  estado: "en_deposito",
  piso: "",
  sector: "",
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

export default function CelularForm({ celId }: { celId?: number }) {
  const router = useRouter();
  const [v, setV] = useState<Record<string, string>>(VACIO);
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    const sb = createClient();
    sb.from("empleados").select("id,nombre,apellido,area").order("apellido").then(({ data }) =>
      setEmpleados((data ?? []) as Empleado[])
    );
    if (celId) {
      sb.from("cel_celulares").select("*").eq("id", celId).single().then(({ data }) => {
        if (data) {
          setV(
            Object.fromEntries(
              Object.keys(VACIO).map((k) => [k, data[k] != null ? String(data[k]) : ""])
            )
          );
        }
      });
    }
  }, [celId]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  const esAsignado = v.estado === "asignado";
  const esBaja = v.estado === "dado_de_baja";

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!v.marca.trim() || !v.modelo.trim()) { setError("Marca y modelo son obligatorios."); return; }

    setGuardando(true);
    const sb = createClient();

    const datos: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      datos[k] = val === "" ? null : val.trim();
    }
    if (!esAsignado) datos.empleado_id = null;
    if (!esBaja) { datos.fecha_baja = null; datos.motivo_baja = null; }

    const { data: { user } } = await sb.auth.getUser();

    const res = celId
      ? await sb.from("cel_celulares").update(datos).eq("id", celId).select("id").single()
      : await sb.from("cel_celulares").insert(datos).select("id").single();

    if (res.error) {
      setGuardando(false);
      setError(res.error.message);
      return;
    }

    const id = res.data.id;

    if (!celId) {
      await sb.from("cel_movimientos").insert({
        celular_id: id,
        tipo_movimiento: "alta",
        empleado_destino_id: datos.empleado_id ?? null,
        usuario_id: user?.id ?? null,
        notas: "Alta inicial de celular",
      });
    }

    setGuardando(false);
    router.push(`/celulares/${id}`);
    router.refresh();
  }

  return (
    <form onSubmit={guardar} className="space-y-5">
      <Bloque titulo="Identificación del equipo">
        <Campo label="Marca *">
          <input className="input" value={v.marca} onChange={set("marca")} placeholder="Ej: Samsung, Apple, Motorola…" required />
        </Campo>
        <Campo label="Modelo *">
          <input className="input" value={v.modelo} onChange={set("modelo")} placeholder="Ej: Galaxy A54, iPhone 14…" required />
        </Campo>
        <Campo label="Color">
          <input className="input" value={v.color} onChange={set("color")} placeholder="Ej: Negro, Blanco, Azul…" />
        </Campo>
        <Campo label="Almacenamiento">
          <input className="input" value={v.almacenamiento} onChange={set("almacenamiento")} placeholder="Ej: 128 GB, 256 GB…" />
        </Campo>
        <Campo label="N° inventario">
          <input className="input" value={v.numero_inventario} onChange={set("numero_inventario")} placeholder="Número interno" />
        </Campo>
        <Campo label="Fecha de ingreso">
          <input type="date" className="input" value={v.fecha_ingreso} onChange={set("fecha_ingreso")} />
        </Campo>
      </Bloque>

      <Bloque titulo="IMEI y SIM">
        <Campo label="IMEI">
          <input className="input font-mono" value={v.imei} onChange={set("imei")} placeholder="15 dígitos" maxLength={17} />
        </Campo>
        <Campo label="IMEI 2 (dual SIM)">
          <input className="input font-mono" value={v.imei2} onChange={set("imei2")} placeholder="15 dígitos" maxLength={17} />
        </Campo>
        <Campo label="N° de línea">
          <input className="input" value={v.numero_linea} onChange={set("numero_linea")} placeholder="Ej: +54 9 11 1234-5678" />
        </Campo>
        <Campo label="Operadora">
          <select className="input" value={v.operadora} onChange={set("operadora")}>
            <option value="">— Sin operadora —</option>
            <option>Personal</option>
            <option>Claro</option>
            <option>Movistar</option>
            <option>Telecom</option>
            <option>Otra</option>
          </select>
        </Campo>
        <Campo label="N° de SIM">
          <input className="input font-mono" value={v.numero_sim} onChange={set("numero_sim")} placeholder="ICCID o N° de tarjeta SIM" />
        </Campo>
        <Campo label="Plan">
          <input className="input" value={v.plan} onChange={set("plan")} placeholder="Ej: Plan corporativo 10 GB…" />
        </Campo>
      </Bloque>

      <Bloque titulo="Asignación y ubicación">
        <Campo label="Estado">
          <select className="input" value={v.estado} onChange={set("estado")}>
            {Object.entries(ESTADOS_CEL).map(([k, lbl]) => (
              <option key={k} value={k}>{lbl}</option>
            ))}
          </select>
        </Campo>
        <Campo label="Piso">
          <input className="input" value={v.piso} onChange={set("piso")} placeholder="Ej: 4°, 5°, 7°…" />
        </Campo>
        <Campo label="Sector">
          <input className="input" value={v.sector} onChange={set("sector")} placeholder="Ej: Ciberseguridad, CAU…" />
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
        <Campo label="Responsable">
          <input className="input" value={v.responsable} onChange={set("responsable")} placeholder="Área o persona responsable" />
        </Campo>
        {esBaja && (
          <>
            <Campo label="Fecha de baja">
              <input type="date" className="input" value={v.fecha_baja} onChange={set("fecha_baja")} />
            </Campo>
            <Campo label="Motivo de baja">
              <input className="input" value={v.motivo_baja} onChange={set("motivo_baja")} placeholder="Ej: Robo, rotura, obsolescencia…" />
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
          {guardando ? "Guardando…" : celId ? "Guardar cambios" : "Registrar celular"}
        </button>
      </div>
    </form>
  );
}
