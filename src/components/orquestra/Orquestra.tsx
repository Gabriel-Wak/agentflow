"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection as RFConnection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { BookMarked, FolderOpen, MessagesSquare, Plus, Send, StickyNote, Terminal as TerminalIcon, Trash2, Users, X } from "lucide-react";
import { AGENT_KINDS, type AgentKind, type Graph, type Score, type ServerMsg } from "@/lib/orquestra/protocol";
import { Button, Input } from "../ui";
import { DaemonContext, useDaemonConnection, type Daemon } from "./daemon";
import TerminalNode, { type TerminalData } from "./TerminalNode";
import NoteNode, { NOTE_COLORS, type NoteData } from "./NoteNode";
import ConnectScreen from "./ConnectScreen";

const nodeTypes = { terminal: TerminalNode, note: NoteNode };
const CANVAS_KEY = "orquestra:canvas";
const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Canvas {
  nodes: Node[];
  edges: Edge[];
  cwd: string;
}
interface LogItem {
  at: number;
  from: string;
  to: string;
  text: string;
}

function loadCanvas(): Canvas | null {
  try {
    const raw = localStorage.getItem(CANVAS_KEY);
    return raw ? (JSON.parse(raw) as Canvas) : null;
  } catch {
    return null;
  }
}

/** Remove estado efêmero antes de salvar. */
const persistable = (nodes: Node[]) =>
  nodes.map(({ id, type, position, width, height, data }) => {
    const d = { ...(data as Record<string, unknown>) };
    delete d.pulse;
    delete d.autostart;
    return { id, type, position, width, height, data: d };
  });

function Stage() {
  const conn = useDaemonConnection();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [cwdInput, setCwd] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [log, setLog] = useState<LogItem[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [scores, setScores] = useState<Score[]>([]);
  const [showScores, setShowScores] = useState(false);
  const [error, setError] = useState("");
  const { screenToFlowPosition, fitView } = useReactFlow();

  // Pasta dos agentes: a escolhida no canvas ou, por padrão, a do daemon.
  const cwd = cwdInput || conn.hello?.cwd || "";
  const daemon: Daemon = useMemo(() => ({ ...conn, cwd }), [conn, cwd]);

  // Restaura o último canvas deste navegador.
  useEffect(() => {
    // Leitura única do armazenamento do navegador. Agentes salvos só reiniciam por clique
    // (ou reconectam se ainda estiverem rodando no daemon).
    /* eslint-disable react-hooks/set-state-in-effect */
    const saved = loadCanvas();
    if (saved) {
      setNodes(saved.nodes);
      setEdges(saved.edges);
      setCwd(saved.cwd ?? "");
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [setNodes, setEdges]);

  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(CANVAS_KEY, JSON.stringify({ nodes: persistable(nodes), edges, cwd }));
      } catch {
        /* sem armazenamento */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [nodes, edges, cwd, hydrated]);

  // Mantém o daemon sabendo quem está ligado a quem.
  const graph: Graph = useMemo(
    () => ({
      cwd,
      agents: nodes.filter((n) => n.type === "terminal").map((n) => {
        const d = n.data as TerminalData;
        return { id: n.id, name: d.name, role: d.role, kind: d.kind };
      }),
      notes: nodes.filter((n) => n.type === "note").map((n) => ({ id: n.id, title: (n.data as NoteData).title, content: (n.data as NoteData).content })),
      edges: edges.map((e) => [e.source, e.target] as [string, string]),
    }),
    [nodes, edges, cwd],
  );
  const graphJson = JSON.stringify(graph);
  useEffect(() => {
    if (conn.state === "open") conn.send({ type: "graph", graph: JSON.parse(graphJson) as Graph });
  }, [graphJson, conn.state, conn.send, conn]);

  const nameOf = useCallback(
    (id: string) => (id === "user" ? "Você" : ((nodes.find((n) => n.id === id)?.data as TerminalData | undefined)?.name ?? id)),
    [nodes],
  );

  const pulse = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, pulse: true } } : n)));
      setTimeout(() => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, pulse: false } } : n))), 2500);
    },
    [setNodes],
  );

  // Eventos do daemon: mensagens entre agentes, notas e partituras.
  useEffect(
    () =>
      conn.on((m: ServerMsg) => {
        if (m.type === "message") {
          setLog((l) => [...l.slice(-199), { at: Date.now(), from: m.from, to: m.to, text: m.text }]);
          pulse(m.to);
          const label = m.text.length > 60 ? m.text.slice(0, 60) + "…" : m.text;
          setEdges((es) =>
            es.map((e) =>
              (e.source === m.from && e.target === m.to) || (e.source === m.to && e.target === m.from)
                ? { ...e, label, style: { stroke: "#7c6cff", strokeWidth: 2.5 }, data: { ...e.data, at: Date.now() } }
                : e,
            ),
          );
          setTimeout(() => setEdges((es) => es.map((e) => (e.label === label ? { ...e, label: undefined, style: undefined } : e))), 5000);
        } else if (m.type === "note") {
          setNodes((ns) => {
            const existing = ns.find((n) => n.type === "note" && (n.id === m.id || (n.data as NoteData).title.toLowerCase() === m.title.toLowerCase()));
            const by = (ns.find((n) => n.id === m.by)?.data as TerminalData | undefined)?.name ?? m.by;
            if (existing) return ns.map((n) => (n === existing ? { ...n, data: { ...n.data, content: m.content, by } } : n));
            const author = ns.find((n) => n.id === m.by);
            const position = author ? { x: author.position.x, y: author.position.y - 240 } : { x: 0, y: -240 };
            const note: Node = { id: m.id ?? uid("note"), type: "note", position, width: 300, height: 200, data: { title: m.title, content: m.content, color: NOTE_COLORS[0], by } };
            if (author) setEdges((es) => [...es, { id: uid("e"), source: author.id, target: note.id, style: { strokeDasharray: "4 4" } }]);
            return [...ns, note];
          });
        } else if (m.type === "scores") {
          setScores(m.scores);
        } else if (m.type === "error") {
          setError(m.message);
          setTimeout(() => setError(""), 6000);
        }
      }),
    [conn, pulse, setEdges, setNodes],
  );

  const onConnect = useCallback((c: RFConnection) => setEdges((es) => addEdge({ ...c, animated: true }, es)), [setEdges]);

  function center() {
    return screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  /** Ao lado do terminal mais à direita (ou no centro da tela), sem sobrepor. */
  function freeSpot() {
    const terms = nodes.filter((n) => n.type === "terminal");
    if (!terms.length) {
      const c = center();
      return { x: c.x - 280, y: c.y - 180 };
    }
    const last = terms.reduce((a, b) => (b.position.x + (b.width ?? 560) > a.position.x + (a.width ?? 560) ? b : a));
    return { x: last.position.x + (last.width ?? 560) + 80, y: last.position.y };
  }

  function addAgent(kind: AgentKind, at?: { x: number; y: number }, extra?: Partial<TerminalData>) {
    const count = nodes.filter((n) => n.type === "terminal" && (n.data as TerminalData).kind === kind).length + 1;
    const base = kind === "claude" ? "Claude" : kind === "codex" ? "Codex" : "Terminal";
    const node: Node = {
      id: uid("agent"),
      type: "terminal",
      position: at ?? freeSpot(),
      width: 560,
      height: 360,
      data: { name: `${base}-${count}`, role: "", kind, autostart: true, ...extra } satisfies TerminalData,
    };
    setNodes((ns) => [...ns, node]);
    return node;
  }

  function addNote() {
    const p = center();
    setNodes((ns) => [...ns, { id: uid("note"), type: "note", position: { x: p.x - 150, y: p.y - 100 }, width: 300, height: 200, data: { title: "Nota", content: "", color: NOTE_COLORS[ns.length % NOTE_COLORS.length] } }]);
  }

  /** Monta o trio Criador → Validador → Aprovador com Claude Code, já ligado. */
  function addTrio() {
    // Abaixo de tudo que já está no canvas, para não cobrir ninguém.
    const c = center();
    const bottom = nodes.length ? Math.max(...nodes.map((n) => n.position.y + (n.height ?? 360))) + 100 : c.y - 180;
    const p = { x: c.x, y: bottom + 180 };
    const roles = [
      ["Criador", "Você implementa a tarefa no repositório. Quando terminar, envie um resumo do que mudou para o Validador e peça a revisão."],
      ["Validador", "Você revisa o trabalho do Criador: lê os arquivos alterados, roda testes/build, aponta bugs. Se houver problemas, devolva ao Criador; se estiver bom, envie ao Aprovador."],
      ["Aprovador", "Você dá a palavra final: confere se a tarefa original foi atendida. Aprovado: registre na nota 'Entrega'. Reprovado: diga ao Criador exatamente o que falta."],
    ];
    const created = roles.map(([name, role], i) => addAgent("claude", { x: p.x - 900 + i * 620, y: p.y - 180 }, { name, role }));
    setEdges((es) => [
      ...es,
      { id: uid("e"), source: created[0].id, target: created[1].id, animated: true },
      { id: uid("e"), source: created[1].id, target: created[2].id, animated: true },
      { id: uid("e"), source: created[2].id, target: created[0].id, animated: true },
    ]);
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 100);
  }

  function loadScore(s: Score) {
    if (!confirm(`Carregar a partitura "${s.name}"? Os terminais atuais serão fechados.`)) return;
    for (const n of nodes) if (n.type === "terminal") conn.send({ type: "kill", id: n.id });
    const canvas = s.canvas as Canvas;
    // Gera ids novos para não colidir com terminais antigos e inicia os agentes.
    const map = new Map<string, string>();
    const ns = canvas.nodes.map((n) => {
      const id = uid(n.type === "terminal" ? "agent" : "note");
      map.set(n.id, id);
      return { ...n, id, data: n.type === "terminal" ? { ...n.data, autostart: true } : n.data };
    });
    setNodes(ns);
    setEdges(canvas.edges.map((e) => ({ ...e, id: uid("e"), source: map.get(e.source) ?? e.source, target: map.get(e.target) ?? e.target })));
    if (canvas.cwd) setCwd(canvas.cwd);
    setShowScores(false);
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 100);
  }

  if (!conn.token || (conn.state !== "open" && !conn.hello)) {
    return <ConnectScreen conn={conn} />;
  }

  const agents = nodes.filter((n) => n.type === "terminal");

  return (
    <DaemonContext.Provider value={daemon}>
      <div className="relative h-[calc(100vh-53px)] md:h-screen">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          deleteKeyCode={["Delete"]}
          minZoom={0.1}
          maxZoom={2}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2a2f3c" />
          <Controls position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" className="hidden lg:block" nodeColor={(n) => (n.type === "terminal" ? AGENT_KINDS[(n.data as TerminalData).kind].color : (n.data as NoteData).color)} />
        </ReactFlow>

        {/* Barra superior */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-2 p-3">
          <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-line bg-panel/95 p-1 shadow-xl backdrop-blur">
            {(Object.keys(AGENT_KINDS) as AgentKind[]).map((k) => (
              <Button
                key={k}
                variant="ghost"
                className="px-2.5 py-1.5 text-xs"
                disabled={!conn.available[k]}
                title={conn.available[k] ? `Novo ${AGENT_KINDS[k].label}` : `${AGENT_KINDS[k].label} não está instalado nesta máquina`}
                onClick={() => addAgent(k)}
              >
                {k === "shell" ? <TerminalIcon className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" style={{ color: AGENT_KINDS[k].color }} />}
                {AGENT_KINDS[k].label}
              </Button>
            ))}
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={addNote}><StickyNote className="h-3.5 w-3.5" /> Nota</Button>
            <div className="mx-1 h-5 w-px bg-line" />
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={addTrio} disabled={!conn.available.claude} title="Criador → Validador → Aprovador com Claude Code">
              <Users className="h-3.5 w-3.5" /> Trio
            </Button>
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => { conn.send({ type: "scores:list" }); setShowScores(true); }}>
              <BookMarked className="h-3.5 w-3.5" /> Partituras
            </Button>
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setShowLog((v) => !v)}>
              <MessagesSquare className="h-3.5 w-3.5" /> Conversas{log.length ? ` (${log.length})` : ""}
            </Button>
          </div>
          <label className="pointer-events-auto flex min-w-0 max-w-md flex-1 items-center gap-2 rounded-xl border border-line bg-panel/95 px-3 py-1.5 text-xs shadow-xl backdrop-blur" title="Pasta onde os novos agentes abrem">
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" />
            <input className="min-w-0 flex-1 bg-transparent font-mono outline-none" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/caminho/do/projeto" />
          </label>
          <span className={`pointer-events-auto ml-auto rounded-full px-2.5 py-1 text-[11px] ${conn.state === "open" ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>
            {conn.state === "open" ? "daemon conectado" : "reconectando..."}
          </span>
        </div>

        {error && <div className="absolute left-1/2 top-16 -translate-x-1/2 rounded-lg bg-bad/90 px-4 py-2 text-xs text-white shadow-xl">{error}</div>}

        {agents.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="max-w-md text-center text-sm text-muted">
              <p className="text-base text-fg">Sua orquestra está vazia</p>
              <p className="mt-2">Adicione agentes pela barra de cima ou clique em <b>Trio</b>. Arraste da bolinha lateral de um terminal até outro para que eles possam conversar.</p>
            </div>
          </div>
        )}

        <Composer agents={agents} send={conn.send} />

        {showLog && (
          <div className="absolute bottom-24 right-3 top-16 z-10 flex w-80 flex-col rounded-xl border border-line bg-panel/95 shadow-2xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-line px-3 py-2 text-sm font-medium">
              Conversas entre agentes
              <button onClick={() => setShowLog(false)} aria-label="Fechar"><X className="h-4 w-4 text-muted" /></button>
            </div>
            <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-3">
              {log.length === 0 && <p className="text-xs text-muted">Quando um agente mandar mensagem para outro, aparece aqui.</p>}
              {log.map((l, i) => (
                <div key={i} className="rounded-lg bg-panel-2 p-2 text-xs">
                  <div className="mb-1 text-[10px] text-muted">{nameOf(l.from)} → {nameOf(l.to)} · {new Date(l.at).toLocaleTimeString("pt-BR")}</div>
                  <div className="line-clamp-6 whitespace-pre-wrap">{l.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {showScores && (
          <ScoresModal
            scores={scores}
            onClose={() => setShowScores(false)}
            onSave={(name) => conn.send({ type: "scores:save", name, canvas: { nodes: persistable(nodes), edges, cwd } })}
            onLoad={loadScore}
            onDelete={(name) => conn.send({ type: "scores:delete", name })}
          />
        )}
      </div>
    </DaemonContext.Provider>
  );
}

/** Caixa de mensagem com @menção: "@Criador implemente X" digita no terminal do Criador. */
function Composer({ agents, send }: { agents: Node[]; send: Daemon["send"] }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const names = agents.map((a) => ({ id: a.id, name: (a.data as TerminalData).name, kind: (a.data as TerminalData).kind }));
  const suggestions = query === null ? [] : names.filter((n) => n.name.toLowerCase().startsWith(query.toLowerCase()));
  const targets = names.filter((n) => new RegExp(`@${n.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text));

  function onChange(v: string) {
    setText(v);
    const caret = ref.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/@([\w-]*)$/);
    setQuery(m ? m[1] : null);
  }
  function pick(name: string) {
    const caret = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\w-]*)$/, `@${name} `);
    setText(before + text.slice(caret));
    setQuery(null);
    ref.current?.focus();
  }
  function submit() {
    if (!targets.length || !text.trim()) return;
    send({ type: "send", to: targets.map((t) => t.id), text: text.trim() });
    setText("");
  }

  if (!agents.length) return null;
  return (
    <div className="absolute bottom-4 left-1/2 z-10 w-[min(680px,calc(100%-2rem))] -translate-x-1/2">
      {suggestions.length > 0 && (
        <div className="mb-1 overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
          {suggestions.map((s) => (
            <button key={s.id} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-panel-2" onMouseDown={(e) => { e.preventDefault(); pick(s.name); }}>
              <span className="h-2 w-2 rounded-full" style={{ background: AGENT_KINDS[s.kind].color }} /> {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-line bg-panel/95 p-2 shadow-2xl backdrop-blur">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && suggestions[0]) { e.preventDefault(); pick(suggestions[0].name); }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="@Criador implemente a tela de login e peça revisão ao @Validador..."
          className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted/60"
        />
        <span className="hidden pb-2 text-[11px] text-muted sm:block">{targets.length ? `→ ${targets.map((t) => t.name).join(", ")}` : "use @ para escolher"}</span>
        <Button className="px-3 py-2" onClick={submit} disabled={!targets.length || !text.trim()} aria-label="Enviar"><Send className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function ScoresModal({ scores, onClose, onSave, onLoad, onDelete }: { scores: Score[]; onClose: () => void; onSave: (n: string) => void; onLoad: (s: Score) => void; onDelete: (n: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-medium">Partituras</h3>
          <button onClick={onClose} aria-label="Fechar"><X className="h-4 w-4 text-muted" /></button>
        </div>
        <p className="mb-4 text-xs text-muted">Salve a formação atual (agentes, papéis, notas e ligações) para reusar em outros projetos. Ficam em ~/.agentflow/partituras.</p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onSave(name.trim()); setName(""); } }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Trio de revisão" />
          <Button>Salvar</Button>
        </form>
        <div className="scroll-thin mt-4 max-h-72 space-y-2 overflow-y-auto">
          {scores.length === 0 && <p className="text-xs text-muted">Nenhuma partitura salva.</p>}
          {scores.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-2 rounded-lg bg-panel-2 px-3 py-2">
              <button className="min-w-0 flex-1 text-left" onClick={() => onLoad(s)}>
                <div className="truncate text-sm">{s.name}</div>
                <div className="text-[11px] text-muted">{((s.canvas as Canvas).nodes ?? []).filter((n) => n.type === "terminal").length} agentes · {new Date(s.savedAt).toLocaleString("pt-BR")}</div>
              </button>
              <button className="text-muted hover:text-bad" onClick={() => onDelete(s.name)} aria-label="Apagar"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Orquestra() {
  return (
    <ReactFlowProvider>
      <Stage />
    </ReactFlowProvider>
  );
}
