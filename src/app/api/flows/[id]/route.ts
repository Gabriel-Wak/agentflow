import { fail, json, withUser } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withUser(async ({ supabase }, _req, { params }: Ctx) => {
  const { id } = await params;
  const { data, error } = await supabase.from("flows").select("*").eq("id", id).single();
  if (error || !data) return fail("Fluxo não encontrado.", 404);
  return json(data);
});

export const PUT = withUser(async ({ supabase }, req, { params }: Ctx) => {
  const { id } = await params;
  const b = (await req.json()) as { name?: string; nodes?: unknown[]; edges?: unknown[]; settings?: unknown };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.name !== undefined) patch.name = b.name;
  if (b.nodes) patch.nodes = b.nodes;
  if (b.edges) patch.edges = b.edges;
  if (b.settings) patch.settings = b.settings;
  const { error } = await supabase.from("flows").update(patch).eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
});

export const DELETE = withUser(async ({ supabase }, _req, { params }: Ctx) => {
  const { id } = await params;
  const { error } = await supabase.from("flows").delete().eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
});
