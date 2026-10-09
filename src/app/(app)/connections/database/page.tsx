import { Database } from "lucide-react";
import ConnectionsManager from "@/components/ConnectionsManager";
import { PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PageHeader icon={<Database className="h-5 w-5" />} title="Banco de dados" subtitle="Conecte seu PostgreSQL. Os agentes podem ler o esquema e rodar consultas somente leitura (transação READ ONLY, um comando por vez). O servidor precisa aceitar conexões da internet." />
      <ConnectionsManager kind="database" />
    </div>
  );
}
