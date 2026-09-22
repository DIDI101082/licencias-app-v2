import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Inter } from "next/font/google";
import "./globals.css";
import { getPerfil } from "@/lib/supabase/server";
import Nav from "@/components/Nav";

const display = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
});
const body = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Licencias | Accusys",
  description: "Control de licencias de software de la empresa",
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
        {perfil && <Nav nombre={perfil.nombre} rol={perfil.rol} />}
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
