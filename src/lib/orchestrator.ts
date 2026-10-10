import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Edge, Node } from "@xyflow/react";
import { z } from "zod";
import { anthropic, DEFAULT_MODEL, fallbackParams, reasoningParams } from "./anthropic";
import { decryptFor } from "./crypto";
import { describeSchema, readOnlyQuery } from "./integrations/database";
import { listFiles, readFile, type GithubConfig } from "./integrations/github";
import { DEFAULT_ROLE_PROMPTS, isReviewer, parseVerdict } from "./roles";
import type { AgentNodeData, FlowSettings, RunEvent, TaskNodeData } from "./types";

type Emit = (e: RunEvent) => void;

interface ConnRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, string>;
  secret: string | null;
}
interface AgentRow {
  id: string;
  name: string;
  kind: string;
  system_prompt: string;
  model: string;
  config: Record<string, string>;
  secret: string | null;
}

const MAX_TOOL_TURNS = 12;

/** Ordem de execução: ordenação topológica a partir do nó de tarefa (arestas de volta são ignoradas). */
export function executionOrder(nodes: Node[], edges: Edge[]): Node[] {
  const start = nodes.find((n) => n.type === "task");
  if (!start) throw new Error("O fluxo precisa de um nó de Tarefa.");
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);

  // DFS para descobrir os nós alcançáveis e marcar arestas que fecham ciclo.
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const post: string[] = [];
  const dfs = (id: string) => {
    visited.add(id);
    onStack.add(id);
    for (const next of out.get(id) ?? []) {
      if (onStack.has(next)) continue; // aresta de volta (loop de revisão)
      if (!visited.has(next)) dfs(next);
    }
    onStack.delete(id);
    post.push(id);
  };
  dfs(start.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return post
    .reverse()
    .map((id) => byId.get(id)!)
    .filter((n) => n?.type === "agent");
}

function toolDefs(hasGithub: boolean, hasDb: boolean): Anthropic.Beta.BetaTool[] {
  const tools: Anthropic.Beta.BetaTool[] = [];
  if (hasGithub) {
    tools.push(
      {
        name: "github_list_files",
        description:
          "Lista os arquivos do repositório GitHub conectado. Use 'prefix' para uma pasta ou 'query' para filtrar pelo nome.",
        input_schema: {
          type: "object",
          properties: {
            prefix: { type: "string", description: "Pasta, ex.: src/app" },
            query: { type: "string", description: "Trecho do caminho, ex.: auth" },
          },
        },
        eager_input_streaming: true,
      },
      {
        name: "github_read_file",
        description: "Lê o conteúdo de um arquivo do repositório GitHub conectado.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string", description: "Caminho completo do arquivo" } },
          required: ["path"],
        },
        eager_input_streaming: true,
      },
    );
  }
  if (hasDb) {
    tools.push(
      {
        name: "database_schema",
        description:
          "Mostra tabelas e colunas do banco PostgreSQL conectado. Informe 'table' (schema.tabela) para uma só.",
        input_schema: {
          type: "object",
          properties: { table: { type: "string" } },
        },
        eager_input_streaming: true,
      },
      {
        name: "database_query",
        description:
          "Executa UM comando SQL somente leitura (SELECT) no banco PostgreSQL conectado e devolve até 200 linhas.",
        input_schema: {
          type: "object",
          properties: { sql: { type: "string" } },
          required: ["sql"],
        },
        eager_input_streaming: true,
      },
    );
  }
  return tools;
}

const toolInputs = {
  github_list_files: z.object({ prefix: z.string().optional(), query: z.string().optional() }),
  github_read_file: z.object({ path: z.string().min(1) }),
  database_schema: z.object({ table: z.string().optional() }),
  database_query: z.object({ sql: z.string().min(1) }),
};

async function runTool(
  name: string,
  rawInput: unknown,
  ctx: { github?: { cfg: GithubConfig; token: string }; dbUrl?: string },
): Promise<{ content: string; isError: boolean }> {
  try {
    switch (name) {
      case "github_list_files": {
        const i = toolInputs.github_list_files.parse(rawInput);
        return { content: await listFiles(ctx.github!.cfg, ctx.github!.token, i.prefix, i.query), isError: false };
      }
      case "github_read_file": {
        const i = toolInputs.github_read_file.parse(rawInput);
        return { content: await readFile(ctx.github!.cfg, ctx.github!.token, i.path), isError: false };
      }
      case "database_schema": {
        const i = toolInputs.database_schema.parse(rawInput);
        return { content: await describeSchema(ctx.dbUrl!, i.table), isError: false };
      }
      case "database_query": {
        const i = toolInputs.database_query.parse(rawInput);
        return { content: await readOnlyQuery(ctx.dbUrl!, i.sql), isError: false };
      }
      default:
        return { content: `Ferramenta desconhecida: ${name}`, isError: true };
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return { content: JSON.stringify({ INVALID_JSON: rawInput }), isError: true };
    }
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

function slug(s: string, i: number) {
  return `${s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "mcp"}-${i}`;
}

async function runClaudeAgent(opts: {
  nodeId: string;
  system: string;
  userMessage: string;
  model: string;
  effort: AgentNodeData["effort"];
  github?: { cfg: GithubConfig; token: string };
  dbUrl?: string;
  mcp: { name: string; url: string; token: string }[];
  emit: Emit;
  signal?: AbortSignal;
}): Promise<string> {
  const { nodeId, emit } = opts;
  const client = anthropic();
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    ...toolDefs(Boolean(opts.github), Boolean(opts.dbUrl)),
    ...opts.mcp.map((m) => ({ type: "mcp_toolset" as const, mcp_server_name: m.name })),
  ];
  const fb = fallbackParams(opts.model);
  const betas = [...fb.betas, ...(opts.mcp.length ? ["mcp-client-2025-11-20"] : [])];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.userMessage }];
  let text = "";

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const turnStart = text;
    const stream = client.beta.messages.stream({
      model: opts.model,
      max_tokens: 32000,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages,
      ...(tools.length ? { tools } : {}),
      ...(opts.mcp.length
        ? {
            mcp_servers: opts.mcp.map((m) => ({
              type: "url" as const,
              name: m.name,
              url: m.url,
              ...(m.token ? { authorization_token: m.token } : {}),
            })),
          }
        : {}),
      ...reasoningParams(opts.model, opts.effort),
      ...("fallbacks" in fb ? { fallbacks: fb.fallbacks } : {}),
      ...(betas.length ? { betas } : {}),
    }, { signal: opts.signal });

    let msg: Anthropic.Beta.BetaMessage;
    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          text += ev.delta.text;
          emit({ type: "delta", nodeId, text: ev.delta.text });
        } else if (ev.type === "content_block_start" && ev.content_block.type === "mcp_tool_use") {
          emit({ type: "tool", nodeId, name: `${ev.content_block.server_name}/${ev.content_block.name}`, detail: "MCP" });
        }
      }
      msg = await stream.finalMessage();
    } catch (e) {
      // Erro de API (inclusive cancelamento) sobe; falha de leitura do stream (ex.: JSON de ferramenta
      // truncado) tenta o mesmo turno de novo, descartando o texto parcial dele.
      if (e instanceof Anthropic.APIError || opts.signal?.aborted) throw e;
      if (turn < MAX_TOOL_TURNS - 1) {
        text = turnStart;
        emit({ type: "delta", nodeId, text: "\n\n[resposta interrompida — tentando de novo]\n\n" });
        continue;
      }
      throw e;
    }

    if (msg.stop_reason === "refusal") {
      const note = "\n\n[O modelo recusou esta solicitação.]";
      emit({ type: "delta", nodeId, text: note });
      return text + note;
    }

    messages.push({ role: "assistant", content: msg.content });

    if (msg.stop_reason === "pause_turn") continue;
    if (msg.stop_reason === "max_tokens") {
      const note = "\n\n[Resposta cortada por limite de tokens.]";
      emit({ type: "delta", nodeId, text: note });
      return text + note;
    }
    if (msg.stop_reason !== "tool_use") return text;

    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const results = await Promise.all(
      uses.map(async (u) => {
        const detail = JSON.stringify(u.input).slice(0, 160);
        emit({ type: "tool", nodeId, name: u.name, detail });
        const r = await runTool(u.name, u.input, { github: opts.github, dbUrl: opts.dbUrl });
        return {
          type: "tool_result" as const,
          tool_use_id: u.id,
          content: r.content,
          is_error: r.isError,
        };
      }),
    );
    messages.push({ role: "user", content: results });
    if (text && !text.endsWith("\n")) {
      text += "\n";
      emit({ type: "delta", nodeId, text: "\n" });
    }
  }
  return text;
}

async function runWebhookAgent(agent: AgentRow, payload: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const url = agent.config.url;
  if (!url) throw new Error(`Agente "${agent.name}" sem URL de webhook.`);
  const auth = decryptFor(agent.secret, agent.name);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Webhook ${res.status}: ${body.slice(0, 300)}`);
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const v = j.output ?? j.text ?? j.result ?? j.message ?? j.response;
    return typeof v === "string" ? v : JSON.stringify(j, null, 2);
  } catch {
    return body;
  }
}

function buildUserMessage(
  task: string,
  history: { label: string; role: string; output: string }[],
  feedback: string | null,
  role: string,
) {
  const parts = [`# Tarefa original\n${task}`];
  if (history.length) {
    parts.push(
      "# Trabalho dos agentes anteriores\n" +
        history.map((h) => `## ${h.label} (${h.role})\n${h.output}`).join("\n\n"),
    );
  }
  if (feedback) parts.push(`# Feedback da revisão anterior — corrija todos os pontos\n${feedback}`);
  parts.push(
    role === "creator"
      ? "Produza agora a entrega completa."
      : isReviewer(role as never)
        ? "Revise agora a entrega acima e termine com a linha de VEREDITO."
        : "Execute agora a sua parte.",
  );
  return parts.join("\n\n");
}

export async function runFlow(opts: {
  supabase: SupabaseClient;
  nodes: Node[];
  edges: Edge[];
  settings: FlowSettings;
  task?: string;
  emit: Emit;
  /** Abortado quando o navegador desconecta: paramos de chamar a API. */
  signal?: AbortSignal;
}): Promise<{ output: string; approved: boolean }> {
  const { supabase, nodes, edges, emit, signal } = opts;
  const order = executionOrder(nodes, edges);
  if (!order.length) throw new Error("Conecte pelo menos um agente ao nó de Tarefa.");

  const taskNode = nodes.find((n) => n.type === "task")!;
  const task = (opts.task || (taskNode.data as TaskNodeData).task || "").trim();
  if (!task) throw new Error("Escreva a tarefa no nó de Tarefa.");

  // Carrega conexões e agentes referenciados (RLS garante que são do usuário).
  const datas = order.map((n) => n.data as AgentNodeData);
  const connIds = [...new Set(datas.flatMap((d) => [...(d.mcpIds ?? []), d.databaseId, d.githubId]).filter(Boolean))];
  const agentIds = [...new Set(datas.map((d) => d.agentId).filter(Boolean))];
  const [conns, agents] = await Promise.all([
    connIds.length
      ? supabase.from("connections").select("id, kind, name, config, secret").in("id", connIds)
      : Promise.resolve({ data: [] as ConnRow[] }),
    agentIds.length
      ? supabase.from("agents").select("id, name, kind, system_prompt, model, config, secret").in("id", agentIds)
      : Promise.resolve({ data: [] as AgentRow[] }),
  ]);
  const connById = new Map(((conns.data ?? []) as ConnRow[]).map((c) => [c.id, c]));
  const agentById = new Map(((agents.data ?? []) as AgentRow[]).map((a) => [a.id, a]));

  const maxRounds = Math.max(1, Math.min(opts.settings.maxRounds || 3, 6));
  const outputs = new Map<string, string>();
  let feedback: string | null = null;
  let round = 1;
  let approved = true;
  let i = 0;

  while (i < order.length) {
    if (signal?.aborted) throw new Error("Execução cancelada.");
    const node = order[i];
    const d = node.data as AgentNodeData;
    const saved = d.agentId ? agentById.get(d.agentId) : undefined;
    emit({ type: "node_start", nodeId: node.id, label: d.label, round });

    const history = order
      .slice(0, i)
      .filter((n) => outputs.has(n.id))
      .map((n) => ({
        label: (n.data as AgentNodeData).label,
        role: (n.data as AgentNodeData).role,
        output: outputs.get(n.id)!,
      }));
    const userMessage = buildUserMessage(task, history, d.role === "creator" ? feedback : null, d.role);

    let output: string;
    if (saved?.kind === "webhook") {
      output = await runWebhookAgent(saved, { task, role: d.role, node: d.label, round, history, feedback }, signal);
      emit({ type: "delta", nodeId: node.id, text: output });
    } else {
      const gh = d.githubId ? connById.get(d.githubId) : undefined;
      const db = d.databaseId ? connById.get(d.databaseId) : undefined;
      const mcp = (d.mcpIds ?? [])
        .map((id) => connById.get(id))
        .filter((c): c is ConnRow => Boolean(c))
        .map((c, idx) => ({ name: slug(c.name, idx), url: c.config.url, token: decryptFor(c.secret, c.name) }));

      const base = saved?.system_prompt || d.systemPrompt || DEFAULT_ROLE_PROMPTS[d.role];
      const ctxNotes = [
        gh && `Repositório GitHub conectado: ${gh.config.repo} (branch ${gh.config.branch || "padrão"}). Use as ferramentas github_* para ler o código.`,
        db && `Banco PostgreSQL conectado: "${db.name}". Use database_schema e database_query (somente leitura).`,
        mcp.length && `Servidores MCP disponíveis: ${mcp.map((m) => m.name).join(", ")}.`,
      ].filter(Boolean);
      const system = ctxNotes.length ? `${base}\n\n# Contexto disponível\n${ctxNotes.join("\n")}` : base;

      output = await runClaudeAgent({
        nodeId: node.id,
        system,
        userMessage,
        model: saved?.model || d.model || DEFAULT_MODEL,
        effort: d.effort || "medium",
        github: gh ? { cfg: { repo: gh.config.repo, branch: gh.config.branch }, token: decryptFor(gh.secret, gh.name) } : undefined,
        dbUrl: db ? decryptFor(db.secret, db.name) : undefined,
        mcp,
        emit,
        signal,
      });
    }

    outputs.set(node.id, output);
    const verdict = isReviewer(d.role) ? parseVerdict(output) : undefined;
    emit({ type: "node_end", nodeId: node.id, output, verdict });

    if (verdict === "rejected") {
      // Volta para o último Criador antes deste revisor, levando o feedback.
      const back = order.slice(0, i).map((n, idx) => ({ n, idx })).reverse()
        .find(({ n }) => (n.data as AgentNodeData).role === "creator");
      if (back && round < maxRounds) {
        round++;
        feedback = `${d.label}:\n${output}`;
        emit({ type: "loop", fromNodeId: node.id, toNodeId: back.n.id, round, feedback });
        for (const n of order.slice(back.idx)) outputs.delete(n.id);
        i = back.idx;
        continue;
      }
      approved = false;
      break;
    }
    i++;
  }

  // Entrega final = última saída do Criador (ou do último agente, se não houver Criador).
  const creators = order.filter((n) => (n.data as AgentNodeData).role === "creator" && outputs.has(n.id));
  const finalNode = creators.at(-1) ?? [...order].reverse().find((n) => outputs.has(n.id));
  const output = finalNode ? outputs.get(finalNode.id)! : "";
  return { output, approved };
}
