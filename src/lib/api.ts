import { NextResponse } from "next/server";
import { getApiUser } from "./supabase/server";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
      return fail(errMsg(e), 500);
    }
  };
}

/** Stream NDJSON: cada evento em uma linha. */
export function ndjsonStream(run: (emit: (e: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: unknown) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await run(emit);
      } catch (e) {
        emit({ type: "error", message: errMsg(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
