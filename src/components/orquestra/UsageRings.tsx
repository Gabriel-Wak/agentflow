"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { AGENT_KINDS, type UsageWindow } from "@/lib/orquestra/protocol";
import type { DaemonConnection } from "./daemon";

type Conn = DaemonConnection;

const PLAN_NAMES: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

const colorFor = (pct: number) => (pct >= 95 ? "var(--bad)" : pct >= 80 ? "var(--warn)" : AGENT_KINDS.claude.color);

function untilReset(iso: string | null, now: number) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "renovando";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `renova em ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `renova em ${h}h${String(min % 60).padStart(2, "0")}`;
  return `renova ${new Date(iso).toLocaleString("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
}

/** Anéis concêntricos (de fora para dentro: sessão, semanal, limite por modelo), como no Maestri. */
function Rings({ windows, size = 26 }: { windows: UsageWindow[]; size?: number }) {
  const stroke = 3;
  const gap = 1.5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
      {windows.slice(0, 3).map((w, i) => {
        const r = size / 2 - stroke / 2 - i * (stroke + gap);
        const c = 2 * Math.PI * r;
        const pct = Math.min(100, Math.max(0, w.usedPercent));
        return (
          <g key={w.id}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={colorFor(w.usedPercent)}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * c} ${c}`}
              style={{ transition: "stroke-dasharray .6s ease" }}
            />
          </g>
        );
      })}
    </svg>
  );
}

export default function UsageRings({ conn }: { conn: Conn }) {
  const usage = conn.usage;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const giveUp = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(giveUp.current);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nova leitura chegou: para o giro
    setLoading(false);
  }, [usage]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(t);
      clearTimeout(giveUp.current);
    };
  }, []);

  // Popover: fecha clicando fora ou com Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!conn.available.claude) return null;

  const windows = usage?.windows ?? [];
  // Anéis: sessão, semanal e o primeiro limite por modelo que existir.
  const ringWindows = [
    windows.find((w) => w.id === "five_hour"),
    windows.find((w) => w.id === "seven_day"),
    windows.find((w) => w.id !== "five_hour" && w.id !== "seven_day"),
  ].filter((w): w is UsageWindow => Boolean(w));
  const session = windows.find((w) => w.id === "five_hour");
  const failed = Boolean(usage && !usage.ok && !windows.length);
  const label = !usage ? "…" : failed ? "!" : usage.limited === false ? "API" : session ? `${Math.round(session.usedPercent)}%` : "—";
  const summary = !usage
    ? "lendo"
    : failed
      ? "não foi possível ler"
      : usage.limited === false
        ? "sem limite de plano"
        : session ? `${Math.round(session.usedPercent)}% da sessão usada` : "sem dados da sessão";

  return (
    <div className="relative" ref={root}>
      <button
        className="flex items-center gap-2 rounded-full border border-line bg-panel/95 py-0.5 pl-0.5 pr-2.5 text-[11px] shadow-xl backdrop-blur hover:border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => setOpen((v) => !v)}
        title="Limite do Claude Code"
        aria-label={`Limite do Claude Code: ${summary}`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {ringWindows.length ? <Rings windows={ringWindows} /> : <span className="h-[26px] w-[26px] rounded-full border-[3px] border-line" />}
        <span className={`font-medium tabular-nums ${failed ? "text-warn" : ""}`} style={{ color: session ? colorFor(session.usedPercent) : undefined }}>{label}</span>
      </button>

      {open && (
        <div role="dialog" aria-label="Limites do Claude Code" className="absolute right-0 top-10 z-30 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-line bg-panel p-3 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Claude Code</div>
              <div className="text-[11px] text-muted">
                {usage?.plan ? `Plano ${PLAN_NAMES[usage.plan] ?? usage.plan}` : "Limites do plano"}
                {usage ? ` · lido às ${new Date(usage.fetchedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : ""}
              </div>
            </div>
            <button
              className="rounded p-1 text-muted hover:text-fg disabled:opacity-50"
              disabled={loading}
              title="Atualizar agora"
              aria-label="Atualizar limites agora"
              onClick={() => {
                if (!conn.send({ type: "usage:refresh" })) return;
                setLoading(true);
                // A CLI pode não responder: não deixa o botão girando para sempre.
                clearTimeout(giveUp.current);
                giveUp.current = setTimeout(() => setLoading(false), 35_000);
              }}
            >
              <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {!usage && <p className="text-xs text-muted">Lendo os limites pela CLI do Claude…</p>}
          {usage?.limited === false && <p className="text-xs text-muted">Esta conta não tem limite de plano (uso cobrado por API).</p>}
          {usage?.error && <p role="alert" className="mb-2 text-xs text-warn">{usage.ok ? "Última atualização falhou: " : "Não foi possível ler os limites: "}{usage.error}</p>}
          {usage && !usage.error && usage.limited !== false && !windows.length && <p className="text-xs text-muted">A CLI não informou nenhum limite para esta conta.</p>}

          <div className="space-y-3">
            {windows.map((w) => (
              <div key={w.id}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span>{w.label}</span>
                  <span className="tabular-nums" style={{ color: colorFor(w.usedPercent) }}>{Math.round(w.usedPercent)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-label={w.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, w.usedPercent))}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, w.usedPercent)}%`, background: colorFor(w.usedPercent) }} />
                </div>
                <div className="mt-1 text-[10px] text-muted">{untilReset(w.resetsAt, now)}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-line pt-2 text-[10px] text-muted">Os agentes veem o mesmo número pela ferramenta <code>limite_claude</code>.</p>
        </div>
      )}
    </div>
  );
}
