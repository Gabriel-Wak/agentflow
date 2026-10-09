import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

/**
 * Testa um servidor MCP remoto (Streamable HTTP, com fallback para SSE) e lista as ferramentas.
 * Na execução dos fluxos, quem conecta no servidor é a própria API da Claude (MCP connector).
 */
export async function testMcp(url: string, token: string) {
  const requestInit: RequestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  const errors: string[] = [];

  for (const kind of ["http", "sse"] as const) {
    const client = new Client({ name: "agentflow", version: "1.0.0" });
    try {
      const transport =
        kind === "http"
          ? new StreamableHTTPClientTransport(new URL(url), { requestInit })
          : new SSEClientTransport(new URL(url), { requestInit });
      await client.connect(transport);
      const { tools } = await client.listTools();
      const server = client.getServerVersion();
      return {
        transport: kind,
        server: server ? `${server.name} ${server.version}` : "",
        tools: tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 200) })),
      };
    } catch (e) {
      errors.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await client.close().catch(() => {});
    }
  }
  throw new Error(`Não foi possível conectar ao servidor MCP. ${errors.join(" | ")}`);
}
