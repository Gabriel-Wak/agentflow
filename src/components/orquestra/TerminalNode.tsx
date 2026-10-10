"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Handle, NodeResizer, Position, useEdges, useNodes, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Clock, Crown, Database, FolderGit2, Hourglass, Link2, Play, RotateCw, ScrollText, ShieldBan, Square, X } from "lucide-react";
import { AGENT_KINDS, type AfSystem, type AgentKind } from "@/lib/orquestra/protocol";
import { useDaemon } from "./daemon";

export interface TerminalData {
  [key: string]: unknown;
  name: string;
  role: string;
  kind: AgentKind;
  /** Instruções longas somadas ao system prompt (ex.: prompt do Maestro). */
  prompt?: string;
  /** Ferramentas proibidas (Claude Code: --disallowed-tools). */
  deny?: string[];
  /** Ferramentas liberadas sem pedir permissão (Claude Code: --allowed-tools). */
  allow?: string[];
  /** Modo Maestro: comanda todos os agentes do canvas. */
  maestro?: boolean;
  /** Sistemas Always Fit que este agente pode usar (o daemon libera as ferramentas MCP). */
  systems?: AfSystem[];
  /** Inicia sozinho quando o nó aparece pela primeira vez. */
  autostart?: boolean;
  /** Destaque temporário quando chega mensagem. */
  pulse?: boolean;
}

/** Sem saída por este tempo, o agente rodando é considerado ocioso. */
const BUSY_MS = 1500;

export const AF_SYSTEMS: Record<AfSystem, { label: string; hint: string }> = {
  db: { label: "Banco Always Fit (leitura)", hint: "réplica de leitura MySQL, via alwaysfit_sql" },
  repos: { label: "Repositórios AlwaysFit", hint: "espelhos do GitHub, via alwaysfit_repos + Read/Grep" },
};
const SYSTEM_ICONS: Record<AfSystem, typeof Database> = { db: Database, repos: FolderGit2 };

/** "em 12 min", "em 1h05", "agora". */
function untilLabel(iso: string, now: number) {
  const min = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (min <= 0) return "agora";
  return min < 60 ? `em ${min} min` : `em ${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

/** Nome usado nas @menções: sem espaços e sem caracteres que quebram a menção. */
export const cleanName = (v: string) => v.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");

function TerminalNode({ id, data, selected }: NodeProps<Node<TerminalData>>) {
  const daemon = useDaemon();
  const { updateNodeData, deleteElements, getNodes } = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ cols: number; rows: number; reset: () => void } | null>(null);
  const [ready, setReady] = useState(false);
  // Sobreposição aberta no corpo do terminal (dentro do nó, que corta o que sai dele).
  const [overlay, setOverlay] = useState<"prompt" | "connect" | null>(null);
  const showPrompt = overlay === "prompt";
  const [busy, setBusy] = useState(false);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // Aviso curto no topo do nó; name: o problema é o nome digitado (campo fica vermelho).
  const [warning, setWarning] = useState<{ text: string; name?: boolean } | null>(null);
  const nameError = warning?.name ? warning.text : "";
  const status = daemon.statuses[id];
  const kind = AGENT_KINDS[data.kind] ?? AGENT_KINDS.shell;
  const running = status === "running";
  const queued = status === "queued";
  const exitCode = daemon.exitCodes[id];

  // Monta o xterm (só no navegador) e liga entrada/saída ao daemon.
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      // StrictMode monta, desmonta e monta de novo: o primeiro import resolve já descartado.
      if (disposed || !box.current) return;
      const term = new Terminal({
        // O xterm mede a fonte direto no canvas: precisa de nome real, não de variável CSS.
        fontFamily: "Menlo, Monaco, 'SF Mono', Consolas, monospace",
        fontSize: 12,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: { background: "#0b0d12", foreground: "#e7e9ee", cursor: kind.color, selectionBackground: "#7c6cff55" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(box.current);
      const handle = { cols: 0, rows: 0, reset: () => term.reset() };
      termRef.current = handle;
      const doFit = () => {
        try {
          fit.fit();
        } catch {
          return; // nó ainda sem tamanho
        }
        // O ResizeObserver dispara a cada pixel ao arrastar a borda: só avisa quando muda a grade.
        if (term.cols === handle.cols && term.rows === handle.rows) return;
        handle.cols = term.cols;
        handle.rows = term.rows;
        daemon.send({ type: "resize", id, cols: term.cols, rows: term.rows });
      };
      doFit();
      let frame = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(doFit);
      });
      ro.observe(box.current);
      const input = term.onData((d) => daemon.send({ type: "input", id, data: d }));
      let idle: ReturnType<typeof setTimeout> | undefined;
      const off = daemon.onOutput(id, (d, replay) => {
        // Replay do attach: a tela inteira de novo, então limpa antes para não duplicar.
        if (replay) term.reset();
        term.write(d);
        if (replay) return;
        setBusy(true);
        clearTimeout(idle);
        idle = setTimeout(() => setBusy(false), BUSY_MS);
      });
      cleanups.push(() => cancelAnimationFrame(frame), () => clearTimeout(idle), () => ro.disconnect(), () => input.dispose(), off, () => term.dispose(), () => {
        if (termRef.current === handle) termRef.current = null;
      });
      setReady(true);
    })();
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- o terminal vive enquanto o nó existir
  }, [id]);

  // Ao (re)conectar: reaproveita o terminal que já roda no daemon ou inicia um novo.
  useEffect(() => {
    if (!ready || daemon.state !== "open") return;
    if (status === "running" || status === "exited") {
      // O daemon reenvia o buffer inteiro: sem limpar, a saída apareceria duas vezes após reconectar.
      termRef.current?.reset();
      daemon.send({ type: "attach", id });
      const size = termRef.current;
      if (size?.cols) daemon.send({ type: "resize", id, cols: size.cols, rows: size.rows });
    } else if (data.autostart) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, daemon.state]);

  function start() {
    const size = termRef.current?.cols ? termRef.current : { cols: 100, rows: 28 };
    const sent = daemon.send({
      type: "spawn",
      id,
      cols: size.cols,
      rows: size.rows,
      cwd: daemon.cwd,
      agent: { id, name: data.name, role: data.role, kind: data.kind, prompt: data.prompt, deny: data.deny, allow: data.allow, maestro: data.maestro, systems: data.systems },
    });
    if (sent) updateNodeData(id, { autostart: false });
  }

  function commitName() {
    if (nameDraft === null) return;
    const next = cleanName(nameDraft);
    setNameDraft(null);
    if (!next) return setWarning({ text: "O nome não pode ficar vazio.", name: true });
    if (next === data.name) return setWarning(null);
    const taken = getNodes().some((n) => n.id !== id && n.type === "terminal" && String((n.data as TerminalData).name).toLowerCase() === next.toLowerCase());
    if (taken) return setWarning({ text: `Já existe um agente chamado "${next}".`, name: true });
    setWarning(null);
    updateNodeData(id, { name: next });
  }

  const pulsing = Boolean(data.pulse);
  const statusLabel = queued
    ? "na fila"
    : running
      ? busy ? "trabalhando" : "ocioso"
      : status === "exited"
        ? `encerrado${exitCode !== undefined ? ` (código ${exitCode})` : ""}`
        : status === "stopped" ? "parado" : "não iniciado";

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-[#0b0d12] shadow-2xl"
      style={{
        borderColor: selected || pulsing ? kind.color : data.maestro ? "#fbbf2499" : "var(--border)",
        boxShadow: pulsing ? `0 0 0 3px ${kind.color}55, 0 0 32px ${kind.color}66` : undefined,
      }}
    >
      <NodeResizer isVisible={selected} minWidth={360} minHeight={220} lineStyle={{ borderColor: "transparent" }} handleStyle={{ width: 10, height: 10, borderRadius: 3, background: kind.color, border: "none" }} />
      <Handle type="target" position={Position.Left} style={{ background: kind.color }} />
      <Handle type="source" position={Position.Right} style={{ background: kind.color }} />

      <div className="flex items-center gap-2 border-b border-line bg-panel px-2.5 py-1.5">
        <span
          role="img"
          aria-label={`Estado: ${statusLabel}`}
          title={statusLabel}
          className={`h-2 w-2 shrink-0 rounded-full ${running && busy ? "animate-pulse" : ""}`}
          style={{ background: running ? kind.color : queued ? "var(--warn)" : status === "exited" && exitCode ? "var(--bad)" : "#4b5263" }}
        />
        <input
          className={`nodrag w-28 min-w-0 rounded bg-transparent text-xs font-semibold outline-none focus-visible:ring-1 focus-visible:ring-accent ${nameError ? "text-bad" : ""}`}
          value={nameDraft ?? data.name}
          onChange={(e) => setNameDraft(e.target.value)}
          onFocus={() => setNameDraft(data.name)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setNameDraft(null);
              setWarning(null);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
          aria-label="Nome do agente"
          aria-invalid={Boolean(nameError)}
          title={nameError || "Nome (usado nas @menções)"}
        />
        <input
          className="nodrag min-w-0 flex-1 rounded bg-transparent text-[11px] text-muted outline-none placeholder:text-muted/50 focus-visible:ring-1 focus-visible:ring-accent"
          value={data.role ?? ""}
          placeholder="papel: ex. cria o código / revisa / aprova"
          onChange={(e) => updateNodeData(id, { role: e.target.value })}
          aria-label="Papel do agente"
          title="Papel do agente (vai nas instruções ao iniciar)"
        />
        {data.kind === "claude" && (
          <button
            className={`nodrag rounded p-1 ${data.maestro ? "text-warn" : "text-muted/50 hover:text-warn"}`}
            title={data.maestro ? "Maestro: vê e comanda todos os agentes. Clique para desligar (vale ao reiniciar)" : "Tornar Maestro (vale ao reiniciar)"}
            aria-label={data.maestro ? "Desligar modo Maestro" : "Tornar Maestro"}
            aria-pressed={Boolean(data.maestro)}
            onClick={() => {
              const other = getNodes().find((n) => n.id !== id && n.type === "terminal" && (n.data as TerminalData).maestro);
              if (!data.maestro && other) return setWarning({ text: `"${(other.data as TerminalData).name}" já é o Maestro.` });
              updateNodeData(id, { maestro: !data.maestro });
            }}
          >
            <Crown className="h-3 w-3" />
          </button>
        )}
        {data.systems?.map((sys) => {
          const Icon = SYSTEM_ICONS[sys];
          return <span key={sys} className="shrink-0 text-accent" title={`Acesso: ${AF_SYSTEMS[sys].label}`} role="img" aria-label={`Acesso: ${AF_SYSTEMS[sys].label}`}><Icon className="h-3 w-3" /></span>;
        })}
        <NextRun at={daemon.nextRuns[data.name.toLowerCase()]} />
        {data.deny?.length ? (
          <span className="shrink-0 text-muted" title={`Proibido para este agente:\n${data.deny.join("\n")}`}><ShieldBan className="h-3 w-3" /></span>
        ) : null}
        <button
          className={`nodrag rounded p-1 hover:text-fg ${overlay === "connect" ? "text-fg" : "text-muted"}`}
          title="Conectar a outros agentes e aos sistemas Always Fit"
          aria-label="Conectar"
          aria-expanded={overlay === "connect"}
          onClick={() => setOverlay((o) => (o === "connect" ? null : "connect"))}
        >
          <Link2 className="h-3 w-3" />
        </button>
        <button
          className={`nodrag rounded p-1 hover:text-fg ${data.prompt ? "text-accent" : "text-muted"}`}
          title={data.prompt ? "Ver/editar instruções (valem ao reiniciar)" : "Adicionar instruções"}
          aria-label="Instruções do agente"
          aria-expanded={showPrompt}
          onClick={() => setOverlay((o) => (o === "prompt" ? null : "prompt"))}
        >
          <ScrollText className="h-3 w-3" />
        </button>
        <span className="hidden shrink-0 text-[10px] text-muted sm:inline" title={kind.label}>{statusLabel}</span>
        {running || queued ? (
          <button className="nodrag rounded p-1 text-muted hover:text-bad" title="Parar" aria-label="Parar terminal" onClick={() => daemon.send({ type: "kill", id })}><Square className="h-3 w-3" /></button>
        ) : (
          <button className="nodrag rounded p-1 text-muted hover:text-ok" title={status ? "Reiniciar" : "Iniciar"} aria-label={status ? "Reiniciar terminal" : "Iniciar terminal"} onClick={start}>
            {status ? <RotateCw className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </button>
        )}
        <button
          className="nodrag rounded p-1 text-muted hover:text-bad"
          title="Fechar terminal"
          aria-label="Fechar terminal"
          // O kill sai no onNodesChange do canvas, depois da confirmação (onBeforeDelete).
          onClick={() => void deleteElements({ nodes: [{ id }] })}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {warning && (
        <div role="alert" className="flex items-center justify-between bg-bad/15 px-2.5 py-1 text-[11px] text-bad">
          {warning.text}
          <button className="nodrag" onClick={() => setWarning(null)} aria-label="Fechar aviso"><X className="h-3 w-3" /></button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={box} className="nodrag nowheel nopan absolute inset-0 p-1.5" />
        {showPrompt && (
          <div className="absolute inset-0 z-10 flex flex-col gap-2 bg-panel p-2">
            <div className="flex items-center justify-between text-[11px] text-muted">
              Instruções do agente{running ? " · reinicie para aplicar" : ""}
              <button className="nodrag hover:text-fg" onClick={() => setOverlay(null)} aria-label="Fechar instruções"><X className="h-3 w-3" /></button>
            </div>
            <textarea
              className="nodrag nowheel scroll-thin min-h-0 flex-1 resize-none rounded-md border border-line bg-[#0b0d12] p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-accent"
              value={data.prompt ?? ""}
              placeholder="Prompt completo deste agente (Markdown)"
              aria-label="Prompt do agente"
              onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && setOverlay(null)}
            />
          </div>
        )}
        {overlay === "connect" && <ConnectMenu id={id} systems={data.systems ?? []} running={running} onClose={() => setOverlay(null)} />}
        {queued && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0d12]/85 p-6 text-center text-xs text-muted">
            <div>
              <Hourglass className="mx-auto mb-2 h-5 w-5 text-warn" />
              Na fila: responda no terminal de outro agente se você confia nesta pasta.<br />Este inicia logo em seguida.
            </div>
          </div>
        )}
        {!running && !queued && daemon.state === "open" && status !== "exited" && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0d12]/80">
            <button className="nodrag flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-white" style={{ background: kind.color }} onClick={start}>
              <Play className="h-4 w-4" /> Iniciar {kind.label}
            </button>
          </div>
        )}
        {status === "exited" && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-line bg-panel/95 px-2.5 py-1.5 text-[11px] text-muted">
            <span>{kind.label} encerrou{exitCode !== undefined ? ` com código ${exitCode}` : ""}.</span>
            <button className="nodrag flex items-center gap-1 rounded px-2 py-0.5 text-fg hover:bg-panel-2" onClick={start}>
              <RotateCw className="h-3 w-3" /> Reiniciar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Contador da próxima rodada (rotina) deste agente. */
function NextRun({ at }: { at?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [at]);
  if (!at) return null;
  const when = new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="hidden shrink-0 items-center gap-0.5 text-[10px] text-muted md:flex" title={`Próxima rodada às ${when}`}>
      <Clock className="h-2.5 w-2.5" /> {untilLabel(at, now)}
    </span>
  );
}

/** Menu "Conectar": liga/desliga este agente dos outros e escolhe os sistemas Always Fit dele. */
function ConnectMenu({ id, systems, running, onClose }: { id: string; systems: AfSystem[]; running: boolean; onClose: () => void }) {
  // useNodes/useEdges só aqui: o menu fechado não rerenderiza o terminal a cada mudança do grafo.
  const nodes = useNodes();
  const edges = useEdges();
  const { setEdges, updateNodeData } = useReactFlow();
  const others = nodes.filter((n) => n.type === "terminal" && n.id !== id).map((n) => ({ id: n.id, data: n.data as TerminalData }));
  const linked = (other: string) => edges.some((e) => (e.source === id && e.target === other) || (e.source === other && e.target === id));
  const touches = (e: { source: string; target: string }, other: string) => (e.source === id && e.target === other) || (e.source === other && e.target === id);
  const connect = (ids: string[]) =>
    setEdges((es) => [
      ...es,
      ...ids
        .filter((o) => !es.some((e) => touches(e, o)))
        .map((o) => ({ id: `e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, source: id, target: o, animated: true })),
    ]);
  const disconnect = (ids: string[]) => setEdges((es) => es.filter((e) => !ids.some((o) => touches(e, o))));
  const toggleSystem = (sys: AfSystem) => {
    const next = systems.includes(sys) ? systems.filter((s) => s !== sys) : [...systems, sys];
    updateNodeData(id, { systems: next.length ? next : undefined });
  };

  return (
    <div className="nodrag nowheel absolute inset-0 z-10 flex flex-col gap-3 overflow-y-auto bg-panel p-3 text-xs scroll-thin" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="flex items-center justify-between text-[11px] text-muted">
        Conexões
        <button className="hover:text-fg" onClick={onClose} aria-label="Fechar conexões"><X className="h-3 w-3" /></button>
      </div>
      <section aria-label="Agentes">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-medium">Conversa com</span>
          {others.length > 1 && (
            <span className="flex gap-2 text-[11px]">
              <button className="text-accent hover:underline" onClick={() => connect(others.map((o) => o.id))}>Ligar a todos</button>
              <button className="text-muted hover:text-fg hover:underline" onClick={() => disconnect(others.map((o) => o.id))}>Desligar de todos</button>
            </span>
          )}
        </div>
        {others.length === 0 && <p className="text-muted">Nenhum outro agente no canvas.</p>}
        <div className="space-y-1">
          {others.map((o) => {
            const on = linked(o.id);
            return (
              <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-panel-2">
                <input type="checkbox" className="accent-[var(--accent)]" checked={on} onChange={() => (on ? disconnect([o.id]) : connect([o.id]))} />
                <span className="h-2 w-2 rounded-full" style={{ background: (AGENT_KINDS[o.data.kind] ?? AGENT_KINDS.shell).color }} />
                <span className="min-w-0 flex-1 truncate">{o.data.name}</span>
                {o.data.maestro && <Crown className="h-3 w-3 text-warn" />}
                {on && <span className="text-[10px] text-ok">ligado</span>}
              </label>
            );
          })}
        </div>
      </section>
      <section aria-label="Sistemas Always Fit">
        <div className="mb-1.5 font-medium">Sistemas Always Fit</div>
        <div className="space-y-1">
          {(Object.keys(AF_SYSTEMS) as AfSystem[]).map((sys) => {
            const Icon = SYSTEM_ICONS[sys];
            return (
              <label key={sys} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-panel-2">
                <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={systems.includes(sys)} onChange={() => toggleSystem(sys)} />
                <Icon className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                <span>
                  {AF_SYSTEMS[sys].label}
                  <span className="block text-[10px] text-muted">{AF_SYSTEMS[sys].hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] text-muted">
          Só leitura. Sem o sistema marcado, o agente nem vê a ferramenta.{running ? " As instruções do agente só mudam ao reiniciar." : ""}
        </p>
      </section>
    </div>
  );
}

export default memo(TerminalNode);
