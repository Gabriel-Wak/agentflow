"use client";

import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";

/**
 * Ligação entre nós: mostra a última mensagem que passou por ela e, selecionada (clique),
 * um botão para desligar. A animação continua vindo do `animated` da aresta.
 * Selecionada, o rótulo sobe acima dos nós: uma ligação que passa atrás de outro terminal
 * deixaria o botão escondido.
 */
function ConnectionEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style, markerEnd, selected }: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, x, y] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={selected ? { ...style, stroke: "var(--accent)", strokeWidth: 2.5 } : style} interactionWidth={24} />
      {(label || selected) && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan pointer-events-auto absolute flex items-center gap-1" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, zIndex: selected ? 1001 : undefined }}>
            {label ? <span className="max-w-60 truncate rounded-md border border-line bg-panel px-2 py-0.5 text-[10px] text-fg shadow-lg">{String(label)}</span> : null}
            {selected && (
              <button
                className="flex items-center gap-1 rounded-full border border-line bg-panel px-2 py-0.5 text-[10px] text-muted shadow-lg hover:border-bad hover:text-bad"
                onClick={() => void deleteElements({ edges: [{ id }] })}
                aria-label="Remover ligação"
                title="Remover ligação (ou tecla Delete)"
              >
                <X className="h-3 w-3" /> Remover
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default memo(ConnectionEdge);
