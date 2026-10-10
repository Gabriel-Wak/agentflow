"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Copy, Loader2, Wrench, XCircle } from "lucide-react";
import { Badge, Button } from "../ui";

export interface RunEntry {
  nodeId: string;
  label: string;
  round: number;
  text: string;
  tools: string[];
  verdict?: "approved" | "rejected";
  finished?: boolean;
  /** A execução parou (cancelada ou erro) antes deste agente terminar. */
  interrupted?: boolean;
  system?: boolean;
}

export default function RunPanel({
  entries,
  running,
  final,
}: {
  entries: RunEntry[];
  running: boolean;
  final: { output: string; approved: boolean } | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Acompanha o fim só se a pessoa já estava lá embaixo — não arranca a leitura de quem rolou para cima.
  useEffect(() => {
    const box = endRef.current?.closest(".overflow-y-auto");
    if (!box) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }, [entries, final]);

  if (!entries.length && !running) {
    return <p className="p-5 text-sm text-muted">Clique em <b>Executar</b> para ver os agentes conversando aqui em tempo real.</p>;
  }

  return (
    <div className="space-y-3 p-4">
      {entries.map((e, i) =>
        e.system ? (
          <div key={i} className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">{e.label}</div>
        ) : (
          <div key={i} className="rounded-lg border border-line bg-panel-2">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <span className="text-sm font-medium">{e.label}{e.round > 1 && <span className="ml-1 text-xs text-muted">· rodada {e.round}</span>}</span>
              {e.interrupted ? (
                <Badge tone="warn">interrompido</Badge>
              ) : !e.finished ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-warn" />
              ) : e.verdict === "approved" ? (
                <Badge tone="ok"><CheckCircle2 className="mr-1 h-3 w-3" /> aprovado</Badge>
              ) : e.verdict === "rejected" ? (
                <Badge tone="bad"><XCircle className="mr-1 h-3 w-3" /> reprovado</Badge>
              ) : (
                <Badge>concluído</Badge>
              )}
            </div>
            {e.tools.length > 0 && (
              <div className="space-y-0.5 border-b border-line px-3 py-2">
                {e.tools.map((t, j) => (
                  <div key={j} className="flex items-center gap-1.5 truncate font-mono text-[10.5px] text-muted"><Wrench className="h-3 w-3 shrink-0" /> {t}</div>
                ))}
              </div>
            )}
            <pre className="scroll-thin max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 font-sans text-xs leading-relaxed text-fg/90">{e.text || "..."}</pre>
          </div>
        ),
      )}
      {final && (
        <div className={`rounded-lg border p-3 ${final.approved ? "border-ok/40 bg-ok/5" : "border-bad/40 bg-bad/5"}`}>
          <div className="mb-2 flex items-center justify-between">
            <span className={`text-sm font-medium ${final.approved ? "text-ok" : "text-bad"}`}>
              {final.approved ? "Entrega aprovada" : "Não aprovada no limite de rodadas"}
            </span>
            <Button variant="outline" className="px-2 py-1 text-xs" onClick={async () => {
              try {
                await navigator.clipboard.writeText(final.output);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* sem permissão de área de transferência */
              }
            }}>
              {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />} Copiar
            </Button>
          </div>
          <pre className="scroll-thin max-h-96 overflow-auto whitespace-pre-wrap font-sans text-xs leading-relaxed">{final.output}</pre>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
