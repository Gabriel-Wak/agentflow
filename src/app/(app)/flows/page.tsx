import { Workflow } from "lucide-react";
import FlowList from "@/components/flow/FlowList";
import { PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PageHeader
        icon={<Workflow className="h-5 w-5" />}
        title="Times de agentes"
        subtitle="Cada time é um fluxo no canvas: uma Tarefa entra, o Criador produz, o Validador revisa, o Aprovador decide — e se reprovar, o ciclo volta para o Criador com o feedback."
      />
      <FlowList />
    </div>
  );
}
