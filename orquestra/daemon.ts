/**
 * Daemon local da Orquestra.
 *
 * - Abre terminais reais (PTY) com Claude Code, Codex ou shell para cada agente do canvas.
 * - Transmite os terminais para o navegador via WebSocket.
 * - Expõe um servidor MCP por agente (/mcp/<id>) com ferramentas para conversar
 *   com os agentes ligados a ele no canvas, ler terminais e escrever notas.
 *
 * Só escuta em 127.0.0.1 e exige token (WebSocket) ou chave por agente (MCP).
 * Rode com: npm run orquestra
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import * as pty from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentInfo, AgentKind, ClientMsg, Graph, Score, ServerMsg, TerminalStatus } from "../src/lib/orquestra/protocol";

const VERSION = "1.0.0";
const PORT = Number(process.env.ORQUESTRA_PORT || 4545);
const HOME = path.join(os.homedir(), ".agentflow");
const SCORES_DIR = path.join(HOME, "partituras");
const RUN_DIR = path.join(HOME, "run");
const BUFFER_LIMIT = 400_000; // caracteres guardados por terminal para reconectar
const ALLOWED_ORIGINS = new Set(
  ["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:3000", "http://127.0.0.1:3000",
    ...(process.env.ORQUESTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)],
);

fs.mkdirSync(SCORES_DIR, { recursive: true });
fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

// Token persistente: o navegador guarda e reconecta sem precisar de link novo.
const TOKEN_FILE = path.join(HOME, "orquestra-token");
const TOKEN = fs.existsSync(TOKEN_FILE)
  ? fs.readFileSync(TOKEN_FILE, "utf8").trim()
  : (() => {
      const t = randomBytes(24).toString("base64url");
      fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
      return t;
    })();

// O npm pode instalar o node-pty sem permissão de execução no spawn-helper.
try {
  const dir = path.join(path.dirname(require.resolve("node-pty/package.json")), "prebuilds");
  for (const sub of fs.readdirSync(dir)) {
    const helper = path.join(dir, sub, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {
  /* sem prebuilds: compilado localmente */
}

function hasCommand(cmd: string) {
  try {
    execFileSync("/bin/sh", ["-lc", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const available: Record<AgentKind, boolean> = { claude: hasCommand("claude"), codex: hasCommand("codex"), shell: true };

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- estado

let graph: Graph = { cwd: os.homedir(), agents: [], notes: [], edges: [] };

interface Term {
  pty: pty.IPty;
  buffer: string;
  status: TerminalStatus;
  key: string;
}
const terms = new Map<string, Term>();
const clients = new Set<WebSocket>();

function broadcast(msg: ServerMsg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

const agentById = (id: string) => graph.agents.find((a) => a.id === id);
const neighbors = (id: string): AgentInfo[] => {
  const ids = new Set<string>();
  for (const [a, b] of graph.edges) {
    if (a === id) ids.add(b);
    if (b === id) ids.add(a);
  }
  return graph.agents.filter((a) => ids.has(a.id));
};
const findByName = (list: AgentInfo[], name: string) => {
  const n = name.trim().replace(/^@/, "").toLowerCase();
  return list.find((a) => a.name.toLowerCase() === n || a.id === name);
};

const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r(?!\n)/g, "\n");

function tail(id: string, lines: number) {
  const t = terms.get(id);
  if (!t) return "(terminal não está rodando)";
  const text = stripAnsi(t.buffer).split("\n").map((l) => l.trimEnd()).filter((l, i, arr) => l || arr[i - 1]);
  return text.slice(-lines).join("\n");
}

/** Digita um prompt no terminal do agente (colagem "bracketed" + Enter). */
function deliver(id: string, text: string) {
  const t = terms.get(id);
  if (!t || t.status !== "running") throw new Error("o terminal desse agente não está rodando");
  t.pty.write(`\x1b[200~${text}\x1b[201~`);
  setTimeout(() => t.pty.write("\r"), 120);
}

// ---------------------------------------------------------------- agentes

function instructions(agent: AgentInfo) {
  const peers = neighbors(agent.id);
  return [
    `Você é "${agent.name}", um agente da Orquestra (canvas de agentes do AgentFlow).`,
    agent.role ? `Seu papel: ${agent.role}` : "",
    "Você pode colaborar com os agentes ligados a você no canvas usando as ferramentas MCP do servidor \"orquestra\":",
    "- listar_agentes: quem está ligado a você agora;",
    "- enviar_mensagem: delega uma tarefa, faz uma pergunta ou entrega um resultado a um agente ligado. A resposta chega depois como uma nova mensagem no seu terminal;",
    "- ler_terminal: lê as últimas linhas do terminal de um agente ligado;",
    "- escrever_nota / ler_notas: notas compartilhadas no canvas para progresso, decisões e resumos.",
    "Quando receber uma mensagem que começa com [Orquestra · de X], faça o pedido e responda a X com enviar_mensagem.",
    peers.length ? `Ligados a você agora: ${peers.map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

function launch(agent: AgentInfo, key: string): { file: string; args: string[] } {
  const shell = process.env.SHELL || "/bin/zsh";
  const mcpUrl = `http://127.0.0.1:${PORT}/mcp/${agent.id}?key=${key}`;
  if (agent.kind === "claude") {
    const cfg = path.join(RUN_DIR, `${agent.id}.mcp.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { orquestra: { type: "http", url: mcpUrl } } }), { mode: 0o600 });
    const cmd = [
      "claude",
      "--mcp-config", JSON.stringify(cfg),
      "--allowed-tools", "mcp__orquestra",
      "--append-system-prompt", shellQuote(instructions(agent)),
    ].join(" ");
    return { file: shell, args: ["-lc", cmd] };
  }
  if (agent.kind === "codex") {
    const cmd = [
      "codex",
      "-c", shellQuote(`mcp_servers.orquestra.url="${mcpUrl}"`),
      shellQuote(instructions(agent) + "\n\nResponda apenas 'Pronto.' e aguarde instruções."),
    ].join(" ");
    return { file: shell, args: ["-lc", cmd] };
  }
  return { file: shell, args: ["-l"] };
}

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function spawn(id: string, cols: number, rows: number) {
  const agent = agentById(id);
  if (!agent) throw new Error("agente não está no canvas");
  const old = terms.get(id);
  if (old?.status === "running") return;
  if (!available[agent.kind]) throw new Error(`"${agent.kind}" não encontrado no PATH. Instale a CLI e reinicie o daemon.`);

  const cwd = fs.existsSync(graph.cwd) ? graph.cwd : os.homedir();
  const key = randomBytes(18).toString("base64url");
  const { file, args } = launch(agent, key);
  const p = pty.spawn(file, args, {
    name: "xterm-256color",
    cols: Math.max(20, cols),
    rows: Math.max(5, rows),
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ORQUESTRA_AGENT: agent.name,
      // Qualquer CLI com suporte a MCP pode usar este endereço para falar com a Orquestra.
      ORQUESTRA_MCP_URL: `http://127.0.0.1:${PORT}/mcp/${id}?key=${key}`,
    } as Record<string, string>,
  });
  const t: Term = { pty: p, buffer: "", status: "running", key };
  terms.set(id, t);
  broadcast({ type: "status", id, status: "running" });

  p.onData((data) => {
    t.buffer += data;
    if (t.buffer.length > BUFFER_LIMIT) t.buffer = t.buffer.slice(-BUFFER_LIMIT);
    broadcast({ type: "output", id, data });
  });
  p.onExit(({ exitCode }) => {
    t.status = "exited";
    broadcast({ type: "status", id, status: "exited", code: exitCode });
  });
}

function kill(id: string) {
  const t = terms.get(id);
  if (!t) return;
  if (t.status === "running") t.pty.kill();
  terms.delete(id);
  fs.rmSync(path.join(RUN_DIR, `${id}.mcp.json`), { force: true });
  broadcast({ type: "status", id, status: "stopped" });
}

// ---------------------------------------------------------------- partituras (layouts salvos)

const scoreFile = (name: string) => path.join(SCORES_DIR, `${name.replace(/[^\w\- ]+/g, "").trim() || "sem-nome"}.json`);
function listScores(): Score[] {
  return fs
    .readdirSync(SCORES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SCORES_DIR, f), "utf8")) as Score;
      } catch {
        return null;
      }
    })
    .filter((s): s is Score => Boolean(s))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// ---------------------------------------------------------------- MCP por agente

function mcpFor(agentId: string) {
  const server = new McpServer({ name: "orquestra", version: VERSION });
  const me = () => agentById(agentId);
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

  server.registerTool(
    "listar_agentes",
    { description: "Lista os agentes ligados a você no canvas (nome, papel, tipo e se o terminal está rodando)." },
    async () => {
      const peers = neighbors(agentId);
      if (!peers.length) return text("Nenhum agente ligado a você. Peça ao usuário para ligar você a outro agente no canvas.");
      return text(peers.map((p) => `- ${p.name} · ${p.kind}${p.role ? ` · ${p.role}` : ""} · ${terms.get(p.id)?.status ?? "parado"}`).join("\n"));
    },
  );

  server.registerTool(
    "enviar_mensagem",
    {
      description:
        "Envia uma mensagem para um agente ligado a você: delegar tarefa, perguntar ou entregar resultado. A mensagem é digitada no terminal dele; a resposta chega depois no seu terminal.",
      inputSchema: {
        para: z.string().describe("Nome do agente destinatário"),
        mensagem: z.string().min(1).describe("Texto completo da mensagem, com todo o contexto necessário"),
      },
    },
    async ({ para, mensagem }) => {
      const from = me();
      const target = findByName(neighbors(agentId), para);
      if (!from || !target) return fail(`"${para}" não está ligado a você. Use listar_agentes.`);
      try {
        deliver(target.id, `[Orquestra · de ${from.name}] ${mensagem}`);
      } catch (e) {
        return fail(`Não entreguei: ${(e as Error).message}.`);
      }
      broadcast({ type: "message", from: from.id, to: target.id, text: mensagem });
      return text(`Mensagem entregue a ${target.name}. A resposta chegará como nova mensagem no seu terminal — não fique esperando em loop.`);
    },
  );

  server.registerTool(
    "ler_terminal",
    {
      description: "Lê as últimas linhas do terminal de um agente ligado a você (ou o seu, com agente = seu nome).",
      inputSchema: { agente: z.string(), linhas: z.number().int().min(5).max(400).optional() },
    },
    async ({ agente, linhas }) => {
      const pool = [...neighbors(agentId), ...(me() ? [me()!] : [])];
      const target = findByName(pool, agente);
      if (!target) return fail(`"${agente}" não está ligado a você.`);
      return text(tail(target.id, linhas ?? 80));
    },
  );

  server.registerTool(
    "escrever_nota",
    {
      description: "Cria ou atualiza (pelo título) uma nota no canvas. Use para registrar progresso, decisões, resumos e próximos passos.",
      inputSchema: { titulo: z.string().min(1), conteudo: z.string() },
    },
    async ({ titulo, conteudo }) => {
      const existing = graph.notes.find((n) => n.title.toLowerCase() === titulo.toLowerCase());
      if (existing) existing.content = conteudo;
      else graph.notes.push({ id: `note-${Date.now().toString(36)}`, title: titulo, content: conteudo });
      broadcast({ type: "note", id: existing?.id, title: titulo, content: conteudo, by: agentId });
      return text(`Nota "${titulo}" ${existing ? "atualizada" : "criada"}.`);
    },
  );

  server.registerTool("ler_notas", { description: "Lê todas as notas do canvas." }, async () =>
    text(graph.notes.length ? graph.notes.map((n) => `## ${n.title}\n${n.content}`).join("\n\n") : "Nenhuma nota no canvas."),
  );

  return server;
}

// ---------------------------------------------------------------- HTTP + WebSocket

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const m = url.pathname.match(/^\/mcp\/([\w-]+)$/);
  if (m) {
    const term = terms.get(m[1]);
    if (!term || !safeEqual(url.searchParams.get("key") ?? "", term.key)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const server = mcpFor(m[1]);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const origin = req.headers.origin ?? "";
  if (!ALLOWED_ORIGINS.has(origin) || !safeEqual(url.searchParams.get("token") ?? "", TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws: WebSocket) => {
  clients.add(ws);
  const send = (m: ServerMsg) => ws.send(JSON.stringify(m));
  send({
    type: "hello",
    version: VERSION,
    home: os.homedir(),
    cwd: graph.cwd,
    terminals: Object.fromEntries([...terms].map(([id, t]) => [id, t.status])),
    agents: available,
  });

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "graph":
          graph = msg.graph;
          break;
        case "spawn":
          // O nó pode ter acabado de nascer: garante que o agente está no grafo.
          graph = { ...graph, cwd: msg.cwd || graph.cwd, agents: [...graph.agents.filter((a) => a.id !== msg.id), { ...msg.agent, id: msg.id }] };
          spawn(msg.id, msg.cols, msg.rows);
          break;
        case "attach": {
          const t = terms.get(msg.id);
          if (t) {
            send({ type: "output", id: msg.id, data: t.buffer });
            send({ type: "status", id: msg.id, status: t.status });
          }
          break;
        }
        case "input":
          terms.get(msg.id)?.pty.write(msg.data);
          break;
        case "resize": {
          const t = terms.get(msg.id);
          if (t?.status === "running") t.pty.resize(Math.max(20, msg.cols), Math.max(5, msg.rows));
          break;
        }
        case "kill":
          kill(msg.id);
          break;
        case "send":
          for (const id of msg.to) {
            deliver(id, msg.text);
            broadcast({ type: "message", from: "user", to: id, text: msg.text });
          }
          break;
        case "scores:list":
          send({ type: "scores", scores: listScores() });
          break;
        case "scores:save":
          fs.writeFileSync(scoreFile(msg.name), JSON.stringify({ name: msg.name, savedAt: new Date().toISOString(), canvas: msg.canvas }, null, 2));
          send({ type: "scores", scores: listScores() });
          break;
        case "scores:delete":
          fs.rmSync(scoreFile(msg.name), { force: true });
          send({ type: "scores", scores: listScores() });
          break;
      }
    } catch (e) {
      send({ type: "error", message: (e as Error).message, id: "id" in msg ? (msg as { id: string }).id : undefined });
    }
  });
  ws.on("close", () => clients.delete(ws));
});

httpServer.listen(PORT, "127.0.0.1", () => {
  const app = process.env.ORQUESTRA_APP_URL || "http://localhost:3001";
  console.log(`\n  🎼 Orquestra rodando em ws://127.0.0.1:${PORT}`);
  console.log(`  Agentes disponíveis: ${Object.entries(available).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
  console.log(`\n  Abra: ${app}/orquestra#token=${TOKEN}\n`);
});

function shutdown() {
  for (const id of [...terms.keys()]) kill(id);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
