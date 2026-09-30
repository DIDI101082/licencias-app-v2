"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Mark from "./Mark";
import { temasVisibles, ubicar, type PaginasGrupo } from "@/lib/menu";
import { type Tema, type Diseno, temaGuardado, guardarTema, aplicarTema, disenoGuardado, guardarDiseno } from "@/lib/tema";
import Buscador from "./Buscador";

const rolLabel: Record<string, string> = {
  administrador: "Administrador",
  lectura_escritura: "Lectura y escritura",
  solo_lectura: "Solo lectura",
};

export default function Nav({ nombre, rol, modulos: permitidos, paginas }: { nombre: string; rol: string; modulos: string[]; paginas?: PaginasGrupo | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const esAdmin = rol === "administrador";
  const [buscar, setBuscar] = useState(false);

  // Temas con las páginas que el usuario puede ver según su grupo de acceso (los vacíos no aparecen)
  const temas = temasVisibles(permitidos, paginas, esAdmin);
  const aqui = ubicar(temas, pathname);
  const activo = temas.find((t) => t.id === aqui?.tema) ?? null;
  const solapas = temas.map((t) => ({ id: t.id, label: t.label, titulo: t.titulo, inicio: t.paginas[0].href }));
  const esActual = (href: string) => aqui?.href === href;

  // Ctrl+K (o Cmd+K) abre el buscador desde cualquier pantalla
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setBuscar(true); } };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, []);

  async function salir() {
    // queda registrada la salida en Logs (si falla, se cierra la sesión igual)
    try { await supabase.rpc("registrar_ingreso", { p_accion: "logout" }); } catch {}
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const botonBuscar = (clase: string, lateralTexto = false) => (
    <button onClick={() => setBuscar(true)} aria-label="Buscar (Ctrl K)" title="Buscar (Ctrl K)"
      className={`flex items-center gap-2 rounded-lg border border-line/10 bg-canvas text-ink/55 hover:text-ink text-sm ${clase}`}>
      <span aria-hidden>⌕</span><span className={lateralTexto ? "" : "hidden 2xl:inline"}>Buscar</span>
      <kbd className={`hidden sm:inline text-[11px] font-sans border border-line/10 rounded px-1 bg-surface ${lateralTexto ? "ml-auto" : ""}`}>Ctrl K</kbd>
    </button>
  );

  return (
    <>
      {/* Diseño 1: solapas arriba */}
      <header className="nav-superior border-b border-line/[0.06] bg-surface print:hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-4 flex flex-wrap md:flex-nowrap items-center gap-x-3 sm:gap-x-5 gap-y-2">
          <Link href={solapas[0]?.inicio ?? "/"} className="flex items-end gap-1.5 shrink-0" aria-label="Accusys Cyber, inicio">
            <Mark className="h-6" />
            <span className="font-display font-extrabold text-lg text-brand-600 leading-none tracking-tight">Cyber</span>
          </Link>
          {/* Solapas de temas: si no entran, se desplazan y se marca que hay más a los costados */}
          <Solapas visibles={solapas} activoId={activo?.id ?? ""} />
          <div className="md:pb-2 shrink-0 max-md:ml-auto">{botonBuscar("px-2.5 py-1.5")}</div>
          <Reloj />
          <MenuUsuario nombre={nombre} rol={rol} esAdmin={esAdmin} enUsuarios={pathname.startsWith("/usuarios")} onSalir={salir} />
        </div>
        {/* Páginas del tema activo */}
        {activo && (
          <nav className="bg-canvas border-t border-line/[0.06]" aria-label={`Páginas de ${activo.label}`}>
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-2 flex gap-1 overflow-x-auto">
              {activo.paginas.map((l) => (
                <Link key={l.href} href={l.href} aria-current={esActual(l.href) ? "page" : undefined}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                    esActual(l.href) ? "bg-surface text-brand-700 shadow-sm" : "text-ink/60 hover:text-ink hover:bg-white/60"
                  }`}>
                  {l.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </header>

      {/* Diseño 2: menú lateral (desde 1024 px de ancho) */}
      <aside className="nav-lateral fixed inset-y-0 left-0 z-40 w-64 flex-col gap-3 border-r border-line/[0.06] bg-surface px-3 py-4 print:hidden" aria-label="Menú principal">
        <Link href={solapas[0]?.inicio ?? "/"} className="flex items-end gap-1.5 px-2" aria-label="Accusys Cyber, inicio">
          <Mark className="h-6" />
          <span className="font-display font-extrabold text-lg text-brand-600 leading-none tracking-tight">Cyber</span>
        </Link>
        {botonBuscar("w-full px-3 py-2", true)}
        <nav className="flex-1 overflow-y-auto -mx-1 px-1 space-y-0.5">
          {temas.map((t) => <GrupoLateral key={t.id} tema={t} activo={t.id === activo?.id} esActual={esActual} />)}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-line/[0.06] pt-3">
          <MenuUsuario nombre={nombre} rol={rol} esAdmin={esAdmin} enUsuarios={pathname.startsWith("/usuarios")} onSalir={salir} arriba />
          <Reloj siempre />
        </div>
      </aside>

      {buscar && <Buscador temas={temas} onCerrar={() => setBuscar(false)} />}
    </>
  );
}

// Un tema del menú lateral: se abre solo si es el de la página actual; los demás, a demanda
function GrupoLateral({ tema, activo, esActual }: { tema: { id: string; label: string; paginas: { href: string; label: string }[] }; activo: boolean; esActual: (h: string) => boolean }) {
  const [abierto, setAbierto] = useState(activo);
  useEffect(() => { if (activo) setAbierto(true); }, [activo]);
  return (
    <div>
      <button onClick={() => setAbierto(!abierto)} aria-expanded={abierto}
        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider ${activo ? "text-ink" : "text-ink/50 hover:text-ink"}`}>
        {tema.label}<span aria-hidden className={`transition-transform ${abierto ? "rotate-90" : ""}`}>›</span>
      </button>
      {abierto && (
        <div className="mb-1.5 space-y-0.5">
          {tema.paginas.map((p) => (
            <Link key={p.href} href={p.href} aria-current={esActual(p.href) ? "page" : undefined}
              className={`block px-3 py-1.5 rounded-md text-sm transition-colors ${esActual(p.href) ? "bg-brand-50 text-brand-700 font-medium" : "text-ink/70 hover:text-ink hover:bg-line/[0.04]"}`}>
              {p.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// Barra de solapas. Si no entran todas, se puede desplazar: aparece un degradé y una flecha
// del lado donde hay más solapas, y la solapa activa siempre queda a la vista.
function Solapas({ visibles, activoId }: { visibles: { id: string; label: string; inicio: string; titulo?: string }[]; activoId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [izq, setIzq] = useState(false);
  const [der, setDer] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => {
      setIzq(el.scrollLeft > 2);
      setDer(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    };
    medir();
    el.addEventListener("scroll", medir, { passive: true });
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", medir); ro.disconnect(); };
  }, [visibles.length]);

  // La solapa activa siempre a la vista (por ejemplo, al entrar a Logs en una pantalla angosta)
  useEffect(() => {
    const sel = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    sel?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activoId]);

  const mover = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * 200, behavior: "smooth" });

  return (
    <div className="relative min-w-0 flex-1 md:border-l border-line/10 md:pl-4 max-md:order-last max-md:basis-full">
      <div
        ref={ref}
        role="tablist"
        aria-label="Módulos"
        className="flex gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {visibles.map((m) => {
          const sel = m.id === activoId;
          return (
            <Link
              key={m.id}
              href={m.inicio}
              role="tab"
              aria-selected={sel}
              title={m.titulo ?? m.label}
              className={`font-display font-bold tracking-tight px-2.5 py-2 whitespace-nowrap text-sm 2xl:text-[15px] rounded-t-lg border-x border-t -mb-px transition-colors shrink-0 ${
                sel ? "bg-canvas border-line/[0.06] text-ink" : "border-transparent text-ink/45 hover:text-ink"
              }`}
            >
              {m.label}
            </Link>
          );
        })}
      </div>
      {izq && (
        <button type="button" onClick={() => mover(-1)} aria-label="Ver solapas anteriores"
          className="absolute left-2 sm:left-4 top-0 bottom-0 w-9 flex items-center justify-start text-ink/60 hover:text-ink bg-gradient-to-r from-surface via-surface/90 to-transparent">
          <span aria-hidden className="text-lg leading-none">‹</span>
        </button>
      )}
      {der && (
        <button type="button" onClick={() => mover(1)} aria-label="Ver más solapas"
          className="absolute right-0 top-0 bottom-0 w-9 flex items-center justify-end text-ink/60 hover:text-ink bg-gradient-to-l from-surface via-surface/90 to-transparent">
          <span aria-hidden className="text-lg leading-none">›</span>
        </button>
      )}
    </div>
  );
}

// Iniciales para el botón del usuario (sirve con nombre o con email)
function iniciales(nombre: string) {
  const base = nombre.includes("@") ? nombre.split("@")[0].replace(/[._-]+/g, " ") : nombre;
  const partes = base.trim().split(/\s+/).filter(Boolean);
  return ((partes[0]?.[0] ?? "") + (partes.length > 1 ? partes[partes.length - 1][0] : partes[0]?.[1] ?? "")).toUpperCase() || "?";
}

function MenuUsuario({ nombre, rol, esAdmin, enUsuarios, onSalir, arriba = false }: {
  nombre: string; rol: string; esAdmin: boolean; enUsuarios: boolean; onSalir: () => void; arriba?: boolean;
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
    <div ref={ref} className={`relative shrink-0 ${arriba ? "" : "md:pb-2"}`}>
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
        <div role="menu" className={`absolute z-50 w-64 card p-2 shadow-lg ${arriba ? "left-0 bottom-11" : "right-0 top-11"}`}>
          <div className="px-3 py-2 border-b border-line/[0.06] mb-1">
            <div className="text-sm font-medium text-ink break-all">{nombre}</div>
            <div className="text-xs text-ink/50">{rolLabel[rol] ?? rol}</div>
          </div>
          {esAdmin && (
            <Link href="/usuarios" role="menuitem" onClick={() => setAbierto(false)}
              className="block px-3 py-2 rounded-md text-sm text-ink hover:bg-line/[0.04]">
              Usuarios y accesos
            </Link>
          )}
          <SelectorTema />
          <SelectorDiseno />
          <button role="menuitem" onClick={onSalir} className="w-full text-left px-3 py-2 rounded-md text-sm text-red-600 hover:bg-red-50">
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

// Fecha y hora actuales (hora de Argentina), junto al botón del usuario
function Reloj({ siempre = false }: { siempre?: boolean }) {
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

  if (!ahora) return <div className={siempre ? "w-24" : "hidden md:block w-40 shrink-0"} aria-hidden />;
  const zona = "America/Argentina/Buenos_Aires";
  const dia = ahora.toLocaleDateString("es-AR", { weekday: "short", timeZone: zona }).replace(".", "");
  const fecha = ahora.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: zona });
  const hora = ahora.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zona });

  return (
    <time
      dateTime={ahora.toISOString()}
      className={`${siempre ? "flex" : "hidden md:flex pb-2"} flex-col items-end leading-tight shrink-0 text-right`}
      title={ahora.toLocaleString("es-AR", { dateStyle: "full", timeStyle: "short", timeZone: zona })}
    >
      <span className="font-display font-bold text-ink text-base tabular-nums">{hora}</span>
      <span className="text-xs text-ink/50 capitalize">{dia} {fecha}</span>
    </time>
  );
}

// Claro / Oscuro / Automático (sigue a Windows, macOS o el celular)
function SelectorTema() {
  const [tema, setTema] = useState<Tema>("auto");

  useEffect(() => {
    setTema(temaGuardado());
    // en automático, acompaña los cambios del sistema (por ejemplo, el modo nocturno)
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const cambio = () => { if (temaGuardado() === "auto") aplicarTema("auto"); };
    mq.addEventListener("change", cambio);
    return () => mq.removeEventListener("change", cambio);
  }, []);

  const opciones: [Tema, string, string][] = [["claro", "☀", "Claro"], ["oscuro", "☾", "Oscuro"], ["auto", "◐", "Auto"]];
  return (
    <div className="px-3 py-2 border-b border-line/[0.06] mb-1">
      <div className="text-xs text-ink/50 mb-1.5">Apariencia</div>
      <div role="radiogroup" aria-label="Apariencia" className="grid grid-cols-3 gap-1 rounded-lg bg-line/[0.05] p-0.5">
        {opciones.map(([k, icono, texto]) => (
          <button key={k} role="radio" aria-checked={tema === k}
            onClick={() => { setTema(k); guardarTema(k); }}
            className={`rounded-md py-1 text-xs font-medium transition-colors ${tema === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
            <span aria-hidden className="mr-1">{icono}</span>{texto}
          </button>
        ))}
      </div>
    </div>
  );
}

// Solapas arriba o menú lateral (se recuerda en este navegador, como el tema)
function SelectorDiseno() {
  const [d, setD] = useState<Diseno>("solapas");
  useEffect(() => { setD(disenoGuardado()); }, []);
  const opciones: [Diseno, string][] = [["solapas", "Solapas arriba"], ["lateral", "Menú lateral"]];
  return (
    <div className="px-3 py-2 border-b border-line/[0.06] mb-1">
      <div className="text-xs text-ink/50 mb-1.5">Menú</div>
      <div role="radiogroup" aria-label="Diseño del menú" className="grid grid-cols-2 gap-1 rounded-lg bg-line/[0.05] p-0.5">
        {opciones.map(([k, texto]) => (
          <button key={k} role="radio" aria-checked={d === k}
            onClick={() => { setD(k); guardarDiseno(k); }}
            className={`rounded-md py-1 text-xs font-medium transition-colors ${d === k ? "bg-surface text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}>
            {texto}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-ink/40 mt-1">El menú lateral se usa en pantallas anchas.</div>
    </div>
  );
}
