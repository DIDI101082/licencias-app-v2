// Clasifica lo que leyó la cámara: ¿es el número de serie o es otro código de la etiqueta?

export type Clasificacion = {
  valor: string;        // lo que se guardaría como N° de serie
  original: string;
  formato: string;
  tipo: "serie" | "producto" | "parte" | "enlace" | "otro";
  aviso: string | null; // explicación para el usuario si no parece un número de serie
};

const NOMBRES_FORMATO: Record<string, string> = {
  CODE_128: "Code 128", CODE_39: "Code 39", CODE_93: "Code 93", ITF: "ITF", CODABAR: "Codabar",
  DATA_MATRIX: "DataMatrix", QR_CODE: "QR", PDF_417: "PDF417", AZTEC: "Aztec",
  EAN_13: "EAN-13", EAN_8: "EAN-8", UPC_A: "UPC-A", UPC_E: "UPC-E",
};

export function nombreFormato(f: string) {
  return NOMBRES_FORMATO[f] ?? f;
}

export function clasificar(texto: string, formato: string): Clasificacion {
  // Sacar caracteres de control (los DataMatrix suelen traer separadores invisibles)
  const original = texto.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const base = { original, formato };

  if (["EAN_13", "EAN_8", "UPC_A", "UPC_E"].includes(formato)) {
    return { ...base, valor: original, tipo: "producto",
      aviso: "Es el código de producto (el mismo para todas las unidades del modelo), no el número de serie. Buscá el código que dice S/N o Serial." };
  }
  if (/^https?:\/\//i.test(original)) {
    // Algunas marcas (HP, Lenovo, Dell) ponen un QR con un enlace que trae el serie como parámetro
    try {
      const url = new URL(original);
      for (const clave of ["sn", "serial", "serialnumber", "serial_number", "servicetag", "st"]) {
        for (const [k, v] of url.searchParams) {
          if (k.toLowerCase() === clave && v.trim().length >= 4) return { ...base, valor: v.trim(), tipo: "serie", aviso: null };
        }
      }
    } catch { /* no es una URL válida */ }
    return { ...base, valor: original, tipo: "enlace", aviso: "Es un enlace web, no un número de serie." };
  }

  // Etiquetas que traen el prefijo dentro del código: "S/N: ABC123", "SN ABC123", "Serial No. ABC123"
  const serie = original.match(/(?:^|\s)(?:S\/?N|SER(?:IAL)?\.?\s*(?:NO|NUM(?:BER)?)?\.?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-\/\.]{3,})/i);
  if (serie) return { ...base, valor: serie[1], tipo: "serie", aviso: null };

  if (/^(?:P\/?N|MPN|PART\s*(?:NO|NUMBER)?|MODEL|MOD\.?)\s*[:#\-]?\s*/i.test(original)) {
    return { ...base, valor: original.replace(/^(?:P\/?N|MPN|PART\s*(?:NO|NUMBER)?|MODEL|MOD\.?)\s*[:#\-]?\s*/i, ""), tipo: "parte",
      aviso: "Parece el número de parte o de modelo, no el de serie." };
  }

  // Un QR o DataMatrix con varios datos: tomar la parte que parece serie si hay separadores
  if (/\s|;|\|/.test(original) && ["QR_CODE", "DATA_MATRIX", "PDF_417"].includes(formato)) {
    return { ...base, valor: original, tipo: "otro", aviso: "El código trae varios datos juntos. Revisá que el número de serie sea correcto antes de guardar." };
  }

  if (original.length < 4) {
    return { ...base, valor: original, tipo: "otro", aviso: "Es muy corto para ser un número de serie." };
  }
  return { ...base, valor: original, tipo: "serie", aviso: null };
}
