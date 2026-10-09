import type { Edge, Node } from "@xyflow/react";
import { fail, ndjsonStream, withUser, errMsg } from "@/lib/api";
import { runFlow } from "@/lib/orchestrator";
import type { FlowSettings, RunEvent } from "@/lib/types";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const POST = withUser(async ({ supabase }, req, { params }: Ctx) => {
  const { id } = await params;
  const b = (await req.json()) as { nodes: Node[]; edges: Edge[]; settings: FlowSettings; task?: string };
  if (!Array.isArray(b.nodes) || !Array.isArray(b.edges)) return fail("Fluxo inválido.");

  const { data: flow } = await supabase.from("flows").select("id").eq("id", id).single();
  if (!flow) return fail("Fluxo não encontrado.", 404);

  const task = (b.task ?? (b.nodes.find((n) => n.type === "task")?.data?.task as string) ?? "").trim();
  const { data: run } = await supabase
    .from("runs")
    .insert({ flow_id: id, task: task || "(sem tarefa)", status: "running" })
    .select("id")
    .single();

  return ndjsonStream(async (emit) => {
    const log: RunEvent[] = [];
    const record = (e: RunEvent) => {
      emit(e);
      if (e.type !== "delta") log.push(e);
    };
    record({ type: "run_start", runId: run?.id ?? null });
    try {
      const result = await runFlow({ supabase, nodes: b.nodes, edges: b.edges, settings: b.settings ?? { maxRounds: 3 }, task, emit: record });
      record({ type: "done", output: result.output, approved: result.approved });
      if (run) {
        await supabase.from("runs").update({
          status: result.approved ? "approved" : "rejected",
          output: result.output,
          events: log,
        }).eq("id", run.id);
      }
    } catch (e) {
      record({ type: "error", message: errMsg(e) });
      if (run) await supabase.from("runs").update({ status: "error", events: log }).eq("id", run.id);
    }
  });
});
