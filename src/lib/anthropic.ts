import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "./types";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY não configurada.");
  }
  client ??= new Anthropic();
  return client;
}

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

/**
 * Parâmetros de raciocínio por modelo: Opus/Sonnet usam thinking adaptativo + effort;
 * Haiku 4.5 não aceita effort nem thinking adaptativo.
 */
export function reasoningParams(model: string, effort: Effort = "medium") {
  if (model.startsWith("claude-haiku")) return {};
  return {
    thinking: { type: "adaptive" as const },
    output_config: { effort },
  };
}

/** Fallback no servidor em caso de recusa (suportado por Opus 5.5 e Sonnet 5.5 na API da Claude). */
export function fallbackParams(model: string) {
  if (model === "claude-opus-5-5" || model === "claude-sonnet-5-5") {
    return { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] };
  }
  return { betas: [] as string[] };
}
