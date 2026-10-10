/** Utilitários do daemon: confiança de pasta do Claude Code, rotinas e notificações do macOS. */
import { execFile, execFileSync, spawn } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Routine } from "../src/lib/orquestra/protocol";

// ---------------------------------------------------------------- log

/** Log discreto no terminal do daemon. Nunca passe token, chave MCP ou texto de mensagem aqui. */
export function log(text: string) {
  const time = new Date().toLocaleTimeString("pt-BR", { hour12: false });
  console.log(`  ${time} · ${text}`);
}

// ---------------------------------------------------------------- ambiente dos agentes

/**
 * Comando da CLI do Claude Code. ORQUESTRA_CLAUDE_BIN aponta para outra instalação
 * (ou para um falso nos testes, sem gastar o limite do plano).
 */
export const CLAUDE_BIN = process.env.ORQUESTRA_CLAUDE_BIN || "claude";

export function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Texto que vai ser colado no terminal de um agente. Tira caracteres de controle — em
 * especial o fim de colagem (ESC[201~), que deixaria uma mensagem "escapar" da colagem e
 * digitar teclas no terminal (num agente shell, executar comandos).
 */
export function pasteSafe(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/**
 * Ambiente limpo para os terminais: se o daemon foi iniciado de dentro de um Claude Code,
 * tira as variáveis daquela sessão para os agentes não se acharem "filhos" dela.
 * Configurações do usuário (ex.: CLAUDE_CODE_USE_BEDROCK) continuam.
 */
export function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_\w+|MESSAGING_\w+|SSE_PORT))$/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// ---------------------------------------------------------------- processos externos

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** A saída passou do limite e o processo foi encerrado antes de terminar. */
  truncated: boolean;
  /** Erro ao iniciar (ex.: binário não existe). */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  /** Para de ler (e mata o processo) quando a saída passa disso. */
  maxBytes?: number;
  /** Para de ler quando a saída já basta (ex.: linhas suficientes). */
  enough?: (stdout: string) => boolean;
}

/** Processos externos em andamento: o daemon mata todos ao encerrar. */
const children = new Set<() => void>();
export function stopChildren() {
  for (const stop of [...children]) stop();
}

/**
 * Roda um binário sem shell (argumentos nunca são interpretados), num grupo de processos
 * próprio: timeout ou limite de saída matam o grupo inteiro (git e mysql abrem subprocessos).
 * Nunca lança.
 */
export function run(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    let truncated = false;
    const child = spawn(file, args, { cwd: opts.cwd, env: (opts.env ?? process.env) as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* já saiu */
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    };
    const finish = (code: number | null, error?: string) => {
      if (done) return;
      done = true;
      children.delete(stop);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) stop();
      resolve({ code, stdout, stderr: stderr.slice(0, 8000), timedOut, truncated, error });
    };
    children.add(stop);
    const timer = setTimeout(() => {
      timedOut = true;
      finish(null, `não terminou em ${Math.round(opts.timeoutMs / 1000)}s`);
    }, opts.timeoutMs);
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
    child.stdout.on("data", (d: Buffer) => {
      if (done) return;
      stdout += d.toString("utf8");
      if ((opts.maxBytes && stdout.length > opts.maxBytes) || opts.enough?.(stdout)) {
        truncated = true;
        finish(0);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString("utf8");
    });
  });
}

/**
 * Caminho de um binário: variável de ambiente, ou o que o shell de login do usuário acha
 * (clientes como o mysql do Homebrew só entram no PATH pelo perfil do shell).
 */
export function resolveBin(name: string, envVar: string) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  try {
    const found = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${shellQuote(name)}`], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")
      .pop();
    return found && path.isAbsolute(found) ? found : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- confiança de pasta

const claudeConfig = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");

/**
 * Se o Claude Code já confia nesta pasta (ou numa pasta acima dela).
 * Só lê a flag `hasTrustDialogAccepted`; quem confia é sempre você, no terminal.
 */
export function claudeTrusts(dir: string) {
  try {
    const projects = (JSON.parse(fs.readFileSync(claudeConfig(), "utf8")).projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>;
    let cur = path.resolve(dir);
    for (;;) {
      if (projects[cur]?.hasTrustDialogAccepted) return true;
      const up = path.dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
  } catch {
    // Sem arquivo de configuração: o Claude vai perguntar, mas não travamos a fila por isso.
    return true;
  }
}

// ---------------------------------------------------------------- rotinas

export class RoutineStore {
  private items: Routine[] = [];

  constructor(private file: string) {
    let raw: unknown = [];
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`rotinas.json ilegível (${(e as Error).message}); começando sem rotinas`);
    }
    // Arquivo editado à mão ou de versão antiga: descarta só o que não dá para usar.
    this.items = (Array.isArray(raw) ? raw : []).filter(
      (r): r is Routine =>
        Boolean(r) && typeof r.id === "string" && typeof r.agent === "string" && typeof r.message === "string" &&
        Number.isFinite(r.everyMinutes) && r.everyMinutes >= 1 && typeof r.nextAt === "string" && !Number.isNaN(Date.parse(r.nextAt)),
    );
    for (const r of this.items) r.enabled = r.enabled !== false;
  }

  list() {
    return [...this.items].sort((a, b) => a.agent.localeCompare(b.agent) || a.nextAt.localeCompare(b.nextAt));
  }

  get(id: string) {
    return this.items.find((r) => r.id === id);
  }

  save(input: Pick<Routine, "agent" | "message" | "everyMinutes"> & { id?: string; enabled?: boolean }, createdBy: string) {
    if (!Number.isFinite(input.everyMinutes)) throw new Error("intervalo da rotina inválido");
    const everyMinutes = Math.min(1440, Math.max(1, Math.round(input.everyMinutes)));
    const existing = input.id ? this.get(input.id) : undefined;
    if (existing) {
      Object.assign(existing, {
        agent: input.agent,
        message: input.message,
        enabled: input.enabled ?? existing.enabled,
        // Mudou o intervalo: recomeça a contagem a partir de agora.
        nextAt: existing.everyMinutes !== everyMinutes ? new Date(Date.now() + everyMinutes * 60_000).toISOString() : existing.nextAt,
        everyMinutes,
      });
      this.persist();
      return existing;
    }
    const r: Routine = {
      id: `rot-${randomBytes(4).toString("hex")}`,
      agent: input.agent,
      message: input.message,
      everyMinutes,
      enabled: input.enabled ?? true,
      nextAt: new Date(Date.now() + everyMinutes * 60_000).toISOString(),
      createdBy,
    };
    this.items.push(r);
    this.persist();
    return r;
  }

  remove(id: string) {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    this.persist();
    return this.items.length !== before;
  }

  /** Rotinas que já deveriam ter rodado. */
  due(now = Date.now()) {
    return this.items.filter((r) => r.enabled && new Date(r.nextAt).getTime() <= now);
  }

  markRun(id: string, error?: string) {
    const r = this.get(id);
    if (!r) return;
    r.lastAt = new Date().toISOString();
    r.lastError = error;
    r.nextAt = new Date(Date.now() + r.everyMinutes * 60_000).toISOString();
    this.persist();
  }

  /** Grava num temporário e renomeia: um crash no meio nunca deixa o arquivo pela metade. */
  private persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------- notificações

/** Notificação nativa do macOS. Texto vai por argv (sem interpolar em AppleScript). */
export function macNotify(title: string, text: string) {
  if (process.platform !== "darwin") return;
  execFile(
    "osascript",
    ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"", "-e", "end run", title.slice(0, 120), text.slice(0, 400)],
    () => {},
  );
}
