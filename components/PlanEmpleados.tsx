"use client";

import { ETIQUETAS, textoValor, type Plan } from "@/lib/empleados-sync";

// Vista previa de cambios antes de aplicarlos (usada por Excel y Entra ID)
export default function PlanEmpleados({ plan }: { plan: Plan }) {
  const MAX = 15;
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg bg-emerald-50 px-4 py-3"><div className="text-xs text-emerald-700">Nuevos</div><div className="font-display text-2xl text-emerald-700">{plan.nuevos.length}</div></div>
        <div className="rounded-lg bg-brand-50 px-4 py-3"><div className="text-xs text-brand-700">Con cambios</div><div className="font-display text-2xl text-brand-700">{plan.actualizar.length}</div></div>
        <div className="rounded-lg bg-red-50 px-4 py-3"><div className="text-xs text-red-600">A desactivar</div><div className="font-display text-2xl text-red-600">{plan.desactivar.length}</div></div>
        <div className="rounded-lg bg-line/[0.04] px-4 py-3"><div className="text-xs text-ink/60">Sin cambios</div><div className="font-display text-2xl text-ink/70">{plan.sinCambios}</div></div>
      </div>

      {plan.nuevos.length > 0 && (
        <details open={plan.nuevos.length <= 5}>
          <summary className="cursor-pointer font-medium text-ink">Se van a crear {plan.nuevos.length} empleados</summary>
          <ul className="mt-2 space-y-0.5 text-ink/70">
            {plan.nuevos.slice(0, MAX).map((n) => <li key={n.email}>{n.nombre} {n.apellido} · {n.email} · {n.area}</li>)}
            {plan.nuevos.length > MAX && <li className="text-ink/50">y {plan.nuevos.length - MAX} más…</li>}
          </ul>
        </details>
      )}

      {plan.actualizar.length > 0 && (
        <details open={plan.actualizar.length <= 5}>
          <summary className="cursor-pointer font-medium text-ink">Se van a actualizar {plan.actualizar.length} empleados</summary>
          <ul className="mt-2 space-y-1 text-ink/70">
            {plan.actualizar.slice(0, MAX).map((c) => (
              <li key={c.id}>
                <b className="text-ink">{c.nombre}:</b>{" "}
                {Object.entries(c.campos).map(([k, v]) => (
                  <span key={k} className="mr-2">
                    {ETIQUETAS[k] ?? k} <span className="line-through text-ink/40">{textoValor(k, v.antes)}</span> → {textoValor(k, v.despues)}
                  </span>
                ))}
              </li>
            ))}
            {plan.actualizar.length > MAX && <li className="text-ink/50">y {plan.actualizar.length - MAX} más…</li>}
          </ul>
        </details>
      )}

      {plan.desactivar.length > 0 && (
        <details open>
          <summary className="cursor-pointer font-medium text-red-600">Se van a desactivar {plan.desactivar.length} empleados (ya no existen en Entra ID)</summary>
          <ul className="mt-2 space-y-0.5 text-ink/70">
            {plan.desactivar.map((d) => <li key={d.id}>{d.nombre} · {d.email}</li>)}
          </ul>
        </details>
      )}

      {plan.errores.length > 0 && (
        <div className="rounded-md bg-amber-500/10 text-amber-700 px-3 py-2">
          <b>Se van a omitir {plan.errores.length} filas:</b>
          <ul className="list-disc pl-5 mt-1">{plan.errores.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
