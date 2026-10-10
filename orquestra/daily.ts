/**
 * Reinício diário dos agentes de IA (ex.: 04:00) para não acumularem contexto rodando 24h.
 * Um por vez, esperando cada um ficar ocioso, com intervalo entre eles.
 *
 * Só dispara dentro de uma janela depois do horário: se o Mac estava dormindo ou o daemon
 * subiu no meio da tarde, aquele dia fica sem reinício (em vez de reiniciar todo mundo na hora).
 * Relógio e efeitos são injetados para os testes.
 */
export interface DailyDeps {
  now: () => Date;
  /** Agentes que devem ser reiniciados agora (IA rodando). */
  agents: () => { id: string; name: string }[];
  isIdle: (id: string) => boolean;
  restart: (id: string) => void;
  wait: (ms: number) => Promise<void>;
  /** Último dia (AAAA-MM-DD, horário local) em que rodou — persistido entre reinícios do daemon. */
  lastRun: { get: () => string | undefined; set: (day: string) => void };
  log: (text: string) => void;
}

export interface DailyOptions {
  gapMs?: number;
  idleWaitMs?: number;
  windowMs?: number;
}

/** "04:00" → { h: 4, m: 0 }. Vazio ou inválido → null (desligado). */
export function parseDailyTime(s: string | undefined) {
  const m = (s ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export class DailyRestart {
  private running = false;
  private gapMs: number;
  private idleWaitMs: number;
  private windowMs: number;

  constructor(
    private at: { h: number; m: number },
    private deps: DailyDeps,
    opts: DailyOptions = {},
  ) {
    this.gapMs = opts.gapMs ?? 60_000;
    this.idleWaitMs = opts.idleWaitMs ?? 15 * 60_000;
    this.windowMs = opts.windowMs ?? 2 * 3_600_000;
  }

  /** Chamado periodicamente (ex.: a cada minuto). Devolve os agentes reiniciados nesta chamada. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    const now = this.deps.now();
    const today = dayKey(now);
    if (this.deps.lastRun.get() === today) return [];
    const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.at.h, this.at.m);
    const late = now.getTime() - scheduled.getTime();
    if (late < 0 || late > this.windowMs) return [];

    // Marca antes de começar: um crash no meio não faz reiniciar todo mundo de novo.
    this.deps.lastRun.set(today);
    this.running = true;
    const done: string[] = [];
    try {
      const list = this.deps.agents();
      if (list.length) this.deps.log(`reinício diário: ${list.length} agente${list.length > 1 ? "s" : ""}`);
      for (const [i, a] of list.entries()) {
        // Não corta uma tarefa no meio: espera ficar ocioso (com limite).
        const until = this.deps.now().getTime() + this.idleWaitMs;
        while (!this.deps.isIdle(a.id) && this.deps.now().getTime() < until) await this.deps.wait(5000);
        // Pode ter sido parado/removido enquanto esperava.
        if (!this.deps.agents().some((x) => x.id === a.id)) continue;
        try {
          this.deps.restart(a.id);
          done.push(a.name);
          this.deps.log(`reinício diário: ${a.name} reiniciado`);
        } catch (e) {
          this.deps.log(`reinício diário: ${a.name} falhou: ${(e as Error).message}`);
        }
        if (i < list.length - 1) await this.deps.wait(this.gapMs);
      }
    } finally {
      this.running = false;
    }
    return done;
  }
}
