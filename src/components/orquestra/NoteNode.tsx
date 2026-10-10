"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { X } from "lucide-react";

export interface NoteData {
  [key: string]: unknown;
  title: string;
  content: string;
  color: string;
  by?: string;
}

export const NOTE_COLORS = ["#fbbf24", "#7c6cff", "#22d3ee", "#34d399", "#f87171"];
const COLOR_NAMES = ["amarelo", "roxo", "ciano", "verde", "vermelho"];

function NoteNode({ id, data, selected }: NodeProps<Node<NoteData>>) {
  const { updateNodeData, deleteElements } = useReactFlow();
  // Enquanto você digita, o texto mostrado é o seu rascunho: se um agente reescrever a nota
  // nesse meio tempo, o cursor não pula e nada do que você digitou some.
  const [draft, setDraft] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<{ content: string; by?: string } | null>(null);
  // Tudo que você escreveu desde que focou: o grafo chega atrasado (o React Flow sincroniza
  // num efeito), então "conteúdo diferente do rascunho" não basta para saber que veio de fora.
  const written = useRef(new Set<string>());
  const editing = draft !== null;

  useEffect(() => {
    if (!editing || written.current.has(data.content)) return;
    // Você ainda não digitou nada: só acompanha a versão nova.
    if (!written.current.size) setDraft(data.content);
    else setIncoming({ content: data.content, by: data.by });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só quando o conteúdo muda
  }, [data.content]);

  const write = (content: string) => {
    written.current.add(content);
    setDraft(content);
    updateNodeData(id, { content });
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border shadow-xl"
      style={{ borderColor: selected ? data.color : `${data.color}66`, background: `color-mix(in srgb, ${data.color} 10%, var(--panel))` }}
    >
      <NodeResizer isVisible={selected} minWidth={200} minHeight={120} lineStyle={{ borderColor: "transparent" }} handleStyle={{ width: 8, height: 8, background: data.color, border: "none" }} />
      <Handle type="target" position={Position.Left} style={{ background: data.color }} />
      <Handle type="source" position={Position.Right} style={{ background: data.color }} />
      <div className="flex items-center gap-1.5 px-2.5 pt-2">
        <input
          className="nodrag min-w-0 flex-1 rounded bg-transparent text-xs font-semibold outline-none focus-visible:ring-1 focus-visible:ring-accent"
          value={data.title ?? ""}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
          placeholder="Título"
          aria-label="Título da nota"
        />
        {NOTE_COLORS.map((c, i) => (
          <button
            key={c}
            className="nodrag h-2.5 w-2.5 rounded-full"
            style={{ background: c, outline: c === data.color ? "1px solid white" : undefined }}
            onClick={() => updateNodeData(id, { color: c })}
            aria-label={`Cor ${COLOR_NAMES[i]}`}
            aria-pressed={c === data.color}
          />
        ))}
        <button className="nodrag ml-1 text-muted hover:text-bad" onClick={() => void deleteElements({ nodes: [{ id }] })} aria-label="Apagar nota"><X className="h-3 w-3" /></button>
      </div>
      {data.by && !incoming && <div className="px-2.5 text-[10px] text-muted">atualizada por {data.by}</div>}
      {incoming && (
        <div role="status" className="mx-2.5 mt-1 flex items-center gap-2 rounded bg-warn/15 px-2 py-1 text-[10px] text-warn">
          <span className="min-w-0 flex-1">{incoming.by ?? "Um agente"} atualizou esta nota enquanto você editava.</span>
          <button
            className="nodrag shrink-0 underline"
            // A versão do agente substitui o seu rascunho.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              written.current.clear();
              setDraft(incoming.content);
              setIncoming(null);
            }}
          >
            usar a dele
          </button>
          <button
            className="nodrag shrink-0 underline"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setIncoming(null);
              write(draft ?? data.content);
            }}
          >
            manter a minha
          </button>
        </div>
      )}
      <textarea
        className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg/90 outline-none"
        value={draft ?? data.content ?? ""}
        onFocus={() => {
          written.current.clear();
          setDraft(data.content ?? "");
        }}
        onChange={(e) => write(e.target.value)}
        onBlur={() => {
          // Saiu sem decidir: o que você digitou fica e vira a versão da nota.
          if (incoming && draft !== null) write(draft);
          setIncoming(null);
          setDraft(null);
        }}
        aria-label="Conteúdo da nota"
        placeholder="Escreva aqui... os agentes também leem e escrevem notas."
      />
    </div>
  );
}

export default memo(NoteNode);
