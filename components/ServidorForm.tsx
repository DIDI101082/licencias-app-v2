"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CRITICIDAD, ENTORNO, type Criticidad, type Datos, type Entorno, type Servidor } from "@/lib/servidores";

type Borrador = Omit<Servidor, "id"> & { id?: number };

export const SERVIDOR_VACIO: Borrador = {
  nombre: "", rol: "", entorno: "produccion", criticidad: "media", sede: "", responsable: "", notas: "", activo: true,
  dispositivo_id: null, so_manual: "", prtg_objid: null, requiere_backup: true, backup_auto: true, backup_trabajos: [], rpo_horas: 26,
};

// Alta y edición de un servidor (solo administradores; la base lo exige igual)
export default function ServidorForm({ inicial, datos, ocupados, onListo, onCancelar }: {
  inicial: Borrador;
  datos: Datos | null;
  ocupados: string[];              // equipos del agente ya vinculados a otro servidor
  onListo: () => void;
  onCancelar: () => void;
}) {
  const [f, setF] = useState<Borrador>({ ...SERVIDOR_VACIO, ...inicial });
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const set = <K extends keyof Borrador>(k: K, v: Borrador[K]) => setF((x) => ({ ...x, [k]: v }));

  const dispositivos = useMemo(
    () => (datos?.dispositivos ?? []).filter((d) => d.id === f.dispositivo_id || !ocupados.includes(d.id)),
    [datos, ocupados, f.dispositivo_id],
  );
  const prtg = useMemo(() => [...(datos?.prtg?.dispositivos ?? [])].sort((a, b) => a.nombre.localeCompare(b.nombre)), [datos]);
  const trabajos = datos?.veeam.trabajos ?? [];
  const disp = dispositivos.find((d) => d.id === f.dispositivo_id);

  // Sugerencia de PRTG: el equipo cuyo nombre o IP coincide con el servidor
  const sugerido = useMemo(() => {
    if (f.prtg_objid != null) return null;
    const nombres = [f.nombre, disp?.hostname].filter(Boolean).map((n) => n!.split(".")[0].toLowerCase());
    return prtg.find((p) =>
      nombres.includes(p.nombre.split(".")[0].toLowerCase()) || nombres.includes((p.host ?? "").split(".")[0].toLowerCase()) ||
      (disp?.ip && p.host === disp.ip)) ?? null;
  }, [prtg, f.nombre, f.prtg_objid, disp]);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setGuardando(true);
    const fila = {
      nombre: f.nombre.trim(), rol: f.rol?.trim() || null, entorno: f.entorno, criticidad: f.criticidad,
      sede: f.sede?.trim() || null, responsable: f.responsable?.trim() || null, notas: f.notas?.trim() || null, activo: f.activo,
      dispositivo_id: f.dispositivo_id || null, so_manual: f.dispositivo_id ? null : f.so_manual?.trim() || null,
      prtg_objid: f.prtg_objid, requiere_backup: f.requiere_backup, backup_auto: f.backup_auto,
      backup_trabajos: f.backup_trabajos, rpo_horas: f.rpo_horas,
    };
    const sb = createClient();
    const { error } = f.id ? await sb.from("srv_servidores").update(fila).eq("id", f.id) : await sb.from("srv_servidores").insert(fila);
    setGuardando(false);
    if (error) return setError(error.message.includes("dispositivo_id") ? "Ese equipo del agente ya está vinculado a otro servidor." : error.message);
    onListo();
  }

  async function borrar() {
    if (!f.id || !confirm(`¿Quitar ${f.nombre} de la lista de servidores? Se borran también sus pruebas de restauración registradas.`)) return;
    const { error } = await createClient().from("srv_servidores").delete().eq("id", f.id);
    if (error) return setError(error.message);
    onListo();
  }

  return (
    <form onSubmit={guardar} className="card p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg text-ink">{f.id ? `Editar ${inicial.nombre}` : "Agregar servidor"}</h2>
        <button type="button" className="text-sm text-ink/50 hover:text-ink" onClick={onCancelar}>Cerrar</button>
      </div>
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <fieldset className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <legend className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-2">Datos</legend>
        <div className="md:col-span-2"><label className="label">Nombre</label>
          <input required className="input" value={f.nombre} onChange={(e) => set("nombre", e.target.value)} placeholder="SRV-DC01" /></div>
        <div className="md:col-span-2"><label className="label">Rol</label>
          <input className="input" value={f.rol ?? ""} onChange={(e) => set("rol", e.target.value)} placeholder="Controlador de dominio, SQL, archivos…" /></div>
        <div><label className="label">Entorno</label>
          <select className="input" value={f.entorno} onChange={(e) => set("entorno", e.target.value as Entorno)}>
            {Object.entries(ENTORNO).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select></div>
        <div><label className="label">Criticidad</label>
          <select className="input" value={f.criticidad} onChange={(e) => set("criticidad", e.target.value as Criticidad)}>
            {Object.entries(CRITICIDAD).map(([k, c]) => <option key={k} value={k}>{c.t}</option>)}
          </select></div>
        <div><label className="label">Sede</label>
          <input className="input" value={f.sede ?? ""} onChange={(e) => set("sede", e.target.value)} placeholder="Datacenter, Piso 5…" /></div>
        <div><label className="label">Responsable</label>
          <input className="input" value={f.responsable ?? ""} onChange={(e) => set("responsable", e.target.value)} placeholder="Nombre o equipo" /></div>
        <div className="sm:col-span-2 md:col-span-4"><label className="label">Notas</label>
          <textarea className="input" rows={2} value={f.notas ?? ""} onChange={(e) => set("notas", e.target.value)}
            placeholder="Qué corre en este servidor, de qué depende, contacto del proveedor…" /></div>
      </fieldset>

      <fieldset className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <legend className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-2">Monitoreo</legend>
        <div>
          <label className="label">Equipo del agente</label>
          <select className="input" value={f.dispositivo_id ?? ""} onChange={(e) => set("dispositivo_id", e.target.value || null)}>
            <option value="">Sin agente</option>
            {dispositivos.map((d) => <option key={d.id} value={d.id}>{d.hostname}{d.so_nombre ? ` · ${d.so_nombre}` : ""}</option>)}
          </select>
          <p className="text-xs text-ink/50 mt-1">Da el sistema operativo, parches, discos y RAM.</p>
        </div>
        <div>
          <label className="label">Equipo en PRTG</label>
          <select className="input" value={f.prtg_objid ?? ""} onChange={(e) => set("prtg_objid", e.target.value ? Number(e.target.value) : null)}>
            <option value="">Sin vincular</option>
            {prtg.map((p) => <option key={p.objid} value={p.objid}>{p.nombre}{p.host ? ` (${p.host})` : ""}{p.grupo ? ` · ${p.grupo}` : ""}</option>)}
          </select>
          {sugerido && (
            <button type="button" className="text-xs text-brand-700 mt-1 hover:underline" onClick={() => set("prtg_objid", Number(sugerido.objid))}>
              Usar {sugerido.nombre}{sugerido.host ? ` (${sugerido.host})` : ""}, que coincide con este servidor
            </button>
          )}
          {!prtg.length && <p className="text-xs text-ink/50 mt-1">Sin datos de PRTG: instalá el puente desde la solapa Red.</p>}
        </div>
        {!f.dispositivo_id && (
          <div className="md:col-span-2">
            <label className="label">Sistema operativo (si no tiene agente)</label>
            <input className="input" value={f.so_manual ?? ""} onChange={(e) => set("so_manual", e.target.value)}
              placeholder="Windows Server 2019 Standard, Ubuntu 22.04 LTS…" />
            <p className="text-xs text-ink/50 mt-1">Sirve para calcular el fin de soporte de equipos sin agente (appliances, Linux sin agente).</p>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-2">Backups</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.requiere_backup} onChange={(e) => set("requiere_backup", e.target.checked)} />
          Requiere backup
        </label>
        {f.requiere_backup && (
          <>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">RPO (horas)</label>
                <input type="number" min={1} max={2160} className="input" value={f.rpo_horas} onChange={(e) => set("rpo_horas", Number(e.target.value))} />
                <p className="text-xs text-ink/50 mt-1">Máximo de horas sin un backup exitoso. 26 h para diarios; 170 h para semanales.</p>
              </div>
              <label className="flex items-start gap-2 text-sm sm:pt-7">
                <input type="checkbox" className="mt-1" checked={f.backup_auto} onChange={(e) => set("backup_auto", e.target.checked)} />
                <span>Sumar solos los trabajos de Veeam que incluyen una VM o equipo con este nombre
                  <span className="block text-xs text-ink/50">Necesita el script de Veeam 1.1 o posterior.</span></span>
              </label>
            </div>
            <div>
              <div className="label">Trabajos de Veeam asignados a mano</div>
              {!trabajos.length ? <p className="text-sm text-ink/50">Todavía no hay trabajos de Veeam informados.</p> : (
                <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto">
                  {trabajos.map((t) => (
                    <label key={t.nombre} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={f.backup_trabajos.includes(t.nombre)}
                        onChange={(e) => set("backup_trabajos", e.target.checked ? [...f.backup_trabajos, t.nombre] : f.backup_trabajos.filter((x) => x !== t.nombre))} />
                      <span className="truncate" title={t.nombre}>{t.nombre}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.activo} onChange={(e) => set("activo", e.target.checked)} />
        Activo (desmarcalo si está fuera de servicio: se ve atenuado y no genera alertas)
      </label>

      <div className="flex flex-wrap gap-2 justify-between">
        <div className="flex gap-2">
          <button className="btn-primary" disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</button>
          <button type="button" className="btn-secondary" onClick={onCancelar}>Cancelar</button>
        </div>
        {f.id && <button type="button" className="text-sm text-red-600 hover:underline" onClick={borrar}>Quitar servidor</button>}
      </div>
    </form>
  );
}
