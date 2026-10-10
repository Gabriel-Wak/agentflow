/**
 * Daemon local da Orquestra.
 *
 * - Abre terminais reais (PTY) com Claude Code, Codex ou shell para cada agente do canvas.
 * - Transmite os terminais para o navegador via WebSocket.
 * - Expõe um servidor MCP por agente (/mcp/<id>) com ferramentas para conversar
 *   com os agentes ligados a ele no canvas, ler terminais e escrever notas.
 * - Modo Maestro: um agente com `maestro: true` vê e comanda todos os outros, cria
 *   agentes novos, liga/desliga, agenda rotinas e manda notificações — mesmo com o
 *   navegador fechado (o canvas sincroniza quando reabrir).
 *
 * Só escuta em 127.0.0.1 e exige token (WebSocket) ou chave por agente (MCP).
 * Rode com: npm run orquestra
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { execFileSync, spawn as spawnProcess, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import * as pty from "node-pty";
import { Terminal as Screen } from "@xterm/headless";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AfSystem, AgentInfo, AgentKind, ClaudeUsage, ClientMsg, Graph, ReportMeta, Score, ServerMsg, TerminalStatus } from "../src/lib/orquestra/protocol";
import { describeUsage, fetchClaudeUsage, stopUsageFetches } from "./usage";
import { CLAUDE_BIN, claudeTrusts, cleanEnv, log, macNotify, pasteSafe, RoutineStore, shellQuote, stopChildren } from "./support";
import { canvasToGraph, parseClientMsg } from "./schema";
import { AlwaysFit } from "./alwaysfit";
import { ReportStore, SEVERITIES } from "./reports";
import { DailyRestart, parseDailyTime } from "./daily";

const VERSION = "1.2.0";
const PORT = Number(process.env.ORQUESTRA_PORT || 4545);
const HOME = process.env.ORQUESTRA_HOME || path.join(os.homedir(), ".agentflow");
const SCORES_DIR = path.join(HOME, "partituras");
const RUN_DIR = path.join(HOME, "run");
const BUFFER_LIMIT = 400_000; // caracteres guardados por terminal para reconectar
const SCREEN_SCROLLBACK = 1000; // linhas que ler_terminal enxerga além da tela (máx. pedido: 400)
const USAGE_INTERVAL = Math.max(60, Number(process.env.ORQUESTRA_USAGE_SECONDS || 300)) * 1000;
const USAGE_MIN_GAP = 60_000; // nunca consulta a CLI mais de uma vez por minuto
const PENDING_TTL = 30_000; // quanto tempo uma mudança do Maestro espera o canvas confirmar
const MAX_WS_PAYLOAD = 8 * 1024 * 1024; // maior mensagem aceita do canvas (partitura grande cabe folgado)
const MAX_CLIENT_BACKLOG = 64 * 1024 * 1024; // aba travada acumulando saída: derruba, ela reconecta e faz attach
const PASTE_ENTER_MS = 120; // espera entre colar e apertar Enter
const DELIVERY_GAP_MS = 300; // intervalo entre duas mensagens para o mesmo agente
const STARTED_AT = Date.now();
const AUTOSTART_FILE = path.join(HOME, "autostart.json");
const AUTOSTART_GAP_MS = Math.max(0, Number(process.env.ORQUESTRA_AUTOSTART_GAP_MS ?? 1500));
// Reinício diário dos agentes de IA: padrão 04:00; ORQUESTRA_DAILY_RESTART= (vazio) desliga.
const DAILY_RESTART = process.env.ORQUESTRA_DAILY_RESTART ?? "04:00";
const ALLOWED_ORIGINS = new Set(
  ["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:3000", "http://127.0.0.1:3000",
    ...(process.env.ORQUESTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)],
);

fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
fs.mkdirSync(SCORES_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
// Configs MCP de uma execução anterior: as chaves já não valem, só ocupam espaço.
for (const f of fs.readdirSync(RUN_DIR)) if (f.endsWith(".mcp.json")) fs.rmSync(path.join(RUN_DIR, f), { force: true });

// Token persistente: o navegador guarda e reconecta sem precisar de link novo.
// Arquivo vazio ou curto demais (editado à mão) gera um novo — token vazio abriria o daemon.
const TOKEN_FILE = path.join(HOME, "orquestra-token");
const TOKEN = (() => {
  const saved = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "";
  if (saved.length >= 24) {
    fs.chmodSync(TOKEN_FILE, 0o600);
    return saved;
  }
  const t = randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600); // `mode` só vale ao criar: um arquivo antigo 0644 continuaria legível
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
    execFileSync("/bin/sh", ["-lc", `command -v ${shellQuote(cmd)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const available: Record<AgentKind, boolean> = { claude: hasCommand(CLAUDE_BIN), codex: hasCommand("codex"), shell: true };

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- estado

let graph: Graph = { cwd: os.homedir(), agents: [], notes: [], edges: [] };

interface Term {
  pty: pty.IPty;
  /** Saída bruta, reenviada ao canvas no attach. */
  buffer: string;
  /** A mesma saída renderizada num terminal sem tela: é o que ler_terminal lê. */
  screen: Screen;
  status: TerminalStatus;
  key: string;
  cwd: string;
  startedAt: number;
  lastOutputAt: number;
}
const terms = new Map<string, Term>();
const clients = new Set<WebSocket>();
const routines = new RoutineStore(path.join(HOME, "rotinas.json"));
const reports = new ReportStore(HOME);
const alwaysfit = new AlwaysFit(
  {
    home: HOME,
    org: process.env.ORQUESTRA_AF_ORG || "AlwaysFit",
    loginPath: process.env.ORQUESTRA_AF_LOGIN_PATH || "alwaysfit-readonly",
    syncMinutes: Math.max(5, Number(process.env.ORQUESTRA_AF_SYNC_MINUTES) || 60),
    concurrency: 4,
  },
  (status) => broadcast({ type: "af:status", status }),
);

function broadcast(msg: ServerMsg) {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState !== c.OPEN) continue;
    if (c.bufferedAmount > MAX_CLIENT_BACKLOG) {
      log("canvas não acompanha a saída dos terminais; desconectado (ele reconecta sozinho)");
      c.terminate();
      continue;
    }
    c.send(data);
  }
}

const agentById = (id: string) => graph.agents.find((a) => a.id === id);
const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const linked = (a: string, b: string) => graph.edges.some(([x, y]) => edgeKey(x, y) === edgeKey(a, b));
const neighbors = (id: string): AgentInfo[] => {
  const ids = new Set<string>();
  for (const [a, b] of graph.edges) {
    if (a === id) ids.add(b);
    if (b === id) ids.add(a);
  }
  return graph.agents.filter((a) => ids.has(a.id));
};
/** Com quem este agente pode falar: o Maestro fala com todos; os outros, só com quem está ligado. */
const reachable = (id: string): AgentInfo[] => (agentById(id)?.maestro ? graph.agents.filter((a) => a.id !== id) : neighbors(id));
const findByName = (list: AgentInfo[], name: string) => {
  const n = name.trim().replace(/^@/, "").toLowerCase();
  return list.find((a) => a.name.toLowerCase() === n || a.id === name);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r(?!\n)/g, "\n");

/**
 * Últimas linhas do terminal como aparecem na tela. Ler o texto bruto sem ANSI não basta:
 * redesenhos (\r, ESC[K, saltos de cursor do zsh e do Claude Code) viravam linhas duplicadas.
 */
async function tail(id: string, lines: number) {
  const t = terms.get(id);
  if (!t) return "(terminal não está rodando)";
  // write é assíncrono: espera o parser processar o que já chegou (com teto, caso o terminal seja descartado).
  await Promise.race([new Promise<void>((r) => t.screen.write("", r)), sleep(1000)]);
  if (terms.get(id) !== t) return "(terminal não está rodando)";
  const b = t.screen.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    // Linha quebrada pela largura: junta com a anterior (sem cortar espaços na emenda).
    const wrapsNext = b.getLine(i + 1)?.isWrapped ?? false;
    const text = line.translateToString(!wrapsNext);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => l || arr[i - 1])
    .slice(-lines)
    .join("\n");
}

const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10}h`;
};
const statusLabel = (id: string) => {
  if (trustQueue.has(id)) return "na fila (esperando o usuário confiar na pasta)";
  const t = terms.get(id);
  if (!t) return "parado";
  if (t.status !== "running") return t.status === "exited" ? "encerrado" : "parado";
  return Date.now() - t.lastOutputAt < 4000 ? "trabalhando" : `ocioso há ${ago(t.lastOutputAt)}`;
};

/**
 * Cabeçalho "[Orquestra · ...]" para quem é modelo (Claude, Codex). Num terminal comum o texto
 * vira comando, e o cabeçalho quebraria a linha (no zsh, "[Orquestra" é glob inválido e nada roda).
 */
const framed = (id: string, header: string, text: string) => (agentById(id)?.kind === "shell" ? text : `[Orquestra · ${header}] ${text}`);


/** Fila de entrega por agente: duas mensagens ao mesmo tempo não se misturam numa colagem só. */
const outbox = new Map<string, Promise<void>>();

/**
 * Digita um prompt no terminal do agente (colagem "bracketed" + Enter).
 * Lança na hora se o agente não pode receber; a digitação em si entra na fila dele.
 *
 * Rotinas e mensagens só digitam no terminal do agente — o daemon nunca executa comandos.
 * Num agente do tipo terminal (shell), porém, o texto digitado + Enter roda como comando,
 * com o mesmo poder de você digitando ali.
 */
function deliver(id: string, text: string) {
  if (trustQueue.has(id)) throw new Error("o agente está na fila, esperando o usuário confiar na pasta");
  const t = terms.get(id);
  if (!t || t.status !== "running") throw new Error("o terminal desse agente não está rodando");
  const paste = `\x1b[200~${pasteSafe(text)}\x1b[201~`;
  // Parado ou reiniciado enquanto esperava na fila: descarta em vez de escrever num PTY morto.
  const alive = () => terms.get(id) === t && t.status === "running";
  const next = (outbox.get(id) ?? Promise.resolve())
    .then(async () => {
      if (!alive()) return;
      t.pty.write(paste);
      await sleep(PASTE_ENTER_MS);
      if (!alive()) return;
      t.pty.write("\r");
      await sleep(DELIVERY_GAP_MS);
    })
    .catch((e: Error) => log(`erro ao digitar no terminal de ${agentById(id)?.name ?? id}: ${e.message}`));
  outbox.set(id, next);
  void next.then(() => {
    if (outbox.get(id) === next) outbox.delete(id);
  });
}

// ---------------------------------------------------------------- sincronia com o canvas
//
// O canvas manda o grafo inteiro a cada mudança. Quando o Maestro muda algo, a mudança
// fica "pendente" até o canvas confirmar (ou expirar), para que um grafo antigo vindo do
// navegador não desfaça o que o Maestro acabou de fazer.

const pending = {
  agents: new Map<string, number>(),
  removedAgents: new Map<string, number>(),
  patches: new Map<string, { patch: Partial<AgentInfo>; at: number }>(),
  addedEdges: new Map<string, { edge: [string, string]; at: number }>(),
  removedEdges: new Map<string, number>(),
};

function mergeGraph(incoming: Graph) {
  const now = Date.now();
  for (const m of [pending.agents, pending.removedAgents, pending.removedEdges]) for (const [k, at] of m) if (now - at > PENDING_TTL) m.delete(k);
  for (const m of [pending.patches, pending.addedEdges]) for (const [k, v] of m) if (now - v.at > PENDING_TTL) m.delete(k);

  const inIds = new Set(incoming.agents.map((a) => a.id));
  for (const id of inIds) pending.agents.delete(id);
  for (const id of [...pending.removedAgents.keys()]) if (!inIds.has(id)) pending.removedAgents.delete(id);

  const agents = incoming.agents
    .filter((a) => !pending.removedAgents.has(a.id))
    .map((a) => {
      const p = pending.patches.get(a.id);
      if (!p) return a;
      const confirmed = Object.entries(p.patch).every(([k, v]) => JSON.stringify(a[k as keyof AgentInfo]) === JSON.stringify(v));
      if (confirmed) pending.patches.delete(a.id);
      return confirmed ? a : { ...a, ...p.patch };
    });
  for (const a of graph.agents) if (pending.agents.has(a.id) && !inIds.has(a.id)) agents.push(a);

  const inEdges = new Set(incoming.edges.map(([a, b]) => edgeKey(a, b)));
  for (const k of inEdges) pending.addedEdges.delete(k);
  for (const k of [...pending.removedEdges.keys()]) if (!inEdges.has(k)) pending.removedEdges.delete(k);
  const ids = new Set(agents.map((a) => a.id));
  const edges = incoming.edges.filter(([a, b]) => !pending.removedEdges.has(edgeKey(a, b)));
  for (const { edge } of pending.addedEdges.values()) edges.push(edge);

  graph = { cwd: validCwd(incoming.cwd) ?? graph.cwd, agents, notes: incoming.notes, edges: edges.filter(([a, b]) => ids.has(a) || ids.has(b)) };
}

/** Só aceita pasta absoluta; vazio ou relativo mantém a atual. */
const validCwd = (cwd: string | undefined) => (cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : undefined);

function addEdges(pairs: [string, string][]) {
  const added = pairs.filter(([a, b]) => a !== b && !linked(a, b));
  for (const e of added) {
    graph.edges.push(e);
    pending.addedEdges.set(edgeKey(...e), { edge: e, at: Date.now() });
    pending.removedEdges.delete(edgeKey(...e));
  }
  return added;
}

function removeEdge(a: string, b: string) {
  const k = edgeKey(a, b);
  graph.edges = graph.edges.filter(([x, y]) => edgeKey(x, y) !== k);
  pending.addedEdges.delete(k);
  pending.removedEdges.set(k, Date.now());
}

function patchAgent(id: string, patch: Partial<AgentInfo>) {
  const a = agentById(id);
  if (!a) return;
  Object.assign(a, patch);
  const prev = pending.patches.get(id)?.patch ?? {};
  pending.patches.set(id, { patch: { ...prev, ...patch }, at: Date.now() });
  broadcast({ type: "agent:update", id, patch });
}

// ---------------------------------------------------------------- limites do Claude

let usage: ClaudeUsage | null = null;
let usageAt = 0;
let usageRunning: Promise<ClaudeUsage> | null = null;

/** Lê os limites (no máximo 1x por minuto) e avisa o canvas. */
function refreshUsage(force = false): Promise<ClaudeUsage | null> {
  if (!available.claude) return Promise.resolve(null);
  if (usageRunning) return usageRunning;
  if (!force && usage && Date.now() - usageAt < USAGE_INTERVAL - 1000) return Promise.resolve(usage);
  if (usage && Date.now() - usageAt < USAGE_MIN_GAP) return Promise.resolve(usage);
  usageAt = Date.now();
  usageRunning = fetchClaudeUsage().then((u) => {
    // Falha passageira não apaga a última leitura boa.
    usage = u.ok || !usage?.ok ? u : { ...usage, error: u.error };
    usageRunning = null;
    broadcast({ type: "usage", usage });
    return usage;
  });
  return usageRunning;
}
// Só consulta enquanto houver alguém olhando ou agente rodando.
setInterval(() => {
  if (clients.size || [...terms.values()].some((t) => t.status === "running")) void refreshUsage();
}, USAGE_INTERVAL);

// ---------------------------------------------------------------- agentes

/** Sistemas Always Fit liberados para o agente (o Maestro vê todos). */
const systemsOf = (a: AgentInfo | undefined) => new Set<AfSystem>(a?.maestro ? ["db", "repos"] : (a?.systems ?? []));

function instructions(agent: AgentInfo) {
  const peers = neighbors(agent.id);
  const sys = systemsOf(agent);
  const alwaysFit = [
    sys.has("db") ? "- alwaysfit_sql: UMA consulta de leitura (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) na réplica do banco da Always Fit; CPF, e-mail, telefone e endereço vêm mascarados. Use LIMIT e filtros;" : "",
    sys.has("repos") ? `- alwaysfit_repos: repositórios da Always Fit (último commit, branch e caminho do espelho). Os espelhos ficam em ${alwaysfit.reposDir}/<nome>: leia com Read/Grep/Glob. São só leitura; as cópias de trabalho do usuário não devem ser tocadas;` : "",
    "- salvar_relatorio: grava um relatório em Markdown (gravidade info, atencao ou critico; critico avisa o usuário na hora);",
    "- listar_relatorios / ler_relatorio: relatórios já salvos, para consolidar resumos.",
    sys.size ? "Você só analisa e reporta: nunca altere código, banco ou repositórios, nem faça commit, push ou PR." : "",
  ];
  const common = [
    "- enviar_mensagem: delega uma tarefa, faz uma pergunta ou entrega um resultado. A resposta chega depois como uma nova mensagem no seu terminal — não fique esperando em loop;",
    "- ler_terminal: lê as últimas linhas do terminal de um agente;",
    "- escrever_nota / ler_notas: notas compartilhadas no canvas para progresso, decisões e resumos;",
    "- notificar: avisa o usuário (notificação no canvas e no macOS) quando algo precisa da atenção dele;",
    "- limite_claude: quanto do limite do plano do Claude (sessão de 5h e semanal) já foi usado. Consulte antes de tarefas longas ou ciclos repetitivos.",
    ...alwaysFit,
  ].filter(Boolean);
  if (agent.maestro) {
    return [
      `Você é "${agent.name}", o MAESTRO da Orquestra (canvas de agentes do Always Flow).`,
      agent.role ? `Seu papel: ${agent.role}` : "",
      "Você comanda todos os agentes do canvas, ligados a você ou não. Ferramentas MCP do servidor \"orquestra\":",
      "- listar_agentes: todos os agentes, com papel, estado (trabalhando/ocioso/parado) e ligações;",
      "- criar_agente: abre um agente novo (claude, codex ou terminal) com nome, papel e instruções, já ligado a você;",
      "- ligar_agentes / desligar_agentes: define quem pode falar com quem;",
      "- definir_papel: muda papel/instruções de um agente (vale ao reiniciar);",
      "- reiniciar_agente / parar_agente / remover_agente;",
      "- agendar_rotina / listar_rotinas / cancelar_rotina: mensagens repetidas para um agente em intervalo fixo (ex.: um ciclo de vigilância);",
      ...common,
      "Como trabalhar: quebre o pedido em tarefas, delegue a quem tem o papel certo (crie agentes se faltar alguém), acompanhe, consolide as respostas e entregue ao usuário. Não faça sozinho o que um subagente pode fazer.",
      "Quando receber uma mensagem que começa com [Orquestra · de X], é um subagente respondendo: consolide e siga o fluxo.",
      agent.prompt ? `\n${agent.prompt}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    `Você é "${agent.name}", um agente da Orquestra (canvas de agentes do Always Flow).`,
    agent.role ? `Seu papel: ${agent.role}` : "",
    "Você pode colaborar com os agentes ligados a você no canvas usando as ferramentas MCP do servidor \"orquestra\":",
    "- listar_agentes: quem está ligado a você agora;",
    ...common,
    "Quando receber uma mensagem que começa com [Orquestra · de X], faça o pedido e responda a X com enviar_mensagem.",
    agent.prompt ? `\n${agent.prompt}` : "",
    peers.length ? `Ligados a você ao iniciar: ${peers.map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

function launch(agent: AgentInfo, key: string): { file: string; args: string[] } {
  const shell = process.env.SHELL || "/bin/zsh";
  const mcpUrl = `http://127.0.0.1:${PORT}/mcp/${agent.id}?key=${key}`;
  if (agent.kind === "claude") {
    const cfg = path.join(RUN_DIR, `${agent.id}.mcp.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { orquestra: { type: "http", url: mcpUrl } } }), { mode: 0o600 });
    const cmd = [
      shellQuote(CLAUDE_BIN),
      "--mcp-config", shellQuote(cfg),
      "--allowed-tools", "mcp__orquestra", ...(agent.allow ?? []).map(shellQuote),
      ...(agent.deny?.length ? ["--disallowed-tools", ...agent.deny.map(shellQuote)] : []),
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

const agentCwd = () => (path.isAbsolute(graph.cwd) && fs.existsSync(graph.cwd) ? graph.cwd : os.homedir());

// Fila de confiança: numa pasta nova, o Claude Code pergunta se você confia nela. Em vez de
// abrir seis perguntas iguais, abre um terminal, espera você responder e libera o resto.
const trustQueue = new Map<string, { cols: number; rows: number; cwd: string }>();

function trustGate(cwd: string) {
  for (const [id, t] of terms) if (t.status === "running" && t.cwd === cwd && agentById(id)?.kind === "claude") return id;
  return undefined;
}

/**
 * O terminal que perguntou já foi liberado? O Claude grava a confiança no ~/.claude.json só
 * depois de um tempo, então também olhamos a tela: depois do diálogo aparece o banner "Claude Code vX".
 * (A tela usa saltos de cursor no lugar de espaços, por isso comparamos sem espaços.)
 */
function gateAccepted(id: string) {
  const t = terms.get(id);
  if (!t || t.status !== "running") return false;
  const screen = stripAnsi(t.buffer).replace(/\s+/g, "");
  const i = screen.lastIndexOf("trustthisfolder");
  return i >= 0 && /ClaudeCodev\d/.test(screen.slice(i));
}

setInterval(() => {
  const newGate = new Set<string>(); // pastas que acabaram de ganhar um terminal perguntando
  for (const [id, q] of trustQueue) {
    if (newGate.has(q.cwd)) continue;
    const gate = trustGate(q.cwd);
    const trusted = claudeTrusts(q.cwd) || (gate !== undefined && gateAccepted(gate));
    if (!trusted && gate) continue;
    trustQueue.delete(id);
    try {
      spawn(id, q.cols, q.rows, true);
    } catch (e) {
      broadcast({ type: "error", message: (e as Error).message, id });
    }
    if (!trusted) newGate.add(q.cwd); // ninguém perguntando (o anterior saiu): este vira o novo
  }
}, 1000);

function spawn(id: string, cols: number, rows: number, fromQueue = false) {
  const agent = agentById(id);
  if (!agent) throw new Error("agente não está no canvas");
  const old = terms.get(id);
  if (old?.status === "running" || (trustQueue.has(id) && !fromQueue)) return;
  if (!available[agent.kind]) throw new Error(`"${agent.kind}" não encontrado no PATH. Instale a CLI e reinicie o daemon.`);

  const cwd = agentCwd();
  if (agent.kind === "claude" && !fromQueue && !claudeTrusts(cwd) && trustGate(cwd)) {
    trustQueue.set(id, { cols, rows, cwd });
    broadcast({ type: "status", id, status: "queued" });
    return;
  }

  const key = randomBytes(18).toString("base64url");
  const { file, args } = launch(agent, key);
  const size = { cols: Math.max(20, cols), rows: Math.max(5, rows) };
  const p = pty.spawn(file, args, {
    name: "xterm-256color",
    ...size,
    cwd,
    env: cleanEnv({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ORQUESTRA_AGENT: agent.name,
      // Qualquer CLI com suporte a MCP pode usar este endereço para falar com a Orquestra.
      ORQUESTRA_MCP_URL: `http://127.0.0.1:${PORT}/mcp/${id}?key=${key}`,
    }),
  });
  // Terminal que tinha saído e volta: continua na mesma tela, como o buffer bruto.
  const screen = old?.screen ?? new Screen({ cols: size.cols, rows: size.rows, scrollback: SCREEN_SCROLLBACK, allowProposedApi: true });
  if (old) screen.resize(size.cols, size.rows);
  const t: Term = { pty: p, buffer: old?.buffer ?? "", screen, status: "running", key, cwd, startedAt: Date.now(), lastOutputAt: Date.now() };
  terms.set(id, t);
  broadcast({ type: "status", id, status: "running" });
  log(`${agent.name} iniciado (${agent.kind}${agent.maestro ? ", maestro" : ""})`);

  p.onData((data) => {
    // Saída final de um terminal já parado/substituído não pode vazar para o novo.
    if (terms.get(id) !== t) return;
    t.buffer += data;
    t.screen.write(data);
    t.lastOutputAt = Date.now();
    if (t.buffer.length > BUFFER_LIMIT) t.buffer = t.buffer.slice(-BUFFER_LIMIT);
    broadcast({ type: "output", id, data });
  });
  p.onExit(({ exitCode }) => {
    if (terms.get(id) !== t) return; // já foi substituído por um reinício
    t.status = "exited";
    broadcast({ type: "status", id, status: "exited", code: exitCode });
    log(`${agentById(id)?.name ?? id} encerrou (código ${exitCode})`);
  });
}

function kill(id: string) {
  const wasQueued = trustQueue.delete(id);
  const t = terms.get(id);
  if (!t) {
    if (wasQueued) broadcast({ type: "status", id, status: "stopped" });
    return;
  }
  terms.delete(id);
  outbox.delete(id);
  t.screen.dispose();
  if (t.status === "running") {
    try {
      t.pty.kill();
    } catch {
      /* já tinha saído */
    }
    log(`${agentById(id)?.name ?? id} parado`);
  }
  fs.rmSync(path.join(RUN_DIR, `${id}.mcp.json`), { force: true });
  broadcast({ type: "status", id, status: "stopped" });
}

function restart(id: string) {
  const t = terms.get(id);
  const q = trustQueue.get(id);
  const size = t ? { cols: t.pty.cols, rows: t.pty.rows } : q ? { cols: q.cols, rows: q.rows } : { cols: 120, rows: 36 };
  kill(id);
  spawn(id, size.cols, size.rows);
}

// ---------------------------------------------------------------- rotinas

const sendRoutines = () => broadcast({ type: "routines", routines: routines.list() });

function runRoutine(id: string) {
  const r = routines.get(id);
  if (!r) return;
  const target = findByName(graph.agents, r.agent);
  let error: string | undefined;
  try {
    if (!target) throw new Error(`agente "${r.agent}" não está no canvas`);
    deliver(target.id, framed(target.id, `rotina a cada ${r.everyMinutes} min`, r.message));
    broadcast({ type: "message", from: "rotina", to: target.id, text: r.message });
    log(`rotina ${r.id} disparada para ${target.name}`);
  } catch (e) {
    error = (e as Error).message;
    log(`rotina ${r.id} falhou: ${error}`);
  }
  routines.markRun(id, error);
  sendRoutines();
}

// Depois do Mac dormir, cada rotina vencida dispara uma vez só e é reagendada a partir de agora.
setInterval(() => {
  for (const r of routines.due()) runRoutine(r.id);
}, 15_000);

// ---------------------------------------------------------------- notificações

function notify(from: string, title: string, text: string, urgent: boolean) {
  broadcast({ type: "notify", from, title, text, urgent });
  log(`notificação de ${from}${urgent ? " (urgente)" : ""}`);
  // Ninguém olhando o canvas, ou urgente: notificação do sistema também.
  if (urgent || clients.size === 0) macNotify(`🎼 ${title}`, text);
}

// ---------------------------------------------------------------- partituras (layouts salvos)

/**
 * Arquivo da partitura. Só letras (com acento), números, espaço, _ e -: sem barra nem ponto,
 * nada sai de SCORES_DIR. Nomes que viram o mesmo arquivo (ex.: "a/b" e "ab") se sobrescrevem.
 */
const scoreFile = (name: string) =>
  path.join(SCORES_DIR, `${name.normalize("NFC").replace(/[^\p{L}\p{N}_\- ]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 80) || "sem-nome"}.json`);
function listScores(): Score[] {
  return fs
    .readdirSync(SCORES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SCORES_DIR, f), "utf8")) as Score;
        // Arquivo estranho na pasta não pode quebrar a lista inteira.
        return s && typeof s.name === "string" && typeof s.savedAt === "string" ? s : null;
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
  const isMaestro = Boolean(me()?.maestro);
  const describe = (a: AgentInfo) => {
    const links = neighbors(a.id).map((n) => n.name);
    return `- ${a.name}${a.maestro ? " 👑" : ""} · ${a.kind}${a.role ? ` · ${a.role}` : ""} · ${statusLabel(a.id)}${isMaestro ? ` · ligado a: ${links.length ? links.join(", ") : "ninguém"}` : ""}`;
  };

  server.registerTool(
    "listar_agentes",
    {
      description: isMaestro
        ? "Lista TODOS os agentes do canvas: nome, tipo, papel, estado (trabalhando, ocioso, parado) e com quem cada um está ligado."
        : "Lista os agentes ligados a você no canvas (nome, papel, tipo e estado).",
    },
    async () => {
      const list = isMaestro ? graph.agents.filter((a) => a.id !== agentId) : neighbors(agentId);
      if (!list.length) return text(isMaestro ? "Você é o único agente no canvas. Use criar_agente para montar a equipe." : "Nenhum agente ligado a você. Peça ao usuário para ligar você a outro agente no canvas.");
      return text(list.map(describe).join("\n"));
    },
  );

  server.registerTool(
    "enviar_mensagem",
    {
      description:
        "Envia uma mensagem para outro agente: delegar tarefa, perguntar ou entregar resultado. A mensagem é digitada no terminal dele; a resposta chega depois no seu terminal.",
      inputSchema: {
        para: z.string().describe("Nome do agente destinatário"),
        mensagem: z.string().min(1).describe("Texto completo da mensagem, com todo o contexto necessário"),
      },
    },
    async ({ para, mensagem }) => {
      const from = me();
      const target = findByName(reachable(agentId), para);
      if (!from || !target) return fail(`"${para}" não está ${isMaestro ? "no canvas" : "ligado a você"}. Use listar_agentes.`);
      try {
        deliver(target.id, framed(target.id, `de ${from.name}`, mensagem));
      } catch (e) {
        return fail(`Não entreguei: ${(e as Error).message}.${isMaestro ? " Use reiniciar_agente." : ""}`);
      }
      broadcast({ type: "message", from: from.id, to: target.id, text: mensagem });
      return text(`Mensagem entregue a ${target.name}. A resposta chegará como nova mensagem no seu terminal — não fique esperando em loop.`);
    },
  );

  server.registerTool(
    "ler_terminal",
    {
      description: "Lê as últimas linhas do terminal de um agente (ou o seu, com agente = seu nome).",
      inputSchema: { agente: z.string(), linhas: z.number().int().min(5).max(400).optional() },
    },
    async ({ agente, linhas }) => {
      const pool = [...reachable(agentId), ...(me() ? [me()!] : [])];
      const target = findByName(pool, agente);
      if (!target) return fail(`"${agente}" não está ${isMaestro ? "no canvas" : "ligado a você"}.`);
      return text(await tail(target.id, linhas ?? 80));
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
      else graph.notes.push({ id: `note-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`, title: titulo, content: conteudo });
      broadcast({ type: "note", id: existing?.id, title: titulo, content: conteudo, by: agentId });
      return text(`Nota "${titulo}" ${existing ? "atualizada" : "criada"}.`);
    },
  );

  server.registerTool("ler_notas", { description: "Lê todas as notas do canvas." }, async () =>
    text(graph.notes.length ? graph.notes.map((n) => `## ${n.title}\n${n.content}`).join("\n\n") : "Nenhuma nota no canvas."),
  );

  server.registerTool(
    "notificar",
    {
      description: "Avisa o usuário: aparece no canvas e, se ele não estiver olhando ou for urgente, como notificação do macOS. Use quando algo precisa da atenção ou aprovação dele.",
      inputSchema: { titulo: z.string().min(1).max(120), mensagem: z.string().min(1).max(400), urgente: z.boolean().optional() },
    },
    async ({ titulo, mensagem, urgente }) => {
      notify(me()?.name ?? agentId, titulo, mensagem, Boolean(urgente));
      return text("Usuário notificado.");
    },
  );

  server.registerTool(
    "limite_claude",
    { description: "Mostra quanto do limite do plano do Claude Code já foi usado (sessão de 5h, semanal e por modelo) e quando renova." },
    async () => text(describeUsage(await refreshUsage())),
  );

  // ------------------------------------------------ Always Fit (por sistema liberado no agente)

  const sys = systemsOf(me());

  if (sys.has("db")) {
    server.registerTool(
      "alwaysfit_sql",
      {
        description:
          "Roda UMA consulta de leitura na réplica do banco MySQL da Always Fit (SELECT, WITH, SHOW, DESCRIBE/DESC ou EXPLAIN). Sessão só leitura, até 15s, no máximo 200 linhas / 60 KB. CPF, e-mail, telefone e endereço (inclusive CEP) vêm mascarados; nomes ficam visíveis. Sempre filtre e use LIMIT.",
        inputSchema: {
          consulta: z.string().min(1).max(20_000).describe("A consulta SQL (uma só, sem ; no meio)"),
          limite: z.number().int().min(1).max(200).optional().describe("Máximo de linhas na resposta (padrão 200)"),
        },
      },
      async ({ consulta, limite }) => {
        try {
          return text(await alwaysfit.sql(consulta, limite ?? 200));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );
  }

  if (sys.has("repos")) {
    server.registerTool(
      "alwaysfit_repos",
      {
        description:
          "Repositórios da Always Fit espelhados localmente (só leitura): último commit, branch e caminho do espelho para ler com Read/Grep/Glob. Com `nome`, mostra os detalhes e os últimos 15 commits.",
        inputSchema: { nome: z.string().max(120).optional().describe("Nome do repositório (ex.: always-ticket)") },
      },
      async ({ nome }) => {
        try {
          return text(await alwaysfit.describeRepos(nome || undefined));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );
  }

  server.registerTool(
    "salvar_relatorio",
    {
      description:
        "Salva um relatório em Markdown (rodada de análise, incidente, resumo diário). Gravidade: info, atencao ou critico — critico também avisa o usuário na hora. Seja objetivo: o que viu, evidências, impacto e recomendação.",
      inputSchema: {
        titulo: z.string().trim().min(1).max(200),
        conteudo: z.string().min(1).max(200_000).describe("Corpo do relatório em Markdown"),
        gravidade: z.enum(SEVERITIES as [string, ...string[]]).describe("info | atencao | critico"),
      },
    },
    async ({ titulo, conteudo, gravidade }) => {
      const author = me()?.name ?? agentId;
      const meta = reports.save({ agent: author, title: titulo, content: conteudo, severity: gravidade as ReportMeta["severity"] });
      broadcast({ type: "report:new", report: meta });
      log(`relatório ${meta.severity} de ${author}: ${meta.id}`);
      if (meta.severity === "critico") notify(author, `Crítico: ${meta.title}`, `Relatório ${meta.id}`, true);
      return text(`Relatório salvo: ${meta.id}${meta.severity === "critico" ? " (usuário avisado)" : ""}.`);
    },
  );

  server.registerTool(
    "listar_relatorios",
    {
      description: "Lista os relatórios salvos, mais recentes primeiro (id, gravidade, agente, título).",
      inputSchema: {
        dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Só deste dia (AAAA-MM-DD)"),
        agente: z.string().max(80).optional(),
      },
    },
    async ({ dia, agente }) => {
      const list = reports.list({ day: dia, agent: agente, limit: 100 });
      if (!list.length) return text("Nenhum relatório encontrado.");
      return text(list.map((r) => `- ${r.id} · ${r.severity} · ${r.agent} · ${r.title}`).join("\n"));
    },
  );

  server.registerTool(
    "ler_relatorio",
    { description: "Lê um relatório pelo id (veja listar_relatorios).", inputSchema: { id: z.string().max(200) } },
    async ({ id }) => {
      try {
        return text(reports.read(id).content);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  if (!isMaestro) return server;

  // ------------------------------------------------ ferramentas exclusivas do Maestro

  const resolve = (name: string) => findByName(graph.agents, name);
  const kinds = ["claude", "codex", "terminal"] as const;

  server.registerTool(
    "criar_agente",
    {
      description:
        "Cria um agente novo no canvas e já inicia o terminal dele (na pasta do projeto). Ele nasce ligado a você e aos agentes de `ligar_a`.",
      inputSchema: {
        nome: z.string().min(1).max(40).describe("Nome único, sem espaços (ex.: Revisor)"),
        tipo: z.enum(kinds).optional().describe("claude (padrão), codex ou terminal"),
        papel: z.string().max(200).optional().describe("Papel em uma linha"),
        instrucoes: z.string().max(20_000).optional().describe("Instruções completas do agente (Markdown)"),
        ligar_a: z.array(z.string()).optional().describe("Outros agentes que podem falar com ele"),
      },
    },
    async ({ nome, tipo, papel, instrucoes, ligar_a }) => {
      const name = nome.trim().replace(/\s+/g, "-");
      if (!name) return fail("Dê um nome ao agente.");
      if (resolve(name)) return fail(`Já existe um agente chamado "${name}".`);
      const kind: AgentKind = tipo === "terminal" ? "shell" : (tipo ?? "claude");
      if (!available[kind]) return fail(`"${kind}" não está instalado nesta máquina.`);
      const others = (ligar_a ?? []).map((n) => ({ n, a: resolve(n) }));
      const missing = others.filter((o) => !o.a).map((o) => o.n);
      if (missing.length) return fail(`Não encontrei: ${missing.join(", ")}.`);

      const agent: AgentInfo = { id: `agent-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`, name, role: papel ?? "", kind, prompt: instrucoes || undefined };
      graph.agents.push(agent);
      pending.agents.set(agent.id, Date.now());
      const edges = addEdges([[agentId, agent.id], ...others.map((o) => [o.a!.id, agent.id] as [string, string])]);
      broadcast({ type: "agent:add", agent, edges, by: agentId });
      log(`${me()?.name ?? agentId} criou o agente ${name}`);
      try {
        spawn(agent.id, 120, 36);
      } catch (e) {
        return fail(`Criei "${name}" no canvas, mas não consegui iniciar: ${(e as Error).message}`);
      }
      const queued = trustQueue.has(agent.id);
      return text(`Agente "${name}" criado (${kind})${queued ? " — na fila até o usuário confiar na pasta" : " e iniciando"}. Ligado a: ${[me()!.name, ...others.map((o) => o.a!.name)].join(", ")}. Dê alguns segundos para ele carregar antes de enviar a primeira tarefa.`);
    },
  );

  server.registerTool(
    "ligar_agentes",
    { description: "Liga dois agentes para que possam conversar.", inputSchema: { a: z.string(), b: z.string() } },
    async ({ a, b }) => {
      const x = resolve(a);
      const y = resolve(b);
      if (!x || !y) return fail(`Não encontrei ${!x ? a : b}.`);
      if (linked(x.id, y.id)) return text(`${x.name} e ${y.name} já estão ligados.`);
      broadcast({ type: "edges", add: addEdges([[x.id, y.id]]), remove: [] });
      return text(`${x.name} ↔ ${y.name} ligados.`);
    },
  );

  server.registerTool(
    "desligar_agentes",
    { description: "Desfaz a ligação entre dois agentes.", inputSchema: { a: z.string(), b: z.string() } },
    async ({ a, b }) => {
      const x = resolve(a);
      const y = resolve(b);
      if (!x || !y) return fail(`Não encontrei ${!x ? a : b}.`);
      if (!linked(x.id, y.id)) return text(`${x.name} e ${y.name} não estavam ligados.`);
      removeEdge(x.id, y.id);
      broadcast({ type: "edges", add: [], remove: [[x.id, y.id]] });
      return text(`${x.name} e ${y.name} desligados.`);
    },
  );

  server.registerTool(
    "definir_papel",
    {
      description: "Muda o papel e/ou as instruções de um agente. Vale quando ele reiniciar (use reiniciar_agente) — ou mande a mudança por mensagem.",
      inputSchema: { agente: z.string(), papel: z.string().max(200).optional(), instrucoes: z.string().max(20_000).optional() },
    },
    async ({ agente, papel, instrucoes }) => {
      const a = resolve(agente);
      if (!a) return fail(`Não encontrei "${agente}".`);
      if (a.id === agentId) return fail("Você não pode reescrever as próprias instruções.");
      const patch: Partial<AgentInfo> = {};
      if (papel !== undefined) patch.role = papel;
      if (instrucoes !== undefined) patch.prompt = instrucoes;
      patchAgent(a.id, patch);
      return text(`Papel de ${a.name} atualizado. Reinicie para aplicar.`);
    },
  );

  server.registerTool(
    "reiniciar_agente",
    { description: "Reinicia (ou inicia) o terminal de um agente, aplicando papel e instruções atuais. A conversa dele recomeça do zero.", inputSchema: { agente: z.string() } },
    async ({ agente }) => {
      const a = resolve(agente);
      if (!a) return fail(`Não encontrei "${agente}".`);
      if (a.id === agentId) return fail("Você não pode reiniciar a si mesmo.");
      try {
        restart(a.id);
      } catch (e) {
        return fail((e as Error).message);
      }
      return text(`${a.name} reiniciando.`);
    },
  );

  server.registerTool(
    "parar_agente",
    { description: "Para o terminal de um agente (ele continua no canvas e pode ser reiniciado).", inputSchema: { agente: z.string() } },
    async ({ agente }) => {
      const a = resolve(agente);
      if (!a) return fail(`Não encontrei "${agente}".`);
      if (a.id === agentId) return fail("Você não pode parar a si mesmo.");
      kill(a.id);
      return text(`${a.name} parado.`);
    },
  );

  server.registerTool(
    "remover_agente",
    { description: "Para o terminal e remove o agente do canvas.", inputSchema: { agente: z.string() } },
    async ({ agente }) => {
      const a = resolve(agente);
      if (!a) return fail(`Não encontrei "${agente}".`);
      if (a.id === agentId) return fail("Você não pode remover a si mesmo.");
      kill(a.id);
      graph.agents = graph.agents.filter((x) => x.id !== a.id);
      graph.edges = graph.edges.filter(([x, y]) => x !== a.id && y !== a.id);
      pending.agents.delete(a.id);
      pending.removedAgents.set(a.id, Date.now());
      broadcast({ type: "agent:remove", id: a.id });
      log(`${me()?.name ?? agentId} removeu o agente ${a.name}`);
      return text(`${a.name} removido.`);
    },
  );

  server.registerTool(
    "agendar_rotina",
    {
      description:
        "Agenda uma mensagem repetida para um agente (ex.: Vigia a cada 15 min). A primeira execução acontece depois do primeiro intervalo; use rodar_agora para disparar já. Se já existir rotina igual para o agente, atualiza.",
      inputSchema: {
        agente: z.string(),
        mensagem: z.string().min(1).max(4000),
        a_cada_minutos: z.number().int().min(1).max(1440),
        rodar_agora: z.boolean().optional(),
      },
    },
    async ({ agente, mensagem, a_cada_minutos, rodar_agora }) => {
      const a = resolve(agente);
      if (!a) return fail(`Não encontrei "${agente}".`);
      const same = routines.list().find((r) => r.agent.toLowerCase() === a.name.toLowerCase() && r.message === mensagem);
      const r = routines.save({ id: same?.id, agent: a.name, message: mensagem, everyMinutes: a_cada_minutos, enabled: true }, me()?.name ?? agentId);
      if (rodar_agora) runRoutine(r.id);
      sendRoutines();
      return text(`Rotina ${r.id}: "${a.name}" a cada ${r.everyMinutes} min${rodar_agora ? " (primeira já enviada)" : ""}.`);
    },
  );

  server.registerTool("listar_rotinas", { description: "Lista as rotinas agendadas." }, async () => {
    const list = routines.list();
    if (!list.length) return text("Nenhuma rotina agendada.");
    return text(
      list
        .map((r) => `- ${r.id} · ${r.agent} a cada ${r.everyMinutes} min · ${r.enabled ? "ativa" : "pausada"} · próxima ${new Date(r.nextAt).toLocaleTimeString("pt-BR")}${r.lastError ? ` · último erro: ${r.lastError}` : ""}\n  ${r.message.slice(0, 160)}`)
        .join("\n"),
    );
  });

  server.registerTool(
    "cancelar_rotina",
    { description: "Cancela uma rotina pelo id (veja listar_rotinas).", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const ok = routines.remove(id);
      sendRoutines();
      return ok ? text(`Rotina ${id} cancelada.`) : fail(`Rotina ${id} não existe.`);
    },
  );

  return server;
}

// ---------------------------------------------------------------- HTTP + WebSocket

async function handleMcp(agentId: string, req: http.IncomingMessage, res: http.ServerResponse) {
  // Servidor MCP sem sessão: um por requisição, fechado junto com a resposta (nada acumula).
  const server = mcpFor(agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = http.createServer((req, res) => {
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
    // Erro numa ferramenta vira 500 para aquele agente, nunca rejeição solta derrubando o daemon.
    handleMcp(m[1], req, res).catch((e: Error) => {
      log(`erro no MCP de ${agentById(m[1])?.name ?? m[1]}: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
    return;
  }
  if (url.pathname === "/health") {
    // Público (sem token): só o que ajuda a diagnosticar, nada de nomes, pastas ou chaves.
    const running = [...terms.values()].filter((t) => t.status === "running").length;
    res
      .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ ok: true, version: VERSION, agents: running, queued: trustQueue.size, uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000), alwaysfit: alwaysfit.health() }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
httpServer.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const origin = req.headers.origin ?? "";
  if (!ALLOWED_ORIGINS.has(origin) || !safeEqual(url.searchParams.get("token") ?? "", TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

function handleClientMsg(msg: ClientMsg, send: (m: ServerMsg) => void) {
  switch (msg.type) {
    case "graph":
      mergeGraph(msg.graph);
      break;
    case "spawn":
      // O nó pode ter acabado de nascer: garante que o agente está no grafo com os dados atuais.
      graph = { ...graph, cwd: validCwd(msg.cwd) ?? graph.cwd, agents: [...graph.agents.filter((a) => a.id !== msg.id), { ...msg.agent, id: msg.id }] };
      pending.removedAgents.delete(msg.id);
      spawn(msg.id, msg.cols, msg.rows);
      break;
    case "attach": {
      const t = terms.get(msg.id);
      if (t) {
        send({ type: "output", id: msg.id, data: t.buffer, replay: true });
        send({ type: "status", id: msg.id, status: t.status });
      }
      break;
    }
    case "input": {
      const t = terms.get(msg.id);
      if (t?.status === "running") t.pty.write(msg.data);
      break;
    }
    case "resize": {
      const t = terms.get(msg.id);
      if (t?.status === "running") {
        const cols = Math.max(20, msg.cols);
        const rows = Math.max(5, msg.rows);
        t.pty.resize(cols, rows);
        t.screen.resize(cols, rows);
      }
      break;
    }
    case "kill":
      kill(msg.id);
      break;
    case "send":
      // Um destino parado não impede os outros de receber.
      for (const id of msg.to) {
        try {
          deliver(id, msg.text);
          broadcast({ type: "message", from: "user", to: id, text: msg.text });
        } catch (e) {
          send({ type: "error", message: `${agentById(id)?.name ?? id}: ${(e as Error).message}`, id });
        }
      }
      break;
    case "usage:refresh":
      void refreshUsage(true);
      break;
    case "routines:list":
      send({ type: "routines", routines: routines.list() });
      break;
    case "routines:save":
      routines.save(msg.routine, "Você");
      sendRoutines();
      break;
    case "routines:delete":
      routines.remove(msg.id);
      sendRoutines();
      break;
    case "routines:run":
      runRoutine(msg.id);
      break;
    case "scores:list":
      send({ type: "scores", scores: listScores() });
      break;
    case "scores:save":
      fs.writeFileSync(scoreFile(msg.name), JSON.stringify({ name: msg.name, savedAt: new Date().toISOString(), canvas: msg.canvas ?? null }, null, 2), { mode: 0o600 });
      send({ type: "scores", scores: listScores() });
      break;
    case "scores:delete":
      fs.rmSync(scoreFile(msg.name), { force: true });
      send({ type: "scores", scores: listScores() });
      break;
    case "af:refresh":
      void alwaysfit.refresh();
      send({ type: "af:status", status: alwaysfit.status });
      break;
    case "af:sync":
      void alwaysfit.sync();
      break;
    case "reports:list":
      send({ type: "reports", reports: reports.list() });
      break;
    case "reports:read": {
      const r = reports.read(msg.id);
      send({ type: "report", id: r.meta.id, content: r.content });
      break;
    }
    case "autostart:save":
      saveAutostart(msg.canvas);
      break;
    case "autostart:clear":
      fs.rmSync(AUTOSTART_FILE, { force: true });
      keepAwake(false);
      log("formação de inicialização apagada");
      broadcast({ type: "autostart", enabled: false });
      break;
  }
}

wss.on("connection", (ws: WebSocket) => {
  clients.add(ws);
  log(`canvas conectado (${clients.size} aberto${clients.size > 1 ? "s" : ""})`);
  const send = (m: ServerMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  send({
    type: "hello",
    version: VERSION,
    home: os.homedir(),
    cwd: graph.cwd,
    terminals: {
      ...Object.fromEntries([...terms].map(([id, t]) => [id, t.status])),
      ...Object.fromEntries([...trustQueue.keys()].map((id) => [id, "queued" as const])),
    },
    agents: available,
    graph,
    autostart: fs.existsSync(AUTOSTART_FILE),
    alwaysfit: alwaysfit.status,
  });
  if (usage) send({ type: "usage", usage });
  send({ type: "routines", routines: routines.list() });
  send({ type: "reports", reports: reports.list() });
  void refreshUsage();

  ws.on("message", (raw) => {
    const parsed = parseClientMsg(String(raw));
    if (!parsed.ok) {
      send({ type: "error", message: parsed.error, id: parsed.id });
      return;
    }
    const msg = parsed.msg;
    try {
      handleClientMsg(msg, send);
    } catch (e) {
      send({ type: "error", message: (e as Error).message, id: "id" in msg ? msg.id : undefined });
    }
  });
  // Frame inválido ou maior que maxPayload: o ws emite "error" e fecha. Sem este handler o daemon cairia.
  ws.on("error", (e) => log(`conexão do canvas com erro: ${e.message}`));
  ws.on("close", () => {
    clients.delete(ws);
    log(`canvas desconectado (${clients.size} aberto${clients.size === 1 ? "" : "s"})`);
  });
});
wss.on("error", (e) => log(`erro no WebSocket: ${e.message}`));

httpServer.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  A porta ${PORT} já está em uso — a Orquestra provavelmente já está rodando. Use ORQUESTRA_PORT para outra porta.\n`);
    process.exit(1);
  }
  throw e;
});

httpServer.listen(PORT, "127.0.0.1", () => {
  const app = process.env.ORQUESTRA_APP_URL || "http://localhost:3001";
  console.log(`\n  🎼 Orquestra ${VERSION} rodando em ws://127.0.0.1:${PORT}`);
  console.log(`  Agentes disponíveis: ${Object.entries(available).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
  console.log(`  Rotinas: ${routines.list().length} · limites do Claude a cada ${USAGE_INTERVAL / 60_000} min`);
  console.log(`\n  Abra: ${app}/orquestra#token=${TOKEN}\n`);
  alwaysfit.start();
  void bootAutostart();
});

// ---------------------------------------------------------------- 24h: formação de inicialização
//
// O canvas grava uma formação (mesmo formato da partitura). Ao subir, o daemon recria agentes,
// ligações e notas e inicia os terminais sozinho — sem navegador aberto. Quando o canvas
// conectar, ele recebe tudo no hello e reconcilia.

function saveAutostart(canvas: unknown) {
  const g = canvasToGraph(canvas);
  if (!g || !g.agents.length) throw new Error("formação inválida: precisa de pelo menos um agente");
  const tmp = `${AUTOSTART_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), canvas }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTOSTART_FILE);
  keepAwake(true);
  log(`formação de inicialização salva (${g.agents.length} agente${g.agents.length > 1 ? "s" : ""})`);
  broadcast({ type: "autostart", enabled: true });
}

async function bootAutostart() {
  let saved: { canvas?: unknown } | null = null;
  try {
    saved = JSON.parse(fs.readFileSync(AUTOSTART_FILE, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`autostart.json ilegível: ${(e as Error).message}`);
    return;
  }
  const g = canvasToGraph(saved?.canvas);
  if (!g || !g.agents.length) {
    log("autostart.json sem agentes válidos; ignorado");
    return;
  }
  // Canvas conectou antes (raro): o grafo dele vale; só sobe quem ainda não está rodando.
  if (!graph.agents.length) graph = { cwd: validCwd(g.cwd) ?? graph.cwd, agents: g.agents, notes: g.notes, edges: g.edges };
  keepAwake(true);
  log(`formação de inicialização: subindo ${g.agents.length} agente${g.agents.length > 1 ? "s" : ""}`);
  for (const a of g.agents) {
    if (shuttingDown) return;
    if (!agentById(a.id) || terms.get(a.id)?.status === "running") continue;
    try {
      spawn(a.id, 120, 36); // claude em pasta nova entra na fila de confiança normalmente
    } catch (e) {
      log(`formação de inicialização: ${a.name} não subiu: ${(e as Error).message}`);
    }
    await sleep(AUTOSTART_GAP_MS); // não abre todos de uma vez
  }
}

/**
 * Com formação de 24h, impede o Mac de dormir por inatividade enquanto o daemon roda
 * (`caffeinate -i -w <pid>` sai sozinho com o daemon). Tampa fechada ainda dorme.
 * ORQUESTRA_CAFFEINATE=0 desliga.
 */
let caffeinate: ChildProcess | null = null;
function keepAwake(on: boolean) {
  if (process.platform !== "darwin" || process.env.ORQUESTRA_CAFFEINATE === "0") return;
  if (on && !caffeinate) {
    caffeinate = spawnProcess("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    caffeinate.on("error", () => (caffeinate = null));
    caffeinate.on("exit", () => (caffeinate = null));
    log("Mac impedido de dormir por inatividade enquanto a Orquestra roda (formação 24h)");
  } else if (!on && caffeinate) {
    caffeinate.kill();
    caffeinate = null;
  }
}

// ---------------------------------------------------------------- 24h: reinício diário

const DAILY_FILE = path.join(HOME, "reinicio-diario.json");
const dailyAt = parseDailyTime(DAILY_RESTART);
if (dailyAt) {
  const daily = new DailyRestart(dailyAt, {
    now: () => new Date(),
    // Só IA (acumula contexto) e só quem já está de pé há um tempo (não reinicia quem acabou de subir).
    agents: () =>
      graph.agents.filter((a) => {
        const t = terms.get(a.id);
        return (a.kind === "claude" || a.kind === "codex") && t?.status === "running" && Date.now() - t.startedAt > 10 * 60_000;
      }),
    isIdle: (id) => Date.now() - (terms.get(id)?.lastOutputAt ?? 0) > 20_000,
    restart: (id) => restart(id),
    wait: sleep,
    lastRun: {
      get: () => {
        try {
          return (JSON.parse(fs.readFileSync(DAILY_FILE, "utf8")) as { lastRun?: string }).lastRun;
        } catch {
          return undefined;
        }
      },
      set: (day) => fs.writeFileSync(DAILY_FILE, JSON.stringify({ lastRun: day }), { mode: 0o600 }),
    },
    log,
  });
  setInterval(() => void daily.tick(), 60_000).unref();
}

// ---------------------------------------------------------------- encerramento
//
// Nenhum PTY pode sobrar: Ctrl+C, kill, terminal fechado ou erro inesperado matam todos.
// As rotinas ficam em disco e voltam quando o daemon subir de novo.

let shuttingDown = false;
function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const id of [...trustQueue.keys(), ...terms.keys()]) {
    try {
      kill(id);
    } catch {
      /* segue matando os outros */
    }
  }
  stopUsageFetches();
  stopChildren();
  alwaysfit.stop();
  log(`Orquestra encerrada${code ? ` (código ${code})` : ""}`);
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
// Erro de programação: o estado pode estar inconsistente, então encerra limpo em vez de seguir.
process.on("uncaughtException", (e) => {
  console.error(e);
  shutdown(1);
});
// Promessa rejeitada sem tratamento é pontual (uma ferramenta, uma consulta): registra e segue.
process.on("unhandledRejection", (e) => log(`promessa rejeitada sem tratamento: ${e instanceof Error ? e.message : String(e)}`));
