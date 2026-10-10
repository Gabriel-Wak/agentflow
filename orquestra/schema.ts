/**
 * Validação das mensagens que chegam do canvas pelo WebSocket.
 *
 * O navegador é confiável (tem o token), mas pode ter bug ou estar numa versão antiga:
 * uma mensagem malformada vira um erro para aquele cliente, nunca derruba o daemon
 * nem corrompe o grafo. Campos desconhecidos são descartados.
 */
import { z } from "zod";
import type { ClientMsg, Graph } from "../src/lib/orquestra/protocol";

const id = z.string().min(1).max(200);
const size = z.number().int().min(1).max(1000);

export const agentInfoSchema = z.object({
  id,
  // Vazio é aceito: o usuário pode estar no meio de renomear o nó.
  name: z.string().trim().max(80),
  role: z.string().max(2000).default(""),
  kind: z.enum(["claude", "codex", "shell"]),
  prompt: z.string().max(100_000).optional(),
  deny: z.array(z.string().max(500)).max(200).optional(),
  allow: z.array(z.string().max(500)).max(200).optional(),
  maestro: z.boolean().optional(),
  // Sistema desconhecido (versão nova do canvas) é ignorado, não derruba o agente.
  systems: z
    .array(z.unknown())
    .max(10)
    .transform((l) => [...new Set(l.filter((x): x is "db" | "repos" => x === "db" || x === "repos"))])
    .optional(),
});

/**
 * Lista em que cada item é validado sozinho: um nó estranho é descartado, mas o resto do
 * grafo continua valendo (recusar tudo deixaria o daemon com um grafo velho).
 */
const tolerantArray = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(z.unknown())
    .max(max)
    .default([])
    .transform((list) => list.flatMap((x) => {
      const r = item.safeParse(x);
      return r.success ? [r.data as z.output<T>] : [];
    }));

export const graphSchema = z.object({
  cwd: z.string().max(4096).default(""),
  agents: tolerantArray(agentInfoSchema, 500),
  notes: tolerantArray(z.object({ id, title: z.string().max(500).default(""), content: z.string().max(500_000).default("") }), 1000),
  edges: tolerantArray(z.tuple([id, id]), 5000),
});

export const routineInputSchema = z.object({
  id: id.optional(),
  agent: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(4000),
  everyMinutes: z.number().min(1).max(1440),
  enabled: z.boolean().optional(),
});

export const clientMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("graph"), graph: graphSchema }),
  z.object({ type: z.literal("spawn"), id, cols: size, rows: size, agent: agentInfoSchema, cwd: z.string().max(4096).default("") }),
  z.object({ type: z.literal("attach"), id }),
  z.object({ type: z.literal("input"), id, data: z.string().max(1_000_000) }),
  z.object({ type: z.literal("resize"), id, cols: size, rows: size }),
  z.object({ type: z.literal("kill"), id }),
  z.object({ type: z.literal("send"), to: z.array(id).min(1).max(500), text: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal("scores:list") }),
  z.object({ type: z.literal("scores:save"), name: z.string().trim().min(1).max(120), canvas: z.unknown() }),
  z.object({ type: z.literal("scores:delete"), name: z.string().trim().min(1).max(120) }),
  z.object({ type: z.literal("usage:refresh") }),
  z.object({ type: z.literal("routines:list") }),
  z.object({ type: z.literal("routines:save"), routine: routineInputSchema }),
  z.object({ type: z.literal("routines:delete"), id }),
  z.object({ type: z.literal("routines:run"), id }),
  z.object({ type: z.literal("af:refresh") }),
  z.object({ type: z.literal("af:sync") }),
  z.object({ type: z.literal("reports:list") }),
  z.object({ type: z.literal("reports:read"), id: z.string().min(1).max(200) }),
  z.object({ type: z.literal("autostart:save"), canvas: z.unknown() }),
  z.object({ type: z.literal("autostart:clear") }),
]);

/**
 * Partitura do canvas ({ nodes, edges, cwd }) → grafo do daemon. Usada pela formação de
 * inicialização (24h): nós de terminal viram agentes, notas viram notas, ligações viram arestas.
 * Devolve null se não der para usar.
 */
export function canvasToGraph(canvas: unknown): Graph | null {
  const c = z
    .object({
      nodes: z.array(z.unknown()).max(1000),
      edges: z.array(z.unknown()).max(5000).default([]),
      cwd: z.string().max(4096).default(""),
    })
    .safeParse(canvas);
  if (!c.success) return null;
  const node = z.object({ id, type: z.string(), data: z.record(z.string(), z.unknown()) });
  const agents: Graph["agents"] = [];
  const notes: Graph["notes"] = [];
  for (const raw of c.data.nodes) {
    const n = node.safeParse(raw);
    if (!n.success) continue;
    if (n.data.type === "terminal") {
      const a = agentInfoSchema.safeParse({ ...n.data.data, id: n.data.id });
      if (a.success) agents.push(a.data);
    } else if (n.data.type === "note") {
      const d = n.data.data;
      notes.push({ id: n.data.id, title: typeof d.title === "string" ? d.title : "", content: typeof d.content === "string" ? d.content : "" });
    }
  }
  const edge = z.object({ source: id, target: id });
  const edges = c.data.edges.flatMap((e) => {
    const r = edge.safeParse(e);
    return r.success ? [[r.data.source, r.data.target] as [string, string]] : [];
  });
  return { cwd: c.data.cwd, agents, notes, edges };
}

/** Lê uma mensagem crua do WebSocket. Devolve a mensagem ou o motivo da recusa. */
export function parseClientMsg(raw: string): { ok: true; msg: ClientMsg } | { ok: false; error: string; id?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "mensagem inválida (não é JSON)" };
  }
  const r = clientMsgSchema.safeParse(json);
  if (r.success) {
    const msg: ClientMsg = r.data; // garante em tempo de compilação que o schema bate com o protocolo
    return { ok: true, msg };
  }
  const issue = r.error.issues[0];
  const type = (json as { type?: unknown })?.type;
  const msgId = (json as { id?: unknown })?.id;
  return {
    ok: false,
    error: `mensagem "${typeof type === "string" ? type.slice(0, 40) : "?"}" inválida: ${issue ? `${issue.path.join(".") || "(raiz)"} — ${issue.message}` : "formato inesperado"}`,
    id: typeof msgId === "string" ? msgId.slice(0, 200) : undefined,
  };
}
