"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safe-next";
import { Button, Card, ErrorText, Input, Label } from "@/components/ui";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(params.get("error") ? params.get("reason")?.slice(0, 200) || "Não foi possível concluir o login." : "");
  const [info, setInfo] = useState("");
  /** null = ainda verificando; false = provedor GitHub desligado no Supabase. */
  const [githubOn, setGithubOn] = useState<boolean | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);

  // Pergunta ao Supabase se o login com GitHub está ativo, para não mandar a pessoa a uma página de erro.
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((r) => r.json())
      .then((s: { external?: { github?: boolean } }) => setGithubOn(Boolean(s.external?.github)))
      .catch(() => setGithubOn(null)); // sem resposta: deixa tentar
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setInfo("");
    const supabase = createClient();
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : error.message);
      else {
        // Mantém o #fragmento do link original (ex.: #token= da Orquestra) — ele não passa pelo servidor.
        router.replace(next + location.hash);
        router.refresh();
      }
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${location.origin}/auth/callback?next=/dashboard` },
      });
      if (error) setError(error.message);
      else if (data.session) {
        router.replace("/dashboard");
        router.refresh();
      } else setInfo("Conta criada! Confirme o e-mail que enviamos para entrar.");
    }
    setLoading(false);
  }

  async function github() {
    setError("");
    setGithubBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      // O #fragmento (ex.: #token= da Orquestra) não passa pelo GitHub: vai junto no next.
      options: { redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next + location.hash)}` },
    });
    if (error) {
      setError(/not enabled|unsupported provider/i.test(error.message) ? "O login com GitHub não está ativado neste servidor." : error.message);
      setGithubBusy(false);
    }
  }

  return (
    <Card className="space-y-5">
      <div className="flex rounded-lg bg-panel-2 p-1 text-sm">
        {(["signin", "signup"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md py-1.5 ${mode === m ? "bg-accent text-white" : "text-muted"}`}
          >
            {m === "signin" ? "Entrar" : "Criar conta"}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label>E-mail</Label>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@empresa.com" />
        </div>
        <div>
          <Label>Senha</Label>
          <Input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="mínimo 6 caracteres" />
        </div>
        <ErrorText>{error}</ErrorText>
        {info && <p className="rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok">{info}</p>}
        <Button className="w-full" disabled={loading}>{loading ? "Aguarde..." : mode === "signin" ? "Entrar" : "Criar conta"}</Button>
      </form>
      <div className="flex items-center gap-3 text-xs text-muted"><div className="h-px flex-1 bg-line" />ou<div className="h-px flex-1 bg-line" /></div>
      <Button
        variant="outline"
        className="w-full"
        onClick={github}
        disabled={githubOn === false || githubBusy}
        title={githubOn === false ? "Ative o provedor GitHub no Supabase (veja o README)" : undefined}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
        {githubBusy ? "Abrindo o GitHub..." : "Continuar com GitHub"}
      </Button>
      {githubOn === false && (
        <p className="text-center text-[11px] text-muted">Login com GitHub ainda não ativado neste servidor — use e-mail e senha ou veja &quot;Login com GitHub&quot; no README.</p>
      )}
    </Card>
  );
}
