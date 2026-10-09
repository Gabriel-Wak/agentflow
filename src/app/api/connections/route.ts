import { encrypt } from "@/lib/crypto";
import { fail, json, withUser, errMsg } from "@/lib/api";
import { normalizeConfig, PUBLIC_COLUMNS, testConnection, toPublic } from "@/lib/connections";
import type { ConnectionKind } from "@/lib/types";

const KINDS: ConnectionKind[] = ["mcp", "database", "github"];

export const GET = withUser(async ({ supabase }, req) => {
  const kind = new URL(req.url).searchParams.get("kind");
  let q = supabase.from("connections").select(PUBLIC_COLUMNS).order("created_at", { ascending: false });
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q;
  if (error) return fail(error.message, 500);
  return json((data ?? []).map(toPublic));
});

export const POST = withUser(async ({ supabase }, req) => {
  const body = (await req.json()) as { kind: ConnectionKind; name: string; config?: Record<string, string>; secret?: string };
  if (!KINDS.includes(body.kind)) return fail("Tipo de conexão inválido.");
  if (!body.name?.trim()) return fail("Dê um nome para a conexão.");
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
    .insert({ kind: body.kind, name: body.name.trim(), config, secret: secret ? encrypt(secret) : null, status, meta })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) return fail(error.message, 500);
  return json(toPublic(data), 201);
});
