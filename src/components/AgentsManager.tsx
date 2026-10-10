"use client";

import { useEffect, useState } from "react";
import { Bot, FileCode2, Loader2, Trash2, Webhook } from "lucide-react";
import { api } from "@/lib/fetcher";
import { DEFAULT_ROLE_PROMPTS } from "@/lib/roles";
import { MODELS, ROLE_LABEL, type AgentKind, type AgentRole, type SavedAgent } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorText, Input, Label, Select, Textarea } from "./ui";

const TABS: { kind: AgentKind; label: string; icon: typeof Bot }[] = [
  { kind: "claude", label: "Agente Claude", icon: Bot },
  { kind: "claude_code", label: "Subagente do Claude Code", icon: FileCode2 },
  { kind: "webhook", label: "Agente externo", icon: Webhook },
];

const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude", claude_code: "Claude Code", webhook: "Webhook" };

const SAMPLE_MD = `---
name: revisor-de-codigo
description: Revisa mudanças procurando bugs e problemas de segurança
model: sonnet
---

Você é um revisor de código sênior. Leia o código com atenção...`;

export default function AgentsManager() {
  const [items, setItems] = useState<SavedAgent[] | null>(null);
  const [kind, setKind] = useState<AgentKind>("claude");
  const [form, setForm] = useState<Record<string, string>>({ role: "custom", model: "claude-opus-5-5" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<SavedAgent[]>("/api/agents").then(setItems).catch((e) => setError(e.message));
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function onFile(file: File | undefined) {
    if (file) set("markdown", await file.text());
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const created = await api<SavedAgent>("/api/agents", { method: "POST", body: JSON.stringify({ ...form, kind }) });
      setItems((p) => [created, ...(p ?? [])]);
      setForm({ role: "custom", model: "claude-opus-5-5" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remover este agente? Os fluxos que o usam passam a usar a configuração do próprio nó.")) return;
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      setItems((p) => p?.filter((a) => a.id !== id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[440px_1fr]">
      <Card className="h-fit">
        <div className="mb-5 grid grid-cols-3 gap-1 rounded-lg bg-panel-2 p-1">
          {TABS.map((t) => (
            <button
              key={t.kind}
              type="button"
              onClick={() => { setKind(t.kind); setError(""); }}
              className={`flex flex-col items-center gap-1 rounded-md px-1 py-2 text-[11px] leading-tight ${kind === t.kind ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
            >
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ))}
        </div>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label hint={kind === "claude_code" ? "(opcional)" : undefined}>Nome</Label>
              <Input required={kind !== "claude_code"} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Ex.: Arquiteto" />
            </div>
            <div>
              <Label>Papel no time</Label>
              <Select value={form.role} onChange={(e) => set("role", e.target.value)}>
                {(Object.keys(ROLE_LABEL) as AgentRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </Select>
            </div>
          </div>

          {kind === "claude" && (
            <>
              <div>
                <Label>Modelo</Label>
                <Select value={form.model} onChange={(e) => set("model", e.target.value)}>
                  {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </Select>
              </div>
              <div>
                <Label>Descrição</Label>
                <Input value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="O que este agente faz" />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Prompt de sistema</Label>
                  <button type="button" className="text-[11px] text-accent" onClick={() => set("system_prompt", DEFAULT_ROLE_PROMPTS[(form.role as AgentRole) ?? "custom"])}>usar modelo do papel</button>
                </div>
                <Textarea required rows={9} value={form.system_prompt ?? ""} onChange={(e) => set("system_prompt", e.target.value)} placeholder="Você é..." />
              </div>
            </>
          )}

          {kind === "claude_code" && (
            <div>
              <Label hint="(.claude/agents/*.md)">Arquivo do subagente</Label>
              <input type="file" accept=".md,.markdown,text/markdown" onChange={(e) => onFile(e.target.files?.[0])} className="mb-2 block w-full text-xs text-muted file:mr-3 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-1.5 file:text-fg" />
              <Textarea required rows={11} className="font-mono text-xs" value={form.markdown ?? ""} onChange={(e) => set("markdown", e.target.value)} placeholder={SAMPLE_MD} />
              <p className="mt-1.5 text-[11px] text-muted">Lemos name, description e model do frontmatter; o corpo vira o prompt de sistema.</p>
            </div>
          )}

          {kind === "webhook" && (
            <>
              <div>
                <Label>URL do webhook</Label>
                <Input required type="url" value={form.url ?? ""} onChange={(e) => set("url", e.target.value)} placeholder="https://seu-n8n.com/webhook/agente" />
              </div>
              <div>
                <Label hint="(opcional)">Header Authorization</Label>
                <Input type="password" value={form.secret ?? ""} onChange={(e) => set("secret", e.target.value)} placeholder="Bearer abc123" />
              </div>
              <div>
                <Label>Descrição</Label>
                <Input value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="Agente do n8n / LangChain / CrewAI..." />
              </div>
              <div className="rounded-lg bg-panel-2 p-3 font-mono text-[11px] leading-relaxed text-muted">
                POST {"{ task, role, node, round, history, feedback }"}<br />
                ← responda JSON {"{ \"output\": \"...\" }"} ou texto puro
              </div>
            </>
          )}

          <ErrorText>{error}</ErrorText>
          <Button className="w-full" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Salvar agente</Button>
        </form>
      </Card>

      <div className="space-y-3">
        {items === null ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Carregando...</div>
        ) : items.length === 0 ? (
          <Empty>Nenhum agente salvo. Crie um aqui ou importe seus subagentes do Claude Code — depois é só escolher no nó do fluxo.</Empty>
        ) : (
          items.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    <Badge tone="accent">{KIND_LABEL[a.kind]}</Badge>
                    <Badge>{ROLE_LABEL[a.role]}</Badge>
                    {a.kind !== "webhook" && <span className="text-[11px] text-muted">{a.model}</span>}
                  </div>
                  {a.description && <p className="mt-1 text-sm text-muted">{a.description}</p>}
                  {a.kind === "webhook" ? (
                    <p className="mt-1 truncate font-mono text-[11px] text-muted">{a.config.url}</p>
                  ) : (
                    <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-muted/80">{a.system_prompt}</p>
                  )}
                </div>
                <Button variant="danger" className="px-2" onClick={() => remove(a.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
