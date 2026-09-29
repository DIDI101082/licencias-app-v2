// Indicadores de postura de seguridad con meta. Los usan Cumplimiento, Normativa (como evidencia
// automática de cada control) y el Informe mensual. Se calculan en el navegador con los permisos de quien mira.
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluar, adminsExtra } from "./seguridad";
import { soporteWindows } from "./riesgos";

export type Kpi = {
  clave: string; area: string; titulo: string; valor: number | null; meta: number; unidad: "%" | "n";
  menorEsMejor?: boolean; detalle?: string; enlace: string; sinDatos?: string;
};
export type Nivel = "ok" | "aviso" | "mal" | "nd";

export function nivel(k: Pick<Kpi, "valor" | "meta" | "menorEsMejor">): Nivel {
  if (k.valor == null) return "nd";
  if (k.menorEsMejor) return k.valor <= k.meta ? "ok" : k.valor <= k.meta + Math.max(1, Math.ceil(k.meta * 0.5 + 1)) ? "aviso" : "mal";
  return k.valor >= k.meta ? "ok" : k.valor >= k.meta - 15 ? "aviso" : "mal";
}
const porc = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

export async function calcularIndicadores(sb: SupabaseClient): Promise<Kpi[]> {
      const hace = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
      const hoy = new Date().toISOString().slice(0, 10);
      const en30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      // Cada consulta es independiente: si un módulo no está instalado, su indicador queda "sin datos"
      const q = async (p: PromiseLike<{ data: any; error: any }>) => { try { const r = await p; return r.error ? null : r.data; } catch { return null; } };
      const [disp, perm, ident, vuln, inc, alertas, backups, bcfg, caps, venc, bajas, ss, correo, sup] = await Promise.all([
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
        q(sb.from("ss_historial").select("actual, maximo").order("fecha", { ascending: false }).limit(1)),
        q(sb.from("correo_estado").select("dominio, hallazgos, error")),
        q(sb.from("sup_puertos").select("puerto").eq("abierto", true).eq("esperado", false)),
      ]);

      const k: Kpi[] = [];
      // --- Equipos ---
      const lista: any[] = (disp ?? []).filter((d: any) => d.seguridad_actualizado && new Date(d.ultimo_reporte) > new Date(hace(30)));
      const permitidos: string[] = (perm as string[] | null) ?? [];
      const ev = lista.map((d) => evaluar(d, permitidos));
      const pctCtl = (c: "bitlocker" | "parches" | "antivirus" | "firewall") => porc(ev.filter((e) => e[c].nivel === "ok").length, ev.filter((e) => e[c].nivel !== "sin_datos").length);
      k.push({ area: "Equipos", clave: "cifrado", titulo: "Discos cifrados", valor: disp ? pctCtl("bitlocker") : null, meta: 100, unidad: "%", enlace: "/inventario/seguridad", detalle: `${ev.length} equipos que reportaron en 30 días` });
      k.push({ area: "Equipos", clave: "antivirus", titulo: "Antivirus activo y actualizado", valor: disp ? pctCtl("antivirus") : null, meta: 100, unidad: "%", enlace: "/inventario/seguridad" });
      k.push({ area: "Equipos", clave: "parches", titulo: "Parches al día", valor: disp ? pctCtl("parches") : null, meta: 95, unidad: "%", enlace: "/inventario/seguridad" });
      k.push({ area: "Equipos", clave: "firewall", titulo: "Firewall encendido", valor: disp ? pctCtl("firewall") : null, meta: 100, unidad: "%", enlace: "/inventario/seguridad" });
      const so = lista.map((d) => soporteWindows(d.so_nombre, d.so_version, d.so_build)).filter((s) => s.nivel !== "sin_datos");
      k.push({ area: "Equipos", clave: "so_soporte", titulo: "Sistema operativo con soporte", valor: disp ? porc(so.filter((s) => s.nivel !== "problema").length, so.length) : null, meta: 100, unidad: "%", enlace: "/inventario/riesgos?vista=sistemas" });
      k.push({ area: "Equipos", clave: "admins_locales", titulo: "Equipos con admins locales no permitidos", valor: disp ? lista.filter((d) => adminsExtra(d.admins_locales, permitidos).length > 0).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/seguridad" });

      // --- Identidad ---
      const id = (ident as any[] | null)?.[0];
      k.push({ area: "Identidad", clave: "mfa", titulo: "Cuentas con MFA", valor: id && id.sin_mfa != null ? porc(id.miembros - id.sin_mfa, id.miembros) : null, meta: 100, unidad: "%", enlace: "/inventario/identidad", sinDatos: "Abrí Identidad para actualizar (requiere Entra ID P1)" });
      k.push({ area: "Identidad", clave: "admins_sin_mfa", titulo: "Administradores sin MFA", valor: id?.admins_sin_mfa ?? null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/identidad" });
      k.push({ area: "Identidad", clave: "cuentas_inactivas", titulo: "Cuentas habilitadas sin uso", valor: id?.inactivos ?? null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/identidad", detalle: id ? `más de ${id.dias_inactivo} días` : undefined });
      k.push({ area: "Identidad", clave: "bajas_pendientes", titulo: "Bajas sin cerrar (+7 días)", valor: bajas ? (bajas as any[]).filter((b) => b.fecha <= hace(7).slice(0, 10)).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/empleados/movimientos" });

      // --- Vulnerabilidades y respuesta ---
      const v = (vuln as any[] | null) ?? null;
      k.push({ area: "Vulnerabilidades", clave: "kev", titulo: "Versiones con vulnerabilidades explotadas (KEV)", valor: v ? v.filter((x) => (x.kev ?? 0) > 0).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/vulnerabilidades" });
      k.push({ area: "Vulnerabilidades", clave: "alertas_graves", titulo: "Alertas críticas o altas abiertas", valor: alertas ? (alertas as any[]).filter((a) => a.severidad === "critica" || a.severidad === "alta").length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/auditoria/alertas" });
      const incs = (inc as any[] | null) ?? null;
      k.push({ area: "Vulnerabilidades", clave: "incidentes_abiertos", titulo: "Incidentes abiertos", valor: incs ? incs.filter((i) => i.estado !== "cerrado").length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/incidentes",
        detalle: incs ? `${incs.filter((i) => i.detectado >= hace(30)).length} registrados en los últimos 30 días` : undefined });

      // --- Continuidad ---
      const bj = (backups as any[] | null) ?? null;
      const limite = (bcfg as any)?.horas_max_sin_exito ?? 26;
      const bOk = bj ? bj.filter((b) => b.ultimo_resultado !== "Failed" && b.ultimo_exito && Date.now() - Date.parse(b.ultimo_exito) < limite * 3600000).length : 0;
      k.push({ area: "Continuidad", clave: "backups", titulo: "Trabajos de backup al día", valor: bj && bj.length ? porc(bOk, bj.length) : null, meta: 100, unidad: "%", enlace: "/inventario/backups", sinDatos: "Conectá Veeam en Seguridad → Backups" });
      k.push({ area: "Continuidad", clave: "vencimientos", titulo: "Vencimientos en los próximos 30 días", valor: venc ? (venc as any[]).filter((x) => x.fecha_vencimiento >= hoy).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/vencimientos",
        detalle: venc ? `${(venc as any[]).filter((x) => x.fecha_vencimiento < hoy).length} ya vencidos` : undefined });

      // --- Personas ---
      const cs = (caps as any[] | null) ?? null;
      k.push({ area: "Personas", clave: "capacitacion", titulo: "Empleados con capacitación al día", valor: cs && cs.length ? porc(cs.filter((c) => c.estado === "al_dia").length, cs.length) : null, meta: 90, unidad: "%", enlace: "/inventario/concientizacion", sinDatos: "Registrá capacitaciones en Concientización" });

      // --- Nube, correo y perímetro ---
      const s0 = (ss as any[] | null)?.[0];
      k.push({ clave: "securescore", area: "Nube y perímetro", titulo: "Secure Score de Microsoft 365", valor: s0 && s0.maximo ? Math.round((100 * s0.actual) / s0.maximo) : null, meta: 70, unidad: "%", enlace: "/inventario/securescore", sinDatos: "Configurá las verificaciones diarias" });
      const dom = ((correo as any[] | null) ?? []).filter((d) => !d.error);
      k.push({ clave: "correo", area: "Nube y perímetro", titulo: "Dominios con correo bien protegido", valor: correo && dom.length ? porc(dom.filter((d) => !(d.hallazgos ?? []).some((h: any) => h.severidad === "alta")).length, dom.length) : null, meta: 100, unidad: "%", enlace: "/inventario/correo", detalle: dom.length ? `${dom.length} dominio(s): SPF, DKIM y DMARC` : undefined, sinDatos: "Cargá los dominios en Correo y dominio" });
      k.push({ clave: "superficie", area: "Nube y perímetro", titulo: "Puertos expuestos sin justificar", valor: sup ? (sup as any[]).length : null, meta: 0, unidad: "n", menorEsMejor: true, enlace: "/inventario/superficie" });
      return k;

}
