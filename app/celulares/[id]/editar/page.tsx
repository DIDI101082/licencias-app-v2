"use client";

import { useParams } from "next/navigation";
import CelularForm from "@/components/CelularForm";

export default function EditarCelularPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-ink">Editar celular</h1>
        <p className="text-ink/60 text-sm mt-1">Modificá los datos del equipo.</p>
      </div>
      <CelularForm celId={Number(id)} />
    </div>
  );
}
