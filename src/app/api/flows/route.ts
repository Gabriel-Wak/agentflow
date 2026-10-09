import { fail, json, withUser } from "@/lib/api";
import { defaultFlow } from "@/lib/flow-template";

export const GET = withUser(async ({ supabase }) => {
  const { data, error } = await supabase
    .from("flows")
    .select("id, name, updated_at, nodes")
    .order("updated_at", { ascending: false });
  if (error) return fail(error.message, 500);
  return json(data);
});

export const POST = withUser(async ({ supabase }, req) => {
  const b = (await req.json().catch(() => ({}))) as { name?: string };
  const tpl = defaultFlow();
  const { data, error } = await supabase
    .from("flows")
    .insert({ name: b.name?.trim() || "Novo time de agentes", ...tpl })
    .select("id")
    .single();
  if (error) return fail(error.message, 500);
  return json(data, 201);
});
