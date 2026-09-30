"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Pagina } from "@/lib/menu";

type Resultado = { tipo: string; texto: string; detalle?: string; href: string };

// Solo letras, números y separadores comunes: evita romper el filtro de la consulta (comas, paréntesis, comodines)
const limpiar = (q: string) => q.replace(/[^\p{L}\p{N} .@_:-]/gu, " ").replace(/\s+/g, " ").trim();
const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Buscador global (Ctrl+K): páginas del menú que el usuario puede abrir, y personas, equipos, servidores,
// direcciones públicas y dominios. Cada consulta respeta los permisos de quien busca.
export default function Buscador({ temas, onCerrar }: { temas: { label: string; paginas: Pagina[] }[]; onCerrar: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [datos, setDatos] = useState<Resultado[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const t = limpiar(q);
    if (t.length < 2) { setDatos([]); return; }
    setBuscando(true);
    const temporizador = setTimeout(async () => {
      const sb = createClient();
      const p = `%${t}%`;
      const nada = { data: [] as any[] };
      const intentar = async (c: PromiseLike<{ data: any; error: any }>) => { try { const r = await c; return r.error ? nada : r; } catch { return nada; } };
      const [emp, eq, disp, sup, dom] = await Promise.all([
        intentar(sb.from("empleados").select("id, nombre, apellido, email, area, activo").or(`nombre.ilike.${p},apellido.ilike.${p},email.ilike.${p}`).limit(6)),
        intentar(sb.from("inv_equipos").select("id, codigo, numero_serie, marca, modelo").or(`codigo.ilike.${p},numero_serie.ilike.${p},modelo.ilike.${p}`).limit(6)),
        intentar(sb.from("inv_dispositivos").select("id, hostname, equipo_id, tipo").ilike("hostname", p).limit(6)),
        intentar(sb.from("sup_objetivos").select("id, direccion, descripcion, ip").or(`direccion.ilike.${p},descripcion.ilike.${p},ip.ilike.${p}`).limit(4)),
        intentar(sb.from("correo_dominios").select("dominio").ilike("dominio", p).limit(3)),
      ]);
      const r: Resultado[] = [
        ...emp.data.map((e: any) => ({ tipo: "Persona", texto: `${e.nombre ?? ""} ${e.apellido ?? ""}`.trim() || e.email, detalle: [e.area, e.activo === false ? "inactivo" : null].filter(Boolean).join(" · "), href: `/empleados/${e.id}` })),
        ...eq.data.map((e: any) => ({ tipo: "Equipo", texto: e.codigo ?? e.numero_serie, detalle: [e.marca, e.modelo, e.numero_serie].filter(Boolean).join(" · "), href: `/inventario/equipos/${e.id}` })),
        ...disp.data.map((d: any) => ({ tipo: d.tipo === "servidor" ? "Servidor" : "Dispositivo", texto: d.hostname, detalle: "con el agente", href: d.equipo_id ? `/inventario/equipos/${d.equipo_id}` : "/inventario/monitoreo" })),
        ...sup.data.map((o: any) => ({ tipo: "IP pública", texto: o.direccion, detalle: o.descripcion ?? o.ip ?? "", href: "/inventario/superficie" })),
        ...dom.data.map((d: any) => ({ tipo: "Dominio", texto: d.dominio, detalle: "correo y dominio", href: "/inventario/correo" })),
      ];
      setDatos(r); setBuscando(false); setSel(0);
    }, 250);
    return () => clearTimeout(temporizador);
  }, [q]);

  const n = sinTildes(q.trim());
  const paginas: Resultado[] = temas.flatMap((t) => t.paginas.map((p) => ({ tipo: "Página", texto: p.label, detalle: t.label, href: p.href })))
    .filter((p) => !n || sinTildes(`${p.texto} ${p.detalle}`).includes(n)).slice(0, n ? 6 : 8);
  const lista = [...paginas, ...datos];

  function abrir(r: Resultado) { onCerrar(); router.push(r.href); }

  function teclas(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCerrar();
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, lista.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && lista[sel]) { e.preventDefault(); abrir(lista[sel]); }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center px-4 pt-[12vh] print:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div role="dialog" aria-label="Buscar" className="w-full max-w-xl card shadow-2xl overflow-hidden">
        <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={teclas}
          placeholder="Buscar persona, equipo, servidor, IP, dominio o página…" aria-label="Buscar"
          className="w-full bg-transparent px-4 py-3.5 text-base text-ink outline-none border-b border-line/[0.08]" />
        <ul className="max-h-[55vh] overflow-y-auto p-1.5">
          {lista.map((r, i) => (
            <li key={`${r.tipo}:${r.href}:${r.texto}`}>
              <button onMouseEnter={() => setSel(i)} onClick={() => abrir(r)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left text-sm ${i === sel ? "bg-brand-50 text-brand-700" : "text-ink"}`}>
                <span className="w-20 shrink-0 text-xs text-ink/50">{r.tipo}</span>
                <span className="font-medium truncate">{r.texto}</span>
                {r.detalle && <span className="ml-auto text-xs text-ink/50 truncate max-w-[45%]">{r.detalle}</span>}
              </button>
            </li>
          ))}
          {!lista.length && <li className="px-3 py-4 text-sm text-ink/50">{buscando ? "Buscando…" : "Sin resultados. Probá con otro nombre, un código de equipo o una IP."}</li>}
          {buscando && lista.length > 0 && <li className="px-3 py-1.5 text-xs text-ink/40">Buscando más…</li>}
        </ul>
        <div className="px-4 py-2 text-xs text-ink/45 border-t border-line/[0.06] flex gap-4">
          <span>↑ ↓ para moverte</span><span>Enter para abrir</span><span>Esc para cerrar</span>
        </div>
      </div>
    </div>
  );
}
