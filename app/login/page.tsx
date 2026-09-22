"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Mark from "@/components/Mark";

export default function LoginPage() {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  async function entrarConMicrosoft() {
    setError(null);
    setCargando(true);

    const { error } = await supabase.auth.signInWithOAuth({
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
    <div className="min-h-screen flex items-center justify-center bg-[#F5F7FB] px-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-1">
          <Mark className="h-7 w-7" />
          <h1 className="font-display font-bold text-3xl text-ink tracking-tight">
            Licencias
          </h1>
        </div>
        <p className="text-ink/60 text-sm mb-8">
          Control de licencias de software · Accusys
        </p>

        <div className="card p-6 space-y-4">
          <p className="text-sm text-ink/60">
            Iniciá sesión con tu cuenta de Microsoft de Accusys.
          </p>

          <button
            type="button"
            onClick={entrarConMicrosoft}
            disabled={cargando}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
              <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            {cargando ? "Redirigiendo…" : "Iniciar sesión con Microsoft"}
          </button>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <p className="text-xs text-ink/50 mt-4">
          Las cuentas nuevas quedan como "solo lectura" por defecto. Un
          administrador debe subirte de rol (lectura y escritura, o
          administrador) desde Supabase si corresponde.
        </p>
      </div>
    </div>
  );
}
