"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Mark from "@/components/Mark";

// Acceso solo con Microsoft 365 (Entra ID). El ingreso con email y contraseña está desactivado en Supabase.
export default function LoginPage() {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // Si el regreso desde Microsoft falló, /auth/callback vuelve acá con ?error=auth
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("motivo") === "inactividad") {
      setAviso("La sesión se cerró por inactividad. Ingresá de nuevo para continuar.");
    }
    if (new URLSearchParams(window.location.search).get("error") === "auth") {
      setError("No se pudo completar el ingreso con Microsoft. Probá de nuevo; si sigue fallando, avisale a Ciberseguridad.");
    }
  }, []);

  async function entrarConMicrosoft() {
    setError(null);
    setCargando(true);
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "azure",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: "email openid profile",
      },
    });
    if (error) {
      setError(error.message);
      setCargando(false);
    }
    // si no hay error, el navegador redirige solo a Microsoft
  }

  return (
    // fixed + inset-0: ocupa toda la ventana, por encima del contenedor general de la app
    <div className="fixed inset-0 z-50 overflow-y-auto flex flex-col items-center justify-center px-6 py-10 text-white bg-[#0A2A6E] bg-[radial-gradient(ellipse_at_top_left,#123C96_0%,transparent_55%),linear-gradient(135deg,#0A2466_0%,#0B3A9E_55%,#1449C8_100%)]">
      <main className="w-full max-w-md rounded-2xl border border-white/20 bg-white/[0.08] backdrop-blur-md shadow-[0_20px_60px_-15px_rgba(0,0,0,0.45)] px-8 py-9">
        <div className="flex items-center justify-center gap-4">
          {/* Logo de Accusys en blanco */}
          <span className="[&_img]:brightness-0 [&_img]:invert"><Mark className="h-9" /></span>
          <span className="h-9 w-px bg-white/35" aria-hidden />
          <span className="font-display font-extrabold text-[26px] leading-none tracking-tight">Cyber</span>
        </div>

        <h1 className="font-display font-bold text-xl text-center mt-8">Bienvenido</h1>
        <p className="text-sm text-white/70 text-center mt-1.5">Ingresá con tu cuenta de la empresa</p>

        {aviso && <p className="mt-5 rounded-lg bg-white/15 px-3 py-2 text-sm text-center" role="status">{aviso}</p>}

        <div className="mt-6">
          <button type="button" onClick={entrarConMicrosoft} disabled={cargando}
            className="w-full flex items-center justify-center gap-3 rounded-xl bg-white text-[#1F2937] font-medium py-3.5 shadow-lg shadow-black/10 hover:bg-white/95 disabled:opacity-70 transition">
            <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
              <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            {cargando ? "Redirigiendo…" : "Continuar con Microsoft"}
          </button>
          <p className="text-xs text-white/60 text-center mt-4">
            Usá tus credenciales de <b className="text-white/85">Microsoft 365</b> para acceder
          </p>
          {error && <p role="alert" className="text-sm text-red-100 bg-red-500/25 border border-red-300/30 rounded-lg px-3 py-2 mt-4">{error}</p>}
        </div>
      </main>
      <p className="text-xs text-white/50 mt-6">© {new Date().getFullYear()} Accusys. Todos los derechos reservados.</p>
    </div>
  );
}
