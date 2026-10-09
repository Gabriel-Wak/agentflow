import { decrypt } from "@/lib/crypto";
import { fail, json, withUser, errMsg } from "@/lib/api";
import { PUBLIC_COLUMNS, testConnection, toPublic } from "@/lib/connections";
import type { ConnectionKind } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** Testa de novo uma conexão salva e atualiza status/metadados. */
export const POST = withUser(async ({ supabase }, _req, { params }: Ctx) => {
  const { id } = await params;
  const { data: row, error } = await supabase.from("connections").select("*").eq("id", id).single();
  if (error || !row) return fail("Conexão não encontrada.", 404);
  let status = "ok";
  let meta: Record<string, unknown> = row.meta;
  let config = row.config;
  try {
    const r = await testConnection(row.kind as ConnectionKind, row.config, decrypt(row.secret));
    meta = r.meta as Record<string, unknown>;
    config = r.config;
  } catch (e) {
    status = "error";
    meta = { ...row.meta, error: errMsg(e) };
  }
  const { data, error: upErr } = await supabase
    .from("connections")
    .update({ status, meta, config })
    .eq("id", id)
    .select(PUBLIC_COLUMNS)
    .single();
  if (upErr) return fail(upErr.message, 500);
  return json(toPublic(data));
});

export const DELETE = withUser(async ({ supabase }, _req, { params }: Ctx) => {
  const { id } = await params;
  const { error } = await supabase.from("connections").delete().eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
});
