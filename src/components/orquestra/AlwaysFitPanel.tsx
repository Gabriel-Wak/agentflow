"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CheckCheck, Copy, Database, FileText, FolderGit2, Power, RefreshCw, X } from "lucide-react";
import type { AfStatus, ClientMsg, ReportMeta, ReportSeverity, ServerMsg } from "@/lib/orquestra/protocol";
import { Button, Select } from "../ui";
import Markdown from "./Markdown";

/** O usuário cria o perfil uma vez; a senha fica no ~/.mylogin.cnf (cifrado) e o daemon nunca a vê. */
export const DB_SETUP_CMD =
  "mysql_config_editor set --login-path=alwaysfit-readonly --host=read-db-homolog-mysql.c3q0u4ksqqea.sa-east-1.rds.amazonaws.com --port=3306 --user=gabriel.bezerra --password";

export const SEVERITY: Record<ReportSeverity, { label: string; className: string }> = {
  critico: { label: "crítico", className: "bg-bad/15 text-bad" },
  atencao: { label: "atenção", className: "bg-warn/15 text-warn" },
  info: { label: "info", className: "bg-panel-2 text-muted" },
};

const time = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

/** O daemon grava o relatório com cabeçalho YAML (título, agente, gravidade): já aparece no topo do leitor. */
const stripFrontmatter = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "muted" }) {
  const bg = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", muted: "#4b5263" }[tone];
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: bg }} aria-hidden="true" />;
}

/** Painel Always Fit: sistemas conectados, relatórios dos agentes e a formação 24h. */
export default function AlwaysFitPanel({
  status,
  reports,
  unread,
  autostart,
  agentCount,
  send,
  on,
  onRead,
  onReadAll,
  onSave24h,
  onClose,
}: {
  status: AfStatus | null;
  reports: ReportMeta[];
  unread: (r: ReportMeta) => boolean;
  autostart: boolean;
  agentCount: number;
  send: (m: ClientMsg) => boolean;
  on: (fn: (m: ServerMsg) => void) => () => void;
  onRead: (id: string) => void;
  onReadAll: () => void;
  onSave24h: () => void;
  onClose: () => void;
}) {
  const [severity, setSeverity] = useState<ReportSeverity | "">("");
  const [agent, setAgent] = useState("");
  const [open, setOpen] = useState<ReportMeta | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  // Conteúdo dos relatórios chega pelo daemon; e qualquer status novo encerra o "verificando".
  useEffect(
    () =>
      on((m) => {
        if (m.type === "report") setContent((c) => ({ ...c, [m.id]: m.content }));
        else if (m.type === "af:status") setChecking(false);
      }),
    [on],
  );

  const agents = [...new Set(reports.map((r) => r.agent))].sort();
  const shown = reports.filter((r) => (!severity || r.severity === severity) && (!agent || r.agent === agent));
  const unreadCount = reports.filter(unread).length;

  function read(r: ReportMeta) {
    setOpen(r);
    onRead(r.id);
    if (content[r.id] === undefined) send({ type: "reports:read", id: r.id });
  }

  const db = status?.db;
  const repos = status?.repos;
  const dbTone = !db ? "muted" : !db.configured ? "warn" : db.ok ? "ok" : "bad";
  const reposTone = !repos ? "muted" : repos.error ? "bad" : repos.syncing ? "warn" : repos.total && repos.synced === repos.total ? "ok" : "warn";

  return (
    <div
      role="dialog"
      aria-label="Always Fit"
      className="absolute bottom-24 right-3 top-16 z-10 flex w-[26rem] max-w-[calc(100%-1.5rem)] flex-col rounded-xl border border-line bg-panel/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2 text-sm font-medium">
        Always Fit
        <button onClick={onClose} aria-label="Fechar painel Always Fit"><X className="h-4 w-4 text-muted" /></button>
      </div>

      {open ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-start gap-2 border-b border-line px-3 py-2">
            <button className="mt-0.5 text-muted hover:text-fg" onClick={() => setOpen(null)} aria-label="Voltar aos relatórios"><ArrowLeft className="h-4 w-4" /></button>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{open.title}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                <span className={`rounded px-1.5 py-0.5 ${SEVERITY[open.severity].className}`}>{SEVERITY[open.severity].label}</span>
                {open.agent} · {time(open.createdAt)}
              </div>
            </div>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
            {content[open.id] === undefined ? <p className="text-xs text-muted">Carregando…</p> : <Markdown text={stripFrontmatter(content[open.id])} />}
          </div>
        </div>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-xs">
          {/* Sistemas */}
          <section aria-label="Sistemas" className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">Sistemas</span>
              <button
                className="flex items-center gap-1 text-[11px] text-muted hover:text-fg disabled:opacity-50"
                disabled={checking}
                onClick={() => send({ type: "af:refresh" }) && setChecking(true)}
              >
                <RefreshCw className={`h-3 w-3 ${checking ? "animate-spin" : ""}`} /> Reverificar
              </button>
            </div>
            {!status && <p className="text-muted">Aguardando o status do daemon…</p>}
            {db && (
              <div role="group" aria-label="Banco" className="rounded-lg bg-panel-2 p-2">
                <div className="flex items-center gap-2">
                  <Dot tone={dbTone} />
                  <Database className="h-3.5 w-3.5 text-muted" />
                  <span className="font-medium">Banco (réplica de leitura)</span>
                  <span className="ml-auto text-[10px] text-muted">{!db.configured ? "não configurado" : db.ok ? "conectado" : "com erro"}</span>
                </div>
                {db.host && <div className="mt-1 truncate font-mono text-[10px] text-muted" title={db.host}>{db.host}</div>}
                {/* Perfil ausente: o comando completo abaixo já diz o que fazer. */}
                {db.error && (db.configured || !/perfil/i.test(db.error)) && <div role="alert" className="mt-1 text-[11px] text-bad">{db.error}</div>}
                {!db.configured && !(db.error && !/perfil/i.test(db.error)) && (
                  <div className="mt-2 space-y-1">
                    <p className="text-[11px] text-muted">Rode uma vez no Terminal do Mac (ele pede a senha; o Always Flow nunca a vê) e clique em Reverificar:</p>
                    <div className="flex items-start gap-1">
                      <code className="block min-w-0 flex-1 break-all rounded bg-[#0b0d12] p-1.5 font-mono text-[10px]">{DB_SETUP_CMD}</code>
                      <button
                        className="shrink-0 rounded p-1 text-muted hover:text-fg"
                        aria-label="Copiar comando"
                        title={copied ? "Copiado" : "Copiar"}
                        onClick={() => {
                          void navigator.clipboard?.writeText(DB_SETUP_CMD).then(() => setCopied(true), () => {});
                        }}
                      >
                        {copied ? <CheckCheck className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}
                {db.checkedAt && <div className="mt-1 text-[10px] text-muted">verificado {time(db.checkedAt)}</div>}
              </div>
            )}
            {repos && (
              <div role="group" aria-label="Repositórios" className="rounded-lg bg-panel-2 p-2">
                <div className="flex items-center gap-2">
                  <Dot tone={reposTone} />
                  <FolderGit2 className="h-3.5 w-3.5 text-muted" />
                  <span className="font-medium">Repositórios {repos.org}</span>
                  <span className="ml-auto tabular-nums text-[10px] text-muted">{repos.synced}/{repos.total} sincronizados</span>
                </div>
                {repos.total > 0 && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#0b0d12]" role="progressbar" aria-label="Repositórios sincronizados" aria-valuemin={0} aria-valuemax={repos.total} aria-valuenow={repos.synced}>
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((repos.synced / repos.total) * 100)}%` }} />
                  </div>
                )}
                {repos.error && <div role="alert" className="mt-1 text-[11px] text-bad">{repos.error}</div>}
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted">
                  <span>{repos.syncing ? "sincronizando…" : `última sincronização ${time(repos.lastSyncAt)}`}</span>
                  <button
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg hover:bg-panel disabled:opacity-50"
                    disabled={repos.syncing}
                    onClick={() => send({ type: "af:sync" })}
                  >
                    <RefreshCw className={`h-3 w-3 ${repos.syncing ? "animate-spin" : ""}`} /> Sincronizar agora
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* 24 horas */}
          <section aria-label="24 horas" className="space-y-2">
            <div className="font-medium">24 horas</div>
            <div className="flex items-center gap-2 rounded-lg bg-panel-2 p-2">
              <Dot tone={autostart ? "ok" : "muted"} />
              <span className="min-w-0 flex-1">
                {autostart ? "Ligado: o daemon sobe a formação salva sozinho sempre que iniciar." : "Desligado: os agentes só rodam com o canvas aberto e iniciados por você."}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="px-2.5 py-1.5 text-xs" onClick={onSave24h} disabled={!agentCount}>
                <Power className="h-3.5 w-3.5" /> {autostart ? "Salvar a formação atual para 24h" : "Manter esta formação rodando 24h"}
              </Button>
              {autostart && (
                <Button
                  variant="ghost"
                  className="px-2.5 py-1.5 text-xs"
                  onClick={() => confirm("Desligar as 24h? Os agentes que já estão rodando continuam; só não sobem sozinhos no próximo início do daemon.") && send({ type: "autostart:clear" })}
                >
                  Desligar 24h
                </Button>
              )}
            </div>
          </section>

          {/* Relatórios */}
          <section aria-label="Relatórios" className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">Relatórios{unreadCount ? <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] text-white">{unreadCount} novos</span> : null}</span>
              <span className="flex gap-2 text-[11px]">
                {unreadCount > 0 && <button className="text-muted hover:text-fg" onClick={onReadAll}>marcar como lidos</button>}
                <button className="text-muted hover:text-fg" onClick={() => send({ type: "reports:list" })} aria-label="Atualizar relatórios"><RefreshCw className="h-3 w-3" /></button>
              </span>
            </div>
            {reports.length > 0 && (
              <div className="flex gap-2">
                <Select value={severity} onChange={(e) => setSeverity(e.target.value as ReportSeverity | "")} className="py-1 text-xs" aria-label="Filtrar por gravidade">
                  <option value="">Todas as gravidades</option>
                  <option value="critico">Crítico</option>
                  <option value="atencao">Atenção</option>
                  <option value="info">Info</option>
                </Select>
                <Select value={agent} onChange={(e) => setAgent(e.target.value)} className="py-1 text-xs" aria-label="Filtrar por agente">
                  <option value="">Todos os agentes</option>
                  {agents.map((a) => <option key={a}>{a}</option>)}
                </Select>
              </div>
            )}
            {reports.length === 0 && <p className="text-muted">Nenhum relatório ainda. Os agentes salvam um por rodada com <code>salvar_relatorio</code>.</p>}
            {reports.length > 0 && shown.length === 0 && <p className="text-muted">Nenhum relatório com esse filtro.</p>}
            <div className="space-y-1">
              {shown.map((r) => (
                <button key={r.id} className="flex w-full items-start gap-2 rounded-lg bg-panel-2 px-2 py-1.5 text-left hover:bg-panel" onClick={() => read(r)}>
                  <FileText className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${r.severity === "critico" ? "text-bad" : r.severity === "atencao" ? "text-warn" : "text-muted"}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${unread(r) ? "font-semibold text-fg" : ""}`}>{r.title}</span>
                    <span className="text-[10px] text-muted">{r.agent} · {time(r.createdAt)}</span>
                  </span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${SEVERITY[r.severity].className}`}>{SEVERITY[r.severity].label}</span>
                  {unread(r) && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="não lido" />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
