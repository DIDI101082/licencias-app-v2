"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Cfg = { activa: boolean; generados: boolean; sectores: string | null; ultima: string | null; total: number | null; error: string | null; url: string | null; con_token: boolean };

// Lectura del sistema de tickets: la base consulta cada 15 minutos un endpoint de solo lectura (HTTP GET)
export default function TicketsLectura({ alLeer }: { alLeer?: () => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [activa, setActiva] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [sectores, setSectores] = useState("");
  const [generados, setGenerados] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [falta, setFalta] = useState(false);

  const cargar = async () => {
    const { data, error } = await createClient().rpc("tickets_lectura_ver");
    if (error) { setFalta(error.message.includes("tickets_lectura_ver")); return; }
    setCfg(data as Cfg); setActiva((data as Cfg).activa); setSectores((data as Cfg).sectores ?? ""); setGenerados((data as Cfg).generados !== false);
  };
  useEffect(() => { cargar(); }, []);

  async function correr(fn: () => PromiseLike<{ error: any; data?: any }>, ok: string, leido = false) {
    setOcupado(true); setMsg(null);
    const { error, data } = await fn();
    setOcupado(false);
    if (error) { setMsg({ ok: false, texto: error.message }); cargar(); return; }
    setMsg({ ok: true, texto: typeof data === "string" && data ? data : ok });
    setUrl(""); setToken("");
    cargar();
    if (leido) alLeer?.();
  }

  if (falta) return <div className="card p-5 text-sm text-ink/60"><b>Lectura de tickets:</b> falta ejecutar tickets-lectura.sql en Supabase.</div>;
  if (!cfg) return null;
  const sb = createClient();

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-display text-lg text-ink">Lectura del sistema de tickets</h2>
        <p className="text-sm text-ink/60 mt-1">
          Cada 15 minutos se consulta por <b>HTTP GET</b> un endpoint de solo lectura del sistema de tickets y se guarda una copia de
          cada ticket (número, título, estado, sector, asignado y fechas). Accusys Cyber no modifica tickets por esta vía.
        </p>
        <details className="text-xs text-ink/60 mt-2">
          <summary className="cursor-pointer">Qué dirección cargar</summary>
          <div className="mt-2 space-y-2">
            <p>
              <b>Helpdesk Dashboard API</b> (workdesk): la bandeja de una subárea. La API Key va en el campo Token; se envía en el
              encabezado <code>X-API-Key</code>.
            </p>
            <pre className="p-3 rounded bg-line/[0.04] overflow-x-auto">{`Tickets asignados a la subárea (los que hay que resolver):
https://workdesk.accusys.com.ar/api/dashboard/bandejas/subarea/50?idEmpresa=1&tipoBandeja=2

Tickets generados por la subárea:
https://workdesk.accusys.com.ar/api/dashboard/bandejas/subarea/50?idEmpresa=1&tipoBandeja=1`}</pre>
            <p>
              De cada ticket se toma: número, título, estado, tipo, prioridad, autor, asignados, estado del SLA y fechas. La bandeja no informa
              la fecha de cierre: para un ticket resuelto o cerrado se usa la fecha de su último cambio de estado.
            </p>
            <p>
              También se acepta cualquier endpoint GET que devuelva una lista JSON de tickets con <code>id</code>, <code>titulo</code>,{" "}
              <code>estado</code>, <code>sector</code>, <code>creado</code> y <code>cerrado</code>.
            </p>
          </div>
        </details>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <label className="block text-sm">Dirección (endpoint de lectura)
          <input className="input mt-1" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder={cfg.url ? `Configurada: ${cfg.url}` : "https://workdesk.accusys.com.ar/api/dashboard/bandejas/subarea/50?idEmpresa=1&tipoBandeja=2"} />
          {cfg.url && <span className="text-xs text-ink/50">Guardada: <code>https://{cfg.url}</code>. Para cambiarla, pegá la dirección completa.</span>}
        </label>
        <label className="block text-sm">Token
          <input className="input mt-1" type="password" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={cfg.con_token ? "Configurado. Escribí otro para reemplazarlo" : "Token de solo lectura"} />
        </label>
        <label className="block text-sm md:col-span-2">Sectores a leer
          <input className="input mt-1" value={sectores} onChange={(e) => setSectores(e.target.value)} placeholder="Vacío: todos los sectores" />
          <span className="text-xs text-ink/50">
            Escribilos igual que figuran en el sistema de tickets, separados por coma. Vacío = todos los sectores.
            Solo se guardan los tickets de estos sectores. Con la Helpdesk Dashboard API dejalo vacío: la bandeja ya viene filtrada por subárea.
          </span>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink/80">
        <input type="checkbox" checked={activa} onChange={(e) => setActiva(e.target.checked)} />
        Leer automáticamente cada 15 minutos
      </label>
      <label className="flex items-center gap-2 text-sm text-ink/80">
        <input type="checkbox" checked={generados} onChange={(e) => setGenerados(e.target.checked)} />
        Leer también los tickets generados por el área (la misma dirección con <code className="text-xs">tipoBandeja=1</code>)
      </label>

      <div className="flex items-center gap-3 flex-wrap">
        <button className="btn-primary" disabled={ocupado}
          onClick={() => correr(() => sb.rpc("tickets_lectura_guardar", { p: { activa, generados, sectores, ...(url.trim() ? { url } : {}), ...(token.trim() ? { token } : {}) } }), "Configuración guardada")}>
          Guardar
        </button>
        <button className="btn-secondary" disabled={ocupado || !cfg.url}
          onClick={() => correr(() => sb.rpc("tickets_leer_ahora"), "Lectura hecha", true)}>
          Leer ahora
        </button>
        <span className="text-xs text-ink/50">
          {cfg.ultima ? `Última lectura: ${new Date(cfg.ultima).toLocaleString("es-AR")} · ${cfg.total ?? 0} tickets` : "Todavía no se hizo ninguna lectura"}
        </span>
      </div>
      {msg && <p className={`text-sm rounded-md px-3 py-2 break-words ${msg.ok ? "text-emerald-700 bg-emerald-50" : "text-red-600 bg-red-50"}`}>{msg.texto}</p>}
      {!msg && cfg.error && <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2 break-words">Último error: {cfg.error}</p>}
    </div>
  );
}
