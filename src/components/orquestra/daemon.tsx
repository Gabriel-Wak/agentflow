"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { DEFAULT_DAEMON_URL, type AfStatus, type AgentKind, type ClaudeUsage, type ClientMsg, type ReportMeta, type ServerMsg, type TerminalStatus } from "@/lib/orquestra/protocol";

const TOKEN_KEY = "orquestra:token";
const URL_KEY = "orquestra:url";

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* modo privado */
  }
};

/** rejected: o daemon respondeu, mas recusou o token ou a origem (não adianta insistir). */
export type DaemonState = "idle" | "connecting" | "open" | "closed" | "rejected";

type Listener = (m: ServerMsg) => void;
type OutputListener = (data: string, replay: boolean) => void;

const RETRY_MIN = 1000;
const RETRY_MAX = 15_000;

/**
 * O navegador não expõe o 401 do handshake do WebSocket: os dois casos viram "close 1006".
 * Se o /health responde, o daemon está no ar e quem falhou foi o token/origem.
 */
async function daemonReachable(wsUrl: string) {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/health";
    u.search = "";
    await fetch(u, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

/** Conexão WebSocket com o daemon local, com reconexão automática (backoff até 15 s). */
export function useDaemonConnection() {
  const [state, setState] = useState<DaemonState>("idle");
  const [token, setTokenState] = useState<string>("");
  const [url, setUrlState] = useState<string>(DEFAULT_DAEMON_URL);
  const [attempt, setAttempt] = useState(0);
  const [hello, setHello] = useState<Extract<ServerMsg, { type: "hello" }> | null>(null);
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const [exitCodes, setExitCodes] = useState<Record<string, number>>({});
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [alwaysfit, setAlwaysfit] = useState<AfStatus | null>(null);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [autostart, setAutostart] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listeners = useRef(new Set<Listener>());
  const outputs = useRef(new Map<string, Set<OutputListener>>());

  // Token vem do link impresso pelo daemon (#token=...) ou do que já foi salvo.
  // Também vale colar o link com a página já aberta (só o hash muda, sem recarregar).
  useEffect(() => {
    const fromHash = () => {
      const t = new URLSearchParams(location.hash.slice(1)).get("token");
      if (!t) return null;
      write(TOKEN_KEY, t);
      // Mantém a query (ex.: ?painel=alwaysfit, que o canvas lê e limpa depois).
      history.replaceState(null, "", location.pathname + location.search);
      return t;
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leitura única do armazenamento do navegador
    setTokenState(fromHash() || read(TOKEN_KEY) || "");
    setUrlState(read(URL_KEY) || DEFAULT_DAEMON_URL);
    const onHash = () => {
      const t = fromHash();
      if (t) setTokenState(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_MIN;
    // Já abriu com este token: uma queda depois é o daemon reiniciando, não token recusado.
    // Sem sondar, o console não enche de "connection refused" a cada nova tentativa.
    let everOpened = false;
    const connect = () => {
      setState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
      } catch {
        // Endereço inválido (ex.: sem ws://): não há o que tentar de novo.
        setState("rejected");
        return;
      }
      let opened = false;
      wsRef.current = ws;
      ws.onopen = () => {
        opened = true;
        everOpened = true;
        delay = RETRY_MIN;
      };
      ws.onmessage = (ev) => {
        if (stopped) return;
        let m: ServerMsg;
        try {
          m = JSON.parse(ev.data as string) as ServerMsg;
        } catch {
          return;
        }
        if (m.type === "hello") {
          setHello(m);
          setStatuses(m.terminals);
          if (m.alwaysfit) setAlwaysfit(m.alwaysfit);
          setAutostart(Boolean(m.autostart));
          setState("open");
        } else if (m.type === "status") {
          setStatuses((s) => ({ ...s, [m.id]: m.status }));
          if (m.status === "exited" && m.code !== undefined) setExitCodes((c) => ({ ...c, [m.id]: m.code! }));
        } else if (m.type === "usage") {
          setUsage(m.usage);
        } else if (m.type === "af:status") {
          setAlwaysfit(m.status);
        } else if (m.type === "reports") {
          setReports(m.reports);
        } else if (m.type === "report:new") {
          // Mais recentes primeiro, como o daemon manda; sem duplicar se a lista chegar junto.
          setReports((rs) => [m.report, ...rs.filter((r) => r.id !== m.report.id)]);
        } else if (m.type === "autostart") {
          setAutostart(m.enabled);
        } else if (m.type === "output") {
          outputs.current.get(m.id)?.forEach((fn) => fn(m.data, Boolean(m.replay)));
          return;
        }
        listeners.current.forEach((fn) => fn(m));
      };
      ws.onclose = () => {
        // Um socket antigo fechando depois de trocar token/endereço não pode apagar o novo.
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) return;
        setState("closed");
        void (async () => {
          // Nunca abriu e o daemon está no ar: token ou origem recusados.
          if (!opened && !everOpened && (await daemonReachable(url))) {
            if (!stopped) setState("rejected");
            return;
          }
          if (stopped) return;
          retry = setTimeout(connect, delay);
          delay = Math.min(RETRY_MAX, delay * 2);
        })();
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [token, url, attempt]);

  /** Envia ao daemon; false se a conexão não está aberta (a mensagem não saiu). */
  const send = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  }, []);

  const on = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const onOutput = useCallback((id: string, fn: OutputListener) => {
    const set = outputs.current.get(id) ?? new Set();
    set.add(fn);
    outputs.current.set(id, set);
    return () => {
      set.delete(fn);
      if (!set.size && outputs.current.get(id) === set) outputs.current.delete(id);
    };
  }, []);

  const setToken = useCallback((t: string) => {
    write(TOKEN_KEY, t.trim());
    setTokenState(t.trim());
    // Mesmo token de novo (ex.: depois de reiniciar o daemon): força nova tentativa.
    setAttempt((n) => n + 1);
  }, []);
  const setUrl = useCallback((u: string) => {
    write(URL_KEY, u.trim());
    setUrlState(u.trim());
  }, []);

  return {
    state,
    token,
    url,
    setToken,
    setUrl,
    hello,
    statuses,
    exitCodes,
    usage,
    alwaysfit,
    reports,
    autostart,
    available: (hello?.agents ?? { claude: false, codex: false, shell: true }) as Record<AgentKind, boolean>,
    send,
    on,
    onOutput,
  };
}

export type DaemonConnection = ReturnType<typeof useDaemonConnection>;

/** O que os nós do canvas precisam do daemon (sem o resto da conexão, para não rerenderizar à toa). */
export type Daemon = Pick<DaemonConnection, "state" | "statuses" | "exitCodes" | "send" | "onOutput"> & {
  cwd: string;
  /** Próxima rodada agendada (ISO) por nome de agente em minúsculas, das rotinas ativas. */
  nextRuns: Record<string, string>;
};

export const DaemonContext = createContext<Daemon | null>(null);
export const useDaemon = () => {
  const d = useContext(DaemonContext);
  if (!d) throw new Error("useDaemon fora do DaemonContext");
  return d;
};
