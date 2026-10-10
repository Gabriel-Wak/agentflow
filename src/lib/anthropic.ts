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
 * Parâmetros de raciocínio por modelo: a geração atual (Opus/Sonnet/Haiku 5.5, Fable) usa thinking
 * adaptativo + effort. Haiku 4.5 (e anteriores) não aceita nenhum dos dois — vai sem.
 * Effort sempre explícito: no Opus 5.5 e no Haiku 5.5 o padrão da API é "medium", não "high".
 */
export function reasoningParams(model: string, effort: Effort = "medium") {
  if (/^claude-(haiku-4|[a-z]+-3)/.test(model)) return {};
  return {
    thinking: { type: "adaptive" as const },
    output_config: { effort },
  };
}

/** Fallback no servidor em caso de recusa (Fable 5.1, Opus 5.5 e Sonnet 5.5 na API da Claude). */
export function fallbackParams(model: string) {
  if (model === "claude-opus-5-5" || model === "claude-sonnet-5-5" || model === "claude-fable-5-1") {
    return { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] };
  }
  return { betas: [] as string[] };
}
