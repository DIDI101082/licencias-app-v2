// Reglas para evaluar la seguridad de cada equipo. Ajustá los umbrales acá.
export const DIAS_MAX_SIN_PARCHES = 30;
export const DIAS_MAX_FIRMAS_AV = 3;

export type Nivel = "ok" | "aviso" | "problema" | "sin_datos";
export type Resultado = { nivel: Nivel; texto: string };
export type Control = "bitlocker" | "parches" | "firewall" | "antivirus" | "admins" | "win11";

export const CONTROLES: { k: Control; titulo: string; tarjeta: string }[] = [
  { k: "bitlocker", titulo: "Cifrado", tarjeta: "Disco sin cifrar" },
  { k: "parches", titulo: "Parches", tarjeta: `Sin parches hace +${DIAS_MAX_SIN_PARCHES} días` },
  { k: "firewall", titulo: "Firewall", tarjeta: "Firewall apagado" },
  { k: "antivirus", titulo: "Antivirus", tarjeta: "Antivirus con problemas" },
  { k: "admins", titulo: "Admins locales", tarjeta: "Admins no permitidos" },
  { k: "win11", titulo: "Windows 11", tarjeta: "Sin TPM 2.0 o Secure Boot" },
];

const PERFILES: Record<string, string> = { Domain: "Dominio", Private: "Privado", Public: "Público" };

const dias = (f: string) => Math.floor((Date.now() - new Date(f).getTime()) / 86400000);

export function adminsExtra(admins: any[] | null, permitidos: string[]) {
  const ok = permitidos.map((p) => p.trim().toLowerCase()).filter(Boolean);
  return (admins ?? []).filter((a) => {
    if (a.integrado) return false;
    const n = String(a.nombre ?? "").toLowerCase();
    const corto = n.split("\\").pop() ?? n;
    return !ok.some((p) => p === n || p === corto);
  });
}

export function evaluar(d: any, permitidos: string[]): Record<Control, Resultado> {
  const sin: Resultado = { nivel: "sin_datos", texto: "Sin datos" };
  if (!d.seguridad_actualizado) {
    return { bitlocker: sin, parches: sin, firewall: sin, antivirus: sin, admins: sin, win11: sin };
  }

  // BitLocker
  const bl: Record<string, Resultado> = {
    cifrado: { nivel: "ok", texto: "Cifrado" },
    cifrando: { nivel: "aviso", texto: "Cifrando…" },
    pausado: { nivel: "aviso", texto: "Cifrado en pausa" },
    suspendido: { nivel: "problema", texto: "Protección suspendida" },
    sin_cifrar: { nivel: "problema", texto: "Sin cifrar" },
    descifrando: { nivel: "problema", texto: "Descifrando" },
    no_disponible: { nivel: "aviso", texto: "No disponible" },
  };
  const bitlocker = bl[d.bitlocker_estado] ?? sin;

  // Parches
  let parches: Resultado = { nivel: "aviso", texto: "Sin historial" };
  if (d.ultimo_parche) {
    const n = dias(d.ultimo_parche);
    parches = { nivel: n > DIAS_MAX_SIN_PARCHES ? "problema" : "ok", texto: n === 0 ? "Hoy" : `Hace ${n} días` };
  }
  if (d.reinicio_pendiente) {
    parches = { nivel: parches.nivel === "problema" ? "problema" : "aviso", texto: `${parches.texto} · reinicio pendiente` };
  }

  // Firewall
  const perfiles = Object.entries(d.firewall_perfiles ?? {});
  const apagados = perfiles.filter(([, v]) => !v).map(([k]) => PERFILES[k] ?? k);
  const firewall: Resultado = perfiles.length === 0 ? sin
    : apagados.length ? { nivel: "problema", texto: `Apagado: ${apagados.join(", ")}` }
    : { nivel: "ok", texto: "Activo" };

  // Antivirus
  const activos = (d.av_productos ?? []).filter((p: any) => p.activo);
  let antivirus: Resultado;
  if (activos.length === 0) antivirus = { nivel: "problema", texto: "Sin antivirus activo" };
  else if (activos.some((p: any) => !p.actualizado)) antivirus = { nivel: "problema", texto: `${activos[0].nombre} desactualizado` };
  else {
    antivirus = { nivel: "ok", texto: activos.map((p: any) => p.nombre).join(", ") };
    const usaDefender = activos.some((p: any) => /defender/i.test(p.nombre));
    if (usaDefender && d.av_firmas_fecha && dias(d.av_firmas_fecha) > DIAS_MAX_FIRMAS_AV) {
      antivirus = { nivel: "aviso", texto: `Firmas de hace ${dias(d.av_firmas_fecha)} días` };
    }
  }

  // Admins
  let admins: Resultado = sin;
  if (d.admins_locales) {
    const extra = adminsExtra(d.admins_locales, permitidos);
    admins = extra.length
      ? { nivel: "aviso", texto: extra.length === 1 ? String(extra[0].nombre) : `${extra.length} no permitidos` }
      : { nivel: "ok", texto: "Solo permitidos" };
  }

  // Windows 11
  const tpm2 = d.tpm_presente && String(d.tpm_version ?? "").startsWith("2");
  const win11: Resultado = tpm2 && d.secure_boot ? { nivel: "ok", texto: "Apto" }
    : !tpm2 ? { nivel: "aviso", texto: d.tpm_presente ? `TPM ${d.tpm_version}` : "Sin TPM" }
    : { nivel: "aviso", texto: "Secure Boot apagado" };

  return { bitlocker, parches, firewall, antivirus, admins, win11 };
}

export const ESTILO: Record<Nivel, { punto: string; texto: string; etiqueta: string }> = {
  ok: { punto: "bg-emerald-500", texto: "text-ink/70", etiqueta: "Correcto" },
  aviso: { punto: "bg-amber-500", texto: "text-amber-700", etiqueta: "Revisar" },
  problema: { punto: "bg-red-500", texto: "text-red-600 font-medium", etiqueta: "Problema" },
  sin_datos: { punto: "bg-black/20", texto: "text-ink/40", etiqueta: "Sin datos" },
};
