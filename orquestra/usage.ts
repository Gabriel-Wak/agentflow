/**
 * Limites do plano do Claude Code (sessão de 5h, semanal e por modelo).
 *
 * Usa a mesma fonte do Maestri: abre `claude -p` em modo stream-json, pede
 * `get_usage` e lê a resposta. Não lê tokens nem chama a API da Anthropic direto.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { ClaudeUsage, UsageWindow } from "../src/lib/orquestra/protocol";
import { CLAUDE_BIN, cleanEnv, shellQuote } from "./support";

const REQUEST_ID = "orquestra-usage";
const TIMEOUT_MS = 30_000;

/** Consultas em andamento: o daemon mata todas ao encerrar. */
const running = new Set<() => void>();
export function stopUsageFetches() {
  for (const stop of [...running]) stop();
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

const WINDOWS: { key: string; label: string; durationSeconds: number }[] = [
  { key: "five_hour", label: "Sessão (5h)", durationSeconds: 18_000 },
  { key: "seven_day", label: "Semanal", durationSeconds: 604_800 },
  { key: "seven_day_opus", label: "Semanal · Opus", durationSeconds: 604_800 },
  { key: "seven_day_sonnet", label: "Semanal · Sonnet", durationSeconds: 604_800 },
];

function parse(response: Record<string, unknown>): ClaudeUsage {
  const limits = (response.rate_limits ?? {}) as Record<string, RawWindow | null> & { model_scoped?: (RawWindow & { display_name?: string })[] };
  const windows: UsageWindow[] = [];
  for (const w of WINDOWS) {
    const raw = limits[w.key];
    if (raw && typeof raw.utilization === "number") {
      windows.push({ id: w.key, label: w.label, usedPercent: raw.utilization, resetsAt: raw.resets_at ?? null, durationSeconds: w.durationSeconds });
    }
  }
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (typeof m.utilization === "number" && m.display_name) {
      windows.push({ id: `model:${m.display_name}`, label: `Semanal · ${m.display_name}`, usedPercent: m.utilization, resetsAt: m.resets_at ?? null, durationSeconds: 604_800 });
    }
  }
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    plan: typeof response.subscription_type === "string" ? response.subscription_type : undefined,
    limited: response.rate_limits_available !== false,
    windows,
  };
}

/** Roda a CLI uma vez e devolve os limites atuais. Nunca lança: erros vêm em `error`. */
export function fetchClaudeUsage(): Promise<ClaudeUsage> {
  const failed = (error: string): ClaudeUsage => ({ ok: false, fetchedAt: new Date().toISOString(), windows: [], error });
  // Pasta vazia: a CLI não carrega CLAUDE.md nem MCP de projeto nenhum.
  let cwd: string;
  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orquestra-usage-"));
  } catch (e) {
    return Promise.resolve(failed(`não consegui criar pasta temporária: ${(e as Error).message}`));
  }

  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    // detached: o shell de login e a CLI ficam num grupo de processos próprio, que matamos inteiro.
    const child = spawn(
      process.env.SHELL || "/bin/zsh",
      ["-lc", `${shellQuote(CLAUDE_BIN)} -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence`],
      { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"], env: cleanEnv({ NO_COLOR: "1", TERM: "dumb" }) as NodeJS.ProcessEnv },
    );
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* já saiu */
      }
    };
    const finish = (u: ClaudeUsage) => {
      if (done) return;
      done = true;
      running.delete(stop);
      clearTimeout(timer);
      killGroup("SIGTERM");
      // Se a CLI ignorar o SIGTERM, não fica processo sobrando.
      if (child.exitCode === null && child.signalCode === null) setTimeout(() => killGroup("SIGKILL"), 2000).unref();
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* pasta temporária: o sistema limpa depois */
      }
      resolve(u);
    };
    const stop = () => finish(failed("consulta cancelada"));
    running.add(stop);
    const timer = setTimeout(() => finish(failed("a CLI do Claude não respondeu em 30s")), TIMEOUT_MS);

    child.on("error", (e) => finish(failed(e.message)));
    // A CLI pode sair antes de ler o pedido (EPIPE): sem este handler o daemon cairia.
    child.stdin.on("error", () => {});
    child.on("close", (code) => finish(failed(code === 127 ? "comando `claude` não encontrado" : `a CLI do Claude saiu sem responder (código ${code})`)));
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { type?: string; response?: { request_id?: string; error?: unknown; response?: Record<string, unknown> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type !== "control_response" || msg.response?.request_id !== REQUEST_ID) continue;
        if (msg.response.error) finish(failed(typeof msg.response.error === "string" ? msg.response.error : "atualize a CLI do Claude para ver os limites"));
        else if (msg.response.response) finish(parse(msg.response.response));
        else finish(failed("resposta sem dados de uso"));
      }
    });
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
  });
}

/** Resumo em texto para as ferramentas MCP dos agentes. */
export function describeUsage(u: ClaudeUsage | null) {
  if (!u) return "Ainda não li os limites do Claude. Tente de novo em alguns segundos.";
  if (!u.ok) return `Não consegui ler os limites do Claude: ${u.error}.`;
  if (u.limited === false) return "Esta conta não tem limite de plano (uso cobrado por API).";
  const lines = u.windows.map((w) => {
    const reset = w.resetsAt ? ` · renova ${new Date(w.resetsAt).toLocaleString("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    return `- ${w.label}: ${Math.round(w.usedPercent)}% usado${reset}`;
  });
  return [`Plano: ${u.plan ?? "?"} · lido às ${new Date(u.fetchedAt).toLocaleTimeString("pt-BR")}`, ...lines].join("\n");
}
