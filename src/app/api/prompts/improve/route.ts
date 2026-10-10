import { anthropic, DEFAULT_MODEL, fallbackParams, reasoningParams } from "@/lib/anthropic";
import { z } from "zod";
import { fail, ndjsonStream, readBody, withUser } from "@/lib/api";
import { IMPROVER_SYSTEM, PROMPT_TARGETS, type PromptTarget } from "@/lib/prompt-improver";

export const maxDuration = 300;

export const POST = withUser(async (_ctx, req) => {
  const b = await readBody(req, z.object({ prompt: z.string().max(200_000).optional(), target: z.string().optional(), context: z.string().max(50_000).optional() }));
  const prompt = b.prompt?.trim();
  if (!prompt) return fail("Escreva o prompt que você quer melhorar.");
  const target = PROMPT_TARGETS[(b.target ?? "chat") as PromptTarget] ?? PROMPT_TARGETS.chat;

  const user = [
    `Destino do prompt: ${target}`,
    b.context?.trim() ? `Contexto extra do usuário:\n${b.context.trim()}` : "",
    `Prompt original:\n<original>\n${prompt}\n</original>`,
  ].filter(Boolean).join("\n\n");

  return ndjsonStream(async (emit, signal) => {
    const model = DEFAULT_MODEL;
    const fb = fallbackParams(model);
    const stream = anthropic().beta.messages.stream({
      model,
      max_tokens: 16000,
      system: IMPROVER_SYSTEM,
      messages: [{ role: "user", content: user }],
      ...reasoningParams(model, "medium"),
      ...("fallbacks" in fb ? { fallbacks: fb.fallbacks } : {}),
      ...(fb.betas.length ? { betas: fb.betas } : {}),
    }, { signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        emit({ type: "delta", text: ev.delta.text });
      }
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") emit({ type: "error", message: "O modelo recusou este pedido." });
    emit({ type: "done" });
  }, req.signal);
});
