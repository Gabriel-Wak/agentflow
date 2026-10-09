"use client";

import { useState } from "react";
import { Loader2, Music } from "lucide-react";
import { Button, Card, Input, Label } from "../ui";
import type { useDaemonConnection } from "./daemon";

export default function ConnectScreen({ conn }: { conn: ReturnType<typeof useDaemonConnection> }) {
  const [token, setToken] = useState(conn.token);
  const [url, setUrl] = useState(conn.url);
  const trying = conn.token && conn.state !== "open";

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <div className="mb-6 flex items-start gap-3">
        <div className="rounded-lg bg-accent/15 p-2 text-accent"><Music className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-semibold">Orquestra de agentes</h1>
          <p className="mt-1 text-sm text-muted">
            Claude Code, Codex e terminais rodando de verdade na sua máquina, lado a lado num canvas infinito. Ligue um agente ao outro e eles conversam sozinhos.
          </p>
        </div>
      </div>

      <Card className="space-y-4">
        <h2 className="font-medium">1. Inicie o daemon local</h2>
        <p className="text-sm text-muted">Ele abre os terminais e faz a ponte entre os agentes. Só aceita conexões desta máquina.</p>
        <pre className="rounded-lg bg-panel-2 p-3 font-mono text-xs">cd ~/Documents/agentflow{"\n"}npm run orquestra</pre>
        <p className="text-sm text-muted">Depois clique no link que ele imprime (<code className="text-xs">…/orquestra#token=…</code>), ou cole o token abaixo.</p>

        <h2 className="pt-2 font-medium">2. Conecte</h2>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); conn.setUrl(url); conn.setToken(token); }}>
          <div>
            <Label hint="(está em ~/.agentflow/orquestra-token)">Token</Label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="cole o token" className="font-mono" />
          </div>
          <div>
            <Label>Endereço do daemon</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" />
          </div>
          <Button disabled={!token.trim()}>
            {trying ? <><Loader2 className="h-4 w-4 animate-spin" /> Tentando conectar...</> : "Conectar"}
          </Button>
          {trying && conn.state === "closed" && (
            <p className="text-xs text-warn">Sem resposta do daemon. Confira se <code>npm run orquestra</code> está rodando e se o token está certo.</p>
          )}
        </form>
      </Card>
    </div>
  );
}
