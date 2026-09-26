"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// Al volver del login (?ingreso=azure o ?ingreso=email) registra el ingreso en Logs.
// Se hace desde el navegador para que quede la IP real de la persona, y después se limpia la dirección.
export default function RegistrarIngreso() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const metodo = url.searchParams.get("ingreso");
    if (!metodo) return;
    createClient().rpc("registrar_ingreso", { p_accion: "login", p_metodo: metodo }).then(() => {}, () => {});
    url.searchParams.delete("ingreso");
    window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
  }, []);
  return null;
}
