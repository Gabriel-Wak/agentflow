"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { DEFAULT_DAEMON_URL, type AgentKind, type ClientMsg, type ServerMsg, type TerminalStatus } from "@/lib/orquestra/protocol";

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

export type DaemonState = "idle" | "connecting" | "open" | "closed";

type Listener = (m: ServerMsg) => void;

/** Conexão WebSocket com o daemon local, com reconexão automática. */
export function useDaemonConnection() {
  const [state, setState] = useState<DaemonState>("idle");
  const [token, setTokenState] = useState<string>("");
  const [url, setUrlState] = useState<string>(DEFAULT_DAEMON_URL);
  const [hello, setHello] = useState<Extract<ServerMsg, { type: "hello" }> | null>(null);
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const listeners = useRef(new Set<Listener>());
  const outputs = useRef(new Map<string, Set<(data: string) => void>>());

  // Token vem do link impresso pelo daemon (#token=...) ou do que já foi salvo.
  useEffect(() => {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
    if (fromHash) {
      write(TOKEN_KEY, fromHash);
      history.replaceState(null, "", location.pathname);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leitura única do armazenamento do navegador
    setTokenState(fromHash || read(TOKEN_KEY) || "");
    setUrlState(read(URL_KEY) || DEFAULT_DAEMON_URL);
  }, []);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      setState("connecting");
      const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as ServerMsg;
        if (m.type === "hello") {
          setHello(m);
          setStatuses(m.terminals);
          setState("open");
        } else if (m.type === "status") {
          setStatuses((s) => ({ ...s, [m.id]: m.status }));
        } else if (m.type === "output") {
          outputs.current.get(m.id)?.forEach((fn) => fn(m.data));
          return;
        }
        listeners.current.forEach((fn) => fn(m));
      };
      ws.onclose = () => {
        wsRef.current = null;
        setState("closed");
        if (!stopped) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [token, url]);

  const send = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  const on = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const onOutput = useCallback((id: string, fn: (data: string) => void) => {
    const set = outputs.current.get(id) ?? new Set();
    set.add(fn);
    outputs.current.set(id, set);
    return () => void set.delete(fn);
  }, []);

  const setToken = (t: string) => {
    write(TOKEN_KEY, t.trim());
    setTokenState(t.trim());
  };
  const setUrl = (u: string) => {
    write(URL_KEY, u.trim());
    setUrlState(u.trim());
  };

  return {
    state,
    token,
    url,
    setToken,
    setUrl,
    hello,
    statuses,
    available: (hello?.agents ?? { claude: false, codex: false, shell: true }) as Record<AgentKind, boolean>,
    send,
    on,
    onOutput,
  };
}

export type Daemon = ReturnType<typeof useDaemonConnection> & { cwd: string };

export const DaemonContext = createContext<Daemon | null>(null);
export const useDaemon = () => {
  const d = useContext(DaemonContext);
  if (!d) throw new Error("useDaemon fora do DaemonContext");
  return d;
};
