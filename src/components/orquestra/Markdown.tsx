"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Markdown simples para os relatórios dos agentes: títulos, listas, citações, blocos de código,
 * tabelas, **negrito**, *itálico*, `código` e links. Monta elementos React (nunca HTML cru):
 * o texto vem de um agente que leu dados externos, então não pode injetar nada na página.
 */
export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(<pre key={key()} className="scroll-thin overflow-x-auto rounded-md bg-[#0b0d12] p-2 font-mono text-[11px]">{body.join("\n")}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const size = ["text-base", "text-sm", "text-sm", "text-xs"][h[1].length - 1];
      out.push(<p key={key()} className={`${size} mt-2 font-semibold`}>{inline(h[2])}</p>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue; // linha separadora |---|
        rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
      }
      const [head, ...body] = rows;
      if (!head) continue;
      out.push(
        <div key={key()} className="scroll-thin overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead><tr>{head.map((c, j) => <th key={j} className="border border-line bg-panel-2 px-1.5 py-1 text-left font-medium">{inline(c)}</th>)}</tr></thead>
            <tbody>{body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} className="border border-line px-1.5 py-1 align-top">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      out.push(<List key={key()} className={`${ordered ? "list-decimal" : "list-disc"} space-y-0.5 pl-5`}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</List>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key()} className="border-l-2 border-line pl-2 text-muted">{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={key()} className="border-line" />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // A primeira linha entra sempre (ex.: "|solto" sem fechar não é tabela): sem isso o laço não avança.
    const para: string[] = [lines[i++]];
    for (; i < lines.length && lines[i].trim() && !/^(\s*```|#{1,4}\s|\s*([-*+]|\d+[.)])\s|\s*>|\s*\|)/.test(lines[i]); i++) para.push(lines[i]);
    out.push(<p key={key()}>{inline(para.join(" "))}</p>);
  }
  return <div className="space-y-2 break-words text-xs leading-relaxed">{out}</div>;
}

/** Negrito, itálico, código e links ([texto](http...)) dentro de uma linha. */
function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) parts.push(<code key={m.index} className="rounded bg-panel-2 px-1 font-mono text-[11px]">{t.slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    else parts.push(<a key={m.index} href={m[5]} target="_blank" rel="noopener noreferrer" className="text-accent underline">{t.slice(1, t.indexOf("]"))}</a>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}
