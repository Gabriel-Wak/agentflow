import { decrypt, mask } from "./crypto";
import { testDatabase } from "./integrations/database";
import { parseRepo, testGithub } from "./integrations/github";
import { testMcp } from "./integrations/mcp";
import type { ConnectionKind } from "./types";

export const PUBLIC_COLUMNS = "id, kind, name, config, status, meta, created_at, secret";

/** Remove o segredo e devolve só uma dica mascarada. */
export function toPublic<T extends { secret?: string | null }>(row: T) {
  const { secret, ...rest } = row;
  let hint = "";
  try {
    hint = mask(decrypt(secret));
  } catch {
    hint = secret ? "••••" : "";
  }
  return { ...rest, secret_hint: hint };
}

export function normalizeConfig(kind: ConnectionKind, config: Record<string, string>): Record<string, string> {
  if (kind === "github") return { repo: parseRepo(config.repo ?? ""), branch: (config.branch ?? "").trim() };
  if (kind === "mcp") return { url: (config.url ?? "").trim() };
  return { label: (config.label ?? "").trim() };
}

/** Testa a conexão de verdade e devolve status + metadados para salvar. */
export async function testConnection(kind: ConnectionKind, config: Record<string, string>, secret: string) {
  if (kind === "mcp") {
    // Na execução quem conecta é a API da Claude, pela internet: localhost/rede interna nunca funcionaria.
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error("URL do servidor MCP inválida.");
    }
    if (url.protocol !== "https:") throw new Error("O servidor MCP precisa ser https:// público — a API da Claude conecta nele pela internet.");
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(url.hostname) || url.hostname.endsWith(".local")) {
      throw new Error("Endereços locais não funcionam: a API da Claude conecta no servidor MCP pela internet.");
    }
    const r = await testMcp(config.url, secret);
    return { config, meta: r };
  }
  if (kind === "github") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error("Use o formato dono/repositorio ou a URL do GitHub.");
    const r = await testGithub({ repo: config.repo, branch: config.branch }, secret);
    return { config: { ...config, branch: r.branch }, meta: r.meta };
  }
  if (!/^postgres(ql)?:\/\//.test(secret)) {
    throw new Error("Informe a connection string no formato postgresql://usuario:senha@host:5432/banco");
  }
  const r = await testDatabase(secret);
  return { config, meta: r };
}
