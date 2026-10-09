import { GitBranch } from "lucide-react";
import ConnectionsManager from "@/components/ConnectionsManager";
import { PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PageHeader icon={<GitBranch className="h-5 w-5" />} title="Repositórios GitHub" subtitle="Conecte o repositório completo. Os agentes listam e leem qualquer arquivo da branch escolhida antes de criar ou revisar." />
      <ConnectionsManager kind="github" />
    </div>
  );
}
