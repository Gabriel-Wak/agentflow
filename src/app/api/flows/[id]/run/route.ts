import type { Edge, Node } from "@xyflow/react";
import { z } from "zod";
import { fail, ndjsonStream, readBody, withUser, errMsg } from "@/lib/api";
import { runFlow } from "@/lib/orchestrator";
import type { RunEvent } from "@/lib/types";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  nodes: z.array(z.object({ id: z.string(), type: z.string().optional(), data: z.record(z.string(), z.unknown()) }).passthrough()).max(500),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string() }).passthrough()).max(2000),
  settings: z.object({ maxRounds: z.number().int().min(1).max(6) }).catch({ maxRounds: 3 }).optional(),
  task: z.string().max(100_000).optional(),
});

export const POST = withUser(async ({ supabase }, req, { params }: Ctx) => {
  const { id } = await params;
  const b = await readBody(req, Body);
  const nodes = b.nodes as unknown as Node[];
  const edges = b.edges as unknown as Edge[];

  const { data: flow } = await supabase.from("flows").select("id").eq("id", id).single();
  if (!flow) return fail("Fluxo não encontrado.", 404);

  const fromNode = nodes.find((n) => n.type === "task")?.data?.task;
  const task = (b.task ?? (typeof fromNode === "string" ? fromNode : "")).trim();
  const { data: run } = await supabase
    .from("runs")
    .insert({ flow_id: id, task: task || "(sem tarefa)", status: "running" })
    .select("id")
    .single();

  return ndjsonStream(async (emit, signal) => {
    const log: RunEvent[] = [];
    const record = (e: RunEvent) => {
      emit(e);
      if (e.type !== "delta") log.push(e);
    };
    record({ type: "run_start", runId: run?.id ?? null });
    try {
      const result = await runFlow({ supabase, nodes, edges, settings: b.settings ?? { maxRounds: 3 }, task, emit: record, signal });
      record({ type: "done", output: result.output, approved: result.approved });
      if (run) {
        await supabase.from("runs").update({
          status: result.approved ? "approved" : "rejected",
          output: result.output,
          events: log,
        }).eq("id", run.id);
      }
    } catch (e) {
      // Navegador fechou: registra como cancelada (não é erro do fluxo).
      const cancelled = signal.aborted;
      if (!cancelled) record({ type: "error", message: errMsg(e) });
      if (run) await supabase.from("runs").update({ status: cancelled ? "cancelled" : "error", events: log }).eq("id", run.id);
    }
  }, req.signal);
});
