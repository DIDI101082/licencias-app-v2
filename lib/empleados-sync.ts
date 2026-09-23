// Lógica compartida para importar empleados desde Excel o Entra ID.
// Compara la fuente contra los empleados actuales y arma un plan de cambios
// que primero se muestra y recién después se aplica.

export type EmpleadoFuente = {
  entra_id?: string | null;
  nombre: string;
  apellido: string;
  email: string;
  area: string;
  puesto?: string | null;
  activo?: boolean; // solo Entra: false si la cuenta está deshabilitada
};

export type EmpleadoActual = {
  id: string;
  entra_id?: string | null;
  nombre: string;
  apellido: string;
  email: string;
  area: string;
  puesto: string | null;
  activo: boolean;
};

export type Cambio = { id: string; nombre: string; campos: Record<string, { antes: any; despues: any }> };

export type Plan = {
  nuevos: EmpleadoFuente[];
  actualizar: Cambio[];
  desactivar: { id: string; nombre: string; email: string }[];
  sinCambios: number;
  errores: string[];
};

const norm = (s: string | null | undefined) => (s ?? "").trim();

export function calcularPlan(
  fuente: EmpleadoFuente[],
  actuales: EmpleadoActual[],
  opciones: { desactivarAusentes: boolean }
): Plan {
  const plan: Plan = { nuevos: [], actualizar: [], desactivar: [], sinCambios: 0, errores: [] };
  const porEntra = new Map(actuales.filter((a) => a.entra_id).map((a) => [a.entra_id!, a]));
  const porEmail = new Map(actuales.map((a) => [a.email.toLowerCase(), a]));
  const vistos = new Set<string>();
  const emailsVistos = new Set<string>();

  for (const f of fuente) {
    const email = norm(f.email).toLowerCase();
    if (!email || !norm(f.nombre) || !norm(f.apellido) || !norm(f.area)) {
      plan.errores.push(`${f.nombre || f.email || "Fila sin datos"}: falta nombre, apellido, email o área`);
      continue;
    }
    if (emailsVistos.has(email)) {
      plan.errores.push(`${email}: aparece más de una vez, se usa la primera`);
      continue;
    }
    emailsVistos.add(email);

    const actual = (f.entra_id && porEntra.get(f.entra_id)) || porEmail.get(email);
    if (!actual) {
      if (f.activo === false) continue; // no se crean cuentas deshabilitadas
      plan.nuevos.push({ ...f, email, nombre: norm(f.nombre), apellido: norm(f.apellido), area: norm(f.area), puesto: norm(f.puesto) || null });
      continue;
    }
    vistos.add(actual.id);

    const campos: Cambio["campos"] = {};
    const comparar = (k: keyof EmpleadoActual, nuevo: any) => {
      if (nuevo === undefined || nuevo === null || nuevo === "") return; // nunca se borra un dato con un vacío
      if (String(actual[k] ?? "") !== String(nuevo)) campos[k] = { antes: actual[k] ?? null, despues: nuevo };
    };
    comparar("nombre", norm(f.nombre));
    comparar("apellido", norm(f.apellido));
    comparar("email", email);
    comparar("area", norm(f.area));
    comparar("puesto", norm(f.puesto));
    if (f.entra_id) comparar("entra_id", f.entra_id);
    if (f.activo !== undefined) comparar("activo", f.activo);

    if (Object.keys(campos).length) {
      plan.actualizar.push({ id: actual.id, nombre: `${actual.nombre} ${actual.apellido}`, campos });
    } else {
      plan.sinCambios++;
    }
  }

  if (opciones.desactivarAusentes) {
    // Empleados que vinieron de Entra y ya no existen ahí (cuenta eliminada)
    for (const a of actuales) {
      if (a.entra_id && a.activo && !vistos.has(a.id)) {
        plan.desactivar.push({ id: a.id, nombre: `${a.nombre} ${a.apellido}`, email: a.email });
      }
    }
  }
  return plan;
}

export const ETIQUETAS: Record<string, string> = {
  nombre: "Nombre", apellido: "Apellido", email: "Email", area: "Área", puesto: "Puesto",
  entra_id: "Vínculo con Entra ID", activo: "Estado",
};

export function textoValor(k: string, v: any) {
  if (k === "activo") return v ? "Activo" : "Inactivo";
  if (k === "entra_id") return v ? "vinculado" : "sin vincular";
  return v ?? "—";
}
