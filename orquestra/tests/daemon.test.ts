/**
 * Testes do daemon da Orquestra: sobe um daemon de verdade numa porta e ORQUESTRA_HOME
 * temporários, conversa com ele pelo WebSocket e pelo MCP e derruba tudo no fim.
 *
 * Os agentes são shells; claude, gh, git e mysql são scripts falsos (orquestra/tests/fakes):
 * nada usa rede, banco de verdade ou o limite do plano do Claude.
 *
 * Rode com: npm run test:orquestra
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { AfStatus, Routine, ServerMsg } from "../../src/lib/orquestra/protocol";
import { pasteSafe, run } from "../support";
import { canvasToGraph, parseClientMsg } from "../schema";
import { maskCep, maskCpf, maskEmail, maskPhone, maskText, maskTsv, validateSql } from "../alwaysfit";
import { DailyRestart, parseDailyTime } from "../daily";

const PORT = Number(process.env.ORQUESTRA_TEST_PORT || 4611);
const ORIGIN = "http://localhost:3001";
const ROOT = path.resolve(__dirname, "../..");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orquestra-test-")));
const HOME = path.join(tmp, "home");
const WORK = path.join(tmp, "projeto");
const UNTRUSTED = path.join(tmp, "nao-confiavel");
const UNTRUSTED2 = path.join(tmp, "nao-confiavel-2");
const STATE = path.join(tmp, "state"); // estado e log dos binários falsos
const PIDS = path.join(STATE, "pids");
const FAKES = path.join(ROOT, "orquestra/tests/fakes");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]/g, "").replace(/\r/g, "");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tempo esgotado esperando: ${what}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------- cliente do canvas

class Canvas {
  events: ServerMsg[] = [];
  out: Record<string, string> = {};
  closed = false;
  private constructor(public ws: WebSocket) {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      if (m.type === "output") this.out[m.id] = (this.out[m.id] ?? "") + m.data;
      this.events.push(m);
    });
    ws.on("close", () => (this.closed = true));
  }
  static open(token: string, origin = ORIGIN) {
    return new Promise<Canvas>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(token)}`, { origin });
      const c = new Canvas(ws);
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }
  send(m: unknown) {
    this.ws.send(typeof m === "string" ? m : JSON.stringify(m));
  }
  event<T extends ServerMsg["type"]>(type: T, pred: (m: Extract<ServerMsg, { type: T }>) => boolean = () => true, ms?: number) {
    return until(() => this.events.find((e): e is Extract<ServerMsg, { type: T }> => e.type === type && pred(e as Extract<ServerMsg, { type: T }>)), `evento ${type}`, ms);
  }
  text(id: string) {
    return stripAnsi(this.out[id] ?? "");
  }
  output(id: string, re: RegExp, ms?: number) {
    return until(() => this.text(id).match(re), `saída ${re} em ${id}`, ms);
  }
  close() {
    this.ws.close();
  }
}

// ---------------------------------------------------------------- MCP

class Mcp {
  private seq = 1;
  constructor(public url: string) {}
  async rpc(method: string, params: unknown) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.seq++, method, params }),
    });
    return (await res.json()) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
  }
  async tools() {
    return ((await this.rpc("tools/list", {})).result?.tools ?? []).map((t) => t.name);
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    const r = await this.rpc("tools/call", { name, arguments: args });
    return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r), err: Boolean(r.result?.isError) };
  }
}

// ---------------------------------------------------------------- daemon de teste

let daemon: ChildProcess;
let daemonOut = { log: "" };
let token = "";
let canvas: Canvas;

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, role: "", kind: "shell", ...extra });
const M = agent("agent-m", "Maestro", { role: "teste", maestro: true });
const VIGIA = agent("agent-vigia", "Vigia");
const graphMsg = (agents: unknown[], edges: [string, string][] = []) => ({ type: "graph", graph: { cwd: WORK, agents, notes: [], edges } });

/** Abre um shell e espera ele imprimir o PID e o endereço MCP. */
async function startShell(c: Canvas, a: { id: string }) {
  c.send({ type: "spawn", id: a.id, cols: 200, rows: 40, cwd: WORK, agent: a });
  await c.event("status", (m) => m.id === a.id && m.status === "running");
  c.send({ type: "input", id: a.id, data: "echo PID=$$ URL=$ORQUESTRA_MCP_URL\r" });
  const m = await c.output(a.id, /PID=(\d+) URL=(http\S+)/, 15_000);
  return { pid: Number(m[1]), mcp: new Mcp(m[2]) };
}

const shellPids: number[] = [];

function startDaemon(port: number) {
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "orquestra/daemon.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      ORQUESTRA_HOME: HOME,
      ORQUESTRA_PORT: String(port),
      ORQUESTRA_CLAUDE_BIN: path.join(FAKES, "claude"),
      ORQUESTRA_GH_BIN: path.join(FAKES, "gh"),
      ORQUESTRA_GIT_BIN: path.join(FAKES, "git"),
      ORQUESTRA_MYSQL_BIN: path.join(FAKES, "mysql"),
      ORQUESTRA_AF_ORG: "AlwaysFit",
      ORQUESTRA_CAFFEINATE: "0",
      ORQUESTRA_DAILY_RESTART: "",
      ORQUESTRA_AUTOSTART_GAP_MS: "100",
      FAKE_STATE: STATE,
      CLAUDE_CONFIG_DIR: path.join(tmp, "claude-config"),
      SHELL: "/bin/zsh",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { log: "" };
  proc.stdout!.on("data", (d) => (out.log += d));
  proc.stderr!.on("data", (d) => (out.log += d));
  return { proc, out };
}

/** Linhas do log dos falsos: [binário, pasta, argumentos]. */
const fakeCalls = () =>
  (fs.existsSync(path.join(STATE, "log")) ? fs.readFileSync(path.join(STATE, "log"), "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t") as [string, string, string]);

let daemon2: ChildProcess | undefined;

before(async () => {
  for (const d of [HOME, WORK, UNTRUSTED, UNTRUSTED2, PIDS, path.join(tmp, "claude-config")]) fs.mkdirSync(d, { recursive: true });
  // Ninguém confia em pasta nenhuma: força a fila de confiança.
  fs.writeFileSync(path.join(tmp, "claude-config", ".claude.json"), JSON.stringify({ projects: {} }));
  // Token vazio (editado à mão) tem de ser trocado por um novo.
  fs.writeFileSync(path.join(HOME, "orquestra-token"), "\n");
  // Rotinas: uma vencida há 3 dias (Mac dormiu), uma para agente inexistente e duas entradas inválidas.
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  fs.writeFileSync(
    path.join(HOME, "rotinas.json"),
    JSON.stringify([
      { id: "rot-vigia", agent: "Vigia", message: "echo ROT$((40+2))X", everyMinutes: 1, enabled: true, nextAt: old, createdBy: "teste" },
      { id: "rot-fantasma", agent: "Fantasma", message: "oi", everyMinutes: 5, enabled: true, nextAt: old, createdBy: "teste" },
      { id: 1 },
      "lixo",
    ]),
  );
  fs.mkdirSync(path.join(HOME, "partituras"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "partituras", "estragada.json"), "{ não é json");
  fs.writeFileSync(path.join(HOME, "partituras", "sem-campos.json"), "{}");

  const d = startDaemon(PORT);
  daemon = d.proc;
  daemonOut = d.out;
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null))?.ok, "daemon subir", 30_000);
  token = fs.readFileSync(path.join(HOME, "orquestra-token"), "utf8").trim();
  canvas = await Canvas.open(token);
});

after(async () => {
  canvas?.close();
  if (daemon2 && daemon2.exitCode === null) daemon2.kill("SIGKILL");
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGKILL");
    // Defesa: se algum teste falhou antes do encerramento, não deixa shell sobrando.
    for (const pid of shellPids) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const f of fs.existsSync(PIDS) ? fs.readdirSync(PIDS) : []) if (alive(Number(f))) process.kill(Number(f), "SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- unidades

describe("unidades", () => {
  test("pasteSafe tira o fim de colagem e outros controles", () => {
    assert.equal(pasteSafe("a\x1b[201~b\x07c\r\nd\re\tf"), "a[201~bc\nd\ne\tf");
    assert.equal(pasteSafe("ação ✓ 🎼"), "ação ✓ 🎼");
  });

  test("schema recusa mensagens malformadas", () => {
    assert.equal(parseClientMsg("{").ok, false);
    assert.equal(parseClientMsg(JSON.stringify({ type: "resize", id: "a", cols: null, rows: 10 })).ok, false);
    assert.equal(parseClientMsg(JSON.stringify({ type: "graph", graph: { cwd: "/", agents: "x", notes: [], edges: [] } })).ok, false);
    // Um nó ruim (ou nome vazio, no meio de renomear) não derruba o grafo inteiro.
    const partial = parseClientMsg(JSON.stringify({ type: "graph", graph: { agents: [{ id: "a", name: "", kind: "shell" }, { id: "b", kind: "robo" }, 7], edges: [["a", "b"], ["x"]] } }));
    assert.ok(partial.ok && partial.msg.type === "graph" && partial.msg.graph.agents.length === 1 && partial.msg.graph.edges.length === 1);
    assert.equal(parseClientMsg(JSON.stringify({ type: "nada" })).ok, false);
    const ok = parseClientMsg(JSON.stringify({ type: "graph", graph: { agents: [{ id: "a", name: "A", kind: "shell", extra: 1 }] } }));
    assert.ok(ok.ok && ok.msg.type === "graph" && ok.msg.graph.agents[0].role === "" && !("extra" in ok.msg.graph.agents[0]));
  });

  test("validateSql aceita só leitura", () => {
    const ok = [
      "SELECT * FROM pedidos WHERE status = 'travado' LIMIT 10",
      "select id from p where obs = 'a;b' and x = \"sleep(1)\";",
      "WITH t AS (SELECT 1) SELECT * FROM t",
      "SHOW TABLES",
      "DESCRIBE pedidos",
      "desc pedidos",
      "EXPLAIN SELECT 1",
      "SELECT updated_at, deleted_at FROM `update` -- comentário com ; DROP\n",
      "SELECT 'it''s' AS x",
    ];
    for (const q of ok) assert.ok(validateSql(q).ok, q);
    const refused: [string, RegExp][] = [
      ["DELETE FROM pedidos", /SELECT, WITH/],
      ["UPDATE pedidos SET x = 1", /SELECT, WITH/],
      ["SELECT 1; DROP TABLE x", /uma consulta/],
      ["SELECT 1 /* ; */ ; SELECT 2", /uma consulta/],
      ["SELECT * FROM t INTO OUTFILE '/tmp/x'", /INTO/],
      ["SELECT LOAD_FILE('/etc/passwd')", /LOAD_FILE/],
      ["SELECT SLEEP(10)", /SLEEP/],
      ["SELECT BENCHMARK(1000000, MD5('a'))", /BENCHMARK/],
      ["SELECT GET_LOCK('a', 10)", /GET_LOCK/],
      ["WITH x AS (SELECT 1) DELETE FROM t", /DELETE/],
      ["SELECT * FROM t FOR UPDATE", /UPDATE/],
      ["SELECT /*!50000 SLEEP(5) */ 1", /executáveis/],
      ["SELECT 'aberto", /sem fechar/],
      ["LOAD DATA INFILE 'x' INTO TABLE t", /SELECT, WITH/],
      ["SET SESSION TRANSACTION READ WRITE", /SELECT, WITH/],
      ["", /vazia/],
    ];
    for (const [q, re] of refused) {
      const r = validateSql(q);
      assert.ok(!r.ok && re.test(r.error), `${q} → ${r.ok ? "aceita" : r.error}`);
    }
  });

  test("máscara de CPF, e-mail e telefone", () => {
    assert.equal(maskCpf("123.456.789-00"), "***.456.789-**");
    assert.equal(maskCpf("12345678900"), "***.456.789-**");
    assert.equal(maskEmail("joao@dominio.com"), "jo***@dominio.com");
    assert.equal(maskPhone("(11) 98765-4321"), "(11) *****-4321");
    assert.equal(maskPhone("+55 11 98765-4321"), "(11) *****-4321");
    const t = maskText("cpf 123.456.789-00, joao.silva@ex.com.br, (11) 98765-4321, 11 3265-4321, pedido 12345, data 2026-10-10");
    assert.equal(t, "cpf ***.456.789-**, jo***@ex.com.br, (11) *****-4321, (11) *****-4321, pedido 12345, data 2026-10-10");
    assert.equal(maskCep("01310-100"), "*****-100");
    assert.equal(maskCep("01310100"), "*****-100");
    assert.equal(maskText("entregar no CEP 04567-890, tel 98765-4321, data 2026-10-10"), "entregar no CEP *****-890, tel 98765-4321, data 2026-10-10");
    // Endereço: colunas inteiras somem; nome continua; "recepcao" e "email_address" não são endereço.
    assert.equal(
      maskTsv("nome\tendereco\tEndereço Entrega\tlogradouro\trua\tnumero_endereco\tcomplemento\tbairro\tcep\tzip_code\taddress_line\tstreet\trecepcao\temail_address\nJoão\tRua A\tRua B\tAv C\tRua D\t10\tap 2\tCentro\t01310-100\t04567890\t1 Main St\tMain\tsim\tjo@x.com"),
      "nome\tendereco\tEndereço Entrega\tlogradouro\trua\tnumero_endereco\tcomplemento\tbairro\tcep\tzip_code\taddress_line\tstreet\trecepcao\temail_address\nJoão\t***\t***\t***\t***\t***\t***\t***\t*****-100\t*****-890\t***\t***\tsim\tjo***@x.com",
    );
    const tsv = maskTsv("id\tcpf\temail\tcelular\tobs\n1\t12345678900\tana@x.com\t11987654321\tfale com bia@y.com\n2\tNULL\tNULL\tNULL\tNULL");
    assert.equal(tsv, "id\tcpf\temail\tcelular\tobs\n1\t***.456.789-**\tan***@x.com\t(11) *****-4321\tfale com bi***@y.com\n2\tNULL\tNULL\tNULL\tNULL");
  });

  test("canvasToGraph lê a partitura do canvas", () => {
    const g = canvasToGraph({
      cwd: "/tmp",
      nodes: [
        { id: "a", type: "terminal", position: { x: 0, y: 0 }, data: { name: "Vigia", role: "vigia", kind: "shell", systems: ["db", "x"], pulse: 1 } },
        { id: "n", type: "note", data: { title: "T", content: "C", color: "#fff" } },
        { id: "b", type: "terminal", data: { name: "Ruim", kind: "robo" } },
        "lixo",
      ],
      edges: [{ id: "e", source: "a", target: "n" }, { source: 1 }],
    });
    assert.ok(g);
    assert.deepEqual(g.agents, [{ id: "a", name: "Vigia", role: "vigia", kind: "shell", systems: ["db"] }]);
    assert.deepEqual(g.notes, [{ id: "n", title: "T", content: "C" }]);
    assert.deepEqual(g.edges, [["a", "n"]]);
    assert.equal(canvasToGraph({ nodes: "x" }), null);
  });

  test("run mata o grupo de processos no timeout", async () => {
    const pidFile = path.join(tmp, "neto.pid");
    fs.mkdirSync(tmp, { recursive: true });
    const r = await run("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], { timeoutMs: 500 });
    assert.ok(r.timedOut);
    const neto = Number(fs.readFileSync(pidFile, "utf8"));
    await until(() => !alive(neto), "processo neto morrer", 4000);
    const big = await run("/bin/sh", ["-c", "yes"], { timeoutMs: 5000, maxBytes: 10_000 });
    assert.ok(big.truncated && !big.timedOut);
  });

  test("reinício diário: janela, um por vez, uma vez por dia", async () => {
    assert.equal(parseDailyTime(""), null);
    assert.equal(parseDailyTime("25:00"), null);
    assert.deepEqual(parseDailyTime("04:00"), { h: 4, m: 0 });
    let now = new Date(2026, 9, 10, 3, 59);
    let last: string | undefined;
    const restarted: string[] = [];
    const busy = new Set(["b"]);
    const daily = new DailyRestart(
      { h: 4, m: 0 },
      {
        now: () => now,
        agents: () => [{ id: "a", name: "A" }, { id: "b", name: "B" }],
        isIdle: (id) => !busy.has(id),
        restart: (id) => restarted.push(id),
        wait: async (ms) => {
          now = new Date(now.getTime() + ms);
          if (now.getTime() > new Date(2026, 9, 10, 4, 1).getTime()) busy.clear(); // B termina a tarefa
        },
        lastRun: { get: () => last, set: (d) => (last = d) },
        log: () => {},
      },
      { gapMs: 30_000 },
    );
    assert.deepEqual(await daily.tick(), []); // antes do horário
    now = new Date(2026, 9, 10, 4, 0);
    assert.deepEqual(await daily.tick(), ["A", "B"]);
    assert.deepEqual(restarted, ["a", "b"]);
    assert.ok(now.getTime() > new Date(2026, 9, 10, 4, 1).getTime(), "esperou B ficar ocioso");
    assert.deepEqual(await daily.tick(), []); // mesmo dia: não repete
    now = new Date(2026, 9, 11, 15, 0); // Mac dormiu a madrugada toda: fora da janela, não dispara
    assert.deepEqual(await daily.tick(), []);
    now = new Date(2026, 9, 12, 4, 30);
    assert.deepEqual(await daily.tick(), ["A", "B"]);
  });
});

// ---------------------------------------------------------------- daemon

describe("daemon", () => {
  test("token vazio é trocado e arquivos sensíveis são 0600", () => {
    assert.ok(token.length >= 24);
    assert.equal(fs.statSync(path.join(HOME, "orquestra-token")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(HOME, "run")).mode & 0o777, 0o700);
  });

  test("/health não vaza dados", async () => {
    const h = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as Record<string, unknown>;
    assert.equal(h.ok, true);
    assert.equal(typeof h.version, "string");
    assert.equal(typeof h.agents, "number");
    assert.ok(!JSON.stringify(h).includes(token) && !JSON.stringify(h).includes(os.homedir()));
  });

  test("recusa token errado e origem desconhecida", async () => {
    await assert.rejects(Canvas.open("errado"));
    await assert.rejects(Canvas.open(token, "http://evil.example"));
  });

  test("hello traz rotinas válidas e ignora as inválidas", async () => {
    const hello = await canvas.event("hello");
    assert.equal(hello.agents.claude, true);
    const r = await canvas.event("routines");
    assert.deepEqual(r.routines.map((x) => x.id).sort(), ["rot-fantasma", "rot-vigia"]);
  });

  test("mensagens malformadas viram erro e não derrubam o daemon", async () => {
    canvas.send("{ não é json");
    canvas.send({ type: "graph", graph: { cwd: WORK, agents: "x", notes: [], edges: [] } });
    canvas.send({ type: "resize", id: "x", cols: "abc", rows: 10 });
    canvas.send({ type: "spawn", id: "x", cols: 80, rows: 24, cwd: WORK, agent: { id: "x", name: "X", kind: "robo" } });
    await until(() => canvas.events.filter((e) => e.type === "error" && e.message.includes("inválida")).length >= 4, "4 erros");
    assert.ok(!canvas.closed);
  });

  test("mensagem acima do limite fecha só aquela conexão", async () => {
    const big = await Canvas.open(token);
    big.ws.on("error", () => {});
    big.send({ type: "input", id: "x", data: "a".repeat(9 * 1024 * 1024) });
    await until(() => big.closed, "conexão grande fechar");
    const again = await Canvas.open(token);
    await again.event("hello");
    again.close();
  });

  let maestro: { pid: number; mcp: Mcp };
  let helperId = "";

  test("Maestro sobe com MCP e ferramentas de comando", async () => {
    canvas.send(graphMsg([M, VIGIA]));
    maestro = await startShell(canvas, M);
    shellPids.push(maestro.pid);
    shellPids.push((await startShell(canvas, VIGIA)).pid);
    await maestro.mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } });
    const tools = await maestro.mcp.tools();
    for (const t of ["criar_agente", "ligar_agentes", "desligar_agentes", "definir_papel", "reiniciar_agente", "parar_agente", "remover_agente", "agendar_rotina", "listar_rotinas", "cancelar_rotina", "notificar", "limite_claude"]) assert.ok(tools.includes(t), t);
  });

  test("MCP: chave errada 401, GET 405", async () => {
    const bad = maestro.mcp.url.replace(/key=[^&]+/, "key=errada");
    assert.equal((await fetch(bad, { method: "POST" })).status, 401);
    assert.equal((await fetch(maestro.mcp.url)).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/mcp/ninguem?key=x`, { method: "POST" })).status, 401);
  });

  test("criar_agente, grafo antigo não apaga e mensagem chega", async () => {
    let r = await maestro.mcp.call("criar_agente", { nome: "Ajudante", tipo: "terminal", papel: "ajuda" });
    assert.ok(!r.err && r.text.includes("criado"), r.text);
    const add = await canvas.event("agent:add", (e) => e.agent.name === "Ajudante");
    assert.ok(add.edges.some(([a, b]) => a === M.id && b === add.agent.id));
    helperId = add.agent.id;
    await canvas.event("status", (e) => e.id === helperId && e.status === "running");
    canvas.send(graphMsg([M, VIGIA])); // navegador atrasado, sem o Ajudante
    await sleep(200);
    r = await maestro.mcp.call("listar_agentes");
    assert.ok(r.text.includes("Ajudante") && r.text.includes("ligado a: Maestro"), r.text);
    r = await maestro.mcp.call("criar_agente", { nome: "   " });
    assert.ok(r.err);
    canvas.send({ type: "input", id: helperId, data: "echo PRONTO$((2*2))\r" });
    await canvas.output(helperId, /PRONTO4/, 15_000);
    r = await maestro.mcp.call("enviar_mensagem", { para: "Ajudante", mensagem: "echo MSG$((1+1))OK" });
    assert.ok(!r.err, r.text);
    await canvas.output(helperId, /MSG2OK/, 10_000);
  });

  test("mensagens simultâneas para o mesmo agente não se misturam", async () => {
    const [a, b] = await Promise.all([
      maestro.mcp.call("enviar_mensagem", { para: "Ajudante", mensagem: "echo CONC$((0+1))A" }),
      maestro.mcp.call("enviar_mensagem", { para: "Ajudante", mensagem: "echo CONC$((0+2))B" }),
    ]);
    assert.ok(!a.err && !b.err);
    await canvas.output(helperId, /^CONC2B$/m, 10_000);
    assert.match(canvas.text(helperId), /^CONC1A$/m);
  });

  test("ler_terminal mostra a tela renderizada, sem redesenhos duplicados", async () => {
    // \r + ESC[K reescreve a linha; o texto bruto sem ANSI mostraria VELHO e NOVO9 em linhas separadas.
    canvas.send({ type: "input", id: helperId, data: "printf 'V%sLHO\\r\\033[KNOVO%s\\n' E 9; echo LIMPO$((6*7))\r" });
    await canvas.output(helperId, /LIMPO42/, 10_000);
    const r = await maestro.mcp.call("ler_terminal", { agente: "Ajudante", linhas: 40 });
    assert.ok(!r.err);
    const lines = r.text.split("\n");
    assert.ok(lines.includes("NOVO9"), r.text);
    assert.ok(!r.text.includes("VELHO"), r.text);
    assert.equal(lines.filter((l) => l === "LIMPO42").length, 1, r.text);
    // A linha do comando aparece uma vez só, mesmo com o zsh redesenhando enquanto digita.
    assert.equal(lines.filter((l) => l.includes("echo LIMPO$((6*7))")).length, 1, r.text);
    assert.ok(!/\n\n\n/.test(r.text) && r.text === r.text.trimEnd());
    // O buffer bruto (replay do canvas) continua com tudo, inclusive o que foi apagado na tela.
    assert.ok((canvas.out[helperId] ?? "").includes("VELHO"));
  });

  test("send do canvas: destino parado vira erro e os outros recebem", async () => {
    canvas.send({ type: "send", to: ["agent-nao-existe", helperId], text: "echo SEND$((2+1))OK" });
    const err = await canvas.event("error", (e) => e.id === "agent-nao-existe");
    assert.match(err.message, /não está rodando/);
    await canvas.output(helperId, /SEND3OK/, 10_000);
  });

  test("attach reenvia o buffer com replay", async () => {
    canvas.send({ type: "attach", id: helperId });
    const o = await canvas.event("output", (e) => e.id === helperId && e.replay === true);
    assert.ok(stripAnsi(o.data).includes("SEND3OK"));
  });

  test("ligar/desligar resiste a grafo antigo; definir_papel", async () => {
    canvas.send(graphMsg([M, VIGIA, { id: helperId, name: "Ajudante", role: "ajuda", kind: "shell" }], [[M.id, helperId]]));
    let r = await maestro.mcp.call("criar_agente", { nome: "Segundo", tipo: "terminal", ligar_a: ["Ajudante"] });
    assert.ok(!r.err && r.text.includes("Ajudante"), r.text);
    const B = (await canvas.event("agent:add", (e) => e.agent.name === "Segundo")).agent;
    const all = [M, VIGIA, { id: helperId, name: "Ajudante", role: "ajuda", kind: "shell" }, B];
    const edges: [string, string][] = [[M.id, helperId], [M.id, B.id], [helperId, B.id]];
    canvas.send(graphMsg(all, edges));
    r = await maestro.mcp.call("desligar_agentes", { a: "Ajudante", b: "Segundo" });
    assert.ok(!r.err);
    canvas.send(graphMsg(all, edges)); // canvas ainda não aplicou
    await sleep(200);
    r = await maestro.mcp.call("listar_agentes");
    assert.ok(!/Ajudante[^\n]*ligado a: [^\n]*Segundo/.test(r.text), r.text);
    r = await maestro.mcp.call("ligar_agentes", { a: "Ajudante", b: "Segundo" });
    assert.ok(!r.err && r.text.includes("ligados"));
    r = await maestro.mcp.call("definir_papel", { agente: "Segundo", papel: "novo papel" });
    await canvas.event("agent:update", (e) => e.patch.role === "novo papel");

    // reiniciar, parar, remover; removido não volta com grafo antigo
    r = await maestro.mcp.call("reiniciar_agente", { agente: "Segundo" });
    assert.ok(!r.err);
    await until(() => canvas.events.filter((e) => e.type === "status" && e.id === B.id && e.status === "running").length >= 2, "Segundo reiniciar");
    r = await maestro.mcp.call("parar_agente", { agente: "Segundo" });
    await canvas.event("status", (e) => e.id === B.id && e.status === "stopped");
    r = await maestro.mcp.call("enviar_mensagem", { para: "Segundo", mensagem: "oi" });
    assert.ok(r.err && r.text.includes("reiniciar_agente"), r.text);
    r = await maestro.mcp.call("remover_agente", { agente: "Segundo" });
    await canvas.event("agent:remove", (e) => e.id === B.id);
    canvas.send(graphMsg(all, edges));
    await sleep(200);
    assert.ok(!(await maestro.mcp.call("listar_agentes")).text.includes("Segundo"));
    assert.ok((await maestro.mcp.call("remover_agente", { agente: "Maestro" })).err);
  });

  test("mensagem pendente para agente parado logo em seguida não derruba o daemon", async () => {
    canvas.send(graphMsg([M, VIGIA, agent(helperId, "Ajudante"), agent("agent-tmp", "Temp")], [[M.id, helperId]]));
    const t = await startShell(canvas, agent("agent-tmp", "Temp"));
    shellPids.push(t.pid);
    for (let i = 0; i < 3; i++) canvas.send({ type: "send", to: ["agent-tmp"], text: `echo ${i}` });
    canvas.send({ type: "kill", id: "agent-tmp" });
    await canvas.event("status", (e) => e.id === "agent-tmp" && e.status === "stopped");
    await sleep(800); // tempo de os Enter atrasados tentarem escrever
    assert.equal(daemon.exitCode, null);
    assert.ok((await fetch(`http://127.0.0.1:${PORT}/health`)).ok);
    canvas.send({ type: "input", id: "agent-tmp", data: "x" }); // terminal parado: ignora
  });

  test("rotinas: agendar, rodar agora, persistir, cancelar", async () => {
    let r = await maestro.mcp.call("agendar_rotina", { agente: "Ajudante", mensagem: "echo ROTA$((5+5))OK", a_cada_minutos: 15, rodar_agora: true });
    assert.ok(!r.err, r.text);
    await canvas.output(helperId, /ROTA10OK/, 10_000);
    const id = r.text.match(/rot-[0-9a-f]+/)![0];
    const saved = JSON.parse(fs.readFileSync(path.join(HOME, "rotinas.json"), "utf8")) as Routine[];
    assert.ok(saved.some((x) => x.id === id));
    assert.equal(fs.statSync(path.join(HOME, "rotinas.json")).mode & 0o777, 0o600);
    r = await maestro.mcp.call("listar_rotinas");
    assert.ok(r.text.includes("Ajudante a cada 15 min"));
    assert.ok(!(await maestro.mcp.call("cancelar_rotina", { id })).err);
    assert.ok((await maestro.mcp.call("cancelar_rotina", { id })).err);
    canvas.send({ type: "routines:save", routine: { agent: "Ajudante", message: "x", everyMinutes: 0 } });
    await canvas.event("error", (e) => e.message.includes("routine.everyMinutes"));
  });

  test("notificar e limite_claude (CLI falsa, processo morto depois)", async () => {
    await maestro.mcp.call("notificar", { titulo: "Teste", mensagem: "olá" });
    await canvas.event("notify", (e) => e.title === "Teste");
    const u = await canvas.event("usage", (e) => e.usage.ok, 15_000);
    assert.equal(u.usage.windows.find((w) => w.id === "five_hour")?.usedPercent, 41);
    assert.match((await maestro.mcp.call("limite_claude")).text, /Sessão \(5h\): 41% usado/);
    // O falso fica em "sleep 120": o daemon tem de ter matado o grupo de processos.
    const usagePids = fs.readdirSync(PIDS).map(Number);
    assert.ok(usagePids.length > 0);
    await until(() => usagePids.every((p) => !alive(p)), "processo da consulta de uso morrer", 5000);
  });

  test("partituras: nome saneado, acentos mantidos, 0600, lista tolera lixo", async () => {
    canvas.send({ type: "scores:save", name: "../../fuga", canvas: { nodes: [] } });
    canvas.send({ type: "scores:save", name: "Ação 1", canvas: { nodes: [] } });
    await until(() => canvas.events.some((e) => e.type === "scores" && e.scores.some((s) => s.name === "Ação 1")), "partitura salva");
    const files = fs.readdirSync(path.join(HOME, "partituras")).sort();
    assert.ok(files.includes("fuga.json") && files.includes("Ação 1.json"), files.join(","));
    assert.ok(!fs.existsSync(path.join(tmp, "fuga.json")));
    assert.equal(fs.statSync(path.join(HOME, "partituras", "fuga.json")).mode & 0o777, 0o600);
    canvas.send({ type: "scores:delete", name: "../../fuga" });
    await until(() => !fs.existsSync(path.join(HOME, "partituras", "fuga.json")), "partitura apagada");
  });

  test("agente comum não tem ferramentas do Maestro nem fala com quem não está ligado", async () => {
    const C = agent("agent-c", "Comum");
    canvas.send(graphMsg([M, VIGIA, { id: helperId, name: "Ajudante", role: "", kind: "shell" }, C], [[M.id, helperId]]));
    const c = await startShell(canvas, C);
    shellPids.push(c.pid);
    const tools = await c.mcp.tools();
    assert.ok(!tools.includes("criar_agente") && tools.includes("enviar_mensagem"));
    // Sem sistemas Always Fit: só os relatórios.
    assert.ok(!tools.includes("alwaysfit_sql") && !tools.includes("alwaysfit_repos") && tools.includes("salvar_relatorio"));
    assert.ok((await c.mcp.call("enviar_mensagem", { para: "Ajudante", mensagem: "x" })).err);
  });

  // ------------------------------------------------ Always Fit

  /** Status Always Fit que satisfaz `pred`, olhando só eventos a partir de `from`. */
  // O hello também conta: a primeira sincronização pode terminar antes do canvas conectar.
  const afStatus = (pred: (s: AfStatus) => boolean, from = 0, ms = 10_000) =>
    until(
      () =>
        canvas.events
          .slice(from)
          .map((e) => (e.type === "af:status" ? e.status : e.type === "hello" ? e.alwaysfit : undefined))
          .find((st): st is AfStatus => Boolean(st) && pred(st!)),
      "af:status",
      ms,
    );
  /** Manda af:refresh e espera o status que satisfaz `pred`. */
  const refreshed = (pred: (s: AfStatus) => boolean) => {
    const from = canvas.events.length;
    canvas.send({ type: "af:refresh" });
    return afStatus(pred, from);
  };

  test("Always Fit: espelhos sincronizados, arquivado e nome inválido pulados, nada fora do HOME", async () => {
    const st = await afStatus((s) => !s.repos.syncing && Boolean(s.repos.lastSyncAt));
    assert.equal(st.repos.org, "AlwaysFit");
    assert.equal(st.repos.total, 3); // always-ticket, central_de_sustentacao, repo-vazio (sem arquivado nem "..")
    assert.equal(st.repos.synced, 2);
    assert.match(st.repos.error ?? "", /repo-vazio/);
    const mirrors = path.join(HOME, "alwaysfit", "repos");
    assert.deepEqual(fs.readdirSync(mirrors).sort(), ["always-ticket", "central_de_sustentacao"]);
    assert.equal(fs.readFileSync(path.join(mirrors, "always-ticket", ".git", "remote"), "utf8").trim(), "https://github.com/AlwaysFit/always-ticket.git");
    assert.equal(fs.readFileSync(path.join(mirrors, "central_de_sustentacao", ".git", "HEAD-fake"), "utf8").trim(), "origin/master");
    const git = fakeCalls().filter(([bin]) => bin === "git");
    assert.ok(git.length > 0);
    for (const [, cwd, args] of git) {
      assert.ok(cwd.startsWith(mirrors), `git rodou fora dos espelhos: ${cwd}`);
      assert.ok(!/x-access-token|ghp_|gho_|github\.com@|:\/\/[^/]*@/.test(args), `credencial nos argumentos: ${args}`);
    }
    // Credencial vem do gh na hora, não de arquivo.
    assert.ok(git.some(([, , a]) => a.includes("credential.helper=!") && a.includes("auth git-credential")));
    // Atualização: não clona de novo, faz fetch e limpa o espelho.
    fs.writeFileSync(path.join(mirrors, "always-ticket", "sujeira.txt"), "x");
    const before = fakeCalls().length;
    canvas.send({ type: "af:sync" });
    await until(() => !fs.existsSync(path.join(mirrors, "always-ticket", "sujeira.txt")), "espelho limpo");
    await until(() => fakeCalls().slice(before).some(([b, , a]) => b === "git" && a.includes("log -1")), "sync terminar");
    const again = fakeCalls().slice(before).filter(([b]) => b === "git").map(([, , a]) => a);
    assert.ok(!again.some((a) => a.includes(" clone ")) && again.some((a) => a.includes(" fetch ")));
  });

  test("Always Fit: banco configurado, sem perfil e fora do ar", async () => {
    let st = await afStatus((s) => s.db.ok);
    assert.equal(st.db.configured, true);
    assert.equal(st.db.host, "replica.exemplo.rds.amazonaws.com");
    fs.writeFileSync(path.join(STATE, "mysql-sem-perfil"), "");
    st = await refreshed((s) => !s.db.configured);
    assert.match(st.db.error ?? "", /mysql_config_editor set --login-path=alwaysfit-readonly/);
    fs.rmSync(path.join(STATE, "mysql-sem-perfil"));
    fs.writeFileSync(path.join(STATE, "mysql-fora"), "");
    st = await refreshed((s) => s.db.configured && !s.db.ok);
    assert.match(st.db.error ?? "", /ERROR 2003/);
    assert.ok(!/Warning/.test(st.db.error ?? ""));
    fs.rmSync(path.join(STATE, "mysql-fora"));
    await refreshed((s) => s.db.ok);
    // O daemon nunca lê o arquivo de senhas do mysql.
    assert.ok(!fakeCalls().some(([, , a]) => a.includes("mylogin")));
    const h = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { alwaysfit: { db: Record<string, unknown>; repos: Record<string, unknown> } };
    assert.deepEqual(Object.keys(h.alwaysfit.db).sort(), ["configured", "ok"]);
    assert.equal(h.alwaysfit.repos.synced, 2);
  });

  let analista: { pid: number; mcp: Mcp };

  test("ferramentas Always Fit liberadas por sistema", async () => {
    const A = agent("agent-analista", "Analista", { systems: ["db"] });
    canvas.send(graphMsg([M, VIGIA, { id: helperId, name: "Ajudante", role: "", kind: "shell" }, agent("agent-c", "Comum"), A], [[M.id, helperId]]));
    analista = await startShell(canvas, A);
    shellPids.push(analista.pid);
    const t = await analista.mcp.tools();
    assert.ok(t.includes("alwaysfit_sql") && !t.includes("alwaysfit_repos") && t.includes("salvar_relatorio"), t.join(","));
    const m = await maestro.mcp.tools();
    assert.ok(m.includes("alwaysfit_sql") && m.includes("alwaysfit_repos"));
    const r = await maestro.mcp.call("alwaysfit_repos", {});
    assert.match(r.text, /always-ticket/);
    assert.ok(r.text.includes(path.join(HOME, "alwaysfit", "repos", "always-ticket")));
    const d = await maestro.mcp.call("alwaysfit_repos", { nome: "always-ticket" });
    assert.match(d.text, /corrige pedido travado/);
    assert.ok((await maestro.mcp.call("alwaysfit_repos", { nome: "../../etc" })).err);
  });

  test("alwaysfit_sql: leitura validada, mascarada e cortada", async () => {
    let r = await analista.mcp.call("alwaysfit_sql", { consulta: "SELECT * FROM clientes LIMIT 5" });
    assert.ok(!r.err, r.text);
    for (const leak of ["123.456.789-00", "joao@", "98765-4321", "91234-5678", "98765432100", "maria@", "Flores", "Centro", "01310-100", "04567-890"]) assert.ok(!r.text.includes(leak), `vazou ${leak}: ${r.text}`);
    assert.ok(r.text.includes("João") && r.text.includes("*****-100") && r.text.includes("CEP *****-890"), r.text);
    assert.ok(r.text.includes("***.456.789-**") && r.text.includes("jo***@exemplo.com") && r.text.includes("(11) *****-4321") && r.text.includes("ma***@ex.com.br"), r.text);
    assert.match(r.text, /2 linhas; dados pessoais mascarados/);
    const before = fakeCalls().filter(([b]) => b === "mysql").length;
    r = await analista.mcp.call("alwaysfit_sql", { consulta: "DELETE FROM clientes" });
    assert.ok(r.err && /recusada/.test(r.text));
    assert.equal(fakeCalls().filter(([b]) => b === "mysql").length, before, "consulta recusada chegou ao mysql");
    r = await analista.mcp.call("alwaysfit_sql", { consulta: "SELECT n FROM grande", limite: 50 });
    assert.match(r.text, /cortado: mostrando 50 linhas/);
    assert.equal(r.text.split("\n").filter((l) => /^\d+$/.test(l)).length, 50);
    r = await analista.mcp.call("alwaysfit_sql", { consulta: "SELECT erro FROM x" });
    assert.ok(r.err && /1064/.test(r.text));
    const last = fakeCalls().filter(([b]) => b === "mysql").pop()!;
    assert.match(last[2], /^--login-path=alwaysfit-readonly /);
    assert.match(last[2], /SET SESSION TRANSACTION READ ONLY; SET SESSION MAX_EXECUTION_TIME=15000; SELECT erro FROM x;/);
  });

  test("relatórios: arquivo 0600, report:new, crítico notifica, leitura segura", async () => {
    let r = await analista.mcp.call("salvar_relatorio", { titulo: "Pedidos travados às 14h", conteudo: "# Resumo\n3 pedidos parados", gravidade: "critico" });
    assert.ok(!r.err, r.text);
    const ev = await canvas.event("report:new", (e) => e.report.agent === "Analista");
    assert.equal(ev.report.severity, "critico");
    assert.match(ev.report.id, /^\d{4}-\d{2}-\d{2}\/\d{4}-analista-pedidos-travados-às-14h$/);
    const n = await canvas.event("notify", (e) => e.urgent && e.title.includes("Pedidos travados"));
    assert.equal(n.from, "Analista");
    const file = path.join(HOME, "relatorios", `${ev.report.id}.md`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(file, "utf8"), /3 pedidos parados/);
    // Mesmo título no mesmo minuto: não sobrescreve.
    r = await analista.mcp.call("salvar_relatorio", { titulo: "Pedidos travados às 14h", conteudo: "segundo", gravidade: "info" });
    const second = await canvas.event("report:new", (e) => e.report.id !== ev.report.id && e.report.agent === "Analista");
    assert.ok(second.report.id.endsWith("-2") || second.report.id.slice(11, 15) !== ev.report.id.slice(11, 15));
    r = await maestro.mcp.call("listar_relatorios", { agente: "analista" });
    assert.ok(r.text.includes(ev.report.id) && r.text.includes(second.report.id));
    assert.match((await maestro.mcp.call("ler_relatorio", { id: ev.report.id })).text, /3 pedidos parados/);
    assert.ok((await maestro.mcp.call("ler_relatorio", { id: "../../orquestra-token" })).err);
    canvas.send({ type: "reports:read", id: ev.report.id });
    assert.match((await canvas.event("report", (e) => e.id === ev.report.id)).content, /gravidade: critico/);
    canvas.send({ type: "reports:list" });
    await canvas.event("reports", (e) => e.reports.length >= 2 && e.reports[0].agent === "Analista");
  });

  test("autostart: salva a formação (0600) e recusa formação vazia", async () => {
    canvas.send({ type: "autostart:save", canvas: { nodes: [], edges: [] } });
    await canvas.event("error", (e) => /formação inválida/.test(e.message));
    canvas.send({
      type: "autostart:save",
      canvas: {
        cwd: WORK,
        nodes: [
          { id: "auto-a", type: "terminal", position: { x: 0, y: 0 }, data: { name: "Plantao", role: "plantão 24h", kind: "shell", systems: ["db", "repos"] } },
          { id: "auto-b", type: "terminal", position: { x: 0, y: 0 }, data: { name: "Relator", role: "", kind: "shell" } },
          { id: "auto-n", type: "note", position: { x: 0, y: 0 }, data: { title: "Ciclo", content: "a cada 1h" } },
        ],
        edges: [{ id: "e1", source: "auto-a", target: "auto-b" }],
      },
    });
    await canvas.event("autostart", (e) => e.enabled);
    assert.equal(fs.statSync(path.join(HOME, "autostart.json")).mode & 0o777, 0o600);
  });

  test("fila de confiança: um pergunta, os outros esperam", async () => {
    const q = (n: number) => ({ id: `agent-q${n}`, name: `Q${n}`, role: "", kind: "claude" });
    canvas.send({ type: "spawn", id: "agent-q1", cols: 120, rows: 30, cwd: UNTRUSTED, agent: q(1) });
    await canvas.output("agent-q1", /trust this folder/);
    canvas.send({ type: "spawn", id: "agent-q2", cols: 120, rows: 30, cwd: UNTRUSTED, agent: q(2) });
    await canvas.event("status", (e) => e.id === "agent-q2" && e.status === "queued");
    canvas.send({ type: "send", to: ["agent-q2"], text: "oi" });
    assert.match((await canvas.event("error", (e) => e.id === "agent-q2")).message, /fila/);
    // Respondeu no primeiro: o segundo é liberado.
    canvas.send({ type: "input", id: "agent-q1", data: "\r" });
    await canvas.event("status", (e) => e.id === "agent-q2" && e.status === "running");

    // Outra pasta: se quem perguntou fecha, o próximo da fila assume.
    canvas.send({ type: "spawn", id: "agent-q3", cols: 120, rows: 30, cwd: UNTRUSTED2, agent: q(3) });
    await canvas.output("agent-q3", /trust this folder/);
    canvas.send({ type: "spawn", id: "agent-q4", cols: 120, rows: 30, cwd: UNTRUSTED2, agent: q(4) });
    await canvas.event("status", (e) => e.id === "agent-q4" && e.status === "queued");
    canvas.send({ type: "kill", id: "agent-q3" });
    await canvas.event("status", (e) => e.id === "agent-q4" && e.status === "running");
    for (const id of ["agent-q1", "agent-q2", "agent-q4"]) canvas.send({ type: "kill", id });
  });

  test("rotinas vencidas depois de dormir disparam uma vez só e reagendam", async () => {
    const r = await canvas.event("routines", (e) => e.routines.some((x) => x.id === "rot-vigia" && Boolean(x.lastAt)), 25_000);
    const vigia = r.routines.find((x) => x.id === "rot-vigia")!;
    assert.equal(vigia.lastError, undefined);
    assert.ok(Date.parse(vigia.nextAt) > Date.now() + 30_000);
    const fantasma = (await canvas.event("routines", (e) => e.routines.some((x) => x.id === "rot-fantasma" && Boolean(x.lastError)))).routines.find((x) => x.id === "rot-fantasma")!;
    assert.match(fantasma.lastError!, /não está no canvas/);
    await canvas.output(VIGIA.id, /ROT42X/, 5000);
    await sleep(1000);
    assert.equal(canvas.text(VIGIA.id).match(/^ROT42X$/gm)?.length, 1);
  });

  test("SIGTERM encerra o daemon e mata todos os terminais", async () => {
    assert.ok(shellPids.some(alive));
    const exited = new Promise<number | null>((r) => daemon.once("exit", (code) => r(code)));
    daemon.kill("SIGTERM");
    assert.equal(await exited, 0);
    await until(() => shellPids.every((p) => !alive(p)), "shells morrerem", 5000);
    assert.equal(fs.readdirSync(path.join(HOME, "run")).length, 0);
    // O log não pode ter chave MCP.
    assert.ok(!/key=/.test(daemonOut.log), "chave MCP no log");
  });

  test("autostart: daemon reiniciado sobe a formação sozinho, com rotinas e relatórios", async () => {
    const port2 = PORT + 1;
    const d = startDaemon(port2);
    daemon2 = d.proc;
    // Sem navegador: os dois agentes sobem sozinhos.
    await until(async () => {
      const h = (await (await fetch(`http://127.0.0.1:${port2}/health`).catch(() => null))?.json().catch(() => null)) as { agents?: number } | null;
      return h?.agents === 2;
    }, "formação subir", 30_000);
    const ws = new WebSocket(`ws://127.0.0.1:${port2}?token=${token}`, { origin: ORIGIN });
    const got: ServerMsg[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(String(raw)) as ServerMsg));
    const hello = await until(() => got.find((m): m is Extract<ServerMsg, { type: "hello" }> => m.type === "hello"), "hello do daemon reiniciado");
    // Rotinas e relatórios continuam lá depois do reinício.
    const rots = await until(() => got.find((m): m is Extract<ServerMsg, { type: "routines" }> => m.type === "routines"), "rotinas");
    assert.ok(rots.routines.some((r) => r.id === "rot-vigia"));
    const reps = await until(() => got.find((m): m is Extract<ServerMsg, { type: "reports" }> => m.type === "reports"), "relatórios");
    assert.ok(reps.reports.some((r) => r.agent === "Analista"));
    ws.close();
    assert.equal(hello.autostart, true);
    assert.deepEqual(hello.terminals, { "auto-a": "running", "auto-b": "running" });
    assert.deepEqual(hello.graph.agents.map((a) => a.name).sort(), ["Plantao", "Relator"]);
    assert.deepEqual(hello.graph.agents.find((a) => a.id === "auto-a")?.systems, ["db", "repos"]);
    assert.deepEqual(hello.graph.edges, [["auto-a", "auto-b"]]);
    assert.equal(hello.graph.notes[0]?.title, "Ciclo");
    assert.ok(hello.alwaysfit?.repos.dir.startsWith(HOME));
    const exited = new Promise<number | null>((r) => daemon2!.once("exit", (code) => r(code)));
    daemon2.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal(fs.readdirSync(path.join(HOME, "run")).length, 0);
  });
});
