import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";

// Retorno do login OAuth (GitHub) e da confirmação de e-mail.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const safeNext = safeNextPath(url.searchParams.get("next"));
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(safeNext, url.origin));
  }
  // GitHub/Supabase devolvem o motivo (ex.: acesso negado, redirect não permitido): mostramos na tela de login.
  const reason = url.searchParams.get("error_description") ?? (code ? "Não foi possível validar o retorno do login. Tente de novo." : "");
  const back = new URL("/login", url.origin);
  back.searchParams.set("error", "auth");
  if (reason) back.searchParams.set("reason", reason.slice(0, 200));
  return NextResponse.redirect(back);
}
