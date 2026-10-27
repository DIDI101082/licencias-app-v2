"use client";

import CelularForm from "@/components/CelularForm";

export default function NuevoCelularPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-ink">Registrar celular corporativo</h1>
        <p className="text-ink/60 text-sm mt-1">Completá los datos del equipo para agregarlo al inventario.</p>
      </div>
      <CelularForm />
    </div>
  );
}
