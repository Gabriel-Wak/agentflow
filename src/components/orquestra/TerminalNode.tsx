"use client";

import { useEffect, useRef, useState } from "react";
import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Play, RotateCw, Square, X } from "lucide-react";
import { AGENT_KINDS, type AgentKind } from "@/lib/orquestra/protocol";
import { useDaemon } from "./daemon";

export interface TerminalData {
  [key: string]: unknown;
  name: string;
  role: string;
  kind: AgentKind;
  /** Inicia sozinho quando o nó aparece pela primeira vez. */
  autostart?: boolean;
  /** Destaque temporário quando chega mensagem. */
  pulse?: boolean;
}

export default function TerminalNode({ id, data, selected }: NodeProps<Node<TerminalData>>) {
  const daemon = useDaemon();
  const { updateNodeData, deleteElements } = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ cols: number; rows: number } | null>(null);
  const [ready, setReady] = useState(false);
  const status = daemon.statuses[id];
  const kind = AGENT_KINDS[data.kind];
  const running = status === "running";

  // Monta o xterm (só no navegador) e liga entrada/saída ao daemon.
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
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
      const doFit = () => {
        try {
          fit.fit();
          termRef.current = { cols: term.cols, rows: term.rows };
          daemon.send({ type: "resize", id, cols: term.cols, rows: term.rows });
        } catch {
          /* nó ainda sem tamanho */
        }
      };
      doFit();
      const ro = new ResizeObserver(() => doFit());
      ro.observe(box.current);
      const input = term.onData((d) => daemon.send({ type: "input", id, data: d }));
      const off = daemon.onOutput(id, (d) => term.write(d));
      cleanups.push(() => ro.disconnect(), () => input.dispose(), off, () => term.dispose());
      setReady(true);
    })();
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- o terminal vive enquanto o nó existir
  }, [id]);

  // Ao conectar: reaproveita o terminal que já roda no daemon ou inicia um novo.
  useEffect(() => {
    if (!ready || daemon.state !== "open") return;
    if (status === "running" || status === "exited") daemon.send({ type: "attach", id });
    else if (data.autostart) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, daemon.state]);

  function start() {
    const size = termRef.current ?? { cols: 100, rows: 28 };
    daemon.send({ type: "spawn", id, ...size, cwd: daemon.cwd, agent: { id, name: data.name, role: data.role, kind: data.kind } });
    updateNodeData(id, { autostart: false });
  }

  const pulsing = Boolean(data.pulse);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-[#0b0d12] shadow-2xl"
      style={{
        borderColor: selected || pulsing ? kind.color : "var(--border)",
        boxShadow: pulsing ? `0 0 0 3px ${kind.color}55, 0 0 32px ${kind.color}66` : undefined,
      }}
    >
      <NodeResizer isVisible={selected} minWidth={360} minHeight={220} lineStyle={{ borderColor: "transparent" }} handleStyle={{ width: 10, height: 10, borderRadius: 3, background: kind.color, border: "none" }} />
      <Handle type="target" position={Position.Left} style={{ background: kind.color }} />
      <Handle type="source" position={Position.Right} style={{ background: kind.color }} />

      <div className="flex items-center gap-2 border-b border-line bg-panel px-2.5 py-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`} style={{ background: running ? kind.color : "#4b5263" }} />
        <input
          className="nodrag w-28 min-w-0 bg-transparent text-xs font-semibold outline-none"
          value={data.name}
          onChange={(e) => updateNodeData(id, { name: e.target.value.replace(/\s+/g, "-") })}
          title="Nome (usado nas @menções)"
        />
        <input
          className="nodrag min-w-0 flex-1 bg-transparent text-[11px] text-muted outline-none placeholder:text-muted/50"
          value={data.role}
          placeholder="papel: ex. cria o código / revisa / aprova"
          onChange={(e) => updateNodeData(id, { role: e.target.value })}
          title="Papel do agente (vai nas instruções ao iniciar)"
        />
        <span className="shrink-0 text-[10px] text-muted">{kind.label}</span>
        {running ? (
          <button className="nodrag rounded p-1 text-muted hover:text-bad" title="Parar" onClick={() => daemon.send({ type: "kill", id })}><Square className="h-3 w-3" /></button>
        ) : (
          <button className="nodrag rounded p-1 text-muted hover:text-ok" title={status ? "Reiniciar" : "Iniciar"} onClick={start}>
            {status ? <RotateCw className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </button>
        )}
        <button
          className="nodrag rounded p-1 text-muted hover:text-bad"
          title="Fechar terminal"
          onClick={() => {
            daemon.send({ type: "kill", id });
            void deleteElements({ nodes: [{ id }] });
          }}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={box} className="nodrag nowheel nopan absolute inset-0 p-1.5" />
        {!running && daemon.state === "open" && status !== "exited" && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0d12]/80">
            <button className="nodrag flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-white" style={{ background: kind.color }} onClick={start}>
              <Play className="h-4 w-4" /> Iniciar {kind.label}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
