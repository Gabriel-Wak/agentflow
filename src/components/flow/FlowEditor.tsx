"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection as RFConnection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { ArrowLeft, Check, Loader2, Play, Save, Square } from "lucide-react";
import { api, readNdjson } from "@/lib/fetcher";
import { agentData } from "@/lib/flow-template";
import { ROLE_LABEL, type AgentRole, type Connection, type FlowSettings, type RunEvent, type SavedAgent } from "@/lib/types";
import { Button, Select } from "../ui";
import { nodeTypes, type RunStatus } from "./nodes";
import Inspector from "./Inspector";
import RunPanel, { type RunEntry } from "./RunPanel";

interface FlowRow { id: string; name: string; nodes: Node[]; edges: Edge[]; settings: FlowSettings }

/** Remove o estado de execução antes de salvar. */
const clean = (nodes: Node[]) =>
  nodes.map(({ id, type, position, data }) => {
    const rest = { ...(data as Record<string, unknown>) };
    delete rest.status;
    delete rest.round;
    return { id, type, position, data: rest };
  });

export default function FlowEditor({ id }: { id: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<FlowSettings>({ maxRounds: 3 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"config" | "run">("config");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [agents, setAgents] = useState<SavedAgent[]>([]);
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<RunEntry[]>([]);
  const [final, setFinal] = useState<{ output: string; approved: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    Promise.all([
      api<FlowRow>(`/api/flows/${id}`),
      api<Connection[]>("/api/connections").catch(() => []),
      api<SavedAgent[]>("/api/agents").catch(() => []),
    ])
      .then(([flow, conns, ags]) => {
        setNodes(flow.nodes);
        setEdges(flow.edges);
        setName(flow.name);
        setSettings({ maxRounds: flow.settings?.maxRounds ?? 3 });
        setConnections(conns);
        setAgents(ags);
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, [id, setNodes, setEdges]);

  // Marca como "não salvo" quando algo muda (exceto mudanças de status de execução).
  const structureKey = useMemo(() => JSON.stringify([clean(nodes), edges.map((e) => [e.source, e.target]), name, settings]), [nodes, edges, name, settings]);
  useEffect(() => {
    if (!loaded) return;
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    setSaveState("dirty");
  }, [structureKey, loaded]);

  const save = useCallback(async () => {
    setSaveState("saving");
    try {
      await api(`/api/flows/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name, nodes: clean(nodes), edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle, animated: true })), settings }),
      });
      setSaveState("saved");
    } catch (e) {
      setError((e as Error).message);
      setSaveState("dirty");
    }
  }, [id, name, nodes, edges, settings]);

  // Salvamento automático 1,5 s depois da última mudança.
  useEffect(() => {
    if (saveState !== "dirty" || running) return;
    const t = setTimeout(save, 1500);
    return () => clearTimeout(t);
  }, [saveState, save, running]);

  const onConnect = useCallback((c: RFConnection) => setEdges((eds) => addEdge({ ...c, animated: true }, eds)), [setEdges]);

  function addAgent(role: AgentRole) {
    const agentsCount = nodes.filter((n) => n.type === "agent").length;
    const maxX = Math.max(0, ...nodes.map((n) => n.position.x));
    const newNode: Node = {
      id: `agent-${Date.now().toString(36)}`,
      type: "agent",
      position: { x: maxX - 160, y: 340 + (agentsCount % 3) * 30 },
      data: agentData(role, `${ROLE_LABEL[role]} ${agentsCount + 1}`),
    };
    setNodes((ns) => [...ns, newNode]);
    setSelectedId(newNode.id);
    setTab("config");
  }

  const updateNodeData = useCallback(
    (nodeId: string, patch: Record<string, unknown>) =>
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))),
    [setNodes],
  );

  const setStatus = useCallback(
    (nodeId: string, status: RunStatus, round?: number) =>
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, status, ...(round ? { round } : {}) } } : n))),
    [setNodes],
  );

  async function run() {
    const taskNode = nodes.find((n) => n.type === "task");
    if (!(taskNode?.data as { task?: string })?.task?.trim()) {
      setSelectedId(taskNode?.id ?? null);
      setTab("config");
      setError("Escreva a tarefa no nó de Tarefa antes de executar.");
      return;
    }
    setError("");
    await save();
    setRunning(true);
    setTab("run");
    setEntries([]);
    setFinal(null);
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: "idle" } })));
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch(`/api/flows/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: clean(nodes), edges, settings }),
        signal: ac.signal,
      });
      await readNdjson<RunEvent>(res, (ev) => {
        switch (ev.type) {
          case "node_start":
            setStatus(ev.nodeId, "running", ev.round);
            setEntries((es) => [...es, { nodeId: ev.nodeId, label: ev.label, round: ev.round, text: "", tools: [] }]);
            break;
          case "delta":
            setEntries((es) => es.map((e, i) => (i === es.length - 1 && e.nodeId === ev.nodeId ? { ...e, text: e.text + ev.text } : e)));
            break;
          case "tool":
            setEntries((es) => es.map((e, i) => (i === es.length - 1 ? { ...e, tools: [...e.tools, `${ev.name} ${ev.detail}`] } : e)));
            break;
          case "node_end":
            setStatus(ev.nodeId, ev.verdict ?? "done");
            setEntries((es) => es.map((e, i) => (i === es.length - 1 ? { ...e, text: ev.output || e.text, verdict: ev.verdict, finished: true } : e)));
            break;
          case "loop":
            setEntries((es) => [...es, { nodeId: ev.toNodeId, label: `↺ Voltando ao Criador — rodada ${ev.round}`, round: ev.round, text: "", tools: [], system: true }]);
            break;
          case "done": {
            setFinal({ output: ev.output, approved: ev.approved });
            const out = nodes.find((n) => n.type === "output");
            if (out) setStatus(out.id, ev.approved ? "approved" : "rejected");
            break;
          }
          case "error":
            setError(ev.message);
            if (ev.nodeId) setStatus(ev.nodeId, "error");
            setNodes((ns) => ns.map((n) => ((n.data as { status?: string }).status === "running" ? { ...n, data: { ...n.data, status: "error" } } : n)));
            break;
        }
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
      setNodes((ns) => ns.map((n) => ((n.data as { status?: string }).status === "running" ? { ...n, data: { ...n.data, status: "idle" } } : n)));
    }
  }

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  if (!loaded) {
    return (
      <div className="flex h-[70vh] items-center justify-center gap-2 text-sm text-muted">
        {error ? <span className="text-bad">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Carregando fluxo...</>}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-53px)] flex-col md:h-screen">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Link href="/flows" className="rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-fg" aria-label="Voltar"><ArrowLeft className="h-4 w-4" /></Link>
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none sm:max-w-xs" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select className="w-auto py-1.5 text-xs" value="" onChange={(e) => e.target.value && addAgent(e.target.value as AgentRole)}>
            <option value="">+ Agente</option>
            {(Object.keys(ROLE_LABEL) as AgentRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
          <Select className="w-auto py-1.5 text-xs" value={settings.maxRounds} onChange={(e) => setSettings({ ...settings, maxRounds: Number(e.target.value) })} title="Máximo de rodadas de revisão">
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} rodada{n > 1 ? "s" : ""}</option>)}
          </Select>
          <Button variant="outline" className="py-1.5 text-xs" onClick={save} disabled={saveState !== "dirty"}>
            {saveState === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saveState === "saved" ? <Check className="h-3.5 w-3.5 text-ok" /> : <Save className="h-3.5 w-3.5" />}
            {saveState === "saved" ? "Salvo" : "Salvar"}
          </Button>
          {running ? (
            <Button variant="outline" className="py-1.5 text-xs" onClick={() => abortRef.current?.abort()}><Square className="h-3.5 w-3.5" /> Parar</Button>
          ) : (
            <Button className="py-1.5 text-xs" onClick={run}><Play className="h-3.5 w-3.5" /> Executar</Button>
          )}
        </div>
      </div>
      {error && <div className="border-b border-bad/30 bg-bad/10 px-4 py-2 text-xs text-bad">{error}</div>}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-[50vh] flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedId(n.id); setTab("config"); }}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2f3c" />
            <Controls />
            <MiniMap pannable zoomable nodeStrokeWidth={2} className="hidden sm:block" />
          </ReactFlow>
        </div>
        <aside className="flex max-h-[60vh] w-full flex-col border-t border-line bg-panel lg:max-h-none lg:w-[420px] lg:border-l lg:border-t-0">
          <div className="flex border-b border-line text-sm">
            {(["config", "run"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2.5 ${tab === t ? "border-b-2 border-accent text-fg" : "text-muted"}`}>
                {t === "config" ? "Configurar" : `Execução${running ? " •" : ""}`}
              </button>
            ))}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {tab === "config" ? (
              <Inspector
                node={selected}
                connections={connections}
                agents={agents}
                onChange={updateNodeData}
                onDelete={(nid) => { setNodes((ns) => ns.filter((n) => n.id !== nid)); setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid)); setSelectedId(null); }}
              />
            ) : (
              <RunPanel entries={entries} running={running} final={final} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
