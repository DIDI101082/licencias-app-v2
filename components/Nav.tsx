"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Mark from "./Mark";
import { moduloDeRuta } from "@/lib/modulos";

// Cada solapa es un módulo con sus propias secciones
const modulos = [
  {
    id: "empleados",
    label: "Empleados",
    inicio: "/empleados",
    links: [{ href: "/empleados", label: "Empleados" }],
    admin: [] as { href: string; label: string }[],
  },
  {
    id: "licencias",
    label: "Licencias",
    inicio: "/",
    links: [
      { href: "/", label: "Panel" },
      { href: "/licencias", label: "Licencias" },
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
      { href: "/inventario/escanear", label: "Escanear" },
      { href: "/inventario/personas", label: "Por persona" },
      { href: "/inventario/monitoreo", label: "Monitoreo" },
      { href: "/inventario/aplicaciones", label: "Aplicaciones" },
    ],
    admin: [{ href: "/inventario/catalogos", label: "Categorías y ubicaciones" }],
  },
  {
    id: "seguridad",
    label: "Seguridad",
    inicio: "/inventario/seguridad",
    links: [
      { href: "/inventario/seguridad", label: "Estado de los equipos" },
      { href: "/inventario/riesgos", label: "Riesgos" },
    ],
    admin: [] as { href: string; label: string }[],
  },
  {
    id: "ubicacion",
    label: "Oficina / Home office",
    inicio: "/inventario/ubicacion",
    links: [{ href: "/inventario/ubicacion", label: "Dónde están los equipos" }],
    admin: [] as { href: string; label: string }[],
  },
];

const rolLabel: Record<string, string> = {
  administrador: "Administrador",
  lectura_escritura: "Lectura y escritura",
  solo_lectura: "Solo lectura",
};

export default function Nav({ nombre, rol, modulos: permitidos }: { nombre: string; rol: string; modulos: string[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const esAdmin = rol === "administrador";

  // Solo las solapas habilitadas para el grupo de acceso del usuario
  const visibles = modulos.filter((m) => permitidos.includes(m.id));
  const activo = visibles.find((m) => m.id === moduloDeRuta(pathname)) ?? visibles[0] ?? modulos[0];
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
      <div className="mx-auto max-w-6xl px-4 sm:px-6 pt-4 flex items-center gap-3 sm:gap-5">
        <Link href="/" className="flex items-end gap-1.5 shrink-0" aria-label="Accusys Cyber, inicio">
          <Mark className="h-6" />
          <span className="font-display font-extrabold text-lg text-brand-600 leading-none tracking-tight">Cyber</span>
        </Link>
        {/* Solapas de módulos: si no entran, se desplazan en lugar de encimarse */}
        <div
          role="tablist"
          aria-label="Módulos"
          className="flex gap-1 border-l border-black/10 pl-3 sm:pl-5 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {visibles.map((m) => {
            const sel = m.id === activo.id;
            return (
              <Link
                key={m.id}
                href={m.inicio}
                role="tab"
                aria-selected={sel}
                className={`font-display font-bold tracking-tight px-3 lg:px-4 py-2 whitespace-nowrap text-sm lg:text-base rounded-t-lg border-x border-t -mb-px transition-colors shrink-0 ${
                  sel ? "bg-[#F5F7FB] border-black/[0.06] text-ink" : "border-transparent text-ink/45 hover:text-ink"
                }`}
              >
                {m.label}
              </Link>
            );
          })}
        </div>
        <Reloj />
        <MenuUsuario nombre={nombre} rol={rol} esAdmin={esAdmin} enUsuarios={pathname.startsWith("/usuarios")} onSalir={salir} />
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

// Iniciales para el botón del usuario (sirve con nombre o con email)
function iniciales(nombre: string) {
  const base = nombre.includes("@") ? nombre.split("@")[0].replace(/[._-]+/g, " ") : nombre;
  const partes = base.trim().split(/\s+/).filter(Boolean);
  return ((partes[0]?.[0] ?? "") + (partes.length > 1 ? partes[partes.length - 1][0] : partes[0]?.[1] ?? "")).toUpperCase() || "?";
}

function MenuUsuario({ nombre, rol, esAdmin, enUsuarios, onSalir }: {
  nombre: string; rol: string; esAdmin: boolean; enUsuarios: boolean; onSalir: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAbierto(false); };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", fuera); document.removeEventListener("keydown", esc); };
  }, [abierto]);

  return (
    <div ref={ref} className="relative shrink-0 pb-2">
      <button
        onClick={() => setAbierto(!abierto)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label={`Menú de ${nombre}`}
        className={`h-9 w-9 rounded-full font-display font-bold text-sm flex items-center justify-center transition-colors ${
          abierto || enUsuarios ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700 hover:bg-brand-100"
        }`}
      >
        {iniciales(nombre)}
      </button>
      {abierto && (
        <div role="menu" className="absolute right-0 top-11 z-50 w-64 card p-2 shadow-lg">
          <div className="px-3 py-2 border-b border-black/[0.06] mb-1">
            <div className="text-sm font-medium text-ink break-all">{nombre}</div>
            <div className="text-xs text-ink/50">{rolLabel[rol] ?? rol}</div>
          </div>
          {esAdmin && (
            <Link href="/usuarios" role="menuitem" onClick={() => setAbierto(false)}
              className="block px-3 py-2 rounded-md text-sm text-ink hover:bg-black/[0.04]">
              Usuarios y accesos
            </Link>
          )}
          <button role="menuitem" onClick={onSalir} className="w-full text-left px-3 py-2 rounded-md text-sm text-red-600 hover:bg-red-50">
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

// Fecha y hora actuales (hora de Argentina), junto al botón del usuario
function Reloj() {
  const [ahora, setAhora] = useState<Date | null>(null);

  useEffect(() => {
    setAhora(new Date());
    // se actualiza al cambiar cada minuto
    let intervalo: ReturnType<typeof setInterval> | undefined;
    const alinear = setTimeout(() => {
      setAhora(new Date());
      intervalo = setInterval(() => setAhora(new Date()), 60000);
    }, 60000 - (Date.now() % 60000));
    return () => { clearTimeout(alinear); if (intervalo) clearInterval(intervalo); };
  }, []);

  if (!ahora) return <div className="hidden md:block w-40 shrink-0" aria-hidden />;
  const zona = "America/Argentina/Buenos_Aires";
  const dia = ahora.toLocaleDateString("es-AR", { weekday: "short", timeZone: zona }).replace(".", "");
  const fecha = ahora.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: zona });
  const hora = ahora.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zona });

  return (
    <time
      dateTime={ahora.toISOString()}
      className="hidden md:flex flex-col items-end leading-tight shrink-0 pb-2 text-right"
      title={ahora.toLocaleString("es-AR", { dateStyle: "full", timeStyle: "short", timeZone: zona })}
    >
      <span className="font-display font-bold text-ink text-base tabular-nums">{hora}</span>
      <span className="text-xs text-ink/50 capitalize">{dia} {fecha}</span>
    </time>
  );
}
