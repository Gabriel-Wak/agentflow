import { NextResponse } from "next/server";
import { z } from "zod";
import { getApiUser } from "./supabase/server";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Erro com status HTTP: lançado dentro de um handler, vira a resposta certa (em vez de 500). */
export class HttpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Lê e valida o corpo JSON. Corpo inválido é erro do cliente (400), nunca 500. */
export async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError("Corpo da requisição não é um JSON válido.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(`Dados inválidos${issue?.path.length ? ` em "${issue.path.join(".")}"` : ""}: ${issue?.message ?? "formato inesperado"}.`);
  }
  return parsed.data;
}

/** Envolve um Route Handler exigindo usuário autenticado. */
export function withUser<A extends unknown[]>(
  fn: (ctx: NonNullable<Awaited<ReturnType<typeof getApiUser>>>, req: Request, ...args: A) => Promise<Response>,
) {
  return async (req: Request, ...args: A) => {
    const ctx = await getApiUser();
    if (!ctx) return fail("Não autenticado.", 401);
    try {
      return await fn(ctx, req, ...args);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message, e.status);
      console.error(e);
      return fail(errMsg(e), 500);
    }
  };
}

/**
 * Stream NDJSON: cada evento em uma linha.
 * Se o navegador desconectar, `signal` aborta — quem roda deve parar de gastar (ex.: chamadas à API da Claude).
 */
export function ndjsonStream(run: (emit: (e: unknown) => void, signal: AbortSignal) => Promise<void>, upstream?: AbortSignal) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  if (upstream) {
    if (upstream.aborted) abort.abort();
    else upstream.addEventListener("abort", () => abort.abort(), { once: true });
  }
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          closed = true; // cliente foi embora
        }
      };
      try {
        await run(emit, abort.signal);
      } catch (e) {
        if (!abort.signal.aborted) emit({ type: "error", message: errMsg(e) });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* já fechado */
          }
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
