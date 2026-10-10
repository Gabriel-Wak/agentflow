import { z } from "zod";
import { fail, json, readBody, withUser } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  nodes: z.array(z.unknown()).max(500).optional(),
  edges: z.array(z.unknown()).max(2000).optional(),
  settings: z.object({ maxRounds: z.number().int().min(1).max(6) }).partial().optional(),
});

export const GET = withUser(async ({ supabase }, _req, { params }: Ctx) => {
  const { id } = await params;
  const { data, error } = await supabase.from("flows").select("*").eq("id", id).single();
  if (error || !data) return fail("Fluxo não encontrado.", 404);
  return json(data);
});

export const PUT = withUser(async ({ supabase }, req, { params }: Ctx) => {
  const { id } = await params;
  const b = await readBody(req, Patch);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.name !== undefined) patch.name = b.name;
  if (b.nodes) patch.nodes = b.nodes;
  if (b.edges) patch.edges = b.edges;
  if (b.settings) patch.settings = b.settings;
  const { data, error } = await supabase.from("flows").update(patch).eq("id", id).select("id");
  if (error) return fail(error.message, 500);
  if (!data?.length) return fail("Fluxo não encontrado.", 404);
  return json({ ok: true });
});

export const DELETE = withUser(async ({ supabase }, _req, { params }: Ctx) => {
  const { id } = await params;
  const { error } = await supabase.from("flows").delete().eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
});
