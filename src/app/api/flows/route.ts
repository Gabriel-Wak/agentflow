import { z } from "zod";
import { fail, json, readBody, withUser } from "@/lib/api";
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
  const b = await readBody(req, z.object({ name: z.string().max(200).optional() }).catch({}));
  const tpl = defaultFlow();
  const { data, error } = await supabase
    .from("flows")
    .insert({ name: b.name?.trim() || "Novo time de agentes", ...tpl })
    .select("id")
    .single();
  if (error) return fail(error.message, 500);
  return json(data, 201);
});
