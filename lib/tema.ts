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

// Diseño del menú: solapas arriba (predeterminado) o menú lateral. También se guarda por navegador.
export type Diseno = "solapas" | "lateral";
const CLAVE_MENU = "accusys-menu";

export function disenoGuardado(): Diseno {
  try { return localStorage.getItem(CLAVE_MENU) === "lateral" ? "lateral" : "solapas"; } catch { return "solapas"; }
}

export function guardarDiseno(d: Diseno) {
  try {
    if (d === "solapas") localStorage.removeItem(CLAVE_MENU);
    else localStorage.setItem(CLAVE_MENU, d);
  } catch {}
  document.documentElement.classList.toggle("menu-lateral", d === "lateral");
}

// Igual que el tema: se aplica antes de dibujar, para que el menú no salte al cargar
export const SCRIPT_MENU = `(function(){try{if(localStorage.getItem("${CLAVE_MENU}")==="lateral")document.documentElement.classList.add("menu-lateral")}catch(e){}})()`;

// Ancho del contenido: centrado (predeterminado) o completo, usando todo el ancho de la pantalla.
export type Ancho = "normal" | "completo";
const CLAVE_ANCHO = "accusys-ancho";

export function anchoGuardado(): Ancho {
  try { return localStorage.getItem(CLAVE_ANCHO) === "completo" ? "completo" : "normal"; } catch { return "normal"; }
}

export function guardarAncho(a: Ancho) {
  try {
    if (a === "normal") localStorage.removeItem(CLAVE_ANCHO);
    else localStorage.setItem(CLAVE_ANCHO, a);
  } catch {}
  document.documentElement.classList.toggle("ancho-completo", a === "completo");
}

export const SCRIPT_ANCHO = `(function(){try{if(localStorage.getItem("${CLAVE_ANCHO}")==="completo")document.documentElement.classList.add("ancho-completo")}catch(e){}})()`;
