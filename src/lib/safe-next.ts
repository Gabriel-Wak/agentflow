/**
 * Destino pós-login seguro: só caminhos internos. Bloqueia URL absoluta, "//host" e "/\host"
 * (o navegador trata a barra invertida como "//"), evitando redirecionar para site externo.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  try {
    // Resolve contra uma origem fictícia: se mudar de origem, não é caminho interno.
    const u = new URL(next, "http://interno.local");
    return u.origin === "http://interno.local" ? `${u.pathname}${u.search}${u.hash}` : fallback;
  } catch {
    return fallback;
  }
}
