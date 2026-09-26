import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // ?ingreso=azure: la app registra el ingreso desde el navegador (con la IP real del usuario)
      return NextResponse.redirect(`${origin}/?ingreso=azure`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
