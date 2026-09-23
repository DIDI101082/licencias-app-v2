// Interpreta los datos de un producto (por su código EAN/UPC) y los traduce al inventario:
// qué tipo de equipo es, marca normalizada y modelo comercial.

export type ProductoExterno = {
  title?: string; brand?: string; model?: string; category?: string; description?: string; images?: string[];
};

export type ProductoInventario = {
  ean: string;
  titulo: string;
  marca: string | null;
  modelo: string | null;
  categoria: string | null;   // nombre de la categoría del inventario
  descripcion: string | null;
  imagen: string | null;
};

// El orden importa: "combo" antes que "teclado" o "mouse"
const REGLAS_CATEGORIA: [RegExp, string][] = [
  [/combo|keyboard\s*(?:and|&|\+|y)\s*mouse|teclado\s*(?:y|\+)\s*mouse|desktop set|\bMK\d{3}\b/i, "Combo teclado + mouse"],
  [/headset|headphone|auricular|earbud|earphone|\bH\d{3}\b|\bzone\b/i, "Auriculares / headset"],
  [/webcam|web cam|c[aá]mara web|\bC9\d{2}\b|\bbrio\b/i, "Webcam"],
  [/docking|dock station|\bdock\b|port replicator|\bWD1\d\b|\bUD22\b/i, "Docking station"],
  [/laptop|notebook|latitude|inspiron|vostro|precision \d|xps \d|thinkpad|elitebook|probook/i, "Notebook"],
  [/monitor|display|pantalla|odyssey|viewfinity|smart monitor|\bLS\d{2}[A-Z]\d/i, "Monitor"],
  [/keyboard|teclado|\bK\d{3}\b/i, "Teclado"],
  [/mouse|mice|rat[oó]n|\bM\d{3}\b|\bMX (?:master|anywhere)/i, "Mouse"],
  [/speaker|parlante|altavoz|\bZ\d{3}\b/i, "Parlantes"],
];

const MARCAS: Record<string, string> = {
  logitech: "Logitech", "logitech g": "Logitech", logi: "Logitech",
  samsung: "Samsung", "samsung electronics": "Samsung",
  dell: "Dell", "dell technologies": "Dell", "dell computers": "Dell",
  hp: "HP", "hewlett packard": "HP", "hp inc": "HP", lenovo: "Lenovo", lg: "LG", "lg electronics": "LG",
  microsoft: "Microsoft", jabra: "Jabra", poly: "Poly", plantronics: "Poly", apple: "Apple",
};

export function normalizarMarca(marca?: string | null, titulo?: string) {
  const m = (marca ?? "").trim().toLowerCase().replace(/[.,]/g, "");
  if (MARCAS[m]) return MARCAS[m];
  for (const [clave, nombre] of Object.entries(MARCAS)) {
    if (new RegExp(`^${clave}\\b`, "i").test(titulo ?? "")) return nombre;
  }
  if (!m) return null;
  // "SAMSUNG" → "Samsung"; respeta marcas que ya vienen bien escritas
  return marca!.trim() === marca!.trim().toUpperCase() && marca!.trim().length > 3
    ? marca!.trim()[0] + marca!.trim().slice(1).toLowerCase()
    : marca!.trim();
}

// Modelos comerciales por marca (lo que la gente reconoce), antes que el número de parte
const MODELOS: [RegExp, RegExp][] = [
  [/logitech/i, /\b(MX (?:Master|Anywhere|Keys|Mechanical|Ergo)(?: (?:\d\w*|Mini|S))*|Zone (?:Vibe|Wireless|Wired|Learn)?\s?\d*\w*|Brio \d*|MK\d{3}|K\d{3}|M\d{3}|H\d{3}|C\d{3,4}\w?|G\d{3}\w?|Z\d{3})\b/i],
  [/samsung/i, /\b(L[SCUF]\d{2}[A-Z]{1,2}\d{2,3}[A-Z0-9]*|[SCUFG]\d{2}[A-Z]\d{2,3}[A-Z]?|Odyssey (?:G\d+|OLED G\d+|Neo G\d+|Ark)|ViewFinity S\d+)\b/i],
  [/dell/i, /\b((?:Latitude|Inspiron|Vostro|Precision|XPS|Pro Max|Pro) \d{2,5}\w*|[PSEUGC]\d{4}[A-Z]{0,3}|WD\d{2}\w*|KM\d{3,4}\w*)\b/i],
];

export function extraerModelo(marca: string | null, titulo: string, modeloApi?: string | null) {
  const regla = MODELOS.find(([m]) => m.test(marca ?? "") || m.test(titulo));
  const enTitulo = regla ? titulo.match(regla[1])?.[1] : null;
  if (enTitulo) return enTitulo.replace(/\s+/g, " ").trim();
  if (regla && modeloApi) {
    const enModelo = modeloApi.match(regla[1])?.[1];
    if (enModelo) return enModelo;
  }
  return modeloApi?.trim() || null;
}

export function categorizar(titulo: string, categoriaApi?: string | null) {
  const texto = `${titulo} ${categoriaApi ?? ""}`;
  return REGLAS_CATEGORIA.find(([re]) => re.test(texto))?.[1] ?? null;
}

export function interpretar(ean: string, p: ProductoExterno): ProductoInventario {
  const titulo = (p.title ?? "").replace(/\s+/g, " ").trim();
  const marca = normalizarMarca(p.brand, titulo);
  return {
    ean,
    titulo,
    marca,
    modelo: extraerModelo(marca, titulo, p.model),
    categoria: categorizar(titulo, p.category),
    descripcion: p.description?.replace(/\s+/g, " ").trim().slice(0, 600) || null,
    imagen: p.images?.find((i) => /^https:\/\//.test(i)) ?? null,
  };
}

// EAN-13, EAN-8, UPC-A y UPC-E con dígito verificador correcto
export function eanValido(codigo: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(codigo)) return false;
  const d = codigo.split("").map(Number);
  const control = d.pop()!;
  const suma = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (suma % 10)) % 10 === control;
}
