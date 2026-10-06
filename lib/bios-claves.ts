import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "crypto";

// Claves de BIOS por equipo: se generan y se cifran acá, en el servidor.
// La llave sale de BIOS_CLAVE_MAESTRA (variable de entorno de Vercel, 32 caracteres o más):
// la base de datos guarda solo el texto cifrado.

function llave(): Buffer | null {
  const s = process.env.BIOS_CLAVE_MAESTRA ?? "";
  return s.length >= 32 ? createHash("sha256").update(s).digest() : null;
}

export const biosConfigurado = () => llave() !== null;

// Solo letras y números, sin los que se confunden (0/O, 1/l/I): en el BIOS el teclado está en inglés
// y los símbolos cambian de lugar; además evita caracteres que rompen la línea de comandos.
const MAYUS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MINUS = "abcdefghijkmnpqrstuvwxyz";
const NUMS = "23456789";

export function generarClave(largo = 16): string {
  const todo = MAYUS + MINUS + NUMS;
  const c = [MAYUS, MINUS, NUMS].map((g) => g[randomInt(g.length)]);
  while (c.length < largo) c.push(todo[randomInt(todo.length)]);
  for (let i = c.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c.join("");
}

export function cifrar(texto: string): string {
  const k = llave();
  if (!k) throw new Error("Falta BIOS_CLAVE_MAESTRA");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const datos = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), datos.toString("base64")].join(":");
}

export function descifrar(cifrado: string): string {
  const k = llave();
  if (!k) throw new Error("Falta BIOS_CLAVE_MAESTRA");
  const [v, iv, tag, datos] = cifrado.split(":");
  if (v !== "v1" || !iv || !tag || !datos) throw new Error("Formato de clave cifrada desconocido");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(datos, "base64")), d.final()]).toString("utf8");
}
