"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SECCION, campo, valor, CAMPOS_OCULTOS_ALTA } from "@/lib/auditoria";

type Registro = {
  id: number; fecha: string; usuario_email: string | null; usuario_nombre: string | null; ip: string | null;
  tabla: string; accion: "alta" | "modificacion" | "baja"; registro_id: string | null; descripcion: string | null; cambios: Record<string, any>;
};

const ACCION = {
  alta: { texto: "Alta", clase: "bg-emerald-50 text-emerald-700" },
  modificacion: { texto: "Modificación", clase: "bg-brand-50 text-brand-700" },
  baja: { texto: "Baja", clase: "bg-red-50 text-red-600" },
};
const PAGINA = 200;
const fechaHora = (f: string) => new Date(f).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "medium" });

function Detalle({ r }: { r: Registro }) {
  const entradas = Object.entries(r.cambios ?? {});
  if (r.accion === "modificacion") {
    return (
      <ul className="space-y-0.5">
        {entradas.map(([k, v]) => (
          <li key={k}>
            <span className="text-ink/50">{campo(k)}:</span>{" "}
            <span className="line-through text-ink/40">{valor(v?.antes)}</span> → <b className="text-ink font-medium">{valor(v?.despues)}</b>
          </li>
        ))}
      </ul>
    );
  }
  const utiles = entradas.filter(([k, v]) => !CAMPOS_OCULTOS_ALTA.has(k) && v !== null && v !== "" && !(Array.isArray(v) && !v.length));
  return (
    <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-0.5">
      {utiles.map(([k, v]) => <li key={k} className="truncate"><span className="text-ink/50">{campo(k)}:</span> {valor(v)}</li>)}
    </ul>
  );
}

export default function Auditoria() {
  const [filas, setFilas] = useState<Registro[]>([]);
  const [cargando, setCargando] = useState(true);
  const [hayMas, setHayMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dias, setDias] = useState(7);
  const [usuario, setUsuario] = useState("");
  const [seccion, setSeccion] = useState("");
  const [accion, setAccion] = useState("");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState<number | null>(null);

  const consultar = async (desdeId?: number) => {
    setCargando(true);
    let c = createClient().from("auditoria").select("*")
      .gte("fecha", new Date(Date.now() - dias * 86400000).toISOString())
      .order("id", { ascending: false }).limit(PAGINA);
    if (usuario) c = c.eq("usuario_email", usuario);
    if (seccion) c = c.eq("tabla", seccion);
    if (accion) c = c.eq("accion", accion);
    if (desdeId) c = c.lt("id", desdeId);
    const { data, error } = await c;
    setCargando(false);
    if (error) return setError(error.message.includes("auditoria") ? "Falta ejecutar auditoria.sql en Supabase." : error.message);
    const nuevas = (data ?? []) as Registro[];
    setFilas((f) => (desdeId ? [...f, ...nuevas] : nuevas));
    setHayMas(nuevas.length === PAGINA);
  };
  useEffect(() => { consultar(); }, [dias, usuario, seccion, accion]);

  const [usuarios, setUsuarios] = useState<string[]>([]);
  useEffect(() => {
    createClient().from("perfiles").select("email").order("email")
      .then(({ data }) => setUsuarios((data ?? []).map((p: any) => p.email)));
  }, []);

  const visibles = useMemo(() => {
    const q = texto.trim().toLowerCase();
    if (!q) return filas;
    return filas.filter((r) => [r.descripcion, r.usuario_email, r.usuario_nombre, SECCION[r.tabla], JSON.stringify(r.cambios)]
      .some((v) => v?.toLowerCase().includes(q)));
  }, [filas, texto]);

  async function exportar() {
    const writeExcelFile = (await import("write-excel-file/browser")).default;
    const cab = ["Fecha", "Usuario", "IP", "Acción", "Sección", "Registro", "Detalle"];
    const det = (r: Registro) => r.accion === "modificacion"
      ? Object.entries(r.cambios ?? {}).map(([k, v]: any) => `${campo(k)}: ${valor(v?.antes)} → ${valor(v?.despues)}`).join(" | ")
      : Object.entries(r.cambios ?? {}).filter(([k]) => !CAMPOS_OCULTOS_ALTA.has(k)).map(([k, v]) => `${campo(k)}: ${valor(v)}`).join(" | ");
    await writeExcelFile([
      cab.map((t) => ({ value: t, fontWeight: "bold" as const })),
      ...visibles.map((r) => [fechaHora(r.fecha), r.usuario_email ?? "", r.ip ?? "", ACCION[r.accion].texto, SECCION[r.tabla] ?? r.tabla, r.descripcion ?? "", det(r)].map((v) => ({ value: v }))),
    ], { columns: [{ width: 20 }, { width: 32 }, { width: 16 }, { width: 14 }, { width: 24 }, { width: 36 }, { width: 90 }] })
      .toFile(`logs-cambios-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Registro de cambios</h1>
          <p className="text-ink/60 text-sm mt-1">
            Qué modificó cada persona en la app. Se registra automáticamente y no se puede editar ni borrar.
          </p>
        </div>
        <button className="btn-secondary" onClick={exportar} disabled={!visibles.length}>Exportar a Excel</button>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <select className="input w-auto" value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Período">
          <option value={1}>Últimas 24 horas</option><option value={7}>Últimos 7 días</option>
          <option value={30}>Últimos 30 días</option><option value={90}>Últimos 90 días</option><option value={365}>Último año</option>
        </select>
        <select className="input w-auto" value={usuario} onChange={(e) => setUsuario(e.target.value)} aria-label="Usuario">
          <option value="">Todas las personas</option>
          {Array.from(new Set([...usuarios, ...filas.map((f) => f.usuario_email).filter(Boolean) as string[]])).sort()
            .map((u) => <option key={u}>{u}</option>)}
        </select>
        <select className="input w-auto" value={seccion} onChange={(e) => setSeccion(e.target.value)} aria-label="Sección">
          <option value="">Todas las secciones</option>
          {Object.entries(SECCION).sort((a, b) => a[1].localeCompare(b[1])).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
        <select className="input w-auto" value={accion} onChange={(e) => setAccion(e.target.value)} aria-label="Acción">
          <option value="">Todas las acciones</option><option value="alta">Altas</option><option value="modificacion">Modificaciones</option><option value="baja">Bajas</option>
        </select>
        <input type="search" className="input flex-1 min-w-[200px]" placeholder="Buscar en los resultados" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
      </div>

      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Fecha</th><th>Persona</th><th>Acción</th><th>Sección</th><th>Qué</th></tr></thead>
          <tbody>
            {visibles.map((r) => (
              <Fragment key={r.id}>
                <tr className="cursor-pointer hover:bg-line/[0.02]" onClick={() => setAbierto(abierto === r.id ? null : r.id)} aria-expanded={abierto === r.id}>
                  <td className="whitespace-nowrap text-ink/70 text-sm">{fechaHora(r.fecha)}</td>
                  <td>
                    <span className="text-ink">{r.usuario_nombre && !r.usuario_nombre.includes("@") ? r.usuario_nombre : r.usuario_email}</span>
                    {r.ip && <div className="text-xs text-ink/40 font-mono">{r.ip}</div>}
                  </td>
                  <td><span className={`pill ${ACCION[r.accion].clase}`}>{ACCION[r.accion].texto}</span></td>
                  <td className="text-ink/70 whitespace-nowrap">{SECCION[r.tabla] ?? r.tabla}</td>
                  <td className="text-sm">
                    <span className="text-ink">{r.descripcion ?? "—"}</span>
                    {r.accion === "modificacion" && abierto !== r.id && (
                      <div className="text-xs text-ink/50 truncate max-w-[380px]">
                        {Object.keys(r.cambios ?? {}).map(campo).join(", ")}
                      </div>
                    )}
                  </td>
                </tr>
                {abierto === r.id && (
                  <tr><td colSpan={5} className="bg-canvas text-sm"><Detalle r={r} /></td></tr>
                )}
              </Fragment>
            ))}
            {!cargando && visibles.length === 0 && <tr><td colSpan={5} className="text-center text-ink/40 py-10">Sin cambios registrados en este período.</td></tr>}
          </tbody>
        </table>
      </div>
      {hayMas && <button className="btn-secondary" disabled={cargando} onClick={() => consultar(filas[filas.length - 1]?.id)}>{cargando ? "Cargando…" : "Cargar más"}</button>}
      <p className="text-xs text-ink/50">Tocá una fila para ver el detalle. Los valores secretos (tokens y claves) se muestran como "(oculto)".</p>
    </div>
  );
}
