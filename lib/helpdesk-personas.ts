// Personas que aparecen en tickets del helpdesk pero NO pertenecen a los sectores que se miden
// (SRE, CAU Servidores, CAU Microinformática, Ciberseguridad, Ambientes, Especialistas).
// No se listan en los cuadros por persona del reporte; sus tickets siguen contando en el sector y en el total.
// Para sumar o quitar a alguien, editar esta lista: no importan mayúsculas, acentos, comas ni el orden del nombre.
export const PERSONAS_AJENAS = [
  "Lo Veci, Mariano",
  "Salvatore, Luciano",
  "Perez, Eduard",
];

// Nombre comparable: sin mayúsculas, acentos ni signos, y sin importar el orden ("Apellido, Nombre" = "Nombre Apellido")
export const clavePersona = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").sort().join(" ");

// Igual que la anterior pero sin espacios, para que "Lo Veci" y "Loveci" sean la misma persona
const compacta = (s: string) => clavePersona(s).replace(/ /g, "").split("").sort().join("");
const ajenas = new Set(PERSONAS_AJENAS.map(compacta));

export const esAjena = (nombre: string) => ajenas.has(compacta(nombre));
