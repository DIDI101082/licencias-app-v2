"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { claseCodigo } from "@/lib/inventario";
import { exportarExcel } from "@/lib/excel";

// Equipos que existen en Active Directory o en el Inventario IT pero no reportan con el agente.
// Se comparan por nombre de equipo (hostname) y, para el inventario, también por vínculo o N° de serie.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fila = Record<string, any>;
type Faltante = {
  nombre: string;
  enAd: boolean;
  so: string | null;
  ultimoLogon: string | null;
  equipo: { id: string; codigo: string; categoria: string | null; empleado: string | null; estado: string } | null;
};

const DIAS_ACTIVO = 60;
const ESTADOS_FUERA = ["dado_de_baja", "perdido"];
const CATEGORIAS_CON_AGENTE = /notebook|laptop|pc|escritorio|desktop|workstation|servidor|server/i;

// "NWKS0001.accusys.local" o "nwks0001" → "NWKS0001"
const clave = (n?: string | null) => (n ?? "").trim().split(".")[0].toUpperCase();

// Tipo de equipo: por la categoría del inventario; si solo figura en AD, por el sistema operativo
// (AD no distingue notebook de PC de escritorio: se informa como "puesto de trabajo").
type TipoFaltante = "notebook" | "pc" | "servidor" | "puesto";
const TIPO_TXT: Record<TipoFaltante, string> = {
  notebook: "Notebook", pc: "PC de escritorio", servidor: "Servidor", puesto: "Puesto de trabajo (solo en AD)",
};
function tipoDe(f: Faltante): TipoFaltante {
  const c = f.equipo?.categoria ?? "";
  if (/notebook|laptop/i.test(c)) return "notebook";
  if (/servidor|server/i.test(c)) return "servidor";
  if (f.equipo) return "pc";
  return /server/i.test(f.so ?? "") ? "servidor" : "puesto";
}

function haceDias(v: string | null) {
  if (!v) return "nunca";
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
  return d < 1 ? "hoy" : d === 1 ? "hace 1 día" : `hace ${d} días`;
}

export default function EquiposSinAgente() {
  const [disp, setDisp] = useState<Fila[] | null>(null);
  const [ad, setAd] = useState<Fila[]>([]);
  const [hayAd, setHayAd] = useState(false);
  const [inv, setInv] = useState<Fila[]>([]);
  const [verInactivos, setVerInactivos] = useState(false);
  const [tipo, setTipo] = useState<"" | "notebooks" | "servidor">("");

  useEffect(() => {
    const sb = createClient();
    Promise.all([
      sb.from("inv_dispositivos").select("hostname, equipo_id, numero_serie"),
      sb.from("ad_equipos").select("nombre, so, habilitado, ultimo_logon, es_dc"),
      sb.from("inv_v_equipos").select("id, codigo, hostname, categoria, grupo, estado, empleado, numero_serie"),
    ]).then(([d, a, e]) => {
      setDisp(d.data ?? []);
      // Sin el puente AD (o sin permiso de Seguridad) se usa solo el inventario
      setHayAd(!a.error && (a.data?.length ?? 0) > 0);
      setAd(a.error ? [] : a.data ?? []);
      setInv(e.data ?? []);
    });
  }, []);

  const { faltantes, inactivos } = useMemo(() => {
    if (!disp) return { faltantes: [] as Faltante[], inactivos: 0 };
    const conAgente = new Set(disp.map((d) => clave(d.hostname)));
    const vinculados = new Set(disp.map((d) => d.equipo_id).filter(Boolean));
    const series = new Set(disp.map((d) => (d.numero_serie ?? "").toUpperCase()).filter(Boolean));

    const m = new Map<string, Faltante>();
    const limite = Date.now() - DIAS_ACTIVO * 86400000;
    let inactivos = 0;

    // Active Directory: computadoras habilitadas (sin los controladores de dominio)
    ad.filter((x) => x.habilitado && !x.es_dc).forEach((x) => {
      const k = clave(x.nombre);
      if (!k || conAgente.has(k)) return;
      const activo = x.ultimo_logon && new Date(x.ultimo_logon).getTime() >= limite;
      if (!activo) { inactivos++; if (!verInactivos) return; }
      m.set(k, { nombre: k, enAd: true, so: x.so, ultimoLogon: x.ultimo_logon, equipo: null });
    });

    // Inventario IT: notebooks, PCs y servidores en uso o en stock
    inv.filter((e) => e.grupo !== "Periféricos" && CATEGORIAS_CON_AGENTE.test(e.categoria ?? "") && !ESTADOS_FUERA.includes(e.estado))
      .forEach((e) => {
        if (vinculados.has(e.id)) return;
        if (e.numero_serie && series.has(String(e.numero_serie).toUpperCase())) return;
        const k = clave(e.hostname) || e.codigo;
        if (conAgente.has(clave(e.hostname))) return;
        const equipo = { id: e.id, codigo: e.codigo, categoria: e.categoria, empleado: e.empleado, estado: e.estado };
        const previo = m.get(k);
        if (previo) previo.equipo = equipo;
        else m.set(k, { nombre: e.hostname ? k : e.codigo, enAd: false, so: null, ultimoLogon: null, equipo });
      });

    const faltantes = Array.from(m.values()).sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
    return { faltantes, inactivos };
  }, [disp, ad, inv, verInactivos]);

  if (!disp) return null;

  // "Notebooks" incluye los puestos que solo figuran en AD: pueden ser notebooks sin cargar en el inventario
  const visibles = faltantes.filter((f) => {
    const t = tipoDe(f);
    return !tipo || (tipo === "servidor" ? t === "servidor" : t === "notebook" || t === "puesto");
  });
  const exportar = () =>
    exportarExcel(
      `equipos-sin-agente${tipo ? `-${tipo}` : ""}-${new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })}`,
      ["Equipo", "Tipo", "Código de inventario", "En Active Directory", "En Inventario", "Sistema", "Último inicio de sesión (AD)", "Asignado a", "Estado en inventario"],
      visibles.map((f) => [
        f.nombre, TIPO_TXT[tipoDe(f)], f.equipo?.codigo ?? "", f.enAd ? "Sí" : "No", f.equipo ? "Sí" : "No",
        f.so?.replace("Microsoft ", "") ?? "",
        f.ultimoLogon ? new Date(f.ultimoLogon).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : f.enAd ? "Nunca" : "",
        f.equipo?.empleado ?? (f.equipo ? "Sin asignar" : ""), f.equipo?.estado ?? "",
      ]),
      { Equipo: 22, Tipo: 30, Sistema: 30, "Asignado a": 28 },
    );

  return (
    <details className="card p-4">
      <summary className="cursor-pointer text-sm font-medium text-ink">
        Equipos sin el agente instalado ({faltantes.length})
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-ink/60">
          Equipos que figuran {hayAd ? "en Active Directory o " : ""}en el Inventario IT pero no reportan con el agente.
          {hayAd ? ` De Active Directory se toman las computadoras habilitadas que iniciaron sesión en los últimos ${DIAS_ACTIVO} días.` : " Conectá el puente de Active Directory para cruzar también con las computadoras del dominio."}
        </p>
        {hayAd && inactivos > 0 && (
          <label className="flex items-center gap-2 text-sm text-ink/70">
            <input type="checkbox" checked={verInactivos} onChange={(e) => setVerInactivos(e.target.checked)} />
            Incluir {inactivos} {inactivos === 1 ? "computadora" : "computadoras"} de AD sin actividad hace más de {DIAS_ACTIVO} días
          </label>
        )}
        {faltantes.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <select className="input w-auto" value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)} aria-label="Tipo de equipo">
              <option value="">Todos los equipos ({faltantes.length})</option>
              <option value="notebooks">Notebooks y puestos de trabajo</option>
              <option value="servidor">Servidores</option>
            </select>
            <button className="btn-secondary" onClick={exportar} disabled={visibles.length === 0}>Exportar a Excel ({visibles.length})</button>
          </div>
        )}
        {faltantes.length === 0 ? (
          <p className="text-sm text-emerald-700">Todos los equipos conocidos tienen el agente instalado.</p>
        ) : visibles.length === 0 ? (
          <p className="text-sm text-ink/50">Ningún equipo de ese tipo sin el agente.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data w-full">
              <thead><tr><th>Equipo</th><th>Tipo</th><th>Dónde figura</th><th>Sistema</th><th>Último inicio de sesión (AD)</th><th>Asignado a</th></tr></thead>
              <tbody>
                {visibles.map((f) => (
                  <tr key={f.nombre}>
                    <td>
                      <span className="font-medium text-ink">{f.nombre}</span>
                      {f.equipo && <Link href={`/inventario/equipos/${f.equipo.id}`} className={`${claseCodigo(f.equipo.codigo)} ml-2`}>{f.equipo.codigo}</Link>}
                    </td>
                    <td className="text-ink/70 whitespace-nowrap">{TIPO_TXT[tipoDe(f)]}</td>
                    <td className="whitespace-nowrap">
                      {f.enAd && <span className="pill bg-line/[0.05] text-ink/60 mr-1">Active Directory</span>}
                      {f.equipo && <span className="pill bg-line/[0.05] text-ink/60">Inventario{f.equipo.categoria ? ` · ${f.equipo.categoria}` : ""}</span>}
                    </td>
                    <td className="text-ink/70">{f.so?.replace("Microsoft ", "") ?? "—"}</td>
                    <td className="text-ink/60 whitespace-nowrap">{f.enAd ? haceDias(f.ultimoLogon) : "—"}</td>
                    <td className="text-ink/70">{f.equipo?.empleado ?? (f.equipo ? "Sin asignar" : "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-ink/50">
          Para instalarlo: <Link href="/inventario/monitoreo/agente" className="text-brand-600 hover:underline">Instalar agente</Link>.
          Un equipo recién instalado aparece primero en “Pendientes de aprobación”.
        </p>
      </div>
    </details>
  );
}
