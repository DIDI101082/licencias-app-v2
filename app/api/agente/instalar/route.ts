import { generarInstalador } from "@/lib/agente";

export const dynamic = "force-dynamic";

// Entrega el instalador del agente (PowerShell) a quien tenga un código de instalación válido.
// Pensado para ESET PROTECT ("Ejecutar comando"): el equipo lo baja y lo ejecuta como SYSTEM.
// El código viaja en la URL (HTTPS); la app solo guarda su huella, y el equipo queda pendiente de aprobación.
export async function GET(req: Request) {
  const codigo = (new URL(req.url).searchParams.get("codigo") ?? "").trim().toLowerCase();
  const sinCache = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (!/^[0-9a-f]{40}$/.test(codigo)) {
    return new Response("Codigo de instalacion invalido.\n", { status: 400, headers: sinCache });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const r = await fetch(`${url}/rest/v1/rpc/inv_instalador_intervalo`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_codigo: codigo }),
    cache: "no-store",
  });
  if (!r.ok) {
    return new Response("No se pudo validar el codigo (falta ejecutar instalacion-eset.sql en Supabase?).\n", { status: 503, headers: sinCache });
  }
  const intervalo = await r.json();
  if (typeof intervalo !== "number") {
    return new Response("Codigo de instalacion vencido, revocado o sin usos disponibles.\n", { status: 403, headers: sinCache });
  }
  // Con BOM: Windows PowerShell 5.1 lee así el archivo como UTF-8
  return new Response("﻿" + generarInstalador(url, anon, codigo, intervalo).replace(/\r?\n/g, "\r\n"), {
    status: 200,
    headers: { ...sinCache, "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="instalar-agente-accusys.ps1"' },
  });
}
