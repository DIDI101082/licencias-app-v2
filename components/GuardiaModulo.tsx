"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { INICIO_MODULO, NOMBRE_MODULO, moduloDeRuta, type Modulo } from "@/lib/modulos";
import { MENU, puedeVerPagina, inicioPermitido, type PaginasGrupo } from "@/lib/menu";

// Si el usuario entra a una solapa que no tiene habilitada (por ejemplo, escribiendo la dirección),
// no se muestra la pantalla. Los datos igual están protegidos en la base de datos.
export default function GuardiaModulo({ modulos, paginas, children }: { modulos: Modulo[]; paginas?: PaginasGrupo | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const modulo = moduloDeRuta(pathname);
  const seccion = MENU.find((m) => m.id === modulo);
  const moduloOk = !modulo || modulos.includes(modulo);
  // Dentro de una solapa habilitada, el grupo puede tener solo algunas páginas
  const paginaOk = !moduloOk || !seccion || puedeVerPagina(paginas, seccion, pathname);
  const permitido = moduloOk && paginaOk;
  const inicio = (m: Modulo) => { const s = MENU.find((x) => x.id === m); return s ? inicioPermitido(paginas, s) : INICIO_MODULO[m]; };

  // Al entrar a la página de inicio sin acceso a Licencias, ir a la primera solapa habilitada
  useEffect(() => {
    if (!permitido && pathname === "/" && modulos.length) router.replace(inicio(modulos[0]));
  }, [permitido, pathname, modulos, router]);

  if (permitido) return <>{children}</>;
  if (modulos.length === 0) {
    return (
      <div className="card p-6 max-w-md">
        <h1 className="font-display text-xl text-ink mb-2">Acceso pendiente</h1>
        <p className="text-sm text-ink/60">
          Tu usuario ya está registrado, pero todavía no tiene solapas habilitadas. Pedile a un administrador que te asigne un grupo de
          acceso; cuando lo haga, refrescá esta página.
        </p>
      </div>
    );
  }
  if (pathname === "/" && modulos.length) return null;
  if (moduloOk && !paginaOk && modulo) {
    return (
      <div className="card p-6 max-w-md">
        <h1 className="font-display text-xl text-ink mb-2">Sin acceso</h1>
        <p className="text-sm text-ink/60">Tu grupo no tiene habilitada esta página de {NOMBRE_MODULO[modulo]}. Si la necesitás, pedíselo a un administrador.</p>
        <Link href={inicio(modulo)} className="btn-secondary mt-4 inline-flex">Ir a {NOMBRE_MODULO[modulo]}</Link>
      </div>
    );
  }

  return (
    <div className="card p-6 max-w-md">
      <h1 className="font-display text-xl text-ink mb-2">Sin acceso</h1>
      <p className="text-sm text-ink/60">
        Tu usuario no tiene habilitada la solapa {modulo ? NOMBRE_MODULO[modulo] : ""}. Si la necesitás, pedíselo a un administrador.
      </p>
      {modulos.length > 0 && (
        <Link href={inicio(modulos[0])} className="btn-secondary mt-4 inline-flex">Ir a {NOMBRE_MODULO[modulos[0]]}</Link>
      )}
    </div>
  );
}
