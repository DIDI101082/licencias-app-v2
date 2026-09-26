"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { ATRIBUCION_GEO, bandera, textoUbicacion } from "@/lib/geo";
import { conectado, hace } from "@/lib/monitoreo";

type Hist = { dispositivo_id: string; fecha: string; pais_codigo: string; pais: string | null; region: string; ciudad: string; isp: string | null };
type Alerta = { tipo: "pais" | "proxy" | "ciudad"; nivel: "problema" | "aviso"; texto: string; d: any };

const ZONA = "America/Argentina/Buenos_Aires";
const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: ZONA });
const menosDias = (f: string, n: number) => { const d = new Date(f + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

export default function ConexionesInusuales() {
  const { esAdmin } = usePerfil();
  const [disp, setDisp] = useState<any[]>([]);
  const [hist, setHist] = useState<Hist[]>([]);
  const [permitidos, setPermitidos] = useState<string[]>(["AR"]);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [verConfig, setVerConfig] = useState(false);
  const [clave, setClave] = useState("");
  const [nuevoPais, setNuevoPais] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = () => {
    const sb = createClient();
    Promise.all([
      sb.from("inv_dispositivos").select("id, hostname, usuario, ultimo_reporte, ip_publica, geo_ciudad, geo_region, geo_pais, geo_pais_codigo, geo_isp, geo_es_proxy, geo_actualizado")
        .eq("estado_registro", "aprobado").order("hostname"),
      sb.from("inv_geo_historial").select("dispositivo_id, fecha, pais_codigo, pais, region, ciudad, isp")
        .gte("fecha", menosDias(hoy(), 97)).order("fecha", { ascending: false }).limit(5000),
      sb.rpc("inv_paises_permitidos"),
    ]).then(([d, h, p]) => {
      setDisp(d.data ?? []);
      setHist((h.data ?? []) as Hist[]);
      if (Array.isArray(p.data) && p.data.length) setPermitidos(p.data as string[]);
      if (d.error?.message.includes("geo_")) setAviso("Falta ejecutar geo.sql en Supabase.");
    });
  };
  useEffect(cargar, []);

  const alertas = useMemo(() => {
    const out: Alerta[] = [];
    const corte = menosDias(hoy(), 7);
    for (const d of disp) {
      if (d.geo_pais_codigo && !permitidos.includes(d.geo_pais_codigo)) {
        out.push({ tipo: "pais", nivel: "problema", texto: `Reporta desde ${bandera(d.geo_pais_codigo)} ${d.geo_pais}`, d });
      }
      if (d.geo_es_proxy) out.push({ tipo: "proxy", nivel: "aviso", texto: "La IP figura como proxy o VPN pública", d });
      // Ciudades de los últimos 7 días que no aparecen en los 90 días anteriores (solo si hay historial previo)
      const propio = hist.filter((h) => h.dispositivo_id === d.id);
      const previas = new Set(propio.filter((h) => h.fecha < corte).map((h) => `${h.pais_codigo}|${h.ciudad}`));
      if (previas.size) {
        const nuevas = Array.from(new Set(propio.filter((h) => h.fecha >= corte && !previas.has(`${h.pais_codigo}|${h.ciudad}`) && h.ciudad).map((h) => `${h.ciudad}${h.pais_codigo !== "AR" ? ", " + (h.pais ?? h.pais_codigo) : ""}`)));
        if (nuevas.length) out.push({ tipo: "ciudad", nivel: "aviso", texto: `Ubicación nueva: ${nuevas.join(" · ")}`, d });
      }
    }
    return out.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === "problema" ? -1 : 1));
  }, [disp, hist, permitidos]);

  async function guardarConfig(cambios: Record<string, any>, ok: string) {
    const { error } = await createClient().from("inv_agente_config").update(cambios).eq("id", 1);
    setAviso(error ? error.message : ok);
    cargar();
  }

  const sinUbicacion = disp.filter((d) => !d.geo_actualizado).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-sm text-ink/60 max-w-2xl">
          Ubicación aproximada (ciudad y proveedor de internet) según la IP pública desde la que reporta cada equipo. Alerta cuando un equipo
          reporta desde un país no permitido, desde una IP marcada como proxy, o desde una ciudad donde no se conectó en los últimos 90 días.
        </p>
        {esAdmin && <button className="btn-secondary" onClick={() => setVerConfig(!verConfig)} aria-expanded={verConfig}>Configuración</button>}
      </div>

      {esAdmin && verConfig && (
        <div className="card p-5 space-y-4">
          <div>
            <div className="text-sm font-medium text-ink">Países permitidos</div>
            <p className="text-xs text-ink/50 mb-2">Si alguien viaja por trabajo, agregá el país para que no genere alerta. Código de 2 letras (UY, BR, US, ES…).</p>
            <div className="flex gap-2 flex-wrap items-center">
              {permitidos.map((p) => (
                <span key={p} className="pill bg-line/[0.05] text-ink/80 flex items-center gap-1">
                  {bandera(p)} {p}
                  {permitidos.length > 1 && (
                    <button aria-label={`Quitar ${p}`} className="text-ink/40 hover:text-red-600"
                      onClick={() => guardarConfig({ geo_paises_permitidos: permitidos.filter((x) => x !== p) }, "Países actualizados.")}>×</button>
                  )}
                </span>
              ))}
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const c = nuevoPais.trim().toUpperCase(); if (/^[A-Z]{2}$/.test(c) && !permitidos.includes(c)) { guardarConfig({ geo_paises_permitidos: [...permitidos, c] }, "Países actualizados."); setNuevoPais(""); } }}>
                <input className="input w-20" maxLength={2} placeholder="UY" value={nuevoPais} onChange={(e) => setNuevoPais(e.target.value)} aria-label="Código de país" />
                <button className="btn-secondary">Agregar</button>
              </form>
            </div>
          </div>
          <div>
            <div className="text-sm font-medium text-ink">Clave de IP2Location.io (recomendada)</div>
            <p className="text-xs text-ink/50 mb-2">
              Sin clave el servicio permite 1.000 consultas por día. Con una clave gratuita (registrándose en ip2location.io) son 50.000 por mes.
              La clave queda guardada en la base y solo la leen los administradores.
            </p>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); guardarConfig({ geo_api_key: clave.trim() || null }, "Clave guardada."); setClave(""); }}>
              <input className="input flex-1" type="password" autoComplete="off" placeholder="Pegá la clave" value={clave} onChange={(e) => setClave(e.target.value)} />
              <button className="btn-secondary">Guardar clave</button>
            </form>
          </div>
        </div>
      )}

      {aviso && <p role="status" className="text-sm text-ink/70 bg-line/[0.03] rounded-md px-3 py-2">{aviso}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4"><div className="text-xs text-ink/50">Fuera de países permitidos</div><div className={`font-display text-3xl mt-1 ${alertas.some((a) => a.tipo === "pais") ? "text-red-600" : "text-emerald-600"}`}>{alertas.filter((a) => a.tipo === "pais").length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Ubicaciones nuevas (7 días)</div><div className="font-display text-3xl mt-1 text-ink">{alertas.filter((a) => a.tipo === "ciudad").length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">IP de proxy o VPN pública</div><div className="font-display text-3xl mt-1 text-ink">{alertas.filter((a) => a.tipo === "proxy").length}</div></div>
        <div className="card p-4"><div className="text-xs text-ink/50">Sin ubicación todavía</div><div className="font-display text-3xl mt-1 text-ink/50">{sinUbicacion}</div></div>
      </div>

      {alertas.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="data w-full">
            <thead><tr><th>Equipo</th><th>Alerta</th><th>Ubicación actual</th><th>Último reporte</th></tr></thead>
            <tbody>
              {alertas.map((a, i) => (
                <tr key={i}>
                  <td><span className="font-medium text-ink">{a.d.hostname}</span><div className="text-xs text-ink/50">{a.d.usuario ?? ""}</div></td>
                  <td><span className={`pill ${a.nivel === "problema" ? "bg-red-50 text-red-600" : "bg-amber-500/10 text-amber-700"}`}>{a.texto}</span></td>
                  <td className="text-sm text-ink/70">{textoUbicacion(a.d) ?? "—"}<div className="text-xs text-ink/40 font-mono">{a.d.ip_publica}</div></td>
                  <td className="text-sm text-ink/60 whitespace-nowrap">{hace(a.d.ultimo_reporte)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Equipo</th><th>Ubicación aproximada</th><th>IP pública</th><th>Ciudades en 90 días</th></tr></thead>
          <tbody>
            {disp.map((d) => {
              const propio = hist.filter((h) => h.dispositivo_id === d.id);
              const ciudades = Array.from(new Set(propio.filter((h) => h.ciudad).map((h) => `${bandera(h.pais_codigo)} ${h.ciudad}`)));
              return (
                <tr key={d.id} className="align-top">
                  <td>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${conectado(d.ultimo_reporte) ? "bg-emerald-500" : "bg-line/20"}`} aria-hidden />
                      <span className="font-medium text-ink">{d.hostname}</span>
                    </div>
                    <div className="text-xs text-ink/50 pl-4">{d.usuario ?? ""}</div>
                  </td>
                  <td className="text-sm text-ink/80">{textoUbicacion(d) ?? <span className="text-ink/40">Sin datos todavía</span>}</td>
                  <td className="text-xs text-ink/60 font-mono">{d.ip_publica ?? "—"}</td>
                  <td className="text-sm">
                    {ciudades.length === 0 ? <span className="text-ink/40">—</span> : (
                      <button className="text-left text-ink/70 hover:text-brand-700" onClick={() => setAbierto(abierto === d.id ? null : d.id)} aria-expanded={abierto === d.id}>
                        {ciudades.slice(0, 3).join(" · ")}{ciudades.length > 3 ? ` y ${ciudades.length - 3} más` : ""}
                      </button>
                    )}
                    {abierto === d.id && (
                      <ul className="mt-2 text-xs text-ink/60 space-y-0.5">
                        {propio.map((h, i) => <li key={i}>{h.fecha.split("-").reverse().join("/")} · {bandera(h.pais_codigo)} {h.ciudad}{h.region && h.region !== h.ciudad ? `, ${h.region}` : ""}{h.isp ? ` · ${h.isp}` : ""}</li>)}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink/50">
        La ubicación por IP es aproximada (ciudad o zona, no domicilio) y con VPN o datos móviles puede mostrar otra ciudad. Usala para
        detectar anomalías, no para seguir personas.{" "}
        <a href={ATRIBUCION_GEO.url} target="_blank" rel="noopener noreferrer" className="underline">{ATRIBUCION_GEO.texto}</a>.
      </p>
    </div>
  );
}
