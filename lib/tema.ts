// Modo claro / oscuro. Se guarda por navegador; "auto" sigue la configuración del sistema.
export type Tema = "claro" | "oscuro" | "auto";
const CLAVE = "accusys-tema";

export function temaGuardado(): Tema {
  try {
    const t = localStorage.getItem(CLAVE);
    return t === "claro" || t === "oscuro" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function aplicarTema(t: Tema) {
  const oscuro = t === "oscuro" || (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", oscuro);
}

export function guardarTema(t: Tema) {
  try {
    if (t === "auto") localStorage.removeItem(CLAVE);
    else localStorage.setItem(CLAVE, t);
  } catch {}
  aplicarTema(t);
}

// Se ejecuta en el <head> antes de dibujar la página, para que no parpadee en blanco
export const SCRIPT_TEMA = `(function(){try{var t=localStorage.getItem("${CLAVE}");var o=t==="oscuro"||(t!=="claro"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(o)document.documentElement.classList.add("dark")}catch(e){}})()`;
