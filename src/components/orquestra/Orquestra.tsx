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
  type NodeChange,
} from "@xyflow/react";
import { Bell, BookMarked, Clock, Crown, FileText, FolderOpen, HeartPulse, MessagesSquare, Music, Plus, Radar, Send, StickyNote, Terminal as TerminalIcon, Trash2, Users, X } from "lucide-react";
import { AGENT_KINDS, type AfSystem, type AgentInfo, type AgentKind, type Graph, type ReportMeta, type Routine, type Score, type ServerMsg } from "@/lib/orquestra/protocol";
import { AF_ORQUESTRA, type Formation } from "@/lib/orquestra/presets/af-orquestra";
import { SUSTENTACAO_24H } from "@/lib/orquestra/presets/sustentacao-24h";
import { Button, Input } from "../ui";
import { DaemonContext, useDaemonConnection, type Daemon } from "./daemon";
import TerminalNode, { cleanName, type TerminalData } from "./TerminalNode";
import NoteNode, { NOTE_COLORS, type NoteData } from "./NoteNode";
import ConnectScreen from "./ConnectScreen";
import UsageRings from "./UsageRings";
import RoutinesPanel from "./RoutinesPanel";
import ConnectionEdge from "./ConnectionEdge";
import AlwaysFitPanel, { SEVERITY } from "./AlwaysFitPanel";

const nodeTypes = { terminal: TerminalNode, note: NoteNode };
// Substitui a aresta padrão: todas as ligações ganham rótulo da mensagem e o botão de remover.
const edgeTypes = { default: ConnectionEdge };
/** Relatórios criados até este instante já foram vistos (o resto conta como novo). */
const REPORTS_SEEN_KEY = "orquestra:reports-seen";
const CANVAS_KEY = "orquestra:canvas";
const NODE_W = 560;
const NODE_H = 400;
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
  /** Relatório salvo por um agente (a linha do tempo abre o painel Always Fit). */
  report?: ReportMeta;
}
interface Toast {
  id: string;
  from: string;
  title: string;
  text: string;
  urgent: boolean;
  /** Toast de relatório: mostra o botão que abre o painel Always Fit. */
  report?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

const systemsOf = (v: unknown) => {
  const list = Array.isArray(v) ? [...new Set(v.filter((x): x is AfSystem => x === "db" || x === "repos"))] : [];
  return list.length ? list : undefined;
};

/**
 * Canvas salvo (localStorage ou partitura) vem de versões antigas ou de arquivo editado à mão:
 * garante os campos que os nós usam e nomes únicos (as @menções e o Maestro dependem disso).
 */
function normalizeCanvas(raw: unknown): Canvas | null {
  if (!isObj(raw) || !Array.isArray(raw.nodes)) return null;
  const taken = new Set<string>();
  const nodes: Node[] = [];
  let maestro = false;
  for (const n of raw.nodes) {
    if (!isObj(n) || typeof n.id !== "string" || (n.type !== "terminal" && n.type !== "note")) continue;
    const d = isObj(n.data) ? n.data : {};
    const p = isObj(n.position) ? n.position : {};
    const position = { x: Number(p.x) || 0, y: Number(p.y) || 0 };
    const size = { width: Number(n.width) || undefined, height: Number(n.height) || undefined };
    if (n.type === "terminal") {
      const kind = (str(d.kind) in AGENT_KINDS ? d.kind : "shell") as AgentKind;
      let name = cleanName(str(d.name)) || AGENT_KINDS[kind].label.split(" ")[0];
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${cleanName(str(d.name)) || "Agente"}-${i}`;
      taken.add(name.toLowerCase());
      // Um só Maestro por canvas.
      const isMaestro: boolean = d.maestro === true && kind === "claude" && !maestro;
      maestro ||= isMaestro;
      nodes.push({ id: n.id, type: "terminal", position, ...size, data: { ...d, name, role: str(d.role), kind, maestro: isMaestro, systems: systemsOf(d.systems) } satisfies TerminalData });
    } else {
      nodes.push({ id: n.id, type: "note", position, ...size, data: { ...d, title: str(d.title, "Nota"), content: str(d.content), color: str(d.color, NOTE_COLORS[0]) } satisfies NoteData });
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter(
    (e): e is Edge => isObj(e) && typeof e.id === "string" && ids.has(e.source as string) && ids.has(e.target as string),
  );
  return { nodes, edges, cwd: str(raw.cwd) };
}

function loadCanvas(): Canvas | null {
  try {
    const raw = localStorage.getItem(CANVAS_KEY);
    return raw ? normalizeCanvas(JSON.parse(raw)) : null;
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

const agentData = (a: AgentInfo): TerminalData => ({ name: a.name, role: a.role, kind: a.kind, prompt: a.prompt, deny: a.deny, allow: a.allow, maestro: a.maestro, systems: a.systems });
const sameEdge = (e: Edge, a: string, b: string) => (e.source === a && e.target === b) || (e.source === b && e.target === a);

const overlaps = (n: Node, x: number, y: number, w: number, h: number) =>
  x < n.position.x + (n.width ?? NODE_W) && x + w > n.position.x && y < n.position.y + (n.height ?? NODE_H) && y + h > n.position.y;

/** O ponto pedido se estiver livre; senão, logo acima de tudo o que ele cobriria. */
function freeNoteSpot(nodes: Node[], at: { x: number; y: number }, w = 300, h = 200) {
  const hit = nodes.filter((n) => overlaps(n, at.x, at.y, w, h));
  if (!hit.length) return at;
  const top = Math.min(...hit.map((n) => n.position.y));
  const y = top - h - 40;
  return nodes.some((n) => overlaps(n, at.x, y, w, h)) ? rowSpot(nodes, at.x, y) : { x: at.x, y };
}

/** Primeira posição livre numa linha (y), começando em x e indo para a direita. */
function rowSpot(nodes: Node[], x: number, y: number) {
  const row = nodes.filter((n) => Math.abs(n.position.y - y) < NODE_H / 2);
  const right = row.length ? Math.max(...row.map((n) => n.position.x + (n.width ?? NODE_W))) + 60 : x;
  return { x: Math.max(x, right), y };
}

function notifyBrowser(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) new Notification(title, { body });
  } catch {
    /* sem suporte */
  }
}
function askNotificationPermission() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* sem suporte */
  }
}

function Stage() {
  const conn = useDaemonConnection();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [cwdInput, setCwd] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [log, setLog] = useState<LogItem[]>([]);
  const [panel, setPanel] = useState<"log" | "routines" | "alwaysfit" | null>(null);
  // Não lidos: criados depois do último "visto" e ainda não abertos (por navegador).
  const [seenAt, setSeenAt] = useState("");
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  const [scores, setScores] = useState<Score[]>([]);
  const [showScores, setShowScores] = useState(false);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState("");
  const { screenToFlowPosition, fitView } = useReactFlow();
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // Timers de destaque/aviso: um por chave (o novo cancela o anterior) e todos limpos ao sair.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const later = useCallback((key: string, ms: number, fn: () => void) => {
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => {
      timers.current.delete(key);
      fn();
    }, ms));
  }, []);
  useEffect(() => {
    const t = timers.current;
    return () => {
      t.forEach(clearTimeout);
      t.clear();
    };
  }, []);

  // Pasta dos agentes: a escolhida no canvas ou, por padrão, a do daemon.
  const cwd = cwdInput || conn.hello?.cwd || "";
  // Só o que os nós usam: arrastar um nó rerenderiza o Stage, mas não precisa rerenderizar todos os terminais.
  const { state: connState, statuses, exitCodes, send, onOutput, on } = conn;
  // Próxima rodada de cada agente (a rotina ativa mais cedo), para o contador no cabeçalho.
  const nextRuns = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of routines) {
      const k = r.agent.toLowerCase();
      if (r.enabled && (!out[k] || r.nextAt < out[k])) out[k] = r.nextAt;
    }
    return out;
  }, [routines]);
  const daemon: Daemon = useMemo(() => ({ state: connState, statuses, exitCodes, send, onOutput, cwd, nextRuns }), [connState, statuses, exitCodes, send, onOutput, cwd, nextRuns]);

  const flash = useCallback((msg: string) => {
    setError(msg);
    later("flash", 6000, () => setError(""));
  }, [later]);

  // ?painel=alwaysfit (link do menu lateral): abre o painel e tira só esse parâmetro da URL,
  // mantendo o resto da query e um #token= que venha junto (o daemon.tsx lê o hash).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    /* eslint-disable react-hooks/set-state-in-effect -- leitura única da URL e do armazenamento do navegador */
    if (q.get("painel") === "alwaysfit") {
      setPanel("alwaysfit");
      q.delete("painel");
      history.replaceState(history.state, "", location.pathname + (q.size ? `?${q}` : "") + location.hash);
    }
    let seen = "";
    try {
      seen = localStorage.getItem(REPORTS_SEEN_KEY) ?? "";
      // Primeira vez: o que já existe não é "novo".
      if (!seen) localStorage.setItem(REPORTS_SEEN_KEY, (seen = new Date().toISOString()));
    } catch {
      seen = new Date().toISOString();
    }
    setSeenAt(seen);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  const isUnread = useCallback((r: ReportMeta) => Boolean(seenAt) && r.createdAt > seenAt && !readIds.has(r.id), [seenAt, readIds]);
  const unreadReports = conn.reports.filter(isUnread).length;
  const markAllRead = () => {
    const now = new Date().toISOString();
    try {
      localStorage.setItem(REPORTS_SEEN_KEY, now);
    } catch {
      /* sem armazenamento */
    }
    setSeenAt(now);
    setReadIds(new Set());
  };

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

  // Ao (re)conectar: traz para o canvas o que o Maestro fez enquanto o navegador estava fechado.
  // Até isso acontecer o canvas não manda o grafo: senão o grafo velho do navegador chegaria
  // primeiro e o daemon descartaria os agentes que o Maestro criou nesse meio tempo.
  const hello = conn.hello;
  const [syncedHello, setSyncedHello] = useState<typeof hello>(null);
  useEffect(() => {
    if (!hydrated || !hello) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marca o hello como aplicado (libera o envio do grafo)
    setSyncedHello(hello);
    const live = hello.graph.agents.filter((a) => hello.terminals[a.id] && hello.terminals[a.id] !== "stopped");
    if (!live.length) return;
    const liveIds = new Set(live.map((a) => a.id));
    setNodes((ns) => {
      const out = ns.map((n) => {
        const a = live.find((x) => x.id === n.id);
        return a ? { ...n, data: { ...n.data, ...agentData(a) } } : n;
      });
      const bottom = out.length ? Math.max(...out.map((n) => n.position.y + (n.height ?? NODE_H))) + 120 : 0;
      for (const a of live) {
        if (out.some((n) => n.id === a.id)) continue;
        out.push({ id: a.id, type: "terminal", position: rowSpot(out, 0, bottom), width: NODE_W, height: NODE_H, data: agentData(a) });
      }
      return out;
    });
    setEdges((es) => {
      const daemonPairs = hello.graph.edges.filter(([a, b]) => liveIds.has(a) && liveIds.has(b));
      // Ligações entre agentes vivos seguem o daemon (o Maestro pode ter ligado/desligado).
      const kept = es.filter((e) => !(liveIds.has(e.source) && liveIds.has(e.target)) || daemonPairs.some(([a, b]) => sameEdge(e, a, b)));
      const added = daemonPairs.filter(([a, b]) => !kept.some((e) => sameEdge(e, a, b))).map(([a, b]) => ({ id: uid("e"), source: a, target: b, animated: true }));
      return [...kept, ...added];
    });
  }, [hydrated, hello, setNodes, setEdges]);

  // Mantém o daemon sabendo quem está ligado a quem. Com debounce: arrastar nó ou digitar
  // numa nota mudaria o grafo a cada quadro/tecla, e os prompts da Central AF são longos.
  const lastGraph = useRef("");
  const synced = connState === "open" && hydrated && syncedHello === hello && hello !== null;
  useEffect(() => {
    // Conexão nova: o daemon precisa receber o grafo mesmo que não tenha mudado.
    if (!synced) lastGraph.current = "";
  }, [synced]);
  useEffect(() => {
    if (!synced) return;
    const t = setTimeout(() => {
      const graph: Graph = {
        cwd,
        agents: nodes.filter((n) => n.type === "terminal").map((n) => {
          const d = n.data as TerminalData;
          // systems: o daemon só libera alwaysfit_sql/alwaysfit_repos a quem tem o sistema no grafo.
          return { id: n.id, name: d.name, role: d.role, kind: d.kind, prompt: d.prompt, deny: d.deny, allow: d.allow, maestro: d.maestro, systems: d.systems };
        }),
        notes: nodes.filter((n) => n.type === "note").map((n) => ({ id: n.id, title: (n.data as NoteData).title, content: (n.data as NoteData).content })),
        edges: edges.map((e) => [e.source, e.target] as [string, string]),
      };
      const json = JSON.stringify(graph);
      if (json !== lastGraph.current && send({ type: "graph", graph })) lastGraph.current = json;
    }, 150);
    return () => clearTimeout(t);
  }, [nodes, edges, cwd, synced, send]);

  const nameOf = useCallback(
    (id: string) => (id === "user" ? "Você" : id === "rotina" ? "Rotina" : ((nodes.find((n) => n.id === id)?.data as TerminalData | undefined)?.name ?? id)),
    [nodes],
  );

  // Duas mensagens seguidas: o timer da primeira não pode apagar o destaque da segunda.
  const pulse = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => (n.id === id && !n.data.pulse ? { ...n, data: { ...n.data, pulse: true } } : n)));
      later(`pulse:${id}`, 2500, () => setNodes((ns) => ns.map((n) => (n.id === id && n.data.pulse ? { ...n, data: { ...n.data, pulse: false } } : n))));
    },
    [setNodes, later],
  );

  // Eventos do daemon: mensagens entre agentes, notas, ações do Maestro, rotinas e avisos.
  useEffect(
    () =>
      on((m: ServerMsg) => {
        if (m.type === "message") {
          setLog((l) => [...l.slice(-199), { at: Date.now(), from: m.from, to: m.to, text: m.text }]);
          pulse(m.to);
          const label = m.text.length > 60 ? m.text.slice(0, 60) + "…" : m.text;
          // Marca de quem acendeu a aresta: só apaga se nenhuma mensagem mais nova chegou por ela
          // (comparar pelo texto apagava arestas com a mesma mensagem).
          const at = uid("m");
          setEdges((es) =>
            es.map((e) => (sameEdge(e, m.from, m.to) ? { ...e, label, style: { stroke: "#7c6cff", strokeWidth: 2.5 }, data: { ...e.data, at } } : e)),
          );
          later(`edge:${at}`, 5000, () => setEdges((es) => es.map((e) => (e.data?.at === at ? { ...e, label: undefined, style: undefined, data: { ...e.data, at: undefined } } : e))));
        } else if (m.type === "note") {
          setNodes((ns) => {
            const existing = ns.find((n) => n.type === "note" && (n.id === m.id || (n.data as NoteData).title.toLowerCase() === m.title.toLowerCase()));
            const by = (ns.find((n) => n.id === m.by)?.data as TerminalData | undefined)?.name ?? m.by;
            if (existing) return ns.map((n) => (n === existing ? { ...n, data: { ...n.data, content: m.content, by } } : n));
            const author = ns.find((n) => n.id === m.by);
            const position = author ? rowSpot(ns, author.position.x, author.position.y - 260) : { x: 0, y: -260 };
            const note: Node = { id: m.id ?? uid("note"), type: "note", position, width: 320, height: 220, data: { title: m.title, content: m.content, color: NOTE_COLORS[0], by } };
            if (author) setEdges((es) => [...es, { id: uid("e"), source: author.id, target: note.id, style: { strokeDasharray: "4 4" } }]);
            return [...ns, note];
          });
        } else if (m.type === "agent:add") {
          setNodes((ns) => {
            if (ns.some((n) => n.id === m.agent.id)) return ns;
            const by = ns.find((n) => n.id === m.by);
            const position = by ? rowSpot(ns, by.position.x, by.position.y + (by.height ?? NODE_H) + 120) : rowSpot(ns, 0, 0);
            return [...ns, { id: m.agent.id, type: "terminal", position, width: NODE_W, height: NODE_H, data: { ...agentData(m.agent), pulse: true } }];
          });
          setEdges((es) => [...es, ...m.edges.filter(([a, b]) => !es.some((e) => sameEdge(e, a, b))).map(([a, b]) => ({ id: uid("e"), source: a, target: b, animated: true }))]);
          later("fit", 150, () => void fitView({ padding: 0.15, duration: 400, maxZoom: 1 }));
          later(`pulse:${m.agent.id}`, 2500, () => setNodes((ns) => ns.map((n) => (n.id === m.agent.id ? { ...n, data: { ...n.data, pulse: false } } : n))));
        } else if (m.type === "agent:update") {
          setNodes((ns) => ns.map((n) => (n.id === m.id ? { ...n, data: { ...n.data, ...m.patch } } : n)));
        } else if (m.type === "agent:remove") {
          setNodes((ns) => ns.filter((n) => n.id !== m.id));
          setEdges((es) => es.filter((e) => e.source !== m.id && e.target !== m.id));
        } else if (m.type === "edges") {
          setEdges((es) => [
            ...es.filter((e) => !m.remove.some(([a, b]) => sameEdge(e, a, b))),
            ...m.add.filter(([a, b]) => !es.some((e) => sameEdge(e, a, b))).map(([a, b]) => ({ id: uid("e"), source: a, target: b, animated: true })),
          ]);
        } else if (m.type === "notify") {
          // Relatório crítico: o daemon também notifica ("Relatório <id>"), mas o toast do report:new já cobre.
          if (m.urgent && /^Relatório \S+$/.test(m.text)) {
            notifyBrowser(`${m.from}: ${m.title}`, m.text);
            return;
          }
          const from = (nodesRef.current.find((n) => n.id === m.from)?.data as TerminalData | undefined)?.name ?? m.from;
          const toast = { id: uid("t"), from, title: m.title, text: m.text, urgent: m.urgent };
          setToasts((ts) => [...ts.slice(-4), toast]);
          if (!m.urgent) later(`toast:${toast.id}`, 10_000, () => setToasts((ts) => ts.filter((t) => t.id !== toast.id)));
          notifyBrowser(`${from}: ${m.title}`, m.text);
        } else if (m.type === "report:new") {
          const r = m.report;
          setLog((l) => [...l.slice(-199), { at: Date.now(), from: r.agent, to: "", text: r.title, report: r }]);
          // Crítico vira aviso vermelho que fica até você fechar (o daemon também notifica o macOS).
          if (r.severity === "critico") {
            setToasts((ts) => [...ts.slice(-4), { id: uid("t"), from: r.agent, title: `Relatório crítico: ${r.title}`, text: "Salvo no painel Always Fit.", urgent: true, report: true }]);
          }
        } else if (m.type === "routines") {
          setRoutines(m.routines);
        } else if (m.type === "scores") {
          setScores(m.scores);
        } else if (m.type === "error") {
          flash(m.message);
        }
      }),
    [on, pulse, setEdges, setNodes, flash, fitView, later],
  );

  // Apagar um nó (tecla Delete inclusive) também encerra o terminal dele.
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      for (const c of changes) {
        if (c.type === "remove" && nodesRef.current.find((n) => n.id === c.id)?.type === "terminal") send({ type: "kill", id: c.id });
      }
      onNodesChange(changes);
    },
    [send, onNodesChange],
  );

  // Fechar (botão X ou Delete) um agente rodando perde o que ele está fazendo: pergunta antes.
  const onBeforeDelete = useCallback(
    async ({ nodes: gone, edges: goneEdges }: { nodes: Node[]; edges: Edge[] }) => {
      const live = gone.filter((n) => n.type === "terminal" && (statuses[n.id] === "running" || statuses[n.id] === "queued"));
      if (!live.length) return { nodes: gone, edges: goneEdges };
      const who = live.map((n) => (n.data as TerminalData).name).join(", ");
      return confirm(live.length > 1 ? `Fechar ${who}? Os terminais serão encerrados.` : `Fechar ${who}? O terminal será encerrado.`) ? { nodes: gone, edges: goneEdges } : false;
    },
    [statuses],
  );

  // Esc fecha o modal/painel aberto, menos quando você está num terminal (lá o Esc é do agente).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.(".xterm")) return;
      if (showScores) setShowScores(false);
      else if (panel) setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showScores, panel]);

  const onConnect = useCallback((c: RFConnection) => setEdges((es) => addEdge({ ...c, animated: true }, es)), [setEdges]);

  function center() {
    return screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  /** Ao lado do terminal mais à direita (ou no centro da tela), sem sobrepor. */
  function freeSpot() {
    const terms = nodes.filter((n) => n.type === "terminal");
    if (!terms.length) {
      const c = center();
      return { x: c.x - NODE_W / 2, y: c.y - NODE_H / 2 };
    }
    const last = terms.reduce((a, b) => (b.position.x + (b.width ?? NODE_W) > a.position.x + (a.width ?? NODE_W) ? b : a));
    return { x: last.position.x + (last.width ?? NODE_W) + 80, y: last.position.y };
  }

  const names = () => new Set(nodes.filter((n) => n.type === "terminal").map((n) => (n.data as TerminalData).name.toLowerCase()));
  const uniqueName = (base: string, taken = names()) => {
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`;
  };

  function addAgent(kind: AgentKind, at?: { x: number; y: number }, extra?: Partial<TerminalData>) {
    const base = kind === "claude" ? "Claude" : kind === "codex" ? "Codex" : "Terminal";
    const node: Node = {
      id: uid("agent"),
      type: "terminal",
      position: at ?? freeSpot(),
      width: NODE_W,
      height: NODE_H,
      data: { role: "", kind, autostart: true, ...extra, name: uniqueName(extra?.name ?? base) } satisfies TerminalData,
    };
    setNodes((ns) => [...ns, node]);
    return node;
  }

  const hasMaestro = nodes.some((n) => n.type === "terminal" && (n.data as TerminalData).maestro);

  /** Modo Maestro: um Claude Code que vê e comanda todos os agentes do canvas. */
  function addMaestro() {
    if (hasMaestro) return flash("Já existe um Maestro no canvas.");
    askNotificationPermission();
    addAgent("claude", undefined, { name: "Maestro", role: "orquestra os agentes: quebra o pedido, delega, acompanha e entrega", maestro: true });
  }

  function addNote() {
    const p = center();
    // No centro da tela, mas sem cobrir um terminal (senão a nota fica escondida atrás dele ao clicar).
    setNodes((ns) => [...ns, { id: uid("note"), type: "note", position: freeNoteSpot(ns, { x: p.x - 150, y: p.y - 100 }), width: 300, height: 200, data: { title: "Nota", content: "", color: NOTE_COLORS[ns.length % NOTE_COLORS.length] } }]);
  }

  /** Monta o trio Criador → Validador → Aprovador com Claude Code, já ligado. */
  function addTrio() {
    // Abaixo de tudo que já está no canvas, para não cobrir ninguém.
    const c = center();
    const bottom = nodes.length ? Math.max(...nodes.map((n) => n.position.y + (n.height ?? NODE_H))) + 100 : c.y - 180;
    const p = { x: c.x, y: bottom + 180 };
    const roles = [
      ["Criador", "Você implementa a tarefa no repositório. Quando terminar, envie um resumo do que mudou para o Validador e peça a revisão."],
      ["Validador", "Você revisa o trabalho do Criador: lê os arquivos alterados, roda testes/build, aponta bugs. Se houver problemas, devolva ao Criador; se estiver bom, envie ao Aprovador."],
      ["Aprovador", "Você dá a palavra final: confere se a tarefa original foi atendida. Aprovado: registre na nota 'Entrega'. Reprovado: diga ao Criador exatamente o que falta."],
    ];
    // Segundo trio no canvas: o mesmo sufixo para os três, e os papéis apontam para os colegas
    // deste trio (sem isso o "Criador-2" mandaria a revisão para o "Validador" do primeiro).
    const taken = names();
    let suffix = "";
    for (let i = 2; roles.some(([name]) => taken.has(`${name}${suffix}`.toLowerCase())); i++) suffix = `-${i}`;
    const created = roles.map(([name, role], i) =>
      addAgent("claude", { x: p.x - 900 + i * 620, y: p.y - 180 }, {
        name: `${name}${suffix}`,
        role: suffix ? role.replace(/\b(Criador|Validador|Aprovador)\b/g, `$1${suffix}`) : role,
      }),
    );
    setEdges((es) => [
      ...es,
      { id: uid("e"), source: created[0].id, target: created[1].id, animated: true },
      { id: uid("e"), source: created[1].id, target: created[2].id, animated: true },
      { id: uid("e"), source: created[2].id, target: created[0].id, animated: true },
    ]);
    later("fit", 100, () => void fitView({ padding: 0.15, duration: 400 }));
  }

  /** Monta uma formação pronta (Central AF, Sustentação 24h): Maestro ligado aos subagentes, já iniciando. */
  function addFormation(f: Formation) {
    if (f.agents.some((a) => a.maestro) && hasMaestro) return flash(`Já existe um Maestro no canvas. Remova-o antes de montar a ${f.name}.`);
    const taken = names();
    const clash = f.agents.find((a) => taken.has(a.name.toLowerCase()));
    if (clash) return flash(`Já existe um agente chamado "${clash.name}".`);
    // Vários Claude Code de uma vez consomem limite do plano: só com confirmação.
    if (!confirm(`Montar a ${f.name}? Isso inicia ${f.agents.length} Claude Code em ${cwd || "pasta do daemon"}.\n\n${f.summary}`)) return;
    askNotificationPermission();
    const c = center();
    const bottom = nodes.length ? Math.max(...nodes.map((n) => n.position.y + (n.height ?? NODE_H))) + 120 : c.y - 600;
    const origin = { x: c.x - 1500, y: bottom };
    const ids = new Map<string, string>();
    const agentNodes: Node[] = f.agents.map((a) => {
      const id = uid("agent");
      ids.set(a.key, id);
      return {
        id,
        type: "terminal",
        position: { x: origin.x + a.at.x, y: origin.y + a.at.y },
        width: NODE_W,
        height: NODE_H,
        data: { name: a.name, role: a.role, prompt: a.prompt, deny: a.deny, allow: a.allow, maestro: a.maestro, systems: a.systems, kind: "claude", autostart: true } satisfies TerminalData,
      };
    });
    const noteNodes: Node[] = f.notes.map((n, i) => ({
      id: uid("note"),
      type: "note",
      position: { x: origin.x + n.at.x, y: origin.y + n.at.y },
      width: 520,
      height: NODE_H,
      data: { title: n.title, content: n.content, color: NOTE_COLORS[(i + 1) % NOTE_COLORS.length] },
    }));
    setNodes((ns) => [...ns, ...agentNodes, ...noteNodes]);
    setEdges((es) => [...es, ...f.edges.map(([a, b]) => ({ id: uid("e"), source: ids.get(a)!, target: ids.get(b)!, animated: true }))]);
    later("fit", 100, () => void fitView({ padding: 0.1, duration: 400 }));
  }
  const addCentralAF = () => addFormation(AF_ORQUESTRA);
  const addSustentacao = () => addFormation(SUSTENTACAO_24H);

  /** 24h: o daemon guarda a formação atual e a sobe sozinho sempre que iniciar. */
  function save24h() {
    const agentsNow = nodes.filter((n) => n.type === "terminal");
    if (!agentsNow.length) return flash("Monte a formação no canvas antes (ex.: Sustentação 24h).");
    const list = agentsNow.map((n) => (n.data as TerminalData).name).join(", ");
    const ok = confirm(
      `Manter esta formação rodando 24h?\n\nO daemon grava ${agentsNow.length} agentes (${list}), as ligações e as notas, e passa a subi-los sozinho sempre que iniciar, mesmo com este canvas fechado.\nDeixe o Mac ligado e sem dormir. Para parar, use "Desligar 24h".`,
    );
    if (!ok) return;
    if (!send({ type: "autostart:save", canvas: { nodes: persistable(nodes), edges, cwd } })) flash("Sem conexão com o daemon: a formação 24h não foi salva.");
  }

  function loadScore(s: Score) {
    const canvas = normalizeCanvas(s.canvas);
    if (!canvas) return flash(`A partitura "${s.name}" está corrompida ou num formato desconhecido.`);
    const live = nodes.filter((n) => n.type === "terminal").length;
    if (!confirm(`Carregar a partitura "${s.name}"?${live ? ` Os ${live} terminais atuais serão fechados.` : ""}`)) return;
    for (const n of nodes) if (n.type === "terminal") send({ type: "kill", id: n.id });
    // Gera ids novos para não colidir com terminais antigos e inicia os agentes.
    const map = new Map<string, string>();
    const ns = canvas.nodes.map((n) => {
      const id = uid(n.type === "terminal" ? "agent" : "note");
      map.set(n.id, id);
      return { ...n, id, data: n.type === "terminal" ? { ...n.data, autostart: true } : n.data };
    });
    setNodes(ns);
    setEdges(canvas.edges.map((e) => ({ ...e, id: uid("e"), source: map.get(e.source)!, target: map.get(e.target)! })));
    if (canvas.cwd) setCwd(canvas.cwd);
    setShowScores(false);
    later("fit", 100, () => void fitView({ padding: 0.15, duration: 400 }));
  }

  if (!conn.token || conn.state === "rejected" || (conn.state !== "open" && !conn.hello)) {
    // key: o token salvo só é lido depois do primeiro render; remonta para o campo mostrá-lo.
    return <ConnectScreen key={`${conn.token}|${conn.url}`} conn={conn} />;
  }

  const agents = nodes.filter((n) => n.type === "terminal");

  return (
    <DaemonContext.Provider value={daemon}>
      <div className="relative h-[calc(100vh-53px)] md:h-screen">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onBeforeDelete={onBeforeDelete}
          deleteKeyCode={["Delete"]}
          minZoom={0.1}
          maxZoom={2}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2a2f3c" />
          <Controls position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" className="hidden lg:block" bgColor="#0b0d12" maskColor="#7c6cff1a" maskStrokeColor="#7c6cff66" nodeColor={(n) => (n.type === "terminal" ? (AGENT_KINDS[(n.data as TerminalData).kind] ?? AGENT_KINDS.shell).color : (n.data as NoteData).color)} />
        </ReactFlow>

        {/* Barra superior */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-start gap-2 p-3">
          {/* Rótulos secundários (Trio, Partituras, Rotinas, Atividade) só em telas largas: os ícones têm title/aria-label. */}
          <div role="toolbar" aria-label="Orquestra" className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-line bg-panel/95 p-1 shadow-xl backdrop-blur">
            {(Object.keys(AGENT_KINDS) as AgentKind[]).map((k) => (
              <Button
                key={k}
                variant="ghost"
                className="px-2.5 py-1.5 text-xs"
                disabled={!conn.available[k]}
                title={conn.available[k] ? `Novo ${AGENT_KINDS[k].label}` : `${AGENT_KINDS[k].label} não está instalado nesta máquina`}
                onClick={() => addAgent(k)}
                aria-label={`Novo ${AGENT_KINDS[k].label}`}
              >
                {k === "shell" ? <TerminalIcon className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" style={{ color: AGENT_KINDS[k].color }} />}
                <span className="hidden sm:inline">{AGENT_KINDS[k].label}</span>
              </Button>
            ))}
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={addNote} aria-label="Nova nota"><StickyNote className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Nota</span></Button>
            <div className="mx-1 h-5 w-px bg-line" />
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={addMaestro} disabled={!conn.available.claude || hasMaestro} aria-label="Maestro" title="Um Claude Code que vê e comanda todos os agentes: cria, liga, delega, agenda rotinas">
              <Crown className="h-3.5 w-3.5 text-warn" /> <span className="hidden sm:inline">Maestro</span>
            </Button>
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={addTrio} disabled={!conn.available.claude} aria-label="Trio" title="Criador → Validador → Aprovador com Claude Code">
              <Users className="h-3.5 w-3.5" /> <span className="hidden min-[1800px]:inline">Trio</span>
            </Button>
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={addCentralAF} disabled={!conn.available.claude || hasMaestro} aria-label="Central AF" title={AF_ORQUESTRA.summary}>
              <Music className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Central AF</span>
            </Button>
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={addSustentacao} disabled={!conn.available.claude || hasMaestro} aria-label="Sustentação 24h" title={SUSTENTACAO_24H.summary}>
              <Radar className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Sustentação 24h</span>
            </Button>
            <div className="mx-1 h-5 w-px bg-line" />
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => { send({ type: "scores:list" }); setShowScores(true); }} aria-haspopup="dialog" aria-label="Partituras" title="Partituras">
              <BookMarked className="h-3.5 w-3.5" /> <span className="hidden min-[1800px]:inline">Partituras</span>
            </Button>
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setPanel((p) => (p === "routines" ? null : "routines"))} aria-expanded={panel === "routines"} aria-label="Rotinas" title="Rotinas">
              <Clock className="h-3.5 w-3.5" /> <span className="hidden min-[1800px]:inline">Rotinas</span>{routines.length ? ` (${routines.filter((r) => r.enabled).length})` : ""}
            </Button>
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setPanel((p) => (p === "log" ? null : "log"))} aria-expanded={panel === "log"} aria-label={`Atividade (${log.length})`} title="Linha do tempo: mensagens, rotinas e relatórios">
              <MessagesSquare className="h-3.5 w-3.5" /> <span className="hidden min-[1800px]:inline">Atividade</span>{log.length ? ` (${log.length})` : ""}
            </Button>
            <Button
              variant="ghost"
              className="relative px-2.5 py-1.5 text-xs"
              onClick={() => setPanel((p) => (p === "alwaysfit" ? null : "alwaysfit"))}
              aria-expanded={panel === "alwaysfit"}
              aria-label={`Always Fit${unreadReports ? ` (${unreadReports} relatórios novos)` : ""}`}
              title="Always Fit: sistemas, relatórios e 24h"
            >
              <HeartPulse className={`h-3.5 w-3.5 ${conn.autostart ? "text-ok" : ""}`} /> <span className="hidden sm:inline">Always Fit</span>
              {unreadReports > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 text-white">{unreadReports}</span>}
            </Button>
          </div>
          <label className="pointer-events-auto flex min-w-[min(16rem,100%)] max-w-md flex-1 items-center gap-2 rounded-xl border border-line bg-panel/95 px-3 py-1.5 text-xs shadow-xl backdrop-blur" title="Pasta onde os novos agentes abrem">
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" />
            <input aria-label="Pasta onde os novos agentes abrem" className="min-w-0 flex-1 bg-transparent font-mono outline-none" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/caminho/do/projeto" />
          </label>
          <div className="pointer-events-auto ml-auto"><UsageRings conn={conn} /></div>
          <span role="status" className={`pointer-events-auto whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] ${conn.state === "open" ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>
            {conn.state === "open" ? "daemon conectado" : "reconectando..."}
          </span>
        </div>

        {error && (
          <div role="alert" className="absolute left-1/2 top-16 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-bad/90 px-4 py-2 text-xs text-white shadow-xl">
            {error}
            <button onClick={() => setError("")} aria-label="Fechar aviso"><X className="h-3 w-3" /></button>
          </div>
        )}

        {toasts.length > 0 && (
          <div className="absolute left-3 top-16 z-30 flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-2">
            {toasts.map((t) => (
              <div key={t.id} role={t.urgent ? "alert" : "status"} className={`rounded-xl border bg-panel p-3 text-xs shadow-2xl ${t.urgent ? "border-bad" : "border-line"}`}>
                <div className="mb-1 flex items-center gap-2">
                  <Bell className={`h-3.5 w-3.5 ${t.urgent ? "text-bad" : "text-accent"}`} />
                  <span className="font-medium">{t.title}</span>
                  <button className="ml-auto text-muted hover:text-fg" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} aria-label="Fechar notificação"><X className="h-3 w-3" /></button>
                </div>
                <div className="whitespace-pre-wrap">{t.text}</div>
                {t.report && (
                  <button
                    className="mt-1.5 rounded border border-line px-2 py-0.5 text-[11px] hover:bg-panel-2"
                    onClick={() => {
                      setPanel("alwaysfit");
                      setToasts((ts) => ts.filter((x) => x.id !== t.id));
                    }}
                  >
                    Ler relatório
                  </button>
                )}
                <div className="mt-1 text-[10px] text-muted">{t.from}</div>
              </div>
            ))}
          </div>
        )}

        {agents.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto max-w-md rounded-xl border border-line bg-panel/90 p-5 text-center text-sm text-muted shadow-xl backdrop-blur">
              <p className="text-base text-fg">Sua orquestra está vazia</p>
              <p className="mt-2">
                Comece pelo <b>Maestro</b>: peça o que precisa e ele monta a equipe, delega e entrega. Ou adicione agentes pela barra de cima e arraste da bolinha lateral de um terminal até outro para que eles conversem.
              </p>
              {conn.available.claude ? (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button className="px-3 py-1.5 text-xs" onClick={addMaestro}><Crown className="h-3.5 w-3.5" /> Chamar o Maestro</Button>
                  <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={addCentralAF}><Music className="h-3.5 w-3.5" /> Montar a Central AF</Button>
                  <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={addSustentacao}><Radar className="h-3.5 w-3.5" /> Sustentação 24h</Button>
                </div>
              ) : (
                <p className="mt-3 text-xs text-warn">O Claude Code não foi encontrado nesta máquina: instale a CLI <code>claude</code> e reinicie o daemon para usar o Maestro.</p>
              )}
            </div>
          </div>
        )}

        <Composer agents={agents} statuses={statuses} send={send} onError={flash} />

        {panel === "log" && (
          <div className="absolute bottom-24 right-3 top-16 z-10 flex w-80 flex-col rounded-xl border border-line bg-panel/95 shadow-2xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-line px-3 py-2 text-sm font-medium">
              Atividade
              <button onClick={() => setPanel(null)} aria-label="Fechar atividade"><X className="h-4 w-4 text-muted" /></button>
            </div>
            <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-3">
              {log.length === 0 && <p className="text-xs text-muted">Mensagens entre agentes, rodadas das rotinas e relatórios aparecem aqui.</p>}
              {log.map((l, i) =>
                l.report ? (
                  <button key={i} className="flex w-full items-start gap-2 rounded-lg bg-panel-2 p-2 text-left text-xs hover:bg-panel" onClick={() => setPanel("alwaysfit")}>
                    <FileText className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${l.report.severity === "critico" ? "text-bad" : l.report.severity === "atencao" ? "text-warn" : "text-muted"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="mb-0.5 block text-[10px] text-muted">relatório de {l.report.agent} · {new Date(l.at).toLocaleTimeString("pt-BR")}</span>
                      <span className="block truncate">{l.text}</span>
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${SEVERITY[l.report.severity].className}`}>{SEVERITY[l.report.severity].label}</span>
                  </button>
                ) : (
                  <div key={i} className="rounded-lg bg-panel-2 p-2 text-xs">
                    <div className="mb-1 text-[10px] text-muted">{nameOf(l.from)} → {nameOf(l.to)} · {new Date(l.at).toLocaleTimeString("pt-BR")}</div>
                    <div className="line-clamp-6 whitespace-pre-wrap">{l.text}</div>
                  </div>
                ),
              )}
            </div>
          </div>
        )}

        {panel === "alwaysfit" && (
          <AlwaysFitPanel
            status={conn.alwaysfit}
            reports={conn.reports}
            unread={isUnread}
            autostart={conn.autostart}
            agentCount={agents.length}
            send={send}
            on={on}
            onRead={(id) => setReadIds((s) => new Set(s).add(id))}
            onReadAll={markAllRead}
            onSave24h={save24h}
            onClose={() => setPanel(null)}
          />
        )}

        {panel === "routines" && (
          <RoutinesPanel routines={routines} agentNames={agents.map((a) => (a.data as TerminalData).name)} send={send} onClose={() => setPanel(null)} />
        )}

        {showScores && (
          <ScoresModal
            scores={scores}
            onClose={() => setShowScores(false)}
            onSave={(name) => {
              if (scores.some((x) => x.name.toLowerCase() === name.toLowerCase()) && !confirm(`Já existe a partitura "${name}". Substituir?`)) return false;
              if (!send({ type: "scores:save", name, canvas: { nodes: persistable(nodes), edges, cwd } })) {
                flash("Sem conexão com o daemon: a partitura não foi salva.");
                return false;
              }
              return true;
            }}
            onLoad={loadScore}
            onDelete={(name) => confirm(`Apagar a partitura "${name}"?`) && send({ type: "scores:delete", name })}
          />
        )}
      </div>
    </DaemonContext.Provider>
  );
}

/** Letras (com acento), números, _ e -: o mesmo conjunto que cleanName aceita num nome. */
const NAME_CHARS = "[\\p{L}\\p{N}_-]";
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Caixa de mensagem: "@Criador implemente X" digita no terminal do Criador; sem @, vai para o Maestro. */
function Composer({ agents, statuses, send, onError }: { agents: Node[]; statuses: Daemon["statuses"]; send: Daemon["send"]; onError: (msg: string) => void }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const names = agents.map((a) => ({ id: a.id, name: (a.data as TerminalData).name, kind: (a.data as TerminalData).kind, maestro: Boolean((a.data as TerminalData).maestro) }));
  const maestro = names.find((n) => n.maestro);
  const suggestions = query === null ? [] : names.filter((n) => n.name.toLowerCase().startsWith(query.toLowerCase()));
  // "@Claude" não pode casar dentro de "@Claude-2" (nem "@José" virar "@Jos").
  const mentioned = names.filter((n) => new RegExp(`@${escapeRe(n.name)}(?!${NAME_CHARS})`, "iu").test(text));
  const targets = mentioned.length ? mentioned : maestro ? [maestro] : [];
  const sel = Math.min(active, Math.max(0, suggestions.length - 1));

  function onChange(v: string) {
    setText(v);
    const caret = ref.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(new RegExp(`@(${NAME_CHARS}*)$`, "u"));
    setQuery(m ? m[1] : null);
    setActive(0);
  }
  function pick(name: string) {
    const caret = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(new RegExp(`@(${NAME_CHARS}*)$`, "u"), `@${name} `);
    setText(before + text.slice(caret));
    setQuery(null);
    ref.current?.focus();
  }
  function submit() {
    if (!targets.length || !text.trim()) return;
    // Parado ou na fila não recebe: avisa em vez de a mensagem sumir.
    const off = targets.filter((t) => statuses[t.id] !== "running");
    const on = targets.filter((t) => statuses[t.id] === "running");
    if (!on.length) {
      onError(`${off.map((t) => t.name).join(", ")} não ${off.length > 1 ? "estão rodando" : "está rodando"}: inicie o terminal antes de mandar a mensagem.`);
      return;
    }
    if (!send({ type: "send", to: on.map((t) => t.id), text: text.trim() })) {
      onError("Sem conexão com o daemon: a mensagem não foi enviada (o texto continua na caixa).");
      return;
    }
    if (off.length) onError(`Não enviado para ${off.map((t) => t.name).join(", ")}: o terminal não está rodando.`);
    setText("");
    setQuery(null);
  }

  if (!agents.length) return null;
  return (
    <div className="absolute bottom-4 left-1/2 z-10 w-[min(680px,calc(100%-2rem))] -translate-x-1/2">
      {suggestions.length > 0 && (
        <div id="composer-mentions" role="listbox" aria-label="Agentes" className="mb-1 overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              role="option"
              aria-selected={i === sel}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-panel-2 ${i === sel ? "bg-panel-2" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pick(s.name); }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: (AGENT_KINDS[s.kind] ?? AGENT_KINDS.shell).color }} /> {s.name}
              {s.maestro && <Crown className="h-3 w-3 text-warn" />}
              {statuses[s.id] !== "running" && <span className="ml-auto text-[10px] text-muted">parado</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-line bg-panel/95 p-2 shadow-2xl backdrop-blur focus-within:border-accent/60">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Compondo com IME (acentos, japonês...): o Enter confirma o caractere, não envia.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (suggestions.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((sel + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pick(suggestions[sel].name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Mensagem para os agentes"
          aria-autocomplete="list"
          aria-controls={suggestions.length ? "composer-mentions" : undefined}
          placeholder={maestro ? `Peça ao ${maestro.name}... (ou use @ para falar direto com um agente)` : "@Criador implemente a tela de login e peça revisão ao @Validador..."}
          className="field-sizing-content max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted/60"
        />
        <span className="hidden pb-2 text-[11px] text-muted sm:block">{targets.length ? `→ ${targets.map((t) => t.name).join(", ")}` : "use @ para escolher"}</span>
        <Button className="px-3 py-2" onClick={submit} disabled={!targets.length || !text.trim()} aria-label="Enviar" title="Enviar (Enter) · nova linha: Shift+Enter"><Send className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function ScoresModal({ scores, onClose, onSave, onLoad, onDelete }: { scores: Score[]; onClose: () => void; onSave: (n: string) => boolean; onLoad: (s: Score) => void; onDelete: (n: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="scores-title" className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 id="scores-title" className="font-medium">Partituras</h3>
          <button onClick={onClose} aria-label="Fechar partituras"><X className="h-4 w-4 text-muted" /></button>
        </div>
        <p className="mb-4 text-xs text-muted">Salve a formação atual (agentes, papéis, notas e ligações) para reusar em outros projetos. Ficam em ~/.agentflow/partituras.</p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim() && onSave(name.trim())) setName(""); }}>
          {/* autoFocus: tira o foco do terminal, para o Esc fechar este modal e não ir para o agente. */}
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Trio de revisão" aria-label="Nome da partitura" maxLength={80} />
          <Button disabled={!name.trim()}>Salvar</Button>
        </form>
        <div className="scroll-thin mt-4 max-h-72 space-y-2 overflow-y-auto">
          {scores.length === 0 && <p className="text-xs text-muted">Nenhuma partitura salva.</p>}
          {scores.map((s) => {
            const nodes = isObj(s.canvas) && Array.isArray(s.canvas.nodes) ? (s.canvas.nodes as { type?: string }[]) : [];
            return (
              <div key={s.name} className="flex items-center justify-between gap-2 rounded-lg bg-panel-2 px-3 py-2">
                <button className="min-w-0 flex-1 text-left" onClick={() => onLoad(s)}>
                  <div className="truncate text-sm">{s.name}</div>
                  <div className="text-[11px] text-muted">{nodes.filter((n) => n?.type === "terminal").length} agentes · {new Date(s.savedAt).toLocaleString("pt-BR")}</div>
                </button>
                <button className="text-muted hover:text-bad" onClick={() => onDelete(s.name)} aria-label={`Apagar a partitura ${s.name}`}><Trash2 className="h-4 w-4" /></button>
              </div>
            );
          })}
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
