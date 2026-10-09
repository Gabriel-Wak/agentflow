/**
 * Importa um subagente do Claude Code (.claude/agents/*.md):
 * frontmatter YAML com name/description/model e o corpo como prompt de sistema.
 */
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
};

export function parseAgentMarkdown(md: string) {
  const text = md.replace(/^﻿/, "").trim();
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const front: Record<string, string> = {};
  let body = text;
  if (m) {
    body = m[2].trim();
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) front[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const model = front.model ? (MODEL_ALIASES[front.model] ?? (front.model.startsWith("claude-") ? front.model : "claude-opus-5-5")) : "claude-opus-5-5";
  return {
    name: front.name || "Subagente importado",
    description: front.description || "",
    system_prompt: body,
    model,
    config: front.tools ? { tools: front.tools } : {},
  };
}
