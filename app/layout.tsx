import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Inter } from "next/font/google";
import "./globals.css";
import { getPerfil } from "@/lib/supabase/server";
import Nav from "@/components/Nav";
import { PerfilProvider } from "@/components/PerfilContext";
import GuardiaModulo from "@/components/GuardiaModulo";
import RegistrarIngreso from "@/components/RegistrarIngreso";

const display = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
});
const body = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Accusys Cyber",
  description: "Empleados, licencias, inventario IT y seguridad en un solo lugar",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { perfil } = await getPerfil();

  return (
    <html lang="es">
      <body className={`${display.variable} ${body.variable} font-sans`}>
        <PerfilProvider perfil={perfil}>
          {perfil && <RegistrarIngreso />}
          {perfil && <Nav nombre={perfil.nombre} rol={perfil.rol} modulos={perfil.modulos ?? []} />}
          <main className="mx-auto max-w-6xl px-6 py-8 print:p-0 print:max-w-none">
            {perfil ? <GuardiaModulo modulos={perfil.modulos ?? []}>{children}</GuardiaModulo> : children}
          </main>
        </PerfilProvider>
      </body>
    </html>
  );
}
