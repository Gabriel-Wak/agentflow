import { fail, json, withUser } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withUser(async ({ supabase }, _req, { params }: Ctx) => {
  const { id } = await params;
  const { error } = await supabase.from("prompts").delete().eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
});
