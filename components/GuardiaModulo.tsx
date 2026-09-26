"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { INICIO_MODULO, NOMBRE_MODULO, moduloDeRuta, type Modulo } from "@/lib/modulos";

// Si el usuario entra a una solapa que no tiene habilitada (por ejemplo, escribiendo la dirección),
// no se muestra la pantalla. Los datos igual están protegidos en la base de datos.
export default function GuardiaModulo({ modulos, children }: { modulos: Modulo[]; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const modulo = moduloDeRuta(pathname);
  const permitido = !modulo || modulos.includes(modulo);

  // Al entrar a la página de inicio sin acceso a Licencias, ir a la primera solapa habilitada
  useEffect(() => {
    if (!permitido && pathname === "/" && modulos.length) router.replace(INICIO_MODULO[modulos[0]]);
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

  return (
    <div className="card p-6 max-w-md">
      <h1 className="font-display text-xl text-ink mb-2">Sin acceso</h1>
      <p className="text-sm text-ink/60">
        Tu usuario no tiene habilitada la solapa {modulo ? NOMBRE_MODULO[modulo] : ""}. Si la necesitás, pedíselo a un administrador.
      </p>
      {modulos.length > 0 && (
        <Link href={INICIO_MODULO[modulos[0]]} className="btn-secondary mt-4 inline-flex">Ir a {NOMBRE_MODULO[modulos[0]]}</Link>
      )}
    </div>
  );
}
