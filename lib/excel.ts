// Exportación a Excel (.xlsx) con filtro en cada columna y la fila de títulos fija.
// write-excel-file no soporta autofiltro, así que se genera el archivo y se le agrega
// el <autoFilter> a la hoja antes de descargarlo.

export type Valor = string | number | null | undefined;

// Convierte 1 → A, 27 → AA
function letraColumna(n: number) {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export async function exportarExcel(
  nombreArchivo: string,
  titulos: string[],
  filas: Valor[][],
  anchos: Record<string, number> = {},
) {
  const [{ default: writeExcelFile }, { unzipSync, zipSync, strToU8, strFromU8 }] = await Promise.all([
    import("write-excel-file/browser"),
    import("fflate"),
  ]);

  const datos = [
    titulos.map((t) => ({ value: t, fontWeight: "bold" as const, backgroundColor: "#E8EEF6" })),
    ...filas.map((f) =>
      f.map((v) => (typeof v === "number" && Number.isFinite(v) ? { value: v, type: Number } : { value: v == null ? "" : String(v) })),
    ),
  ];

  const blob = await writeExcelFile(datos as any, {
    columns: titulos.map((t) => ({ width: anchos[t] ?? Math.min(40, Math.max(12, t.length + 4)) })),
    stickyRowsCount: 1,
  }).toBlob();

  // Agrega el filtro a la hoja (va justo después de los datos, como pide el formato de Excel)
  const archivos = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const hoja = "xl/worksheets/sheet1.xml";
  const rango = `A1:${letraColumna(titulos.length)}${filas.length + 1}`;
  if (archivos[hoja]) {
    const xml = strFromU8(archivos[hoja]).replace(/<\/sheetData>|<sheetData\/>/, (m) =>
      `${m === "<sheetData/>" ? m : "</sheetData>"}<autoFilter ref="${rango}"/>`,
    );
    archivos[hoja] = strToU8(xml);
  }
  const final = new Blob([zipSync(archivos)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(final);
  a.download = nombreArchivo.endsWith(".xlsx") ? nombreArchivo : `${nombreArchivo}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
