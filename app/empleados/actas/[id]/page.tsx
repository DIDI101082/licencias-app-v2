"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import Mark from "@/components/Mark";

type Acta = {
  id: number; numero: number; empleado_id: string; tipo: "entrega" | "devolucion"; fecha: string;
  empleado: { nombre: string; email: string; area: string | null; puesto: string | null };
  equipos: { codigo: string; categoria: string | null; marca: string | null; modelo: string | null; numero_serie: string | null; condicion: string | null }[];
  observaciones: string | null; generado_por_nombre: string | null;
};

const CONDICION: Record<string, string> = { nuevo: "Nuevo", bueno: "Bueno", regular: "Regular", malo: "Malo" };

export default function ActaPage({ params }: { params: { id: string } }) {
  const [acta, setActa] = useState<Acta | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    createClient().from("empleados_actas").select("*").eq("id", params.id).maybeSingle()
      .then(({ data }) => (data ? setActa(data as Acta) : setError(true)));
  }, [params.id]);

  if (error) return <p className="text-sm text-ink/60">No se encontró el acta o no tenés permiso para verla.</p>;
  if (!acta) return <p className="text-sm text-ink/50">Cargando…</p>;

  const entrega = acta.tipo === "entrega";
  const f = new Date(acta.fecha);
  const fechaLarga = f.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center print:hidden">
        <Link href={`/empleados/${acta.empleado_id}`} className="text-sm text-brand-600 hover:underline">← Volver a la ficha</Link>
        <span className="flex-1" />
        <button className="btn-primary" onClick={() => window.print()}>Imprimir / Guardar PDF</button>
      </div>
      <p className="text-xs text-ink/50 print:hidden">Para el PDF, en la ventana de impresión elegí “Guardar como PDF”.</p>

      {/* Hoja A4 */}
      <article className="acta bg-white mx-auto max-w-[800px] p-10 border border-black/10 shadow-sm print:shadow-none print:border-0 print:p-0 text-[13px] leading-relaxed text-black">
        <header className="flex items-start justify-between border-b-2 border-black pb-3">
          <Mark className="h-9" />
          <div className="text-right">
            <div className="font-bold text-base">ACTA DE {entrega ? "ENTREGA" : "DEVOLUCIÓN"} DE EQUIPOS</div>
            <div>N° {String(acta.numero).padStart(5, "0")}</div>
          </div>
        </header>

        <p className="mt-5">
          En la Ciudad de Buenos Aires, a los {fechaLarga}, Accusys Technology {entrega ? "entrega a" : "recibe de"}{" "}
          <b>{acta.empleado.nombre}</b> ({acta.empleado.email}){acta.empleado.area ? `, del área ${acta.empleado.area}` : ""}
          {acta.empleado.puesto ? `, puesto ${acta.empleado.puesto}` : ""}, los siguientes equipos propiedad de la empresa:
        </p>

        <table className="w-full mt-4 border-collapse">
          <thead>
            <tr className="bg-black/[0.06]">
              {["Código", "Equipo", "Marca y modelo", "N° de serie", "Estado"].map((h) => (
                <th key={h} className="border border-black/40 px-2 py-1.5 text-left font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {acta.equipos.map((e) => (
              <tr key={e.codigo}>
                <td className="border border-black/40 px-2 py-1.5 font-mono">{e.codigo}</td>
                <td className="border border-black/40 px-2 py-1.5">{e.categoria ?? "—"}</td>
                <td className="border border-black/40 px-2 py-1.5">{[e.marca, e.modelo].filter(Boolean).join(" ") || "—"}</td>
                <td className="border border-black/40 px-2 py-1.5 font-mono">{e.numero_serie ?? "—"}</td>
                <td className="border border-black/40 px-2 py-1.5">{CONDICION[e.condicion ?? ""] ?? e.condicion ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {acta.observaciones && (
          <p className="mt-4"><b>Observaciones:</b> {acta.observaciones}</p>
        )}

        {entrega ? (
          <div className="mt-5 space-y-2">
            <p>La persona que recibe declara recibir los equipos en el estado indicado y se compromete a:</p>
            <ol className="list-decimal pl-6 space-y-1">
              <li>Usarlos exclusivamente para tareas laborales y cuidarlos de daños, pérdida o robo.</li>
              <li>No desinstalar ni desactivar el antivirus, el cifrado de disco ni el agente de gestión de la empresa.</li>
              <li>No instalar software sin licencia ni software no autorizado por el área de Tecnología.</li>
              <li>Informar de inmediato a Tecnología / Ciberseguridad cualquier pérdida, robo, falla o incidente de seguridad.</li>
              <li>Devolverlos en buen estado, con sus accesorios, al finalizar la relación laboral o cuando la empresa lo solicite.</li>
            </ol>
          </div>
        ) : (
          <p className="mt-5">
            La empresa deja constancia de la recepción de los equipos detallados, en el estado indicado. La revisión técnica
            posterior y el borrado seguro de la información quedan a cargo del área de Tecnología.
          </p>
        )}

        <div className="grid grid-cols-2 gap-12 mt-20">
          {[entrega ? "Recibe (empleado)" : "Entrega (empleado)", entrega ? "Entrega (Tecnología)" : "Recibe (Tecnología)"].map((r) => (
            <div key={r} className="text-center">
              <div className="border-t border-black pt-1">{r}</div>
              <div className="text-left mt-4 space-y-3 text-xs">
                <div>Aclaración: ______________________________</div>
                <div>DNI: ____________________</div>
              </div>
            </div>
          ))}
        </div>

        <footer className="mt-12 pt-2 border-t border-black/20 text-[10px] text-black/50 flex justify-between">
          <span>Generada en Accusys Cyber por {acta.generado_por_nombre ?? "—"}</span>
          <span>{f.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}</span>
        </footer>
      </article>
    </div>
  );
}
