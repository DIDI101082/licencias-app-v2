"use client";

import { useEffect, useMemo, useState } from "react";
import { ROLES_CRITICOS_LISTA } from "@/lib/identidad-roles";

type Usuario = {
  id: string; nombre: string; upn: string; email: string | null; area: string | null; habilitado: boolean;
  invitado: boolean; estado_invitacion: string | null; creado: string | null; ultimo_ingreso: string | null;
  mfa: boolean | null; metodos: string[]; roles: string[]; inactivo: boolean;
};
type Resumen = {
  miembros: number; sin_mfa: number | null; inactivos: number | null; admins: number | null;
  admins_sin_mfa: number | null; invitados: number; invitados_pendientes: number;
};
type Respuesta = {
  configurado: boolean; error?: string; resumen?: Resumen; usuarios?: Usuario[]; avisos?: string[];
  disponibles?: { ingresos: boolean; mfa: boolean; roles: boolean }; consultado?: string; dias?: number;
};
type Filtro = "sin_mfa" | "inactivos" | "admins" | "invitados" | "todos";

const CRITICOS = new Set(ROLES_CRITICOS_LISTA);
const fd = (f: string | null) => (f ? new Date(f).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "—");
const diasDesde = (f: string | null) => (f ? Math.floor((Date.now() - Date.parse(f)) / 86400000) : null);
const METODO: Record<string, string> = {
  microsoftAuthenticatorPush: "Authenticator", microsoftAuthenticatorPasswordless: "Authenticator sin contraseña",
  softwareOneTimePasscode: "App OTP", hardwareOneTimePasscode: "Token físico", mobilePhone: "SMS/llamada",
  alternateMobilePhone: "Teléfono alternativo", officePhone: "Teléfono de oficina", fido2SecurityKey: "Llave FIDO2",
  windowsHelloForBusiness: "Windows Hello", passKeyDeviceBound: "Passkey", email: "Email", temporaryAccessPass: "Pase temporal",
  securityQuestion: "Preguntas", macOsSecureEnclaveKey: "Mac Secure Enclave",
};

export default function Identidad() {
  const [d, setD] = useState<Respuesta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [filtro, setFiltro] = useState<Filtro>("sin_mfa");
  const [dias, setDias] = useState(90);
  const [q, setQ] = useState("");

  const cargar = async (n = dias) => {
    setCargando(true);
    const r = await fetch(`/api/identidad?dias=${n}`).then((x) => x.json()).catch((e) => ({ configurado: true, error: String(e) }));
    setD(r);
    setCargando(false);
  };
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const usuarios = d?.usuarios ?? [];
  const lista = useMemo(() => {
    const t = q.trim().toLowerCase();
    return usuarios
      .filter((u) => {
        if (t && ![u.nombre, u.upn, u.area].some((v) => v?.toLowerCase().includes(t))) return false;
        if (filtro === "sin_mfa") return u.habilitado && !u.invitado && u.mfa === false;
        if (filtro === "inactivos") return u.habilitado && u.inactivo;
        if (filtro === "admins") return u.roles.length > 0;
        if (filtro === "invitados") return u.invitado;
        return true;
      })
      .sort((a, b) => b.roles.length - a.roles.length || a.nombre.localeCompare(b.nombre));
  }, [usuarios, filtro, q]);

  const r = d?.resumen;
  const tarjeta = (f: Filtro, titulo: string, valor: number | null | undefined, malo: boolean, sub?: string) => (
    <button onClick={() => setFiltro(f)}
      className={`card p-4 text-left transition ${filtro === f ? "ring-2 ring-brand-600" : "hover:ring-1 hover:ring-line/20"}`}>
      <div className="text-xs text-ink/50">{titulo}</div>
      <div className={`font-display text-3xl mt-1 ${valor == null ? "text-ink/30" : malo && valor > 0 ? "text-red-600" : "text-ink"}`}>{valor ?? "N/D"}</div>
      {sub && <div className="text-xs text-ink/50 mt-1">{sub}</div>}
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Identidad</h1>
          <p className="text-ink/60 text-sm mt-1">
            Cuentas de Entra ID sin MFA, sin uso, con roles de administrador e invitados externos. Son los puntos de entrada más
            comunes en un ataque: una cuenta olvidada o sin segundo factor alcanza para entrar a correo, Teams y OneDrive.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink/60">Inactiva después de</label>
          <select className="input w-auto" value={dias} onChange={(e) => { const n = Number(e.target.value); setDias(n); cargar(n); }}>
            {[30, 60, 90, 180].map((n) => <option key={n} value={n}>{n} días</option>)}
          </select>
          <button className="btn-secondary" onClick={() => cargar()} disabled={cargando}>{cargando ? "Consultando…" : "Actualizar"}</button>
        </div>
      </div>

      {d && !d.configurado && (
        <div className="card p-4 text-sm">
          Falta configurar la conexión con Entra ID (variables <code>AZURE_TENANT_ID</code>, <code>AZURE_CLIENT_ID</code> y{" "}
          <code>AZURE_CLIENT_SECRET</code> en Vercel). Es la misma app que usa la sincronización de empleados.
        </div>
      )}
      {d?.error && <div className="card p-3 text-sm text-red-600 bg-red-50">{d.error}</div>}
      {!!d?.avisos?.length && (
        <div className="card p-3 text-sm bg-amber-50 text-amber-800 space-y-1">
          <div className="font-medium">Algunos datos no están disponibles:</div>
          {d.avisos.map((a) => <div key={a}>• {a}</div>)}
          <div className="text-xs text-amber-700/80 pt-1">
            Permisos de aplicación a agregar en Entra → Registros de aplicaciones → tu app → Permisos de API → Microsoft Graph:
            AuditLog.Read.All y RoleManagement.Read.Directory, y después “Conceder consentimiento de administrador”.
          </div>
        </div>
      )}

      {r && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {tarjeta("sin_mfa", "Cuentas sin MFA", r.sin_mfa, true, r.sin_mfa != null ? `de ${r.miembros} cuentas activas` : "Requiere Entra ID P1")}
          {tarjeta("inactivos", `Sin uso hace ${d?.dias}+ días`, r.inactivos, true, r.inactivos != null ? "habilitadas, conviene deshabilitar" : "Requiere Entra ID P1")}
          {tarjeta("admins", "Con rol de administrador", r.admins, false,
            r.admins_sin_mfa ? `${r.admins_sin_mfa} sin MFA` : r.admins != null ? "todos con MFA" : undefined)}
          {tarjeta("invitados", "Invitados externos", r.invitados, false, r.invitados_pendientes ? `${r.invitados_pendientes} nunca aceptaron` : undefined)}
        </div>
      )}

      {d?.configurado && !d.error && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-line/[0.08]">
            <div className="flex gap-1 text-sm">
              {([["sin_mfa", "Sin MFA"], ["inactivos", "Inactivas"], ["admins", "Administradores"], ["invitados", "Invitados"], ["todos", "Todas"]] as [Filtro, string][])
                .map(([k, t]) => (
                  <button key={k} onClick={() => setFiltro(k)}
                    className={`px-3 py-1 rounded-full ${filtro === k ? "bg-brand-600 text-white" : "text-ink/60 hover:bg-line/[0.05]"}`}>{t}</button>
                ))}
            </div>
            <input className="input w-60" placeholder="Buscar nombre, usuario o área" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="overflow-x-auto">
            <table className="data w-full">
              <thead>
                <tr><th>Cuenta</th><th>Área</th><th>MFA</th><th>Último ingreso</th><th>Roles</th><th>Estado</th></tr>
              </thead>
              <tbody>
                {cargando && !usuarios.length && <tr><td colSpan={6} className="text-center text-ink/50 py-6">Consultando Entra ID…</td></tr>}
                {!cargando && !lista.length && <tr><td colSpan={6} className="text-center text-ink/50 py-6">Nada para revisar en esta vista.</td></tr>}
                {lista.map((u) => {
                  const hace = diasDesde(u.ultimo_ingreso);
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="font-medium text-ink">{u.nombre}</div>
                        <div className="text-xs text-ink/50">{u.upn.replace("#EXT#", " (ext)")}</div>
                      </td>
                      <td className="text-sm text-ink/70">{u.area ?? "—"}</td>
                      <td className="text-sm">
                        {u.mfa == null ? <span className="text-ink/30">N/D</span>
                          : u.mfa ? <span className="text-emerald-700" title={u.metodos.map((m) => METODO[m] ?? m).join(", ")}>
                              Sí <span className="text-xs text-ink/50">· {u.metodos.filter((m) => m !== "email").map((m) => METODO[m] ?? m).slice(0, 2).join(", ")}</span>
                            </span>
                          : <span className="text-red-600 font-medium">No</span>}
                      </td>
                      <td className="text-sm">
                        {d?.disponibles?.ingresos === false ? <span className="text-ink/30">N/D</span> : (
                          <span className={u.inactivo && u.habilitado ? "text-red-600" : "text-ink/70"}>
                            {u.ultimo_ingreso ? `${fd(u.ultimo_ingreso)} (${hace} d)` : "Nunca"}
                          </span>
                        )}
                      </td>
                      <td className="text-sm">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((rol) => (
                            <span key={rol} className={`px-2 py-0.5 rounded text-xs ${CRITICOS.has(rol) ? "bg-red-500/10 text-red-700" : "bg-line/[0.05] text-ink/70"}`}>{rol}</span>
                          ))}
                          {!u.roles.length && <span className="text-ink/30">—</span>}
                        </div>
                      </td>
                      <td className="text-sm">
                        {!u.habilitado ? <span className="text-ink/40">Deshabilitada</span>
                          : u.invitado ? <span className="text-amber-700">{u.estado_invitacion === "PendingAcceptance" ? "Invitación pendiente" : "Invitado"}</span>
                          : <span className="text-ink/70">Activa</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {d?.consultado && <div className="px-3 py-2 text-xs text-ink/40 border-t border-line/[0.08]">Consultado en vivo a Microsoft Graph el {new Date(d.consultado).toLocaleString("es-AR")}. Para deshabilitar o forzar MFA, hacelo desde el centro de administración de Entra.</div>}
        </div>
      )}
    </div>
  );
}
