"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { exportarExcel } from "@/lib/excel";
import { hace } from "@/lib/monitoreo";

type Licencia = {
  id: string; nombre: string; costo_unitario: number; periodicidad: "mensual" | "anual" | "unica";
  sku_id?: string | null; sku_codigo?: string | null;
};
type Cuenta = {
  entra_id: string; email: string | null; nombre: string | null; habilitada: boolean; ultimo_ingreso: string | null;
  empleado_id: string | null; area: string | null; skus: string[];
};
type Estado = {
  automatica: boolean; incluir_gratuitas: boolean; ultima_ejecucion: string | null; ultimo_error: string | null;
  resultado: { sin_totales?: boolean; con_ingresos?: boolean }; avisos: string[]; cuentas: Cuenta[];
};
type Filtro = "todas" | "deshabilitadas" | "sin_uso" | "no_empleados" | "superpuestos";

// Planes que incluyen correo y Office: tener dos a la vez suele ser una licencia de más
const PLANES = new Set([
  "O365_BUSINESS_ESSENTIALS", "O365_BUSINESS_PREMIUM", "SPB", "STANDARDPACK", "ENTERPRISEPACK", "ENTERPRISEPREMIUM",
  "SPE_E3", "SPE_E5", "SPE_F1", "DESKLESSPACK",
]);
const DIAS_SIN_USO = 90;
const dinero = (v: number) => v.toLocaleString("es-AR", { style: "currency", currency: "ARS" });
const mensual = (l?: Licencia) => (!l ? 0 : l.periodicidad === "anual" ? Number(l.costo_unitario) / 12 : l.periodicidad === "mensual" ? Number(l.costo_unitario) : 0);

// Licencias de Microsoft 365 por usuario, leídas de Entra ID. Va al pie de la pantalla Licencias.
export default function LicenciasM365({ licencias, esAdmin }: { licencias: Licencia[]; esAdmin: boolean }) {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [falta, setFalta] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [buscar, setBuscar] = useState("");
  const [ahora, setAhora] = useState(Date.now());

  const cargar = useCallback(async () => {
    const { data, error } = await createClient().rpc("m365_estado");
    if (error) setFalta(/m365_estado/.test(error.message) ? "Falta ejecutar supabase/m365-licencias.sql en Supabase." : error.message);
    else { setFalta(null); setEstado(data as Estado); }
    setAhora(Date.now());
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const porSku = useMemo(() => new Map(licencias.filter((l) => l.sku_id).map((l) => [l.sku_id!, l])), [licencias]);

  const filas = useMemo(() => (estado?.cuentas ?? []).map((c) => {
    const lics = c.skus.map((s) => porSku.get(s)).filter(Boolean) as Licencia[];
    const dias = c.ultimo_ingreso ? Math.floor((ahora - new Date(c.ultimo_ingreso).getTime()) / 86400000) : null;
    return {
      ...c, lics, dias,
      costo: lics.reduce((s, l) => s + mensual(l), 0),
      sinUso: c.habilitada && !!estado?.resultado?.con_ingresos && (dias == null || dias > DIAS_SIN_USO),
      superpuestos: lics.filter((l) => l.sku_codigo && PLANES.has(l.sku_codigo.toUpperCase())).length > 1,
    };
  }), [estado, porSku, ahora]);

  const grupos: { id: Filtro; t: string; n: number }[] = [
    { id: "todas", t: "Todas", n: filas.length },
    { id: "deshabilitadas", t: "Cuentas deshabilitadas", n: filas.filter((f) => !f.habilitada).length },
    { id: "sin_uso", t: `Sin ingresar hace más de ${DIAS_SIN_USO} días`, n: filas.filter((f) => f.sinUso).length },
    { id: "no_empleados", t: "No son empleados", n: filas.filter((f) => !f.empleado_id).length },
    { id: "superpuestos", t: "Planes superpuestos", n: filas.filter((f) => f.superpuestos).length },
  ];
  const q = buscar.trim().toLowerCase();
  const visibles = filas.filter((f) =>
    (filtro === "todas" || (filtro === "deshabilitadas" && !f.habilitada) || (filtro === "sin_uso" && f.sinUso)
      || (filtro === "no_empleados" && !f.empleado_id) || (filtro === "superpuestos" && f.superpuestos))
    && (!q || `${f.nombre} ${f.email} ${f.area ?? ""} ${f.lics.map((l) => l.nombre).join(" ")}`.toLowerCase().includes(q)));
  const costoVisible = visibles.reduce((s, f) => s + f.costo, 0);

  async function sincronizar() {
    setSincronizando(true); setAviso(null);
    try {
      const r = await fetch("/api/entra/licencias", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "No se pudo sincronizar");
      setAviso({ ok: true, texto: `Listo: ${j.cuentas} cuentas con licencia, ${j.asignadas} asignaciones nuevas y ${j.liberadas} liberadas.` });
      await cargar();
      router.refresh();
    } catch (e: any) { setAviso({ ok: false, texto: e.message }); }
    setSincronizando(false);
  }

  async function guardar(cambio: Partial<Pick<Estado, "automatica" | "incluir_gratuitas">>) {
    const { error } = await createClient().rpc("m365_guardar", { p: cambio });
    if (error) setAviso({ ok: false, texto: error.message });
    else { await cargar(); if ("incluir_gratuitas" in cambio) setAviso({ ok: true, texto: "Guardado. Se aplica en la próxima sincronización." }); }
  }

  function exportar() {
    exportarExcel(`licencias_microsoft365_${new Date().toISOString().slice(0, 10)}.xlsx`,
      ["Usuario", "Correo", "Área", "Empleado", "Cuenta", "Último ingreso", "Licencias", "Cantidad", "Costo mensual"],
      visibles.map((f) => [f.nombre, f.email, f.area ?? "", f.empleado_id ? "Sí" : "No", f.habilitada ? "Habilitada" : "Deshabilitada",
        f.ultimo_ingreso ? new Date(f.ultimo_ingreso).toLocaleDateString("es-AR") : "", f.lics.map((l) => l.nombre).join(", "), f.lics.length, Math.round(f.costo * 100) / 100]),
      { Usuario: 28, Correo: 32, Licencias: 60 });
  }

  if (falta) return esAdmin ? <p className="text-sm text-ink/50">Licencias de Microsoft 365: {falta}</p> : null;
  if (!estado) return null;

  return (
    <div className="space-y-3 pt-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-display text-xl text-ink">Microsoft 365 por usuario</h2>
          <p className="text-sm text-ink/60 mt-1">
            Leído de Entra ID en modo solo lectura.
            {estado.ultima_ejecucion ? ` Última actualización ${hace(estado.ultima_ejecucion, ahora)}.` : " Todavía no se sincronizó."}
          </p>
        </div>
        <div className="flex gap-2">
          {filas.length > 0 && <button className="btn-secondary" onClick={exportar}>Exportar a Excel</button>}
          {esAdmin && <button className="btn-primary" disabled={sincronizando} onClick={sincronizar}>{sincronizando ? "Sincronizando…" : "Sincronizar ahora"}</button>}
        </div>
      </div>

      {esAdmin && (
        <div className="flex gap-x-6 gap-y-1 flex-wrap text-sm text-ink/70">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={estado.automatica} onChange={(e) => guardar({ automatica: e.target.checked })} />
            Actualizar sola cada 15 minutos
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={estado.incluir_gratuitas} onChange={(e) => guardar({ incluir_gratuitas: e.target.checked })} />
            Incluir licencias gratuitas y de prueba
          </label>
        </div>
      )}

      {aviso && <p role="status" className={`text-sm rounded-md px-3 py-2 ${aviso.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{aviso.texto}</p>}
      {estado.ultimo_error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">La última sincronización falló: {estado.ultimo_error}</p>}
      {esAdmin && estado.avisos?.map((a) => <p key={a} className="text-sm text-amber-800 bg-amber-500/10 rounded-md px-3 py-2">{a}</p>)}

      {filas.length === 0 ? (
        <div className="card p-6 text-sm text-ink/60">
          {estado.ultima_ejecucion ? "No hay cuentas con licencias para mostrar." : esAdmin ? "Tocá «Sincronizar ahora» para traer las licencias de Microsoft 365." : "Todavía no se cargaron las licencias de Microsoft 365."}
        </div>
      ) : (
        <>
          <div className="flex gap-1 flex-wrap items-center">
            {grupos.filter((g) => g.id === "todas" || g.n > 0 || g.id === filtro).map((g) => (
              <button key={g.id} onClick={() => setFiltro(g.id)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium ${filtro === g.id ? "bg-brand-50 text-brand-700" : "text-ink/50 hover:bg-line/[0.03]"}`}>
                {g.t} <span className="tabular-nums">({g.n})</span>
              </button>
            ))}
            <input className="input ml-auto max-w-xs" placeholder="Buscar usuario, área o licencia" aria-label="Buscar" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
          </div>

          <div className="card overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Usuario</th><th>Área</th><th>Cuenta</th><th>Último ingreso</th><th>Licencias</th><th className="text-right">Costo mensual</th></tr></thead>
              <tbody>
                {visibles.map((f) => (
                  <tr key={f.entra_id}>
                    <td>
                      {f.empleado_id
                        ? <Link href={`/empleados/${f.empleado_id}`} className="font-medium text-ink hover:underline">{f.nombre}</Link>
                        : <span className="font-medium text-ink">{f.nombre}</span>}
                      <div className="text-xs text-ink/40">{f.email}</div>
                    </td>
                    <td className="text-ink/60">{f.area ?? <span className="text-ink/40">No es empleado</span>}</td>
                    <td>{f.habilitada ? <span className="text-ink/60">Habilitada</span> : <span className="pill bg-red-50 text-red-600">Deshabilitada</span>}</td>
                    <td className={`whitespace-nowrap ${f.sinUso ? "text-red-600" : "text-ink/60"}`}>
                      {f.ultimo_ingreso ? new Date(f.ultimo_ingreso).toLocaleDateString("es-AR") : estado.resultado?.con_ingresos ? "Nunca" : "—"}
                    </td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        {f.lics.map((l) => <span key={l.id} className="pill bg-line/[0.06] text-ink/70">{l.nombre}</span>)}
                      </div>
                    </td>
                    <td className="text-right tabular-nums text-ink/60">{f.costo ? dinero(f.costo) : "—"}</td>
                  </tr>
                ))}
                {visibles.length === 0 && <tr><td colSpan={6} className="text-center text-ink/40 py-8">Ninguna cuenta coincide.</td></tr>}
              </tbody>
              {costoVisible > 0 && (
                <tfoot><tr><td colSpan={5} className="text-right text-sm text-ink/60">Total mensual de {visibles.length} cuentas</td><td className="text-right tabular-nums font-medium text-ink">{dinero(costoVisible)}</td></tr></tfoot>
              )}
            </table>
          </div>
          {!licencias.some((l) => l.sku_id && Number(l.costo_unitario) > 0) && esAdmin && (
            <p className="text-xs text-ink/50">Para ver el costo por usuario, cargá el precio de cada licencia de Microsoft 365 con «Editar» en la tabla de arriba.</p>
          )}
        </>
      )}
    </div>
  );
}
