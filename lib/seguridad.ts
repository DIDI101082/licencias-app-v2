// Reglas para evaluar la seguridad de cada equipo. Ajustá los umbrales acá.
export const DIAS_MAX_SIN_PARCHES = 30;
export const DIAS_MAX_FIRMAS_AV = 3;

export type Nivel = "ok" | "aviso" | "problema" | "sin_datos";
export type Resultado = { nivel: Nivel; texto: string };
export type Control = "bitlocker" | "parches" | "firewall" | "antivirus" | "admins" | "bios" | "win11";

export const CONTROLES: { k: Control; titulo: string; tarjeta: string }[] = [
  { k: "bitlocker", titulo: "Cifrado", tarjeta: "Disco sin cifrar" },
  { k: "parches", titulo: "Parches", tarjeta: `Sin parches hace +${DIAS_MAX_SIN_PARCHES} días` },
  { k: "firewall", titulo: "Firewall", tarjeta: "Firewall apagado" },
  { k: "antivirus", titulo: "Antivirus", tarjeta: "Antivirus con problemas" },
  { k: "admins", titulo: "Admins locales", tarjeta: "Admins no permitidos" },
  { k: "bios", titulo: "Clave BIOS", tarjeta: "BIOS sin clave de administrador" },
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
    return { bitlocker: sin, parches: sin, firewall: sin, antivirus: sin, admins: sin, bios: sin, win11: sin };
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
  // Si hay cifrado de ESET, manda ESET (es el cifrado corporativo); si no, BitLocker de Windows
  const eset: Record<string, Resultado> = {
    cifrado: { nivel: "ok", texto: "Cifrado (ESET)" },
    cifrando: { nivel: "aviso", texto: "Cifrando… (ESET)" },
    pendiente: { nivel: "aviso", texto: "ESET: falta activar (contraseña de inicio o reinicio)" },
    error: { nivel: "problema", texto: "ESET: falló el cifrado" },
    sin_cifrar: { nivel: "problema", texto: "Sin cifrar (ESET instalado)" },
    desconocido: { nivel: "aviso", texto: "ESET: estado sin confirmar" },
  };
  // Linux: cifrado de disco con LUKS
  const luks: Record<string, Resultado> = {
    cifrado: { nivel: "ok", texto: "Cifrado (LUKS)" },
    sin_cifrar: { nivel: "problema", texto: "Sin cifrar (LUKS)" },
  };
  const bitlocker = d.cifrado_producto && /luks/i.test(d.cifrado_producto)
    ? (luks[d.cifrado_estado] ?? { nivel: "aviso" as const, texto: "LUKS: estado sin confirmar" })
    : d.cifrado_producto
    ? (eset[d.cifrado_estado] ?? eset.desconocido)
    : d.bitlocker_estado === "cifrado"
      ? { nivel: "ok" as const, texto: "Cifrado (BitLocker)" }
      : bl[d.bitlocker_estado] ?? sin;

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
    : apagados.length ? { nivel: "problema", texto: apagados.length === 1 && apagados[0] === "Firewall" ? "Apagado" : `Apagado: ${apagados.join(", ")}` }
    : perfiles.some(([k]) => !PERFILES[k] && k !== "Firewall")
      ? { nivel: "ok", texto: perfiles.map(([k]) => k).join(", ") }   // firewall de terceros (ej. ESET)
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

  // En Linux no aplican la clave del BIOS (no se puede leer) ni el control de Windows 11
  const esLinux = !!d.so_nombre && !/windows/i.test(d.so_nombre);

  // Clave del BIOS: la importante es la de administrador (impide cambiar la configuración o arrancar desde USB)
  const bios: Resultado = esLinux
    ? { nivel: "sin_datos", texto: "No aplica (Linux)" }
    : !d.bios_fuente || d.bios_clave_admin == null
    ? { nivel: "sin_datos", texto: d.bios_fuente ? "No se pudo leer" : "Sin datos" }
    : d.bios_clave_admin
      ? { nivel: "ok", texto: d.bios_clave_sistema ? "Con clave (admin y encendido)" : "Con clave de administrador" }
      : { nivel: "problema", texto: "Sin clave de administrador" };

  // Windows 11
  const tpm2 = d.tpm_presente && String(d.tpm_version ?? "").startsWith("2");
  const win11: Resultado = esLinux ? { nivel: "sin_datos", texto: "No aplica (Linux)" }
    : tpm2 && d.secure_boot ? { nivel: "ok", texto: "Apto" }
    : !tpm2 ? { nivel: "aviso", texto: d.tpm_presente ? `TPM ${d.tpm_version}` : "Sin TPM" }
    : { nivel: "aviso", texto: "Secure Boot apagado" };

  return { bitlocker, parches, firewall, antivirus, admins, bios, win11 };
}

export const ESTILO: Record<Nivel, { punto: string; texto: string; etiqueta: string }> = {
  ok: { punto: "bg-emerald-500", texto: "text-ink/70", etiqueta: "Correcto" },
  aviso: { punto: "bg-amber-500", texto: "text-amber-700", etiqueta: "Revisar" },
  problema: { punto: "bg-red-500", texto: "text-red-600 font-medium", etiqueta: "Problema" },
  sin_datos: { punto: "bg-black/20", texto: "text-ink/40", etiqueta: "Sin datos" },
};
