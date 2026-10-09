"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { CheckCircle2, ClipboardList, Database, Flag, GitBranch, Loader2, Plug, ShieldCheck, Sparkles, Wand2, XCircle } from "lucide-react";
import { ROLE_LABEL, type AgentNodeData, type AgentRole, type OutputNodeData, type TaskNodeData } from "@/lib/types";

export type RunStatus = "idle" | "running" | "done" | "approved" | "rejected" | "error";
type WithStatus<T> = T & { status?: RunStatus; round?: number };

const ROLE_STYLE: Record<AgentRole, { color: string; icon: typeof Wand2 }> = {
  creator: { color: "#7c6cff", icon: Wand2 },
  validator: { color: "#22d3ee", icon: ShieldCheck },
  approver: { color: "#34d399", icon: CheckCircle2 },
  custom: { color: "#fbbf24", icon: Sparkles },
};

function StatusPill({ status, round }: { status?: RunStatus; round?: number }) {
  if (!status || status === "idle") return null;
  const map = {
    running: { text: round && round > 1 ? `trabalhando · rodada ${round}` : "trabalhando", cls: "text-warn", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    done: { text: "concluído", cls: "text-muted", icon: <CheckCircle2 className="h-3 w-3" /> },
    approved: { text: "aprovado", cls: "text-ok", icon: <CheckCircle2 className="h-3 w-3" /> },
    rejected: { text: "reprovado", cls: "text-bad", icon: <XCircle className="h-3 w-3" /> },
    error: { text: "erro", cls: "text-bad", icon: <XCircle className="h-3 w-3" /> },
  }[status];
  return <div className={`mt-2 flex items-center gap-1 text-[11px] ${map.cls}`}>{map.icon} {map.text}</div>;
}

export function AgentNode({ data, selected }: NodeProps<Node<WithStatus<AgentNodeData>>>) {
  const style = ROLE_STYLE[data.role] ?? ROLE_STYLE.custom;
  const Icon = style.icon;
  const running = data.status === "running";
  return (
    <div
      className="w-56 rounded-xl border bg-panel p-3 shadow-lg transition"
      style={{
        borderColor: selected || running ? style.color : "var(--border)",
        boxShadow: running ? `0 0 0 3px ${style.color}33, 0 0 24px ${style.color}44` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <div className="rounded-lg p-1.5" style={{ background: `${style.color}22`, color: style.color }}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{data.label}</div>
          <div className="text-[11px] text-muted">{ROLE_LABEL[data.role]} · {data.agentId ? "agente salvo" : data.model.replace("claude-", "")}</div>
        </div>
      </div>
      {(data.mcpIds?.length || data.databaseId || data.githubId) ? (
        <div className="mt-2 flex gap-2 text-muted">
          {data.githubId && <GitBranch className="h-3.5 w-3.5" />}
          {data.databaseId && <Database className="h-3.5 w-3.5" />}
          {data.mcpIds?.length ? <span className="flex items-center gap-0.5 text-[11px]"><Plug className="h-3.5 w-3.5" />{data.mcpIds.length}</span> : null}
        </div>
      ) : null}
      <StatusPill status={data.status} round={data.round} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function TaskNode({ data, selected }: NodeProps<Node<WithStatus<TaskNodeData>>>) {
  return (
    <div className={`w-56 rounded-xl border bg-panel p-3 ${selected ? "border-accent" : "border-line"}`}>
      <div className="flex items-center gap-2 text-sm font-medium"><ClipboardList className="h-4 w-4 text-accent-2" /> {data.label}</div>
      <p className="mt-2 line-clamp-3 text-[11px] text-muted">{data.task || "Clique para escrever a tarefa..."}</p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function OutputNode({ data, selected }: NodeProps<Node<WithStatus<OutputNodeData>>>) {
  const tone = data.status === "approved" ? "text-ok border-ok" : data.status === "rejected" ? "text-bad border-bad" : selected ? "border-accent" : "border-line";
  return (
    <div className={`w-44 rounded-xl border bg-panel p-3 ${tone}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2 text-sm font-medium"><Flag className="h-4 w-4" /> {data.label}</div>
      <StatusPill status={data.status} />
    </div>
  );
}

export const nodeTypes = { agent: AgentNode, task: TaskNode, output: OutputNode };
