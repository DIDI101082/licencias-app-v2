import { NextResponse } from "next/server";
import { createClient, getPerfil } from "@/lib/supabase/server";
import { entraConfigurado, leerUsuariosEntra } from "@/lib/entra";
import { calcularPlan, type EmpleadoActual } from "@/lib/empleados-sync";

export const dynamic = "force-dynamic";

async function preparar(requerirArea: boolean) {
  const { perfil } = await getPerfil();
  if (perfil?.rol !== "administrador") {
    return { error: NextResponse.json({ error: "Solo los administradores pueden sincronizar con Entra ID." }, { status: 403 }) };
  }
  if (!entraConfigurado()) {
    return { error: NextResponse.json({ configurado: false }, { status: 200 }) };
  }
  const supabase = createClient();
  const [{ usuarios, descartes, total }, { data: actuales, error }] = await Promise.all([
    leerUsuariosEntra({ requerirArea }),
    supabase.from("empleados").select("id, entra_id, nombre, apellido, email, area, puesto, activo"),
  ]);
  if (error) throw new Error(error.message);
  const plan = calcularPlan(usuarios, (actuales ?? []) as EmpleadoActual[], { desactivarAusentes: true });
  return { supabase, plan, descartes, total };
}

// Vista previa: qué cambiaría, sin tocar nada
export async function GET(req: Request) {
  try {
    const requerirArea = new URL(req.url).searchParams.get("requerirArea") !== "0";
    const r = await preparar(requerirArea);
    if ("error" in r) return r.error;
    return NextResponse.json({ configurado: true, plan: r.plan, descartes: r.descartes, total: r.total });
  } catch (e: any) {
    return NextResponse.json({ configurado: true, error: e.message }, { status: 500 });
  }
}

// Aplicar: se vuelve a calcular en el servidor (no se confía en lo que manda el navegador)
export async function POST(req: Request) {
  try {
    const { requerirArea = true } = await req.json().catch(() => ({}));
    const r = await preparar(requerirArea);
    if ("error" in r) return r.error;
    const { supabase, plan } = r;
    const ahora = new Date().toISOString();

    if (plan.nuevos.length) {
      const { error } = await supabase.from("empleados").insert(
        plan.nuevos.map((n) => ({
          nombre: n.nombre, apellido: n.apellido, email: n.email, area: n.area, puesto: n.puesto,
          entra_id: n.entra_id, activo: true, origen: "entra", sincronizado: ahora,
        }))
      );
      if (error) throw new Error(`Al crear empleados: ${error.message}`);
    }
    for (const c of plan.actualizar) {
      const datos: Record<string, any> = Object.fromEntries(Object.entries(c.campos).map(([k, v]) => [k, v.despues]));
      const { error } = await supabase.from("empleados").update({ ...datos, sincronizado: ahora }).eq("id", c.id);
      if (error) throw new Error(`Al actualizar ${c.nombre}: ${error.message}`);
    }
    if (plan.desactivar.length) {
      const { error } = await supabase.from("empleados").update({ activo: false, sincronizado: ahora })
        .in("id", plan.desactivar.map((d) => d.id));
      if (error) throw new Error(`Al desactivar: ${error.message}`);
    }
    const desactivadosPorEstado = plan.actualizar.filter((c) => c.campos.activo?.despues === false).length;
    await supabase.from("empleados_sync").insert({
      fuente: "entra", nuevos: plan.nuevos.length,
      actualizados: plan.actualizar.length - desactivadosPorEstado,
      desactivados: plan.desactivar.length + desactivadosPorEstado,
    });
    return NextResponse.json({ ok: true, nuevos: plan.nuevos.length, actualizados: plan.actualizar.length, desactivados: plan.desactivar.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
