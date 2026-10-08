"use client";

import { useState } from "react";
import EsquemaFisico from "@/components/EsquemaFisico";
import EsquemaSimple from "@/components/EsquemaSimple";

// Mapa de conectividad: el esquema por sede (WAN → FortiGate → core → switches, VMware y antenas) y el detalle boca por boca.
const VISTAS = [
  { id: "simple", titulo: "Esquema", ayuda: "Vista general por sede: los enlaces de Internet que entran al FortiGate, los switches de core y lo que cuelga de ellos." },
  { id: "fisico", titulo: "Detalle por boca", ayuda: "Qué hay conectado en cada switch, boca por boca, con lo que informan los switches (vecinos LLDP/CDP y tabla MAC) y UniFi." },
] as const;

export default function MapaConectividad() {
  const [vista, setVista] = useState<(typeof VISTAS)[number]["id"]>("simple");
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-ink">Mapa de conectividad</h1>
        <p className="text-ink/60 text-sm mt-1">Cómo está conectada la red de cada sede.</p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-line/[0.08] flex-wrap">
        {VISTAS.map((v) => (
          <button key={v.id} role="tab" aria-selected={vista === v.id} onClick={() => setVista(v.id)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${vista === v.id ? "border-brand-600 text-brand-700" : "border-transparent text-ink/60 hover:text-ink"}`}>{v.titulo}</button>
        ))}
      </div>
      <p className="text-sm text-ink/60">{VISTAS.find((v) => v.id === vista)!.ayuda}</p>
      {vista === "simple" ? <EsquemaSimple /> : <EsquemaFisico />}
    </div>
  );
}
