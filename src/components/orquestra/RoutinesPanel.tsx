"use client";

import { useState } from "react";
import { Pause, Play, Plus, Trash2, X, Zap } from "lucide-react";
import type { ClientMsg, Routine } from "@/lib/orquestra/protocol";
import { Button, Input, Select, Textarea } from "../ui";

/** Rotinas: mensagens repetidas para um agente (ex.: ciclo do Vigia). O Maestro também cria pelo MCP. */
export default function RoutinesPanel({
  routines,
  agentNames,
  send,
  onClose,
}: {
  routines: Routine[];
  agentNames: string[];
  send: (m: ClientMsg) => boolean;
  onClose: () => void;
}) {
  const [agent, setAgent] = useState("");
  const [message, setMessage] = useState("");
  const [every, setEvery] = useState(15);
  // O agente escolhido pode ter sido renomeado/removido: volta para o primeiro que existe.
  const target = agentNames.includes(agent) ? agent : agentNames[0] || "";

  return (
    <div className="absolute bottom-24 right-3 top-16 z-10 flex w-96 max-w-[calc(100%-1.5rem)] flex-col rounded-xl border border-line bg-panel/95 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-line px-3 py-2 text-sm font-medium">
        Rotinas
        <button onClick={onClose} aria-label="Fechar rotinas"><X className="h-4 w-4 text-muted" /></button>
      </div>
      <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-3">
        {routines.length === 0 && (
          <p className="text-xs text-muted">Nenhuma rotina. Crie abaixo ou peça ao Maestro (ex.: &quot;rode o ciclo do Vigia a cada 15 min&quot;). Ficam em ~/.agentflow/rotinas.json e rodam enquanto o daemon estiver ligado.</p>
        )}
        {routines.map((r) => (
          <div key={r.id} className={`rounded-lg bg-panel-2 p-2 text-xs ${r.enabled ? "" : "opacity-60"}`}>
            <div className="mb-1 flex items-center gap-2">
              <span className="font-medium">{r.agent}</span>
              <span className="text-muted">a cada {r.everyMinutes} min</span>
              <span className="ml-auto flex items-center gap-1">
                <button className="rounded p-1 text-muted hover:text-fg" title="Rodar agora" aria-label={`Rodar agora a rotina de ${r.agent}`} onClick={() => send({ type: "routines:run", id: r.id })}><Zap className="h-3 w-3" /></button>
                <button
                  className="rounded p-1 text-muted hover:text-fg"
                  title={r.enabled ? "Pausar" : "Retomar"}
                  aria-label={`${r.enabled ? "Pausar" : "Retomar"} a rotina de ${r.agent}`}
                  onClick={() => send({ type: "routines:save", routine: { id: r.id, agent: r.agent, message: r.message, everyMinutes: r.everyMinutes, enabled: !r.enabled } })}
                >
                  {r.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                </button>
                <button className="rounded p-1 text-muted hover:text-bad" title="Apagar" aria-label={`Apagar a rotina de ${r.agent}`} onClick={() => confirm(`Apagar a rotina de ${r.agent}?`) && send({ type: "routines:delete", id: r.id })}><Trash2 className="h-3 w-3" /></button>
              </span>
            </div>
            <div className="line-clamp-3 whitespace-pre-wrap">{r.message}</div>
            <div className="mt-1 text-[10px] text-muted">
              {r.enabled ? `próxima ${new Date(r.nextAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "pausada"}
              {r.lastAt ? ` · última ${new Date(r.lastAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : ""}
              {` · criada por ${r.createdBy}`}
            </div>
            {r.lastError && <div className="mt-1 text-[10px] text-bad">Falhou: {r.lastError}</div>}
          </div>
        ))}
      </div>
      <form
        className="space-y-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!target || !message.trim()) return;
          // Só limpa se saiu: sem conexão, o texto fica para tentar de novo.
          if (send({ type: "routines:save", routine: { agent: target, message: message.trim(), everyMinutes: Math.min(1440, Math.max(1, Math.round(every))) } })) setMessage("");
        }}
      >
        <div className="flex gap-2">
          <Select value={target} onChange={(e) => setAgent(e.target.value)} className="py-1.5 text-xs" disabled={!agentNames.length} aria-label="Agente que recebe a rotina">
            {agentNames.map((n) => <option key={n}>{n}</option>)}
          </Select>
          <label className="flex shrink-0 items-center gap-1 text-xs text-muted">
            a cada
            <Input type="number" min={1} max={1440} value={every} onChange={(e) => setEvery(Number(e.target.value) || 1)} className="w-16 py-1.5 text-xs" />
            min
          </label>
        </div>
        <Textarea rows={2} aria-label="Mensagem da rotina" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Mensagem enviada a cada ciclo" className="text-xs" />
        <Button className="w-full py-1.5 text-xs" disabled={!target || !message.trim()}><Plus className="h-3.5 w-3.5" /> Agendar</Button>
      </form>
    </div>
  );
}
