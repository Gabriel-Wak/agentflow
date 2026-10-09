import { Bot } from "lucide-react";
import AgentsManager from "@/components/AgentsManager";
import { PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PageHeader
        icon={<Bot className="h-5 w-5" />}
        title="Meus agentes"
        subtitle="Conecte os agentes que você já tem: crie agentes Claude, importe subagentes do Claude Code ou ligue agentes externos por webhook (n8n, LangChain, CrewAI...). Eles ficam disponíveis em qualquer nó do fluxo."
      />
      <AgentsManager />
    </div>
  );
}
