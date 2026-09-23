import EquipoForm from "@/components/EquipoForm";

export default function NuevoEquipo() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Cargar equipo</h1>
        <p className="text-ink/60 text-sm mt-1">El código se asigna solo: las computadoras toman su hostname (o NWKS- hasta que reporte el agente), los periféricos la serie P- y el resto la serie IT-.</p>
      </div>
      <EquipoForm />
    </div>
  );
}
