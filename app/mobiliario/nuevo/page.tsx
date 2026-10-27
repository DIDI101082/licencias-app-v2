import MobiliarioForm from "@/components/MobiliarioForm";

export default function NuevoMobiliario() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Registrar mobiliario</h1>
        <p className="text-ink/60 text-sm mt-1">
          El código MOB- se asigna automáticamente. Completá los datos del mueble y su ubicación inicial.
        </p>
      </div>
      <MobiliarioForm />
    </div>
  );
}
