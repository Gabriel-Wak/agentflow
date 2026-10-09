import { Plug } from "lucide-react";
import ConnectionsManager from "@/components/ConnectionsManager";
import { PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PageHeader icon={<Plug className="h-5 w-5" />} title="Servidores MCP" subtitle="Conecte servidores MCP remotos (Model Context Protocol). As ferramentas deles ficam disponíveis para os agentes do fluxo — a API da Claude conecta direto no servidor." />
      <ConnectionsManager kind="mcp" />
    </div>
  );
}
