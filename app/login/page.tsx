"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Mark from "@/components/Mark";

export default function LoginPage() {
  const [metodo, setMetodo] = useState<"sso" | "credenciales">("sso");
  const [cargandoMicrosoft, setCargandoMicrosoft] = useState(false);
  const [errorMicrosoft, setErrorMicrosoft] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  // Solo inicio de sesión: las cuentas nuevas no se crean desde acá (acceso por Microsoft 365)
  async function onSubmitEmail(e: React.FormEvent) {
    e.preventDefault();
    setErrorEmail(null);
    setCargandoEmail(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setCargandoEmail(false);
    if (error) {
      setErrorEmail(error.message === "Invalid login credentials" ? "Email o contraseña incorrectos." : error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  const campo =
    "w-full rounded-xl bg-white/10 border border-white/20 px-3.5 py-2.5 text-sm text-white placeholder:text-white/40 " +
    "focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10 text-white bg-[#0A2A6E] bg-[radial-gradient(ellipse_at_top_left,#123C96_0%,transparent_55%),linear-gradient(135deg,#0A2466_0%,#0B3A9E_55%,#1449C8_100%)]">
      <main className="w-full max-w-md rounded-2xl border border-white/20 bg-white/[0.08] backdrop-blur-md shadow-[0_20px_60px_-15px_rgba(0,0,0,0.45)] px-8 py-9">
        <div className="flex items-center justify-center gap-4">
          {/* Logo de Accusys en blanco */}
          <span className="[&_img]:brightness-0 [&_img]:invert"><Mark className="h-9" /></span>
          <span className="h-9 w-px bg-white/35" aria-hidden />
          <span className="font-display font-extrabold text-[26px] leading-none tracking-tight">Cyber</span>
        </div>

        <h1 className="font-display font-bold text-xl text-center mt-8">Bienvenido</h1>
        <p className="text-sm text-white/70 text-center mt-1.5">Seleccioná tu método de acceso</p>

        <div role="tablist" aria-label="Método de acceso" className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-white/10 p-1">
          {([["sso", "Microsoft SSO"], ["credenciales", "Credenciales"]] as const).map(([k, t]) => (
            <button key={k} type="button" role="tab" aria-selected={metodo === k} onClick={() => setMetodo(k)}
              className={`rounded-lg py-2.5 text-sm transition-colors ${metodo === k ? "bg-white/20 font-semibold text-white shadow-sm" : "text-white/70 hover:text-white"}`}>
              {t}
            </button>
          ))}
        </div>

        {metodo === "sso" ? (
          <div className="mt-6">
            <button type="button" onClick={entrarConMicrosoft} disabled={cargandoMicrosoft}
              className="w-full flex items-center justify-center gap-3 rounded-xl bg-white text-[#1F2937] font-medium py-3.5 shadow-lg shadow-black/10 hover:bg-white/95 disabled:opacity-70 transition">
              <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
                <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
              </svg>
              {cargandoMicrosoft ? "Redirigiendo…" : "Continuar con Microsoft"}
            </button>
            <p className="text-xs text-white/60 text-center mt-4">
              Usá tus credenciales de <b className="text-white/85">Microsoft 365</b> para acceder
            </p>
            {errorMicrosoft && <p role="alert" className="text-sm text-red-100 bg-red-500/25 border border-red-300/30 rounded-lg px-3 py-2 mt-4">{errorMicrosoft}</p>}
          </div>
        ) : (
          <form onSubmit={onSubmitEmail} className="mt-6 space-y-3">
            <div>
              <label htmlFor="email" className="block text-xs text-white/70 mb-1.5">Email</label>
              <input id="email" type="email" required autoComplete="email" className={campo} value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="nombre@accusys.com.ar" />
            </div>
            <div>
              <label htmlFor="password" className="block text-xs text-white/70 mb-1.5">Contraseña</label>
              <input id="password" type="password" required autoComplete="current-password" className={campo} value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            {errorEmail && <p role="alert" className="text-sm text-red-100 bg-red-500/25 border border-red-300/30 rounded-lg px-3 py-2">{errorEmail}</p>}
            <button type="submit" disabled={cargandoEmail}
              className="w-full rounded-xl bg-white text-[#1F2937] font-medium py-3.5 shadow-lg shadow-black/10 hover:bg-white/95 disabled:opacity-70 transition">
              {cargandoEmail ? "Un momento…" : "Ingresar"}
            </button>
            <p className="text-xs text-white/60 text-center pt-1">Acceso para cuentas creadas por un administrador</p>
          </form>
        )}
      </main>
      <p className="text-xs text-white/50 mt-6">© {new Date().getFullYear()} Accusys. Todos los derechos reservados.</p>
    </div>
  );
}
