import { z } from "zod";
import { fail, json, readBody, withUser } from "@/lib/api";

export const GET = withUser(async ({ supabase }) => {
  const { data, error } = await supabase.from("prompts").select("*").order("created_at", { ascending: false });
  if (error) return fail(error.message, 500);
  return json(data);
});

export const POST = withUser(async ({ supabase }, req) => {
  const b = await readBody(
    req,
    z.object({ title: z.string().max(200).optional(), original: z.string().max(200_000).optional(), improved: z.string().max(400_000).optional(), notes: z.string().max(20_000).optional() }),
  );
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
