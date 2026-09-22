"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Mark from "@/components/Mark";

export default function LoginPage() {
  const [cargandoMicrosoft, setCargandoMicrosoft] = useState(false);
  const [errorMicrosoft, setErrorMicrosoft] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [modo, setModo] = useState<"entrar" | "registrarse">("entrar");
  const [errorEmail, setErrorEmail] = useState<string | null>(null);
  const [cargandoEmail, setCargandoEmail] = useState(false);

  const router = useRouter();
  const supabase = createClient();

  async function entrarConMicrosoft() {
    setErrorMicrosoft(null);
    setCargandoMicrosoft(true);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: "email openid profile",
      },
    });

    if (error) {
      setErrorMicrosoft(error.message);
      setCargandoMicrosoft(false);
    }
    // si no hay error, el navegador redirige solo a Microsoft
  }

  async function onSubmitEmail(e: React.FormEvent) {
    e.preventDefault();
    setErrorEmail(null);
    setCargandoEmail(true);

    const { error } =
      modo === "entrar"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setCargandoEmail(false);

    if (error) {
      setErrorEmail(error.message);
      return;
    }

    router.push("/");
    router.refresh();
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
          <button
            type="button"
            onClick={entrarConMicrosoft}
            disabled={cargandoMicrosoft}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
              <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            {cargandoMicrosoft ? "Redirigiendo…" : "Iniciar sesión con Microsoft"}
          </button>

          {errorMicrosoft && (
            <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
              {errorMicrosoft}
            </p>
          )}

          <div className="flex items-center gap-3 py-1">
            <div className="h-px bg-black/10 flex-1" />
            <span className="text-xs text-ink/40">o con email</span>
            <div className="h-px bg-black/10 flex-1" />
          </div>

          <form onSubmit={onSubmitEmail} className="space-y-3">
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                required
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nombre@empresa.com"
              />
            </div>
            <div>
              <label className="label">Contraseña</label>
              <input
                type="password"
                required
                minLength={6}
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {errorEmail && (
              <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
                {errorEmail}
              </p>
            )}

            <button
              type="submit"
              disabled={cargandoEmail}
              className="btn-secondary w-full"
            >
              {cargandoEmail
                ? "Un momento…"
                : modo === "entrar"
                ? "Entrar con email"
                : "Crear cuenta"}
            </button>

            <button
              type="button"
              onClick={() => setModo(modo === "entrar" ? "registrarse" : "entrar")}
              className="text-sm text-brand-600 hover:underline w-full text-center"
            >
              {modo === "entrar"
                ? "¿No tenés cuenta? Registrate"
                : "¿Ya tenés cuenta? Entrá"}
            </button>
          </form>
        </div>

        <p className="text-xs text-ink/50 mt-4">
          Las cuentas nuevas quedan como "solo lectura" por defecto. Un
          administrador debe subirte de rol (lectura y escritura, o
          administrador) desde Supabase o desde la pantalla de Usuarios.
        </p>
      </div>
    </div>
  );
}
