"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/fetcher";
import type { Connection, ConnectionKind } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorText, Input, Label } from "./ui";

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  required?: boolean;
  hint?: string;
  type?: string;
}

const FIELDS: Record<ConnectionKind, FieldDef[]> = {
  mcp: [
    { key: "url", label: "URL do servidor MCP", placeholder: "https://mcp.exemplo.com/mcp", required: true, hint: "(Streamable HTTP ou SSE, acessível pela internet)" },
    { key: "secret", label: "Token de acesso", placeholder: "opcional — enviado como Bearer", secret: true, type: "password" },
  ],
  database: [
    { key: "secret", label: "Connection string PostgreSQL", placeholder: "postgresql://usuario:senha@host:5432/banco", secret: true, required: true, type: "password", hint: "(Supabase, Neon, RDS, Railway...)" },
  ],
  github: [
    { key: "repo", label: "Repositório", placeholder: "dono/repositorio ou https://github.com/dono/repositorio", required: true },
    { key: "branch", label: "Branch", placeholder: "padrão do repositório" },
    { key: "secret", label: "Token do GitHub", placeholder: "ghp_... (obrigatório para repositórios privados)", secret: true, type: "password", hint: "(permissão Contents: read)" },
  ],
};

function Details({ c }: { c: Connection }) {
  const m = c.meta as Record<string, unknown>;
  if (m.error && c.status === "error") return <p className="text-xs text-bad">{String(m.error)}</p>;
  if (c.kind === "mcp") {
    const tools = (m.tools as { name: string; description: string }[]) ?? [];
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted">{c.config.url} · {String(m.server || "")} · {String(m.transport || "").toUpperCase()}</p>
        <div className="flex flex-wrap gap-1.5">
          {tools.slice(0, 30).map((t) => <span key={t.name} title={t.description} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{t.name}</span>)}
          {tools.length > 30 && <span className="text-[11px] text-muted">+{tools.length - 30}</span>}
        </div>
      </div>
    );
  }
  if (c.kind === "database") {
    const tables = (m.tables as string[]) ?? [];
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted">{String(m.version || "")} · {tables.length} tabela(s) · {c.secret_hint}</p>
        {m.warning ? <p className="rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-xs text-warn">{String(m.warning)}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          {tables.slice(0, 30).map((t) => <span key={t} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{t}</span>)}
        </div>
      </div>
    );
  }
  const langs = (m.languages as string[]) ?? [];
  return (
    <div className="space-y-1.5 text-xs text-muted">
      <p>
        <a className="text-accent hover:underline" href={`https://github.com/${c.config.repo}`} target="_blank" rel="noreferrer">{c.config.repo}</a>
        {" "}· branch {c.config.branch} · {String(m.fileCount ?? 0)} arquivos · {m.private ? "privado" : "público"}
      </p>
      {m.description ? <p>{String(m.description)}</p> : null}
      {langs.length > 0 && <p>Linguagens: {langs.join(", ")}</p>}
    </div>
  );
}

export default function ConnectionsManager({ kind }: { kind: ConnectionKind }) {
  const [items, setItems] = useState<Connection[] | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ name: "" });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Connection[]>(`/api/connections?kind=${kind}`).then(setItems).catch((e) => setError(e.message));
  }, [kind]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const { name, secret, ...config } = form;
      const created = await api<Connection>("/api/connections", {
        method: "POST",
        body: JSON.stringify({ kind, name, secret, config }),
      });
      setItems((prev) => [created, ...(prev ?? [])]);
      setForm({ name: "" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function retest(id: string) {
    setBusy(id);
    try {
      const updated = await api<Connection>(`/api/connections/${id}`, { method: "POST" });
      setItems((prev) => prev?.map((c) => (c.id === id ? updated : c)) ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remover esta conexão? Os agentes que a usam perdem o acesso.")) return;
    try {
      await api(`/api/connections/${id}`, { method: "DELETE" });
      setItems((prev) => prev?.filter((c) => c.id !== id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <Card className="h-fit">
        <h2 className="mb-4 font-medium">Nova conexão</h2>
        <form onSubmit={save} className="space-y-4">
          <div>
            <Label>Nome</Label>
            <Input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Produção" />
          </div>
          {FIELDS[kind].map((f) => (
            <div key={f.key}>
              <Label hint={f.hint}>{f.label}</Label>
              <Input
                type={f.type ?? "text"}
                required={f.required}
                autoComplete="off"
                value={form[f.key] ?? ""}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                placeholder={f.placeholder}
              />
            </div>
          ))}
          <ErrorText>{error}</ErrorText>
          <Button className="w-full" disabled={saving}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Testando conexão...</> : "Testar e salvar"}
          </Button>
          <p className="text-[11px] text-muted">Testamos a conexão antes de salvar. Tokens e senhas ficam criptografados (AES-256-GCM).</p>
        </form>
      </Card>

      <div className="space-y-3">
        {items === null ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Carregando...</div>
        ) : items.length === 0 ? (
          <Empty>Nenhuma conexão ainda.</Empty>
        ) : (
          items.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Badge tone={c.status === "ok" ? "ok" : c.status === "error" ? "bad" : "muted"}>
                    {c.status === "ok" ? "conectado" : c.status === "error" ? "erro" : c.status}
                  </Badge>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" className="px-2" title="Testar de novo" aria-label={`Testar de novo ${c.name}`} onClick={() => retest(c.id)} disabled={busy === c.id}>
                    <RefreshCw className={`h-4 w-4 ${busy === c.id ? "animate-spin" : ""}`} />
                  </Button>
                  <Button variant="danger" className="px-2" title="Remover" aria-label={`Remover ${c.name}`} onClick={() => remove(c.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
              <Details c={c} />
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
