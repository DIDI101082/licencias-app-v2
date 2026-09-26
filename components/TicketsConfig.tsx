"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Cfg = {
  activo: boolean; sector: string; severidad_min: string; incidentes: boolean; avisar_resueltas: boolean;
  ultimo_envio: string | null; ultimo_error: string | null; url: string | null; con_token: boolean;
};

// Integración con el sistema de tickets propio: cada alerta (y cada incidente) abre un ticket por HTTP POST
export default function TicketsConfig() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [f, setF] = useState<Partial<Cfg>>({});
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [falta, setFalta] = useState(false);

  const cargar = async () => {
    const { data, error } = await createClient().rpc("tickets_config_ver");
    if (error) { setFalta(error.message.includes("tickets_config_ver")); return; }
    setCfg(data as Cfg); setF(data as Cfg);
  };
  useEffect(() => { cargar(); }, []);

  async function correr(fn: () => PromiseLike<{ error: any; data?: any }>, ok: string) {
    setOcupado(true); setMsg(null);
    const { error, data } = await fn();
    setOcupado(false);
    if (error) return setMsg({ ok: false, texto: error.message });
    setMsg({ ok: true, texto: typeof data === "string" && data ? data : ok });
    cargar();
  }

  if (falta) return <div className="card p-5 text-sm text-ink/60"><b>Sistema de tickets:</b> falta ejecutar tickets.sql en Supabase.</div>;
  if (!cfg) return null;
  const sb = createClient();

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-display text-lg text-ink">Sistema de tickets</h2>
        <p className="text-sm text-ink/60 mt-1">
          Cada alerta nueva (desde la severidad elegida) y cada incidente registrado se envía por <b>HTTP POST</b> con un JSON
          a tu sistema de tickets. Si tu sistema responde <code>{`{"id": "..."}`}</code>, el número de ticket queda guardado en la alerta.
        </p>
        <details className="text-xs text-ink/60 mt-2">
          <summary className="cursor-pointer">Formato del JSON que se envía</summary>
          <pre className="mt-2 p-3 rounded bg-line/[0.04] overflow-x-auto">{`{
  "origen": "accusys-cyber",
  "evento": "alerta_nueva" | "alerta_resuelta" | "incidente_nuevo" | "prueba",
  "id": "alerta-123" | "INC-0004",
  "sector": "${f.sector ?? "Ciberseguridad"}",
  "severidad": "critica" | "alta" | "media" | "info",
  "titulo": "...", "detalle": "...",
  "url": "https://.../enlace a la app",
  "fecha": "2026-09-26T18:00:00Z",
  "ticket_ref": "..."   // solo en alerta_resuelta
}
Encabezado: Authorization: Bearer <token>`}</pre>
        </details>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <label className="block text-sm">Dirección (endpoint)
          <input className="input mt-1" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder={cfg.url ? `Configurada (${cfg.url}). Pegá otra para reemplazarla` : "https://tickets.accusys.com.ar/api/tickets"} />
        </label>
        <label className="block text-sm">Token
          <input className="input mt-1" type="password" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={cfg.con_token ? "Configurado. Escribí otro para reemplazarlo" : "Opcional"} />
        </label>
        <label className="block text-sm">Sector al que se deriva
          <input className="input mt-1" value={f.sector ?? ""} onChange={(e) => setF({ ...f, sector: e.target.value })} />
        </label>
        <label className="block text-sm">Abrir ticket desde severidad
          <select className="input mt-1" value={f.severidad_min} onChange={(e) => setF({ ...f, severidad_min: e.target.value })}>
            <option value="critica">Crítica</option><option value="alta">Alta o más</option><option value="media">Media o más</option><option value="info">Todas</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Activado</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.incidentes} onChange={(e) => setF({ ...f, incidentes: e.target.checked })} /> Abrir ticket por cada incidente</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.avisar_resueltas} onChange={(e) => setF({ ...f, avisar_resueltas: e.target.checked })} /> Avisar cuando la alerta se resuelve</label>
      </div>

      {(cfg.ultimo_envio || cfg.ultimo_error) && (
        <p className="text-xs text-ink/50">
          {cfg.ultimo_envio && <>Último envío: {new Date(cfg.ultimo_envio).toLocaleString("es-AR")}. </>}
          {cfg.ultimo_error && <span className="text-red-600">Último error: {cfg.ultimo_error}</span>}
        </p>
      )}
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.texto}</p>}

      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={ocupado} onClick={() => {
          const p: Record<string, any> = { activo: f.activo, sector: f.sector, severidad_min: f.severidad_min, incidentes: f.incidentes, avisar_resueltas: f.avisar_resueltas };
          if (url.trim()) p.url = url.trim();
          if (token.trim()) p.token = token.trim();
          correr(() => sb.rpc("tickets_config_guardar", { p }), "Configuración guardada.").then(() => { setUrl(""); setToken(""); });
        }}>Guardar</button>
        {cfg.url && <button className="btn-secondary" disabled={ocupado} onClick={() => correr(() => sb.rpc("tickets_probar"), "Prueba enviada.")}>Enviar ticket de prueba</button>}
        {cfg.url && <button className="btn-secondary" disabled={ocupado}
          onClick={() => confirm("¿Quitar la integración? Se borran la dirección y el token.") && correr(() => sb.rpc("tickets_config_guardar", { p: { url: "", token: "", activo: false } }), "Integración quitada.")}>Quitar</button>}
      </div>
    </div>
  );
}
