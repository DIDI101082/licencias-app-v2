import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ESTADOS, dinero, fecha, diasHasta } from "@/lib/inventario";

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
  const porGrupo = Object.entries(
    activos.reduce<Record<string, number>>((acc, e) => ((acc[e.grupo] = (acc[e.grupo] ?? 0) + e.cantidad), acc), {})
  ).sort((a, b) => b[1] - a[1]);
  const maxGrupo = Math.max(1, ...porGrupo.map(([, n]) => n));

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

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-3">Por tipo de equipo</h2>
          {porGrupo.length === 0 && <p className="text-sm text-ink/50">Todavía no hay equipos cargados.</p>}
          <ul className="space-y-3">
            {porGrupo.map(([g, n]) => (
              <li key={g} className="text-sm">
                <div className="flex justify-between"><span>{g}</span><span className="font-medium">{n}</span></div>
                <div className="h-1.5 bg-black/[0.05] rounded-full mt-1 overflow-hidden">
                  <div className="h-full bg-brand-500 rounded-full" style={{ width: `${(n / maxGrupo) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-6">
          <div className="card p-5">
            <h2 className="font-medium text-ink mb-3">Garantías que vencen en 60 días</h2>
            {garantias.length === 0 ? (
              <p className="text-sm text-ink/50">Ninguna garantía vence en los próximos 60 días.</p>
            ) : (
              <ul className="space-y-2">
                {garantias.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 text-sm border-b border-black/[0.04] pb-2 last:border-0">
                    <span className="flex items-center gap-2">
                      <Link href={`/inventario/equipos/${e.id}`} className="tag-inv">{e.codigo}</Link>
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
                  <li key={e.id} className="flex items-center justify-between gap-3 text-sm border-b border-black/[0.04] pb-2 last:border-0">
                    <span className="flex items-center gap-2">
                      <Link href={`/inventario/equipos/${e.id}`} className="tag-inv">{e.codigo}</Link>
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
