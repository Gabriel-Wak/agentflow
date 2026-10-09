"use client";

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

export default function NoteNode({ id, data, selected }: NodeProps<Node<NoteData>>) {
  const { updateNodeData, deleteElements } = useReactFlow();
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
          className="nodrag min-w-0 flex-1 bg-transparent text-xs font-semibold outline-none"
          value={data.title}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
          placeholder="Título"
        />
        {NOTE_COLORS.map((c) => (
          <button key={c} className="nodrag h-2.5 w-2.5 rounded-full" style={{ background: c, outline: c === data.color ? "1px solid white" : undefined }} onClick={() => updateNodeData(id, { color: c })} aria-label="Cor" />
        ))}
        <button className="nodrag ml-1 text-muted hover:text-bad" onClick={() => void deleteElements({ nodes: [{ id }] })} aria-label="Apagar nota"><X className="h-3 w-3" /></button>
      </div>
      {data.by && <div className="px-2.5 text-[10px] text-muted">atualizada por {data.by}</div>}
      <textarea
        className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg/90 outline-none"
        value={data.content}
        onChange={(e) => updateNodeData(id, { content: e.target.value })}
        placeholder="Escreva aqui... os agentes também leem e escrevem notas."
      />
    </div>
  );
}
