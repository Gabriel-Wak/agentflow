import { z } from "zod";
import { encrypt } from "@/lib/crypto";
import { fail, json, readBody, withUser, errMsg } from "@/lib/api";
import { normalizeConfig, PUBLIC_COLUMNS, testConnection, toPublic } from "@/lib/connections";
import type { ConnectionKind } from "@/lib/types";

const KINDS: ConnectionKind[] = ["mcp", "database", "github"];
const Body = z.object({
  kind: z.enum(["mcp", "database", "github"]),
  name: z.string().trim().min(1, "dê um nome para a conexão").max(120),
  config: z.record(z.string(), z.string().max(2000)).optional(),
  secret: z.string().max(10_000).optional(),
});

export const GET = withUser(async ({ supabase }, req) => {
  const kind = new URL(req.url).searchParams.get("kind");
  let q = supabase.from("connections").select(PUBLIC_COLUMNS).order("created_at", { ascending: false });
  if (kind) {
    if (!KINDS.includes(kind as ConnectionKind)) return fail("Tipo de conexão inválido.");
    q = q.eq("kind", kind);
  }
  const { data, error } = await q;
  if (error) return fail(error.message, 500);
  return json((data ?? []).map(toPublic));
});

export const POST = withUser(async ({ supabase }, req) => {
  const body = await readBody(req, Body);
  const secret = (body.secret ?? "").trim();
  let config = normalizeConfig(body.kind, body.config ?? {});

  const status = "ok";
  let meta: Record<string, unknown> = {};
  try {
    const r = await testConnection(body.kind, config, secret);
    config = r.config;
    meta = r.meta as Record<string, unknown>;
  } catch (e) {
    return fail(`Falha ao testar a conexão: ${errMsg(e)}`);
  }

  const { data, error } = await supabase
    .from("connections")
    .insert({ kind: body.kind, name: body.name, config, secret: secret ? encrypt(secret) : null, status, meta })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) return fail(error.message, 500);
  return json(toPublic(data), 201);
});
