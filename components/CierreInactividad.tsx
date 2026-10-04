"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Cierra la sesión sola después de un rato sin actividad (30 minutos; se cambia con la variable
// NEXT_PUBLIC_INACTIVIDAD_MIN en Vercel). Un minuto antes avisa y deja seguir conectado.
// La última actividad se guarda en el navegador, así todas las pestañas comparten el mismo reloj
// y, si se cerró el navegador sin salir, la sesión no sigue abierta al volver.
const MINUTOS = Math.max(2, Number(process.env.NEXT_PUBLIC_INACTIVIDAD_MIN) || 30);
const LIMITE = MINUTOS * 60_000;
const AVISO = 60_000;
const CLAVE = "cyber-ultima-actividad";

const leer = () => { try { return Number(localStorage.getItem(CLAVE)) || 0; } catch { return 0; } };
const guardar = (t: number) => { try { localStorage.setItem(CLAVE, String(t)); } catch {} };
const borrar = () => { try { localStorage.removeItem(CLAVE); } catch {} };

export default function CierreInactividad() {
  const [restan, setRestan] = useState<number | null>(null);   // segundos que quedan (solo durante el aviso)
  const ultima = useRef(Date.now());
  const saliendo = useRef(false);

  useEffect(() => {
    // Ingreso recién hecho (?ingreso=...) o primera vez: el reloj arranca ahora
    const recienIngreso = new URL(window.location.href).searchParams.has("ingreso");
    const previa = leer();
    if (recienIngreso || !previa) { ultima.current = Date.now(); guardar(ultima.current); }
    else ultima.current = previa;

    async function salir() {
      if (saliendo.current) return;
      saliendo.current = true;
      borrar();
      const supabase = createClient();
      try { await supabase.rpc("registrar_ingreso", { p_accion: "logout" }); } catch {}
      try { await supabase.auth.signOut(); } catch {}
      window.location.href = "/login?motivo=inactividad";
    }

    function revisar() {
      // otra pestaña pudo haber tenido actividad (o haber cerrado la sesión)
      const guardada = leer();
      if (guardada > ultima.current) ultima.current = guardada;
      const quieto = Date.now() - ultima.current;
      if (quieto >= LIMITE) { salir(); return; }
      setRestan(quieto >= LIMITE - AVISO ? Math.ceil((LIMITE - quieto) / 1000) : null);
    }

    let ultimoGuardado = 0;
    function actividad() {
      const ahora = Date.now();
      // si ya venció (por ejemplo, la notebook estuvo suspendida), no se revive la sesión con un clic
      if (ahora - ultima.current >= LIMITE) { salir(); return; }
      ultima.current = ahora;
      if (ahora - ultimoGuardado > 5000) { ultimoGuardado = ahora; guardar(ahora); }
    }

    const eventos = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];
    eventos.forEach((e) => window.addEventListener(e, actividad, { passive: true, capture: true }));
    const alVolver = () => { if (document.visibilityState === "visible") revisar(); };
    document.addEventListener("visibilitychange", alVolver);
    const reloj = window.setInterval(revisar, 1000);
    revisar();

    return () => {
      eventos.forEach((e) => window.removeEventListener(e, actividad, { capture: true }));
      document.removeEventListener("visibilitychange", alVolver);
      window.clearInterval(reloj);
    };
  }, []);

  if (restan === null) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 print:hidden" role="alertdialog" aria-modal="true" aria-labelledby="inactividad-titulo">
      <div className="card max-w-sm w-full p-6 text-center">
        <h2 id="inactividad-titulo" className="font-display text-lg font-bold text-ink">¿Seguís ahí?</h2>
        <p className="mt-2 text-sm text-ink/70">
          Por seguridad, la sesión se cierra sola después de {MINUTOS} minutos sin actividad.
          Se va a cerrar en <b>{restan}</b> segundos.
        </p>
        <button autoFocus className="btn btn-primary mt-4" onClick={() => { ultima.current = Date.now(); guardar(ultima.current); setRestan(null); }}>
          Seguir conectado
        </button>
      </div>
    </div>
  );
}
