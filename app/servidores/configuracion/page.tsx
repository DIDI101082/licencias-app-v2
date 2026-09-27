"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { CONFIG_INICIAL, fechaCorta, type Config } from "@/lib/servidores";

type Fin = { id: number; patron: string; nombre: string; fin_estandar: string | null; fin_extendido: string; notas: string | null };
const NUEVO = { patron: "", nombre: "", fin_estandar: "", fin_extendido: "", notas: "" };

const REGLAS: { k: string; t: string; ayuda: string }[] = [
  { k: "reporte", t: "Servidor sin reportar", ayuda: "Servidores críticos y altos cuyo agente deja de enviar datos." },
  { k: "fin_soporte", t: "Fin de soporte", ayuda: "Sistema operativo sin soporte o que lo pierde pronto." },
  { k: "backup", t: "Backup fuera de RPO o sin backup", ayuda: "Servidores (salvo baja criticidad) sin backup exitoso dentro de su RPO." },
  { k: "restauracion", t: "Prueba de restauración vencida", ayuda: "Servidores críticos y altos sin prueba de restauración exitosa reciente." },
];

export default function ConfiguracionServidores() {
  const { esAdmin } = usePerfil();
  const [c, setC] = useState<Config>(CONFIG_INICIAL);
  const [fin, setFin] = useState<Fin[]>([]);
  const [nuevo, setNuevo] = useState(NUEVO);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const cargar = async () => {
    const sb = createClient();
    const [a, b] = await Promise.all([
      sb.from("srv_config").select("*").eq("id", 1).maybeSingle(),
      sb.from("srv_fin_soporte").select("*").order("fin_extendido"),
    ]);
    if (a.error) setMsg({ ok: false, t: /srv_/.test(a.error.message) ? "Falta ejecutar supabase/servidores.sql en Supabase." : a.error.message });
    if (a.data) setC(a.data as Config);
    setFin((b.data ?? []) as Fin[]);
  };
  useEffect(() => { cargar(); }, []);

  if (!esAdmin) return <div className="card p-6 max-w-md text-sm text-ink/60">Solo un administrador puede cambiar la configuración de Servidores.</div>;

  async function guardar() {
    const { error } = await createClient().rpc("srv_config_guardar", { p: c });
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: "Guardado. Se aplica en la próxima revisión de alertas (cada 10 minutos)." });
  }

  async function agregar(e: React.FormEvent) {
    e.preventDefault();
    const patron = nuevo.patron.includes("%") ? nuevo.patron.trim() : `%${nuevo.patron.trim()}%`;
    const { error } = await createClient().from("srv_fin_soporte").insert({
      patron, nombre: nuevo.nombre.trim(), fin_estandar: nuevo.fin_estandar || null, fin_extendido: nuevo.fin_extendido, notas: nuevo.notas.trim() || null,
    });
    if (error) return setMsg({ ok: false, t: error.message.includes("patron") ? "Ya hay una fila con ese texto." : error.message });
    setNuevo(NUEVO); setMsg(null); cargar();
  }

  const numero = (k: keyof Config, t: string, min: number, max: number, ayuda?: string) => (
    <label className="block text-sm">{t}
      <input type="number" min={min} max={max} className="input mt-1" value={c[k] as number} onChange={(e) => setC({ ...c, [k]: Number(e.target.value) })} />
      {ayuda && <span className="text-xs text-ink/50">{ayuda}</span>}
    </label>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Configuración de Servidores</h1>
        <p className="text-ink/60 text-sm mt-1">Alertas (van a Teams y al sistema de tickets, como el resto) y tabla de fin de soporte.</p>
      </div>
      {msg && <p className={`text-sm rounded-md px-3 py-2 ${msg.ok ? "text-emerald-700 bg-emerald-50" : "text-red-600 bg-red-50"}`}>{msg.t}</p>}

      <div className="card p-5 space-y-4">
        <h2 className="font-display text-lg text-ink">Alertas</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={c.alertas} onChange={(e) => setC({ ...c, alertas: e.target.checked })} /> Enviar alertas de servidores
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          {REGLAS.map((r) => (
            <label key={r.k} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" disabled={!c.alertas} checked={c.reglas.includes(r.k)}
                onChange={() => setC({ ...c, reglas: c.reglas.includes(r.k) ? c.reglas.filter((x) => x !== r.k) : [...c.reglas, r.k] })} />
              <span><span className="text-ink">{r.t}</span><span className="block text-xs text-ink/50">{r.ayuda}</span></span>
            </label>
          ))}
        </div>
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
          {numero("horas_sin_reporte", "Sin reportar después de (horas)", 1, 168)}
          {numero("dias_sin_parche", "Parches atrasados después de (días)", 7, 365, "Solo se marca en pantalla; el aviso lo da la regla general de parches.")}
          {numero("dias_aviso_fin_soporte", "Avisar fin de soporte con (días)", 0, 730)}
          {numero("dias_prueba_restore", "Prueba de restauración cada (días)", 30, 730)}
        </div>
        <button className="btn-primary" onClick={guardar}>Guardar</button>
      </div>

      <div className="card overflow-x-auto">
        <div className="p-5 pb-2">
          <h2 className="font-display text-lg text-ink">Fin de soporte por sistema operativo</h2>
          <p className="text-sm text-ink/60 mt-1">
            Se compara el texto con el sistema operativo que informa el agente (o el cargado a mano). <code className="text-xs">%</code> es un
            comodín. Si coinciden varias filas, gana la más específica (la de texto más largo). Revisá las fechas con el ciclo de vida oficial de cada fabricante.
          </p>
        </div>
        <table className="data w-full">
          <thead><tr><th>Versión</th><th>Texto a buscar</th><th>Fin soporte general</th><th>Fin parches de seguridad</th><th>Notas</th><th></th></tr></thead>
          <tbody>
            {fin.map((x) => (
              <tr key={x.id}>
                <td className="text-sm text-ink">{x.nombre}</td>
                <td className="font-mono text-xs text-ink/70">{x.patron}</td>
                <td className="text-sm text-ink/70">{fechaCorta(x.fin_estandar)}</td>
                <td className="text-sm text-ink">{fechaCorta(x.fin_extendido)}</td>
                <td className="text-xs text-ink/60">{x.notas ?? ""}</td>
                <td className="text-right">
                  <button className="text-xs text-ink/40 hover:text-red-600" onClick={async () => {
                    if (!confirm(`¿Quitar ${x.nombre}?`)) return;
                    const { error } = await createClient().from("srv_fin_soporte").delete().eq("id", x.id);
                    if (error) setMsg({ ok: false, t: error.message }); else cargar();
                  }}>Quitar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={agregar} className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end p-5">
          <div><label className="label">Versión</label><input required className="input" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} placeholder="Oracle Linux 8" /></div>
          <div><label className="label">Texto a buscar</label><input required className="input" value={nuevo.patron} onChange={(e) => setNuevo({ ...nuevo, patron: e.target.value })} placeholder="Oracle Linux Server 8" /></div>
          <div><label className="label">Fin general</label><input type="date" className="input" value={nuevo.fin_estandar} onChange={(e) => setNuevo({ ...nuevo, fin_estandar: e.target.value })} /></div>
          <div><label className="label">Fin de parches</label><input type="date" required className="input" value={nuevo.fin_extendido} onChange={(e) => setNuevo({ ...nuevo, fin_extendido: e.target.value })} /></div>
          <div><label className="label">Notas</label><input className="input" value={nuevo.notas} onChange={(e) => setNuevo({ ...nuevo, notas: e.target.value })} /></div>
          <div><button className="btn-secondary w-full">Agregar</button></div>
        </form>
      </div>
    </div>
  );
}
