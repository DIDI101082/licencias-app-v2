import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

function fmtMoneda(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });
}

function diasHasta(fecha: string) {
  const hoy = new Date();
  const f = new Date(fecha);
  return Math.ceil((f.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
}

export default async function DashboardPage() {
  const supabase = createClient();

  const [{ data: licencias }, { data: ocupacion }, { data: asignaciones }] =
    await Promise.all([
      supabase.from("licencias").select("*"),
      supabase.from("licencias_ocupacion").select("*"),
      supabase
        .from("asignaciones")
        .select("id, fecha_asignacion, licencias(nombre), empleados(nombre, apellido)")
        .is("fecha_liberacion", null)
        .order("fecha_asignacion", { ascending: false })
        .limit(6),
    ]);

  const totalLicencias = licencias?.length ?? 0;
  const seatsOcupados =
    ocupacion?.reduce((acc, l) => acc + (l.seats_ocupados ?? 0), 0) ?? 0;
  const seatsLibres =
    ocupacion?.reduce((acc, l) => acc + (l.seats_libres ?? 0), 0) ?? 0;

  const costoMensual =
    licencias?.reduce((acc, l) => {
      const ocup =
        ocupacion?.find((o) => o.licencia_id === l.id)?.seats_ocupados ?? 0;
      if (l.periodicidad === "mensual") return acc + l.costo_unitario * ocup;
      if (l.periodicidad === "anual") return acc + (l.costo_unitario * ocup) / 12;
      return acc;
    }, 0) ?? 0;

  const porVencer =
    licencias?.filter(
      (l) => l.fecha_vencimiento && diasHasta(l.fecha_vencimiento) <= 30
    ) ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl text-ink">Panel general</h1>
        <p className="text-ink/60 text-sm mt-1">
          Resumen de licencias de software de la empresa
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Licencias activas</div>
          <div className="font-display text-3xl text-ink mt-1">{totalLicencias}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Seats ocupados</div>
          <div className="font-display text-3xl text-ink mt-1">{seatsOcupados}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Seats libres</div>
          <div className="font-display text-3xl text-ink mt-1">{seatsLibres}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Costo mensual estimado</div>
          <div className="font-display text-3xl text-ink mt-1">
            {fmtMoneda(costoMensual)}
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-ink">Vencen en los próximos 30 días</h2>
            <Link href="/licencias" className="text-sm text-brand-600 hover:underline">
              Ver todas
            </Link>
          </div>
          {porVencer.length === 0 ? (
            <p className="text-sm text-ink/50">No hay licencias por vencer.</p>
          ) : (
            <ul className="space-y-2">
              {porVencer.map((l) => {
                const dias = diasHasta(l.fecha_vencimiento);
                return (
                  <li
                    key={l.id}
                    className="flex items-center justify-between text-sm border-b border-black/[0.04] pb-2 last:border-0 last:pb-0"
                  >
                    <span className="text-ink">{l.nombre}</span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        dias < 0
                          ? "bg-red-50 text-red-600"
                          : dias <= 7
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-black/[0.04] text-ink/60"
                      }`}
                    >
                      {dias < 0 ? `Venció hace ${-dias} días` : `Vence en ${dias} días`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-ink">Últimas asignaciones</h2>
            <Link href="/asignaciones" className="text-sm text-brand-600 hover:underline">
              Ver todas
            </Link>
          </div>
          {!asignaciones || asignaciones.length === 0 ? (
            <p className="text-sm text-ink/50">Todavía no hay asignaciones.</p>
          ) : (
            <ul className="space-y-2">
              {asignaciones.map((a: any) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between text-sm border-b border-black/[0.04] pb-2 last:border-0 last:pb-0"
                >
                  <span className="text-ink">
                    {a.empleados?.nombre} {a.empleados?.apellido}
                  </span>
                  <span className="text-ink/50">{a.licencias?.nombre}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
