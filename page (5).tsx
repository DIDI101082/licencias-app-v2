import EquipoForm from "@/components/EquipoForm";

export default function EditarEquipo({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-ink">Editar equipo</h1>
      <EquipoForm equipoId={params.id} />
    </div>
  );
}
