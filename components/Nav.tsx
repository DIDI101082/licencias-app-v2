"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Mark from "./Mark";

// Cada solapa es un módulo con sus propias secciones
const modulos = [
  {
    id: "licencias",
    label: "Licencias",
    inicio: "/",
    links: [
      { href: "/", label: "Panel" },
      { href: "/licencias", label: "Licencias" },
      { href: "/empleados", label: "Empleados" },
      { href: "/asignaciones", label: "Asignaciones" },
      { href: "/reportes", label: "Reportes" },
    ],
    admin: [] as { href: string; label: string }[],
  },
  {
    id: "inventario",
    label: "Inventario IT",
    inicio: "/inventario",
    links: [
      { href: "/inventario", label: "Panel" },
      { href: "/inventario/equipos", label: "Equipos" },
      { href: "/inventario/personas", label: "Por persona" },
      { href: "/inventario/monitoreo", label: "Monitoreo" },
      { href: "/inventario/aplicaciones", label: "Aplicaciones" },
      { href: "/inventario/seguridad", label: "Seguridad" },
    ],
    admin: [{ href: "/inventario/catalogos", label: "Categorías y ubicaciones" }],
  },
];

const rolLabel: Record<string, string> = {
  administrador: "Administrador",
  lectura_escritura: "Lectura y escritura",
  solo_lectura: "Solo lectura",
};

export default function Nav({ nombre, rol }: { nombre: string; rol: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const esAdmin = rol === "administrador";

  const activo = pathname.startsWith("/inventario") ? modulos[1] : modulos[0];
  const subLinks = [...activo.links, ...(esAdmin ? activo.admin : [])];

  function esActual(href: string) {
    if (href === "/" || href === "/inventario") return pathname === href;
    return pathname.startsWith(href);
  }

  async function salir() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-black/[0.06] bg-white print:hidden">
      <div className="mx-auto max-w-6xl px-6 pt-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center">
            <Mark className="h-6" />
          </Link>
          {/* Solapas de módulos */}
          <div role="tablist" aria-label="Módulos" className="flex gap-1 border-l border-black/10 pl-6">
            {modulos.map((m) => {
              const sel = m.id === activo.id;
              return (
                <Link
                  key={m.id}
                  href={m.inicio}
                  role="tab"
                  aria-selected={sel}
                  className={`font-display font-bold tracking-tight px-4 py-2 rounded-t-lg border-x border-t -mb-px transition-colors ${
                    sel
                      ? "bg-[#F5F7FB] border-black/[0.06] text-ink"
                      : "border-transparent text-ink/45 hover:text-ink"
                  }`}
                >
                  {m.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3 pb-2">
          {esAdmin && (
            <Link
              href="/usuarios"
              className={`text-sm font-medium px-3 py-1.5 rounded-md ${
                pathname.startsWith("/usuarios") ? "bg-brand-50 text-brand-700" : "text-ink/60 hover:text-ink"
              }`}
            >
              Usuarios
            </Link>
          )}
          <div className="text-right leading-tight">
            <div className="text-sm font-medium text-ink">{nombre}</div>
            <div className="text-xs text-ink/50">{rolLabel[rol] ?? rol}</div>
          </div>
          <button onClick={salir} className="btn-secondary">
            Salir
          </button>
        </div>
      </div>
      {/* Secciones de la solapa activa */}
      <nav className="bg-[#F5F7FB] border-t border-black/[0.06]">
        <div className="mx-auto max-w-6xl px-6 py-2 flex gap-1 overflow-x-auto">
          {subLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={esActual(l.href) ? "page" : undefined}
              className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                esActual(l.href)
                  ? "bg-white text-brand-700 shadow-sm"
                  : "text-ink/60 hover:text-ink hover:bg-white/60"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
