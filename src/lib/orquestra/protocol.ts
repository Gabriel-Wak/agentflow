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

export type TerminalStatus = "running" | "exited" | "stopped";

export interface Score {
  name: string;
  savedAt: string;
  canvas: unknown;
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
  | { type: "scores:delete"; name: string };

export type ServerMsg =
  | { type: "hello"; version: string; home: string; cwd: string; terminals: Record<string, TerminalStatus>; agents: Record<AgentKind, boolean> }
  | { type: "output"; id: string; data: string }
  | { type: "status"; id: string; status: TerminalStatus; code?: number }
  | { type: "message"; from: string; to: string; text: string }
  | { type: "note"; id?: string; title: string; content: string; by: string }
  | { type: "scores"; scores: Score[] }
  | { type: "error"; message: string; id?: string };
