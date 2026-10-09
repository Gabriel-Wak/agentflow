import { encrypt } from "@/lib/crypto";
import { fail, json, withUser } from "@/lib/api";
import { toPublic } from "@/lib/connections";
import { parseAgentMarkdown } from "@/lib/agent-import";
import type { AgentKind, AgentRole } from "@/lib/types";

const COLS = "id, name, kind, role, description, system_prompt, model, config, created_at, secret";

export const GET = withUser(async ({ supabase }) => {
  const { data, error } = await supabase.from("agents").select(COLS).order("created_at", { ascending: false });
  if (error) return fail(error.message, 500);
  return json((data ?? []).map(toPublic));
});

export const POST = withUser(async ({ supabase }, req) => {
  const b = (await req.json()) as {
    kind: AgentKind;
    name?: string;
    role?: AgentRole;
    description?: string;
    system_prompt?: string;
    model?: string;
    markdown?: string;
    url?: string;
    secret?: string;
  };
  let row: Record<string, unknown>;
  if (b.kind === "claude_code") {
    if (!b.markdown?.trim()) return fail("Cole o arquivo .md do subagente.");
    const parsed = parseAgentMarkdown(b.markdown);
    row = { ...parsed, kind: "claude_code", role: b.role ?? "custom", name: b.name?.trim() || parsed.name };
  } else if (b.kind === "webhook") {
    if (!/^https?:\/\//.test(b.url ?? "")) return fail("Informe a URL do webhook do agente.");
    row = {
      kind: "webhook",
      name: b.name?.trim(),
      role: b.role ?? "custom",
      description: b.description ?? "",
      config: { url: b.url!.trim() },
      secret: b.secret?.trim() ? encrypt(b.secret.trim()) : null,
    };
  } else if (b.kind === "claude") {
    if (!b.system_prompt?.trim()) return fail("Escreva o prompt de sistema do agente.");
    row = {
      kind: "claude",
      name: b.name?.trim(),
      role: b.role ?? "custom",
      description: b.description ?? "",
      system_prompt: b.system_prompt.trim(),
      model: b.model || "claude-opus-5-5",
    };
  } else {
    return fail("Tipo de agente inválido.");
  }
  if (!row.name) return fail("Dê um nome para o agente.");
  const { data, error } = await supabase.from("agents").insert(row).select(COLS).single();
  if (error) return fail(error.message, 500);
  return json(toPublic(data), 201);
});
