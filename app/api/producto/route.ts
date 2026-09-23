import { NextResponse } from "next/server";
import { createClient, getPerfil } from "@/lib/supabase/server";
import { interpretar } from "@/lib/productos";

export const dynamic = "force-dynamic";

// Busca un producto por su código EAN/UPC: primero en el catálogo propio,
// después en UPCitemdb (gratis, 100 consultas por día) y guarda el resultado.
export async function GET(req: Request) {
  const { perfil } = await getPerfil();
  if (!perfil || !["administrador", "lectura_escritura"].includes(perfil.rol)) {
    return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
  }
  const ean = (new URL(req.url).searchParams.get("ean") ?? "").replace(/\D/g, "");
  if (!/^\d{8,14}$/.test(ean)) return NextResponse.json({ error: "Código inválido" }, { status: 400 });

  const supabase = createClient();
  const { data: categorias } = await supabase.from("inv_categorias").select("id, nombre");

  // 1. Catálogo propio
  const { data: propio } = await supabase.from("inv_productos").select("*").eq("ean", ean).maybeSingle();
  if (propio) {
    return NextResponse.json({ encontrado: true, origen: "catalogo", producto: propio });
  }

  // 2. Base pública
  let r: Response;
  try {
    r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`, {
      headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10000),
    });
  } catch {
    return NextResponse.json({ encontrado: false, error: "No se pudo consultar la base de productos (sin respuesta)." });
  }
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 429 || j.code === "EXCEED_LIMIT" || j.code === "TOO_FAST") {
    return NextResponse.json({
      encontrado: false,
      error: j.code === "TOO_FAST"
        ? "Demasiadas consultas seguidas. Esperá un minuto y volvé a intentar."
        : "Se alcanzó el límite gratuito de consultas de hoy. Cargá marca y modelo a mano: quedan guardados para la próxima.",
    });
  }
  const item = j.items?.[0];
  if (!r.ok || !item) return NextResponse.json({ encontrado: false });

  const p = interpretar(ean, item);
  const categoria_id = categorias?.find((c) => c.nombre === p.categoria)?.id ?? null;
  const producto = {
    ean, titulo: p.titulo, marca: p.marca, modelo: p.modelo, categoria_id,
    descripcion: p.descripcion, imagen: p.imagen, fuente: "upcitemdb",
  };
  await supabase.from("inv_productos").upsert(producto);
  return NextResponse.json({ encontrado: true, origen: "upcitemdb", producto });
}
