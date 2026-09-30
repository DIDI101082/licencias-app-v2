"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePerfil } from "@/components/PerfilContext";
import { conectado, hace } from "@/lib/monitoreo";
import { claseCodigo } from "@/lib/inventario";
import { ThFiltro, FiltrosActivos, useFiltrosColumna } from "@/components/FiltroColumna";

type Tipo = "oficina" | "vpn" | "remoto" | "invitados";

const TIPOS: Record<Tipo | "desconocido", { titulo: string; pill: string; barra: string }> = {
  oficina: { titulo: "En la oficina", pill: "bg-brand-50 text-brand-700", barra: "bg-brand-500" },
  vpn: { titulo: "Home office con VPN", pill: "bg-emerald-50 text-emerald-700", barra: "bg-emerald-500" },
  remoto: { titulo: "Home office sin VPN", pill: "bg-amber-500/10 text-amber-700", barra: "bg-amber-500" },
  invitados: { titulo: "En WiFi de invitados", pill: "bg-red-50 text-red-600", barra: "bg-red-500" },
  desconocido: { titulo: "Sin datos", pill: "bg-line/[0.05] text-ink/50", barra: "bg-line/20" },
};

function Redes() {
  const [redes, setRedes] = useState<any[]>([]);
  const [nueva, setNueva] = useState({ nombre: "", sede: "", cidr: "", tipo: "corporativa", ssid: "" });
  const [error, setError] = useState<string | null>(null);
  const cargar = () => createClient().from("inv_redes").select("*").order("sede").order("nombre").then(({ data }) => setRedes(data ?? []));
  useEffect(() => { cargar(); }, []);

  async function agregar(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const { error } = await createClient().from("inv_redes").insert({ ...nueva, ssid: nueva.ssid.trim() || null });
    if (error) return setError(error.message.includes("cidr") ? "La red tiene que tener el formato 192.168.10.0/24." : error.message);
    setNueva({ nombre: "", sede: "", cidr: "", tipo: "corporativa", ssid: "" }); cargar();
  }
  async function borrar(id: number) {
    await createClient().from("inv_redes").delete().eq("id", id); cargar();
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-medium text-ink">Redes de la empresa</h2>
        <p className="text-sm text-ink/60 mt-1">
          Con estas redes se decide dónde está cada equipo. Los cambios se aplican en el siguiente reporte de cada agente (unos minutos).
          En el nombre del WiFi, <code className="text-xs">%</code> es un comodín: <code className="text-xs">Accusys%P5</code> acepta
          “Accusys_P5” y “Accusys_Wifi_P5”, sin importar mayúsculas.
        </p>
      </div>
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>}
      <div className="overflow-x-auto">
        <table className="data w-full">
          <thead><tr><th>Nombre</th><th>Sede</th><th>Red</th><th>Tipo</th><th>WiFi</th><th></th></tr></thead>
          <tbody>
            {redes.map((r) => (
              <tr key={r.id}>
                <td className="text-ink">{r.nombre}</td>
                <td className="text-ink/70">{r.sede}</td>
                <td className="font-mono text-xs">{r.cidr}</td>
                <td className="text-ink/70">{r.tipo === "corporativa" ? "Oficina" : r.tipo === "invitados" ? "Invitados" : "VPN"}</td>
                <td className="text-ink/70">{r.ssid ?? "—"}</td>
                <td className="text-right"><button className="text-sm text-ink/40 hover:text-red-600" onClick={() => borrar(r.id)}>Quitar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={agregar} className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
        <div className="md:col-span-2"><label className="label">Nombre</label><input required className="input" value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} placeholder="Piso 6 · WiFi" /></div>
        <div><label className="label">Sede</label><input required className="input" value={nueva.sede} onChange={(e) => setNueva({ ...nueva, sede: e.target.value })} placeholder="Oficina central" /></div>
        <div><label className="label">Red</label><input required className="input" value={nueva.cidr} onChange={(e) => setNueva({ ...nueva, cidr: e.target.value })} placeholder="192.168.206.0/24" /></div>
        <div>
          <label className="label">Tipo</label>
          <select className="input" value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value })}>
            <option value="corporativa">Oficina</option><option value="invitados">Invitados</option><option value="vpn">VPN</option>
          </select>
        </div>
        <div><label className="label">WiFi (opcional)</label><input className="input" value={nueva.ssid} onChange={(e) => setNueva({ ...nueva, ssid: e.target.value })} placeholder="Accusys%P6" /></div>
        <div className="col-span-2 md:col-span-6"><button className="btn-secondary">Agregar red</button></div>
      </form>
    </div>
  );
}

export default function Ubicacion() {
  const { esAdmin } = usePerfil();
  const [disp, setDisp] = useState<any[]>([]);
  const [historial, setHistorial] = useState<any[]>([]);
  const [ahora, setAhora] = useState(Date.now());
  const [filtro, setFiltro] = useState<Tipo | null>(null);
  const [verRedes, setVerRedes] = useState(false);
  const [texto, setTexto] = useState("");
  const [red, setRed] = useState("");
  const [pagina, setPagina] = useState(1);
  // Antena UniFi de cada equipo (si está conectado el puente de UniFi)
  const [uni, setUni] = useState<{ actualizado: string | null; dispositivos: { dispositivo_id: string; zona: string; antena: string | null; ssid: string | null }[];
    zonas: { zona: string; con_agente: number; otros: number; invitados: number }[] } | null>(null);

  useEffect(() => {
    const sb = createClient();
    const cargar = () =>
      sb.from("inv_dispositivos")
        .select("id, hostname, usuario, ip, ssid, redes, ultimo_reporte, ubicacion_tipo, ubicacion_sede, ubicacion_red, ubicacion_actualizada, inv_equipos(id, codigo)")
        .eq("estado_registro", "aprobado").order("hostname")
        .then(({ data }) => setDisp(data ?? []));
    cargar();
    const desde = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    sb.from("inv_ubicacion_diaria").select("dispositivo_id, fecha, tipo").gte("fecha", desde)
      .then(({ data }) => setHistorial(data ?? []));
    // Los agentes reportan seguido: se agrupan los cambios y se recarga como mucho una vez cada 30 segundos
    let pendiente: ReturnType<typeof setTimeout> | undefined;
    const recargarLuego = () => { if (!pendiente) pendiente = setTimeout(() => { pendiente = undefined; cargar(); }, 30000); };
    const canal = sb.channel("inv-ubicacion")
      .on("postgres_changes", { event: "*", schema: "public", table: "inv_dispositivos" }, () => recargarLuego())
      .subscribe();
    const cargarUni = () => sb.rpc("unifi_ubicacion").then(({ data, error }) => setUni(error ? null : data));
    cargarUni();
    const uniIntervalo = setInterval(cargarUni, 120000);
    const reloj = setInterval(() => setAhora(Date.now()), 30000);
    return () => { sb.removeChannel(canal); clearInterval(reloj); clearInterval(uniIntervalo); clearTimeout(pendiente); };
  }, []);

  const conectados = disp.filter((d) => conectado(d.ultimo_reporte, ahora));
  const desconectados = disp.length - conectados.length;
  const tipoDe = (d: any): Tipo | "desconocido" => (d.ubicacion_tipo as Tipo) ?? "desconocido";
  const cuenta = (t: Tipo) => conectados.filter((d) => tipoDe(d) === t).length;
  const sinDatos = conectados.filter((d) => !d.ubicacion_tipo).length;

  // Oficina por sede y piso/red
  const porRed = useMemo(() => {
    const m = new Map<string, { sede: string; red: string; n: number; invitados: boolean }>();
    conectados.filter((d) => d.ubicacion_tipo === "oficina" || d.ubicacion_tipo === "invitados").forEach((d) => {
      const k = `${d.ubicacion_sede}|${d.ubicacion_red}`;
      const x = m.get(k) ?? { sede: d.ubicacion_sede, red: d.ubicacion_red, n: 0, invitados: d.ubicacion_tipo === "invitados" };
      x.n++; m.set(k, x);
    });
    return Array.from(m.values()).sort((a, b) => a.sede.localeCompare(b.sede) || a.red.localeCompare(b.red));
  }, [conectados]);

  // Últimos 30 días: equipos distintos por día en oficina y en casa
  const dias = useMemo(() => {
    const out: { fecha: string; oficina: number; casa: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const f = new Date(Date.now() - i * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
      const del = historial.filter((h) => h.fecha === f);
      out.push({
        fecha: f,
        oficina: new Set(del.filter((h) => h.tipo === "oficina" || h.tipo === "invitados").map((h) => h.dispositivo_id)).size,
        casa: new Set(del.filter((h) => h.tipo === "vpn" || h.tipo === "remoto").map((h) => h.dispositivo_id)).size,
      });
    }
    return out;
  }, [historial]);
  const maxDia = Math.max(1, ...dias.map((d) => d.oficina + d.casa));
  const uniFresco = !!uni?.actualizado && ahora - Date.parse(uni.actualizado) < 30 * 60000;
  const zonaDe = useMemo(() => new Map((uniFresco ? uni?.dispositivos ?? [] : []).map((x) => [x.dispositivo_id, x])), [uni, uniFresco]);
  const zonas = uniFresco ? uni?.zonas ?? [] : [];
  const hayHistorial = dias.some((d) => d.oficina + d.casa > 0);

  // Red o piso de cada equipo, tal como se muestra en la columna "Red"
  const redDe = (d: any) => d.ubicacion_red ?? (tipoDe(d) === "remoto" ? "Red de su casa" : "Sin datos");
  const redes = useMemo(() => {
    const m = new Map<string, number>();
    conectados.filter((d) => !filtro || tipoDe(d) === filtro).forEach((d) => m.set(redDe(d), (m.get(redDe(d)) ?? 0) + 1));
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0], "es", { numeric: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conectados, filtro]);
  const filas = conectados.filter((d) => {
    if (filtro && tipoDe(d) !== filtro) return false;
    if (red && redDe(d) !== red) return false;
    const q = texto.trim().toLowerCase();
    return !q || [d.hostname, d.usuario, d.ip, d.ssid, d.ubicacion_red, d.ubicacion_sede, d.inv_equipos?.codigo, zonaDe.get(d.id)?.zona]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
  // Filtros por columna (tipo Excel)
  const ipDe = (d: any) => (d.redes ?? []).find((r: any) => r.gateway)?.ip ?? d.ip;
  const fc = useFiltrosColumna(filas, {
    equipo: (d) => d.hostname,
    ubicacion: (d) => (tipoDe(d) === "oficina" ? d.ubicacion_sede : TIPOS[tipoDe(d)].titulo),
    red: (d) => [zonaDe.get(d.id)?.zona, redDe(d)].filter(Boolean) as string[],
    ip: (d) => ipDe(d),
    reporte: (d) => hace(d.ultimo_reporte, ahora),
  });
  const enTabla = fc.filtradas;
  useEffect(() => { setPagina(1); }, [filtro, red, texto, fc.filtros]);
  // Paginación de a 50; al cambiar un filtro se vuelve a la primera página
  const POR_PAGINA = 50;
  const paginas = Math.max(1, Math.ceil(enTabla.length / POR_PAGINA));
  const paginaActual = Math.min(pagina, paginas);
  const visibles = enTabla.slice((paginaActual - 1) * POR_PAGINA, paginaActual * POR_PAGINA);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-ink">Oficina y home office</h1>
          <p className="text-ink/60 text-sm mt-1">Dónde están ahora los equipos conectados, según la red a la que están conectados. Se actualiza solo.</p>
        </div>
        {esAdmin && <button className="btn-secondary" onClick={() => setVerRedes(!verRedes)} aria-expanded={verRedes}>Redes de la empresa</button>}
      </div>

      {esAdmin && verRedes && <Redes />}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {(["oficina", "vpn", "remoto", "invitados"] as Tipo[]).map((t) => {
          const n = cuenta(t);
          return (
            <button key={t} onClick={() => setFiltro(filtro === t ? null : t)} aria-pressed={filtro === t}
              className={`card p-5 text-left transition-colors ${filtro === t ? "border-brand-500 ring-2 ring-brand-500/20" : "hover:border-brand-300"}`}>
              <div className="text-xs text-ink/50 font-medium">{TIPOS[t].titulo}</div>
              <div className={`font-display text-3xl mt-1 ${t === "invitados" && n ? "text-red-600" : "text-ink"}`}>{n}</div>
            </button>
          );
        })}
        <div className="card p-5">
          <div className="text-xs text-ink/50 font-medium">Desconectados</div>
          <div className="font-display text-3xl mt-1 text-ink/50">{desconectados}</div>
        </div>
      </div>

      {cuenta("invitados") > 0 && (
        <p className="text-sm text-red-700 bg-red-50 rounded-md px-3 py-2">
          Hay equipos corporativos conectados al WiFi de invitados. Esa red no debería usarse con equipos de la empresa: quedan fuera de los
          controles de la red interna.
        </p>
      )}
      {sinDatos > 0 && (
        <p className="text-sm text-ink/60">
          {sinDatos} {sinDatos === 1 ? "equipo conectado todavía no informa" : "equipos conectados todavía no informan"} su ubicación: necesitan el agente 1.7.
        </p>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-medium text-ink mb-3">En la oficina, por sede y piso</h2>
          {zonas.length > 0 ? (
            <>
              <ul className="space-y-2">
                {zonas.map((z) => (
                  <li key={z.zona} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink">{z.zona}</span>
                    <span className="text-right">
                      <span className="font-display text-lg">{z.con_agente}</span>
                      <span className="text-xs text-ink/50"> con agente</span>
                      {z.otros > 0 && <span className="text-xs text-ink/50"> · {z.otros} otros</span>}
                      {z.invitados > 0 && <span className="text-xs text-amber-700"> · {z.invitados} en invitados</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink/50 mt-3">
                Según la antena WiFi de UniFi a la que está conectado cada dispositivo. “Otros” son celulares y equipos sin agente.{" "}
                <Link href="/inventario/ubicacion/ocupacion" className="text-brand-600 hover:underline">Ver ocupación por piso</Link>
              </p>
            </>
          ) : porRed.length === 0 ? <p className="text-sm text-ink/50">Ningún equipo conectado desde la oficina en este momento.</p> : (
            <ul className="space-y-2">
              {porRed.map((r) => (
                <li key={r.sede + r.red} className="flex items-center justify-between text-sm">
                  <span>
                    <span className="text-ink/50">{r.sede} · </span>
                    <span className={r.invitados ? "text-red-600" : "text-ink"}>{r.red}</span>
                  </span>
                  <span className="font-display text-lg">{r.n}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-medium text-ink">Últimos 30 días</h2>
            <span className="text-xs text-ink/50 flex gap-3">
              <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-brand-500 inline-block" /> Oficina</span>
              <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> Home office</span>
            </span>
          </div>
          {!hayHistorial ? <p className="text-sm text-ink/50">El historial empieza a completarse a partir de hoy.</p> : (
            <div className="flex items-end gap-[3px] h-32" role="img" aria-label="Equipos por día en oficina y en home office">
              {dias.map((d) => (
                <div key={d.fecha} className="flex-1 flex flex-col justify-end h-full" title={`${d.fecha.split("-").reverse().join("/")}: ${d.oficina} en oficina, ${d.casa} en home office`}>
                  <div className="bg-emerald-500 rounded-t-sm" style={{ height: `${(d.casa / maxDia) * 100}%` }} />
                  <div className="bg-brand-500" style={{ height: `${(d.oficina / maxDia) * 100}%` }} />
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-ink/50 mt-2">Cantidad de equipos distintos por día. Un equipo que estuvo en la oficina y en su casa el mismo día cuenta en los dos.</p>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input type="search" className="input flex-1 min-w-[14rem]" placeholder="Buscar por equipo, usuario, IP, red o WiFi…"
          value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" />
        <select className="input w-auto" value={red} onChange={(e) => setRed(e.target.value)} aria-label="Red o piso">
          <option value="">Todas las redes y pisos</option>
          {red && !redes.some(([r]) => r === red) && <option value={red}>{red} (0)</option>}
          {redes.map(([r, n]) => <option key={r} value={r}>{r} ({n})</option>)}
        </select>
        {(texto || red || filtro) && (
          <button className="text-sm text-ink/50 hover:text-ink hover:underline" onClick={() => { setTexto(""); setRed(""); setFiltro(null); }}>
            Limpiar filtros
          </button>
        )}
      </div>

      <FiltrosActivos ctl={fc} total={filas.length} />

      <div className="card overflow-x-auto">
        <table className="data w-full" data-paginada>
          <thead>
            <tr>
              <ThFiltro ctl={fc} col="equipo">Equipo</ThFiltro><ThFiltro ctl={fc} col="ubicacion">Ubicación</ThFiltro>
              <ThFiltro ctl={fc} col="red">Red</ThFiltro><ThFiltro ctl={fc} col="ip">IP</ThFiltro>
              <ThFiltro ctl={fc} col="reporte">Último reporte</ThFiltro>
            </tr>
          </thead>
          <tbody>
            {visibles.map((d) => {
              const t = tipoDe(d);
              const ipVpn = (d.redes ?? []).find((r: any) => /^192\.168\.51\./.test(r.ip))?.ip;
              const ipPrincipal = (d.redes ?? []).find((r: any) => r.gateway)?.ip ?? d.ip;
              return (
                <tr key={d.id}>
                  <td>
                    <span className="font-medium text-ink">{d.hostname}</span>
                    {d.inv_equipos && <Link href={`/inventario/equipos/${d.inv_equipos.id}`} className={`${claseCodigo(d.inv_equipos.codigo)} ml-2`}>{d.inv_equipos.codigo}</Link>}
                    <div className="text-xs text-ink/50">{d.usuario ?? "Sin sesión"}</div>
                  </td>
                  <td><span className={`pill ${TIPOS[t].pill}`}>{t === "oficina" ? d.ubicacion_sede : TIPOS[t].titulo}</span></td>
                  <td className="text-ink/70">
                    {zonaDe.get(d.id) && <div className="text-ink">{zonaDe.get(d.id)!.zona}<span className="text-xs text-ink/50"> · antena {zonaDe.get(d.id)!.antena}</span></div>}
                    {d.ubicacion_red ?? (t === "remoto" ? "Red de su casa" : "—")}
                    {d.ssid && <div className="text-xs text-ink/50">WiFi: {d.ssid}</div>}
                  </td>
                  <td className="text-xs text-ink/60 whitespace-nowrap">
                    {ipPrincipal ?? "—"}
                    {ipVpn && ipVpn !== ipPrincipal && <div>VPN: {ipVpn}</div>}
                  </td>
                  <td className="text-ink/60 whitespace-nowrap">{hace(d.ultimo_reporte, ahora)}</td>
                </tr>
              );
            })}
            {enTabla.length === 0 && (
              <tr><td colSpan={5} className="text-center text-ink/40 py-10">
                {texto || red || fc.activos ? "Ningún equipo coincide con el filtro." : filtro ? "Ningún equipo en esta situación ahora." : "No hay equipos conectados en este momento."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {enTabla.length > POR_PAGINA && (
        <nav aria-label="Páginas de equipos" className="flex items-center justify-between gap-3 flex-wrap text-sm">
          <span className="text-ink/60">
            Mostrando {(paginaActual - 1) * POR_PAGINA + 1}–{Math.min(paginaActual * POR_PAGINA, enTabla.length)} de {enTabla.length} equipos
          </span>
          <div className="flex items-center gap-1">
            <button className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={paginaActual === 1} onClick={() => setPagina(paginaActual - 1)}>Anterior</button>
            {Array.from({ length: paginas }, (_, i) => i + 1).map((n) => (
              <button key={n} onClick={() => setPagina(n)} aria-current={n === paginaActual ? "page" : undefined}
                className={`min-w-[2.25rem] px-2 py-1.5 rounded-lg tabular-nums transition-colors ${n === paginaActual ? "bg-brand-600 text-white font-medium" : "text-ink/60 hover:bg-line/[0.06] hover:text-ink"}`}>
                {n}
              </button>
            ))}
            <button className="btn-secondary px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed" disabled={paginaActual === paginas} onClick={() => setPagina(paginaActual + 1)}>Siguiente</button>
          </div>
        </nav>
      )}
      <p className="text-xs text-ink/50">
        Registrar desde dónde trabaja cada persona es información sobre el personal: conviene que el esquema esté informado a los empleados y
        validado con RRHH.
      </p>
    </div>
  );
}
