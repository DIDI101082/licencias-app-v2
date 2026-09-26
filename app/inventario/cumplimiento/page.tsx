"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { evaluar, adminsExtra } from "@/lib/seguridad";
import { soporteWindows } from "@/lib/riesgos";

// Un indicador del tablero: valor actual contra una meta
type Kpi = {
  area: string; titulo: string; valor: number | null; meta: number; unidad: "%" | "n";
  menorEsMejor?: boolean; detalle?: string; enlace: string; sinDatos?: string;
};
type Nivel = "ok" | "aviso" | "mal" | "nd";

function nivel(k: Kpi): Nivel {
  if (k.valor == null) return "nd";
  if (k.menorEsMejor) return k.valor <= k.meta ? "ok" : k.valor <= k.meta + Math.max(1, Math.ceil(k.meta * 0.5 + 1)) ? "aviso" : "mal";
  return k.valor >= k.meta ? "ok" : k.valor >= k.meta - 15 ? "aviso" : "mal";
}
const COLOR: Record<Nivel, { borde: string; texto: string; punto: string; etiqueta: string }> = {
  ok: { borde: "border-l-emerald-500", texto: "text-emerald-700", punto: "bg-emerald-500", etiqueta: "Cumple" },
  aviso: { borde: "border-l-amber-400", texto: "text-amber-700", punto: "bg-amber-400", etiqueta: "Cerca" },
  mal: { borde: "border-l-red-500", texto: "text-red-600", punto: "bg-red-500", etiqueta: "No cumple" },
  nd: { borde: "border-l-line/20", texto: "text-ink/40", punto: "bg-line/30", etiqueta: "Sin datos" },
};
const porc = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

export default function Cumplimiento() {
  const [kpis, setKpis] = useState<Kpi[] | null>(null);
  const [fecha] = useState(new Date());

  useEffect(() => {
    (async () => {
      const sb = createClient();
      const hace = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
      const hoy = new Date().toISOString().slice(0, 10);
      const en30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      // Cada consulta es independiente: si un módulo no está instalado, su indicador queda "sin datos"
      const q = async (p: PromiseLike<{ data: any; error: any }>) => { try { const r = await p; return r.error ? null : r.data; } catch { return null; } };
      const [disp, perm, ident, vuln, inc, alertas, backups, bcfg, caps, venc, bajas] = await Promise.all([
        q(sb.from("inv_dispositivos").select("*").eq("estado_registro", "aprobado")),
        q(sb.rpc("inv_admins_permitidos")),
        q(sb.from("identidad_resumen").select("*").order("fecha", { ascending: false }).limit(1)),
        q(sb.from("vuln_v_resumen").select("kev, criticas, equipos")),
        q(sb.from("incidentes_v").select("estado, severidad, detectado, cerrado")),
        q(sb.from("alertas").select("severidad").is("resuelta", null)),
        q(sb.from("backups_trabajos").select("*").eq("habilitado", true).eq("ignorar", false)),
        q(sb.rpc("backups_estado")),
        q(sb.from("capacitaciones_v_estado").select("estado")),
        q(sb.from("vencimientos_v").select("fecha_vencimiento").lte("fecha_vencimiento", en30)),
        q(sb.from("empleados_v_movimientos").select("fecha").eq("tipo", "baja").eq("estado", "abierto")),
      ]);

      const k: Kpi[] = [];
      // --- Equipos ---
      const lista: any[] = (disp ?? []).filter((d: any) => d.seguridad_actualizado && new Date(d.ultimo_reporte) > new Date(hace(30)));
      const permitidos: string[] = (perm as string[] | null) ?? [];
      const ev = lista.map((d) => evaluar(d, permitidos));
      const pctCtl = (c: "bitlocker" | "parches" | "antivirus" | "firewall") => porc(ev.filter((e) => e[c].nivel === "ok").length, ev.filter((e) => e[c].nivel !== "sin_datos").length);
      k.push({ area: "Equipos", titulo: "Discos cifrados", valor: disp ? pctCtl("bitlocker") : null, meta: 100, unidad: "%", enlace: "/inventario/seguridad", detalle: `${ev.length} equipos que reportaron en 30 días` });
      k.push({ area: "Equipos", titulo: "Antivirus activo y actualizado", valor: disp ? pctCtl("antivirus") : null, meta: 100, unidad: "%", enlace: "/inventario/seguridad" });
      k.push({ area: "Equipos", titulo: "Parches al día", valor: disp ? pctCtl("parches") : null, meta: 95, unidad: "%", enlace: "/inventario/seguridad" });
      k.push({ area: "Equipos", titulo: "Firewall encendido", valor: disp ? pctCtl("firewall") : null, meta: 100, unidad: "%", enlace: "/inventario/seguridad" });
      const so = lista.map((d) => soporteWindows(d.so_nombre, d.so_version, d.so_build)).filter((s) => s.nivel !== "sin_datos");
      k.push({ area: "Equipos", titulo: "Sistema operativo con soporte", valor: disp ? porc(so.filter((s) => s.nivel !== "problema").length, so.length) : null, meta: 100, unidad: "%", enlace: "/inventario/riesgos?vista=sistemas" });
      k.push({ area: "Equipos", titulo: "Equipos con admins locales no permitidos", valor: disp ? lista.filter((d) => adminsExtra(d.admins_locales, permitidos).length > 0).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/seguridad" });

      // --- Identidad ---
      const id = (ident as any[] | null)?.[0];
      k.push({ area: "Identidad", titulo: "Cuentas con MFA", valor: id && id.sin_mfa != null ? porc(id.miembros - id.sin_mfa, id.miembros) : null, meta: 100, unidad: "%", enlace: "/inventario/identidad", sinDatos: "Abrí Identidad para actualizar (requiere Entra ID P1)" });
      k.push({ area: "Identidad", titulo: "Administradores sin MFA", valor: id?.admins_sin_mfa ?? null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/identidad" });
      k.push({ area: "Identidad", titulo: "Cuentas habilitadas sin uso", valor: id?.inactivos ?? null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/identidad", detalle: id ? `más de ${id.dias_inactivo} días` : undefined });
      k.push({ area: "Identidad", titulo: "Bajas sin cerrar (+7 días)", valor: bajas ? (bajas as any[]).filter((b) => b.fecha <= hace(7).slice(0, 10)).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/empleados/movimientos" });

      // --- Vulnerabilidades y respuesta ---
      const v = (vuln as any[] | null) ?? null;
      k.push({ area: "Vulnerabilidades", titulo: "Versiones con vulnerabilidades explotadas (KEV)", valor: v ? v.filter((x) => (x.kev ?? 0) > 0).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/vulnerabilidades" });
      k.push({ area: "Vulnerabilidades", titulo: "Alertas críticas o altas abiertas", valor: alertas ? (alertas as any[]).filter((a) => a.severidad === "critica" || a.severidad === "alta").length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/auditoria/alertas" });
      const incs = (inc as any[] | null) ?? null;
      k.push({ area: "Vulnerabilidades", titulo: "Incidentes abiertos", valor: incs ? incs.filter((i) => i.estado !== "cerrado").length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/incidentes",
        detalle: incs ? `${incs.filter((i) => i.detectado >= hace(30)).length} registrados en los últimos 30 días` : undefined });

      // --- Continuidad ---
      const bj = (backups as any[] | null) ?? null;
      const limite = (bcfg as any)?.horas_max_sin_exito ?? 26;
      const bOk = bj ? bj.filter((b) => b.ultimo_resultado !== "Failed" && b.ultimo_exito && Date.now() - Date.parse(b.ultimo_exito) < limite * 3600000).length : 0;
      k.push({ area: "Continuidad", titulo: "Trabajos de backup al día", valor: bj && bj.length ? porc(bOk, bj.length) : null, meta: 100, unidad: "%", enlace: "/inventario/backups", sinDatos: "Conectá Veeam en Seguridad → Backups" });
      k.push({ area: "Continuidad", titulo: "Vencimientos en los próximos 30 días", valor: venc ? (venc as any[]).filter((x) => x.fecha_vencimiento >= hoy).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/vencimientos",
        detalle: venc ? `${(venc as any[]).filter((x) => x.fecha_vencimiento < hoy).length} ya vencidos` : undefined });

      // --- Personas ---
      const cs = (caps as any[] | null) ?? null;
      k.push({ area: "Personas", titulo: "Empleados con capacitación al día", valor: cs && cs.length ? porc(cs.filter((c) => c.estado === "al_dia").length, cs.length) : null, meta: 90, unidad: "%", enlace: "/inventario/concientizacion", sinDatos: "Registrá capacitaciones en Concientización" });

      setKpis(k);
    })();
  }, []);

  const areas = kpis ? Array.from(new Set(kpis.map((k) => k.area))) : [];
  const medidos = (kpis ?? []).filter((k) => nivel(k) !== "nd");
  const puntaje = medidos.length ? Math.round((medidos.filter((k) => nivel(k) === "ok").length / medidos.length) * 100) : null;
  const fechaTxt = fecha.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "long", timeStyle: "short" });

  return (
    <div className="space-y-5">
      <style>{`@media print {
        @page { size: A4; margin: 14mm; }
        body { background: #fff !important; }
        .card { break-inside: avoid; box-shadow: none !important; border: 1px solid #ddd !important; }
        a { color: inherit !important; text-decoration: none !important; }
      }`}</style>

      <div className="hidden print:block border-b pb-3 mb-2">
        <div className="text-xs uppercase tracking-wide text-ink/50">Accusys Technology · Ciberseguridad y Tecnología</div>
        <div className="font-display text-2xl text-ink">Reporte de cumplimiento de seguridad</div>
        <div className="text-sm text-ink/60">{fechaTxt}</div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="font-display text-2xl text-ink">Cumplimiento</h1>
          <p className="text-ink/60 text-sm mt-1">
            Resumen de la postura de seguridad en indicadores con meta, para gerencia o auditorías de clientes.
            Se calcula en el momento con los datos de todos los módulos.
          </p>
        </div>
        <button className="btn-primary" onClick={() => window.print()} disabled={!kpis}>Exportar PDF</button>
      </div>

      {!kpis ? <p className="text-sm text-ink/50">Calculando…</p> : (
        <>
          <div className="grid md:grid-cols-3 gap-3">
            <div className="card p-5">
              <div className="text-xs text-ink/50">Indicadores que cumplen la meta</div>
              <div className={`font-display text-5xl mt-1 ${puntaje == null ? "text-ink/30" : puntaje >= 80 ? "text-emerald-700" : puntaje >= 60 ? "text-amber-600" : "text-red-600"}`}>{puntaje == null ? "—" : `${puntaje}%`}</div>
              <div className="text-xs text-ink/50 mt-1">{medidos.filter((k) => nivel(k) === "ok").length} de {medidos.length} medidos{kpis.length > medidos.length ? ` · ${kpis.length - medidos.length} sin datos` : ""}</div>
            </div>
            <div className="card p-5 md:col-span-2">
              <div className="text-xs text-ink/50 mb-2">A resolver primero</div>
              {kpis.filter((k) => nivel(k) === "mal").length === 0 ? <p className="text-sm text-emerald-700">Ningún indicador está fuera de meta.</p> : (
                <ul className="space-y-1 text-sm">
                  {kpis.filter((k) => nivel(k) === "mal").map((k) => (
                    <li key={k.titulo} className="flex gap-2"><span className="text-red-600">●</span>
                      <Link href={k.enlace} className="text-ink hover:text-brand-700">{k.titulo}: <b>{k.valor}{k.unidad === "%" ? "%" : ""}</b> <span className="text-ink/50">(meta {k.menorEsMejor ? "≤ " : "≥ "}{k.meta}{k.unidad === "%" ? "%" : ""})</span></Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {areas.map((a) => (
            <div key={a}>
              <h2 className="font-display text-lg text-ink mb-2">{a}</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {kpis.filter((k) => k.area === a).map((k) => {
                  const n = nivel(k);
                  return (
                    <Link key={k.titulo} href={k.enlace} className={`card p-4 border-l-4 ${COLOR[n].borde} hover:ring-1 hover:ring-line/20`}>
                      <div className="flex justify-between gap-2">
                        <div className="text-sm text-ink/80">{k.titulo}</div>
                        <span className={`text-xs whitespace-nowrap ${COLOR[n].texto}`}>{COLOR[n].etiqueta}</span>
                      </div>
                      <div className={`font-display text-3xl mt-1 ${COLOR[n].texto}`}>{k.valor == null ? "—" : `${k.valor}${k.unidad === "%" ? "%" : ""}`}</div>
                      <div className="text-xs text-ink/50 mt-1">
                        Meta: {k.menorEsMejor ? (k.meta === 0 ? "ninguno" : `≤ ${k.meta}`) : `≥ ${k.meta}${k.unidad === "%" ? "%" : ""}`}
                        {k.valor == null && k.sinDatos ? ` · ${k.sinDatos}` : k.detalle ? ` · ${k.detalle}` : ""}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-xs text-ink/40">
            Metas sugeridas según buenas prácticas (CIS Controls / ISO 27001); ajustalas en <code>app/inventario/cumplimiento/page.tsx</code> si tu política define otras.
            Generado el {fechaTxt}.
          </p>
        </>
      )}
    </div>
  );
}
