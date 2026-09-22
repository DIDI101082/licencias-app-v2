"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Mark from "./Mark";

const links = [
  { href: "/", label: "Panel" },
  { href: "/licencias", label: "Licencias" },
  { href: "/empleados", label: "Empleados" },
  { href: "/asignaciones", label: "Asignaciones" },
  { href: "/reportes", label: "Reportes" },
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

  const visibleLinks =
    rol === "administrador"
      ? [...links, { href: "/usuarios", label: "Usuarios" }]
      : links;

  async function salir() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-black/[0.06] bg-white">
      <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <span className="flex items-center gap-2">
            <Mark className="h-5 w-5" />
            <span className="font-display font-bold text-lg text-ink tracking-tight">
              Licencias
            </span>
            <span className="hidden sm:inline text-xs text-ink/40 font-medium border-l border-black/10 pl-2 ml-1">
              Accusys
            </span>
          </span>
          <nav className="flex gap-1">
            {visibleLinks.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  pathname === l.href
                    ? "bg-brand-50 text-brand-700"
                    : "text-ink/60 hover:text-ink hover:bg-black/[0.03]"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right leading-tight">
            <div className="text-sm font-medium text-ink">{nombre}</div>
            <div className="text-xs text-ink/50">{rolLabel[rol] ?? rol}</div>
          </div>
          <button onClick={salir} className="btn-secondary">
            Salir
          </button>
        </div>
      </div>
    </header>
  );
}
