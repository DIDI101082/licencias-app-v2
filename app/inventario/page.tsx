import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ESTADOS, dinero, fecha, diasHasta, claseCodigo } from "@/lib/inventario";

export const dynamic = "force-dynamic";

type Fila = {
  id: string; codigo: string; categoria: string; grupo: string; marca: string | null; modelo: string | null;
  estado: string; costo: number | null; moneda: string; garantia_hasta: string | null;
  fecha_compra: string | null; vida_util_meses: number | null; cantidad: number;
};

export default async function InventarioPanel() {
  const supabase = createClient();
  const { data } = await supabase
    .from("inv_v_equipos")
    .select("id,codigo,categoria,grupo,marca,modelo,estado,costo,moneda,garantia_hasta,fecha_compra,vida_util_meses,cantidad");
  const equipos = (data ?? []) as Fila[];
  const activos = equipos.filter((e) => !["dado_de_baja", "perdido"].includes(e.estado));

  const porEstado = Object.keys(ESTADOS).map((k) => ({ k, n: equipos.filter((e) => e.estado === k).length }));
  // Detalle por tipo de equipo (categoría), agrupado por familia
  type Conteo = { categoria: string; grupo: string; total: number; stock: number; asignados: number; reparacion: number; otros: number };
  const porCategoria = Object.values(
    activos.reduce<Record<string, Conteo>>((acc, e) => {
      const c = (acc[e.categoria] ??= { categoria: e.categoria, grupo: e.grupo, total: 0, stock: 0, asignados: 0, reparacion: 0, otros: 0 });
      c.total += e.cantidad;
      if (e.estado === "en_stock") c.stock += e.cantidad;
      else if (e.estado === "asignado") c.asignados += e.cantidad;
      else if (e.estado === "en_reparacion") c.reparacion += e.cantidad;
      else c.otros += e.cantidad;
      return acc;
    }, {})
  );
  const grupos = Array.from(new Set(porCategoria.map((c) => c.grupo)))
    .map((g) => ({
      grupo: g,
      filas: porCategoria.filter((c) => c.grupo === g).sort((a, b) => b.total - a.total),
      total: porCategoria.filter((c) => c.grupo === g).reduce((s, c) => s + c.total, 0),
    }))
    .sort((a, b) => b.total - a.total);
  const totalActivos = porCategoria.reduce((s, c) => s + c.total, 0);
  const hayOtros = porCategoria.some((c) => c.otros > 0);

  const valorARS = activos.filter((e) => e.moneda === "ARS").reduce((s, e) => s + (e.costo ?? 0) * e.cantidad, 0);
  const valorUSD = activos.filter((e) => e.moneda === "USD").reduce((s, e) => s + (e.costo ?? 0) * e.cantidad, 0);

  const garantias = activos
    .map((e) => ({ ...e, dias: diasHasta(e.garantia_hasta) }))
    .filter((e) => e.dias !== null && e.dias <= 60)
    .sort((a, b) => a.dias! - b.dias!);

  const recambio = activos
    .filter((e) => e.fecha_compra && e.vida_util_meses)
    .map((e) => {
      const fin = new Date(e.fecha_compra + "T12:00:00");
      fin.setMonth(fin.getMonth() + e.vida_util_meses!);
      return { ...e, fin, vencido: fin.getTime() < Date.now() };
    })
    .filter((e) => e.fin.getTime() < Date.now() + 90 * 86400000)
    .sort((a, b) => a.fin.getTime() - b.fin.getTime());

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Inventario IT</h1>
          <p className="text-ink/60 text-sm mt-1">{activos.length} equipos activos en inventario</p>
        </div>
        <Link href="/inventario/equipos/nuevo" className="btn-primary">+ Cargar equipo</Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {porEstado.filter(({ k }) => ["en_stock", "asignado", "en_reparacion", "prestado"].includes(k)).map(({ k, n }) => (
          <Link key={k} href={`/inventario/equipos?estado=${k}`} className="card p-5 hover:border-brand-300">
            <div className="text-xs text-ink/50 font-medium">{ESTADOS[k]}</div>
            <div className="font-display text-3xl text-ink mt-1">{n}</div>
          </Link>
        ))}
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Valor de compra (ARS)</div>
          <div className="font-display text-2xl text-ink mt-1">{dinero(valorARS)}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Valor de compra (USD)</div>
          <div className="font-display text-2xl text-ink mt-1">{dinero(valorUSD, "USD")}</div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="px-5 pt-5 pb-3 flex items-baseline justify-between gap-3">
          <h2 className="font-medium text-ink">Detalle por tipo de equipo</h2>
          <span className="text-xs text-ink/50">Tocá un tipo para ver la lista</span>
        </div>
        {grupos.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink/50">Todavía no hay equipos cargados.</p>
        ) : (
          <table className="data w-full">
            <thead>
              <tr>
                <th>Tipo</th>
                <th className="text-right">Total</th>
                <th className="text-right">En stock</th>
                <th className="text-right">Asignados</th>
                <th className="text-right">En reparación</th>
                {hayOtros && <th className="text-right">Prestados</th>}
              </tr>
            </thead>
            <tbody>
              {grupos.map((g) => (
                <Fragment key={g.grupo}>
                  <tr className="bg-canvas">
                    <td className="text-xs font-semibold uppercase tracking-wide text-ink/50">{g.grupo}</td>
                    <td className="text-right text-xs font-semibold text-ink/50">{g.total}</td>
                    <td colSpan={hayOtros ? 4 : 3}></td>
                  </tr>
                  {g.filas.map((c) => (
                    <tr key={c.categoria} className="hover:bg-line/[0.015]">
                      <td>
                        <Link href={`/inventario/equipos?categoria=${encodeURIComponent(c.categoria)}`} className="text-ink hover:text-brand-700 hover:underline">
                          {c.categoria}
                        </Link>
                      </td>
                      <td className="text-right font-display text-lg text-ink">{c.total}</td>
                      <td className="text-right">
                        {c.stock ? (
                          <Link href={`/inventario/equipos?categoria=${encodeURIComponent(c.categoria)}&estado=en_stock`} className="text-emerald-700 hover:underline">{c.stock}</Link>
                        ) : <span className="text-ink/30">0</span>}
                      </td>
                      <td className="text-right">
                        {c.asignados ? (
                          <Link href={`/inventario/equipos?categoria=${encodeURIComponent(c.categoria)}&estado=asignado`} className="text-brand-700 hover:underline">{c.asignados}</Link>
                        ) : <span className="text-ink/30">0</span>}
                      </td>
                      <td className="text-right">
                        {c.reparacion ? (
                          <Link href={`/inventario/equipos?categoria=${encodeURIComponent(c.categoria)}&estado=en_reparacion`} className="text-amber-700 hover:underline">{c.reparacion}</Link>
                        ) : <span className="text-ink/30">0</span>}
                      </td>
                      {hayOtros && <td className="text-right text-ink/60">{c.otros || <span className="text-ink/30">0</span>}</td>}
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="border-t-2 border-line/[0.08]">
                <td className="font-medium text-ink">Total</td>
                <td className="text-right font-display text-lg text-ink">{totalActivos}</td>
                <td className="text-right text-ink/70">{porCategoria.reduce((s, c) => s + c.stock, 0)}</td>
                <td className="text-right text-ink/70">{porCategoria.reduce((s, c) => s + c.asignados, 0)}</td>
                <td className="text-right text-ink/70">{porCategoria.reduce((s, c) => s + c.reparacion, 0)}</td>
                {hayOtros && <td className="text-right text-ink/70">{porCategoria.reduce((s, c) => s + c.otros, 0)}</td>}
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="contents">
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-3">Garantías que vencen en 60 días</h2>
            {garantias.length === 0 ? (
              <p className="text-sm text-ink/50">Ninguna garantía vence en los próximos 60 días.</p>
            ) : (
              <ul className="space-y-2">
                {garantias.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 text-sm border-b border-line/[0.04] pb-2 last:border-0">
                    <span className="flex items-center gap-2">
                      <Link href={`/inventario/equipos/${e.id}`} className={claseCodigo(e.codigo)}>{e.codigo}</Link>
                      {e.categoria} {e.marca} {e.modelo}
                    </span>
                    <span className={`pill ${e.dias! < 0 ? "bg-red-50 text-red-600" : "bg-amber-500/10 text-amber-600"}`}>
                      {e.dias! < 0 ? `Venció el ${fecha(e.garantia_hasta)}` : `Vence en ${e.dias} días`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-5">
            <h2 className="font-medium text-ink mb-3">Recambio por vida útil</h2>
            {recambio.length === 0 ? (
              <p className="text-sm text-ink/50">Ningún equipo cumple su vida útil en los próximos 90 días.</p>
            ) : (
              <ul className="space-y-2">
                {recambio.slice(0, 12).map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 text-sm border-b border-line/[0.04] pb-2 last:border-0">
                    <span className="flex items-center gap-2">
                      <Link href={`/inventario/equipos/${e.id}`} className={claseCodigo(e.codigo)}>{e.codigo}</Link>
                      {e.categoria} {e.marca} {e.modelo}
                    </span>
                    <span className={`pill ${e.vencido ? "bg-red-50 text-red-600" : "bg-amber-500/10 text-amber-600"}`}>
                      {e.vencido ? "Vida útil cumplida" : `Cumple el ${e.fin.toLocaleDateString("es-AR")}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
