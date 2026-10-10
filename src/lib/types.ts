export type ConnectionKind = "mcp" | "database" | "github";

export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  config: Record<string, string>;
  status: string;
  meta: Record<string, unknown>;
  created_at: string;
  /** Segredo mascarado (nunca o valor real) — só para exibir. */
  secret_hint?: string;
}

export type AgentKind = "claude" | "claude_code" | "webhook";
export type AgentRole = "creator" | "validator" | "approver" | "custom";

export interface SavedAgent {
  id: string;
  name: string;
  kind: AgentKind;
  role: AgentRole;
  description: string;
  system_prompt: string;
  model: string;
  config: Record<string, string>;
  created_at: string;
  secret_hint?: string;
}

export interface PromptItem {
  id: string;
  title: string;
  original: string;
  improved: string;
  notes: string;
  created_at: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentNodeData {
  [key: string]: unknown;
  label: string;
  role: AgentRole;
  /** Agente salvo em /agents; se vazio, usa o prompt abaixo. */
  agentId?: string;
  systemPrompt: string;
  model: string;
  effort: Effort;
  mcpIds: string[];
  databaseId?: string;
  githubId?: string;
}

export interface TaskNodeData {
  [key: string]: unknown;
  label: string;
  task: string;
}

export interface OutputNodeData {
  [key: string]: unknown;
  label: string;
}

export interface FlowSettings {
  maxRounds: number;
}

/** Eventos enviados (NDJSON) durante a execução de um fluxo. */
export type RunEvent =
  | { type: "run_start"; runId: string | null }
  | { type: "node_start"; nodeId: string; label: string; round: number }
  | { type: "delta"; nodeId: string; text: string }
  | { type: "tool"; nodeId: string; name: string; detail: string }
  | { type: "node_end"; nodeId: string; output: string; verdict?: "approved" | "rejected" }
  | { type: "loop"; fromNodeId: string; toNodeId: string; round: number; feedback: string }
  | { type: "done"; output: string; approved: boolean }
  | { type: "error"; message: string; nodeId?: string };

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (mais capaz)" },
] as const;

export const ROLE_LABEL: Record<AgentRole, string> = {
  creator: "Criador",
  validator: "Validador",
  approver: "Aprovador",
  custom: "Personalizado",
};
