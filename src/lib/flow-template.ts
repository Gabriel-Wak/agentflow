import type { Edge, Node } from "@xyflow/react";
import { DEFAULT_ROLE_PROMPTS } from "./roles";
import type { AgentNodeData, AgentRole, FlowSettings } from "./types";

export function agentData(role: AgentRole, label: string): AgentNodeData {
  return {
    label,
    role,
    systemPrompt: DEFAULT_ROLE_PROMPTS[role],
    model: "claude-opus-5-5",
    effort: role === "creator" ? "high" : "medium",
    mcpIds: [],
  };
}

/** Time padrão: Tarefa → Criador → Validador → Aprovador → Entrega (com loop de revisão). */
export function defaultFlow(): { nodes: Node[]; edges: Edge[]; settings: FlowSettings } {
  const nodes: Node[] = [
    { id: "task", type: "task", position: { x: 0, y: 160 }, data: { label: "Tarefa", task: "" } },
    { id: "creator", type: "agent", position: { x: 320, y: 120 }, data: agentData("creator", "Criador") },
    { id: "validator", type: "agent", position: { x: 640, y: 120 }, data: agentData("validator", "Validador") },
    { id: "approver", type: "agent", position: { x: 960, y: 120 }, data: agentData("approver", "Aprovador") },
    { id: "output", type: "output", position: { x: 1280, y: 160 }, data: { label: "Entrega" } },
  ];
  const e = (s: string, t: string): Edge => ({ id: `${s}-${t}`, source: s, target: t, animated: true });
  return {
    nodes,
    edges: [e("task", "creator"), e("creator", "validator"), e("validator", "approver"), e("approver", "output")],
    settings: { maxRounds: 3 },
  };
}
