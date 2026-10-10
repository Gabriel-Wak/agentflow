/** Protocolo entre o canvas (navegador) e o daemon local da Orquestra (`npm run orquestra`). */

export type AgentKind = "claude" | "codex" | "shell";

export const AGENT_KINDS: Record<AgentKind, { label: string; command: string; color: string }> = {
  claude: { label: "Claude Code", command: "claude", color: "#d97757" },
  codex: { label: "Codex", command: "codex", color: "#10a37f" },
  shell: { label: "Terminal", command: "$SHELL", color: "#8b93a7" },
};

export const DEFAULT_DAEMON_URL = "ws://127.0.0.1:4545";

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  kind: AgentKind;
  /** Instruções longas (ex.: prompt do Maestro), somadas ao system prompt ao iniciar. */
  prompt?: string;
  /** Ferramentas proibidas para este agente (Claude Code: --disallowed-tools). */
  deny?: string[];
  /** Ferramentas liberadas sem pedir permissão (Claude Code: --allowed-tools). */
  allow?: string[];
  /** Modo Maestro: vê e comanda todos os agentes do canvas, cria novos e agenda rotinas. */
  maestro?: boolean;
  /** Sistemas Always Fit que este agente pode usar (libera as ferramentas MCP correspondentes). */
  systems?: AfSystem[];
}

// ---------------------------------------------------------------- Always Fit

/** db: réplica de leitura MySQL · repos: espelhos dos repositórios da organização no GitHub. */
export type AfSystem = "db" | "repos";

export interface AfStatus {
  db: { configured: boolean; ok: boolean; host?: string; error?: string; checkedAt?: string };
  repos: { org: string; total: number; synced: number; syncing: boolean; lastSyncAt?: string; error?: string; dir: string };
}

export type ReportSeverity = "info" | "atencao" | "critico";

export interface ReportMeta {
  id: string;
  agent: string;
  title: string;
  severity: ReportSeverity;
  createdAt: string;
}

export interface NoteInfo {
  id: string;
  title: string;
  content: string;
}

/** Grafo atual do canvas: o daemon usa para saber quem pode falar com quem. */
export interface Graph {
  cwd: string;
  agents: AgentInfo[];
  notes: NoteInfo[];
  edges: [string, string][];
}

/** queued: esperando você confiar na pasta no terminal de outro agente. */
export type TerminalStatus = "running" | "exited" | "stopped" | "queued";

/** Mensagem repetida para um agente em intervalo fixo (ex.: ciclo do Vigia). */
export interface Routine {
  id: string;
  /** Nome do agente que recebe a mensagem. */
  agent: string;
  message: string;
  everyMinutes: number;
  enabled: boolean;
  nextAt: string;
  lastAt?: string;
  lastError?: string;
  createdBy: string;
}

export interface Score {
  name: string;
  savedAt: string;
  canvas: unknown;
}

export interface UsageWindow {
  id: string;
  label: string;
  /** 0–100; pode passar de 100 quando há uso excedente. */
  usedPercent: number;
  resetsAt: string | null;
  durationSeconds: number | null;
}

/** Limites do plano do Claude Code, lidos com a própria CLI (mesma fonte do Maestri). */
export interface ClaudeUsage {
  ok: boolean;
  fetchedAt: string;
  plan?: string;
  /** false: a conta não tem limite de plano (ex.: chave de API). */
  limited?: boolean;
  windows: UsageWindow[];
  error?: string;
}

export type ClientMsg =
  | { type: "graph"; graph: Graph }
  | { type: "spawn"; id: string; cols: number; rows: number; agent: AgentInfo; cwd: string }
  | { type: "attach"; id: string }
  | { type: "input"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "kill"; id: string }
  | { type: "send"; to: string[]; text: string }
  | { type: "scores:list" }
  | { type: "scores:save"; name: string; canvas: unknown }
  | { type: "scores:delete"; name: string }
  | { type: "usage:refresh" }
  | { type: "routines:list" }
  | { type: "routines:save"; routine: Pick<Routine, "agent" | "message" | "everyMinutes"> & { id?: string; enabled?: boolean } }
  | { type: "routines:delete"; id: string }
  | { type: "routines:run"; id: string }
  /** Reverifica banco e repositórios. */
  | { type: "af:refresh" }
  /** Sincroniza os espelhos dos repositórios agora. */
  | { type: "af:sync" }
  | { type: "reports:list" }
  | { type: "reports:read"; id: string }
  /** Formação que o daemon sobe sozinho ao iniciar (24h), no mesmo formato da partitura. */
  | { type: "autostart:save"; canvas: unknown }
  | { type: "autostart:clear" };

export type ServerMsg =
  | { type: "hello"; version: string; home: string; cwd: string; terminals: Record<string, TerminalStatus>; agents: Record<AgentKind, boolean>; graph: Graph; autostart?: boolean; alwaysfit?: AfStatus }
  /** O Maestro criou um agente (o terminal já está rodando no daemon). */
  | { type: "agent:add"; agent: AgentInfo; edges: [string, string][]; by: string }
  | { type: "agent:update"; id: string; patch: Partial<AgentInfo> }
  | { type: "agent:remove"; id: string }
  | { type: "edges"; add: [string, string][]; remove: [string, string][] }
  | { type: "notify"; from: string; title: string; text: string; urgent: boolean }
  | { type: "routines"; routines: Routine[] }
  /** replay: buffer inteiro reenviado no attach — o canvas limpa o terminal antes de escrever. */
  | { type: "output"; id: string; data: string; replay?: true }
  | { type: "status"; id: string; status: TerminalStatus; code?: number }
  | { type: "message"; from: string; to: string; text: string }
  | { type: "note"; id?: string; title: string; content: string; by: string }
  | { type: "scores"; scores: Score[] }
  | { type: "usage"; usage: ClaudeUsage }
  | { type: "error"; message: string; id?: string }
  | { type: "af:status"; status: AfStatus }
  | { type: "reports"; reports: ReportMeta[] }
  | { type: "report"; id: string; content: string }
  /** Um agente salvou um relatório: o canvas avisa. */
  | { type: "report:new"; report: ReportMeta }
  /** Formação de inicialização gravada ou apagada. */
  | { type: "autostart"; enabled: boolean };
