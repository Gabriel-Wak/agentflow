import { fail, json, withUser } from "@/lib/api";

export const GET = withUser(async ({ supabase }) => {
  const { data, error } = await supabase.from("prompts").select("*").order("created_at", { ascending: false });
  if (error) return fail(error.message, 500);
  return json(data);
});

export const POST = withUser(async ({ supabase }, req) => {
  const b = (await req.json()) as { title?: string; original?: string; improved?: string; notes?: string };
  if (!b.improved?.trim() || !b.original?.trim()) return fail("Nada para salvar.");
  const title = b.title?.trim() || b.original.trim().split("\n")[0].slice(0, 60);
  const { data, error } = await supabase
    .from("prompts")
    .insert({ title, original: b.original, improved: b.improved, notes: b.notes ?? "" })
    .select("*")
    .single();
  if (error) return fail(error.message, 500);
  return json(data, 201);
});
