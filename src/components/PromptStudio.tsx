"use client";

import { useEffect, useState, useRef } from "react";
import { Check, Copy, Loader2, Save, Sparkles, Trash2 } from "lucide-react";
import { api, readNdjson } from "@/lib/fetcher";
import { PROMPT_TARGETS, type PromptTarget } from "@/lib/prompt-improver";
import type { PromptItem } from "@/lib/types";
import { Button, Card, Empty, ErrorText, Label, Select, Textarea } from "./ui";

function split(raw: string) {
  const prompt = raw.match(/<prompt>\s*([\s\S]*?)(?:<\/prompt>|$)/)?.[1] ?? "";
  const notes = raw.match(/<notas>\s*([\s\S]*?)(?:<\/notas>|$)/)?.[1] ?? "";
  return { prompt: prompt.trim(), notes: notes.trim() };
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button variant="outline" type="button" onClick={async () => { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}>
      {ok ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />} {ok ? "Copiado" : "Copiar"}
    </Button>
  );
}

export default function PromptStudio() {
  const [original, setOriginal] = useState("");
  const [context, setContext] = useState("");
  const [target, setTarget] = useState<PromptTarget>("claude_code");
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<PromptItem[]>([]);
  const [justSaved, setJustSaved] = useState(false);
  const { prompt, notes } = split(raw);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api<PromptItem[]>("/api/prompts").then(setSaved).catch(() => {});
    // Saiu da página: cancela a geração (o servidor para de chamar a API).
    return () => abortRef.current?.abort();
  }, []);

  async function improve(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setRaw("");
    setJustSaved(false);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/prompts/improve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: original, target, context }),
        signal: ac.signal,
      });
      await readNdjson<{ type: string; text?: string; message?: string }>(res, (ev) => {
        if (ev.type === "delta") setRaw((r) => r + ev.text);
        if (ev.type === "error") setError(ev.message ?? "Erro");
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  async function save() {
    try {
      const item = await api<PromptItem>("/api/prompts", { method: "POST", body: JSON.stringify({ original, improved: prompt, notes }) });
      setSaved((s) => [item, ...s]);
      setJustSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/prompts/${id}`, { method: "DELETE" });
      setSaved((s) => s.filter((p) => p.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <form onSubmit={improve} className="space-y-4">
            <div>
              <Label>Seu prompt</Label>
              <Textarea required rows={10} value={original} onChange={(e) => setOriginal(e.target.value)} placeholder="Ex.: cria uma tela de login com google pro meu app next" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Onde vai usar</Label>
                <Select value={target} onChange={(e) => setTarget(e.target.value as PromptTarget)}>
                  {(Object.keys(PROMPT_TARGETS) as PromptTarget[]).map((k) => <option key={k} value={k}>{PROMPT_TARGETS[k]}</option>)}
                </Select>
              </div>
              <div>
                <Label hint="(opcional)">Contexto extra</Label>
                <Textarea rows={1} value={context} onChange={(e) => setContext(e.target.value)} placeholder="stack, público, restrições..." />
              </div>
            </div>
            <ErrorText>{error}</ErrorText>
            <Button className="w-full" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {loading ? "Melhorando..." : "Melhorar prompt"}
            </Button>
          </form>
        </Card>

        <Card className="flex flex-col">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-medium">Prompt melhorado</h2>
            {prompt && !loading && (
              <div className="flex gap-2">
                <CopyButton text={prompt} />
                <Button variant="outline" type="button" onClick={save} disabled={justSaved}>
                  {justSaved ? <Check className="h-4 w-4 text-ok" /> : <Save className="h-4 w-4" />} {justSaved ? "Salvo" : "Salvar"}
                </Button>
              </div>
            )}
          </div>
          {prompt || loading ? (
            <>
              <pre className="scroll-thin max-h-[420px] flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-panel-2 p-4 font-mono text-xs leading-relaxed">
                {prompt || "..."}
              </pre>
              {notes && (
                <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs leading-relaxed text-muted whitespace-pre-wrap">{notes}</div>
              )}
            </>
          ) : (
            <Empty>O resultado aparece aqui, em tempo real.</Empty>
          )}
        </Card>
      </div>

      <div>
        <h2 className="mb-3 font-medium">Biblioteca</h2>
        {saved.length === 0 ? (
          <Empty>Prompts salvos aparecem aqui e podem ser usados nos agentes.</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {saved.map((p) => (
              <Card key={p.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{p.title}</span>
                  <div className="flex shrink-0 gap-1">
                    <CopyButton text={p.improved} />
                    <Button variant="danger" className="px-2" onClick={() => remove(p.id)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-muted">{p.improved}</p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
