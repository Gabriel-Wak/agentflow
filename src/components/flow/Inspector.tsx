"use client";

import Link from "next/link";
import type { Node } from "@xyflow/react";
import { MousePointerClick, Trash2 } from "lucide-react";
import { DEFAULT_ROLE_PROMPTS } from "@/lib/roles";
import { MODELS, ROLE_LABEL, type AgentNodeData, type AgentRole, type Connection, type Effort, type SavedAgent } from "@/lib/types";
import { Button, Input, Label, Select, Textarea } from "../ui";

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Baixo (rápido)" },
  { id: "medium", label: "Médio" },
  { id: "high", label: "Alto" },
  { id: "xhigh", label: "Muito alto" },
  { id: "max", label: "Máximo" },
];

export default function Inspector({
  node,
  connections,
  agents,
  onChange,
  onDelete,
}: {
  node: Node | null;
  connections: Connection[];
  agents: SavedAgent[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
}) {
  if (!node) {
    return (
      <div className="space-y-4 p-5 text-sm text-muted">
        <div className="flex items-center gap-2 text-fg"><MousePointerClick className="h-4 w-4 text-accent" /> Selecione um nó para configurar</div>
        <ul className="list-disc space-y-1.5 pl-5 text-xs">
          <li>Arraste da bolinha direita de um nó até outro para ligar agentes.</li>
          <li>Selecione uma ligação ou nó e aperte Delete para remover.</li>
          <li>Revisores (Validador/Aprovador) terminam com <code>VEREDITO</code>; se reprovarem, o fluxo volta ao Criador com o feedback.</li>
          <li>Dê ferramentas a cada agente: repositório GitHub, banco de dados e servidores MCP.</li>
        </ul>
      </div>
    );
  }

  const set = (patch: Record<string, unknown>) => onChange(node.id, patch);

  if (node.type === "task") {
    const d = node.data as { label: string; task: string };
    return (
      <div className="space-y-4 p-5">
        <h3 className="font-medium">Tarefa</h3>
        <div>
          <Label>O que o time deve fazer?</Label>
          <Textarea rows={12} value={d.task} onChange={(e) => set({ task: e.target.value })} placeholder="Ex.: Crie a rota /api/relatorios que lista as vendas do mês a partir da tabela orders, seguindo o padrão das outras rotas do repositório." />
        </div>
        <p className="text-xs text-muted">Dica: use o <Link href="/prompts" className="text-accent">Estúdio de prompts</Link> para deixar a tarefa bem especificada.</p>
      </div>
    );
  }

  if (node.type === "output") {
    return (
      <div className="space-y-3 p-5 text-sm">
        <h3 className="font-medium">Entrega</h3>
        <p className="text-xs text-muted">Recebe a versão final do Criador quando os revisores aprovam (ou quando acabam as rodadas). O resultado aparece na aba Execução.</p>
      </div>
    );
  }

  const d = node.data as AgentNodeData;
  const mcps = connections.filter((c) => c.kind === "mcp");
  const dbs = connections.filter((c) => c.kind === "database");
  const repos = connections.filter((c) => c.kind === "github");
  const saved = agents.find((a) => a.id === d.agentId);

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Agente</h3>
        <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => onDelete(node.id)}><Trash2 className="h-3.5 w-3.5" /> Remover</Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Nome</Label>
          <Input value={d.label} onChange={(e) => set({ label: e.target.value })} />
        </div>
        <div>
          <Label>Papel</Label>
          <Select
            value={d.role}
            onChange={(e) => {
              const role = e.target.value as AgentRole;
              // Troca o prompt junto se ainda for o padrão do papel anterior.
              const isDefault = d.systemPrompt === DEFAULT_ROLE_PROMPTS[d.role];
              set({ role, ...(isDefault ? { systemPrompt: DEFAULT_ROLE_PROMPTS[role] } : {}) });
            }}
          >
            {(Object.keys(ROLE_LABEL) as AgentRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </div>
      </div>

      <div>
        <Label hint={<Link href="/agents" className="text-accent">(gerenciar)</Link>}>Usar agente salvo</Label>
        <Select value={d.agentId ?? ""} onChange={(e) => set({ agentId: e.target.value || undefined })}>
          <option value="">— Não, configurar aqui —</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind === "webhook" ? "webhook" : a.kind === "claude_code" ? "Claude Code" : "Claude"})</option>)}
        </Select>
        {saved && <p className="mt-1.5 text-[11px] text-muted">{saved.description || (saved.kind === "webhook" ? saved.config.url : saved.system_prompt.slice(0, 140))}</p>}
      </div>

      {!saved && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Modelo</Label>
              <Select value={d.model} onChange={(e) => set({ model: e.target.value })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </Select>
            </div>
            <div>
              <Label>Esforço</Label>
              <Select value={d.effort} onChange={(e) => set({ effort: e.target.value })} disabled={d.model.startsWith("claude-haiku")}>
                {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </Select>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label>Prompt de sistema</Label>
              <button className="text-[11px] text-accent" onClick={() => set({ systemPrompt: DEFAULT_ROLE_PROMPTS[d.role] })}>restaurar padrão</button>
            </div>
            <Textarea rows={9} className="text-xs" value={d.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} />
          </div>
        </>
      )}

      {saved?.kind !== "webhook" && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="text-xs font-medium">Ferramentas do agente</div>
          <div>
            <Label hint={<Link href="/connections/github" className="text-accent">(conectar)</Link>}>Repositório GitHub</Label>
            <Select value={d.githubId ?? ""} onChange={(e) => set({ githubId: e.target.value || undefined })}>
              <option value="">Nenhum</option>
              {repos.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.config.repo}</option>)}
            </Select>
          </div>
          <div>
            <Label hint={<Link href="/connections/database" className="text-accent">(conectar)</Link>}>Banco de dados</Label>
            <Select value={d.databaseId ?? ""} onChange={(e) => set({ databaseId: e.target.value || undefined })}>
              <option value="">Nenhum</option>
              {dbs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div>
            <Label hint={<Link href="/connections/mcp" className="text-accent">(conectar)</Link>}>Servidores MCP</Label>
            {mcps.length === 0 ? (
              <p className="text-[11px] text-muted">Nenhum servidor MCP conectado.</p>
            ) : (
              <div className="space-y-1.5">
                {mcps.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={d.mcpIds?.includes(c.id) ?? false}
                      onChange={(e) => set({ mcpIds: e.target.checked ? [...(d.mcpIds ?? []), c.id] : (d.mcpIds ?? []).filter((x) => x !== c.id) })}
                    />
                    {c.name}
                    <span className="text-[11px] text-muted">{((c.meta.tools as unknown[]) ?? []).length} ferramentas</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
