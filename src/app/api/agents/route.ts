import { z } from "zod";
import { encrypt } from "@/lib/crypto";
import { fail, json, readBody, withUser } from "@/lib/api";
import { toPublic } from "@/lib/connections";
import { parseAgentMarkdown } from "@/lib/agent-import";
import { MODELS } from "@/lib/types";

const COLS = "id, name, kind, role, description, system_prompt, model, config, created_at, secret";

export const GET = withUser(async ({ supabase }) => {
  const { data, error } = await supabase.from("agents").select(COLS).order("created_at", { ascending: false });
  if (error) return fail(error.message, 500);
  return json((data ?? []).map(toPublic));
});

const Body = z.object({
  kind: z.enum(["claude", "claude_code", "webhook"], { message: "tipo de agente inválido" }),
  name: z.string().max(120).optional(),
  role: z.enum(["creator", "validator", "approver", "custom"]).optional(),
  description: z.string().max(2000).optional(),
  system_prompt: z.string().max(100_000).optional(),
  model: z.string().max(80).optional(),
  markdown: z.string().max(200_000).optional(),
  url: z.string().max(2000).optional(),
  secret: z.string().max(10_000).optional(),
});

export const POST = withUser(async ({ supabase }, req) => {
  const b = await readBody(req, Body);
  if (b.model && !MODELS.some((m) => m.id === b.model)) return fail("Modelo desconhecido.");
  let row: Record<string, unknown>;
  if (b.kind === "claude_code") {
    if (!b.markdown?.trim()) return fail("Cole o arquivo .md do subagente.");
    const parsed = parseAgentMarkdown(b.markdown);
    row = { ...parsed, kind: "claude_code", role: b.role ?? "custom", name: b.name?.trim() || parsed.name };
  } else if (b.kind === "webhook") {
    if (!/^https?:\/\/[^\s/]+/.test(b.url?.trim() ?? "")) return fail("Informe a URL do webhook do agente (http:// ou https://).");
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
