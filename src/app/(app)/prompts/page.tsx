import { Sparkles } from "lucide-react";
import PromptStudio from "@/components/PromptStudio";
import { PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PageHeader
        icon={<Sparkles className="h-5 w-5" />}
        title="Estúdio de prompts"
        subtitle="Cole um prompt simples e receba uma versão com objetivo, contexto, critérios de aceite e formato de saída — pronta para o Claude Code ou para seus agentes."
      />
      <PromptStudio />
    </div>
  );
}
