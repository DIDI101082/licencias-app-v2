import MobiliarioForm from "@/components/MobiliarioForm";

export default async function EditarMobiliario({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Editar mobiliario</h1>
        <p className="text-ink/60 text-sm mt-1">
          Modificá los datos del elemento. Los movimientos se registran por separado.
        </p>
      </div>
      <MobiliarioForm mobId={id} />
    </div>
  );
}
