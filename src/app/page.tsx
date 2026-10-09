import Link from "next/link";
import { Bot, Database, GitBranch, Plug, Sparkles, Workflow } from "lucide-react";

const features = [
  { icon: Workflow, title: "3 agentes em time", text: "Criador, Validador e Aprovador conversam em um fluxo visual e repetem o ciclo até aprovar." },
  { icon: Plug, title: "Servidores MCP", text: "Conecte qualquer servidor MCP remoto e dê ferramentas reais aos agentes." },
  { icon: Database, title: "Seu banco de dados", text: "PostgreSQL com acesso somente leitura: os agentes consultam o esquema e os dados." },
  { icon: GitBranch, title: "Repositório GitHub", text: "Os agentes navegam e leem o repositório inteiro antes de criar ou revisar." },
  { icon: Sparkles, title: "Prompts muito melhores", text: "Reescreve seu prompt com contexto, critérios de aceite e formato de saída." },
  { icon: Bot, title: "Seus agentes", text: "Importe subagentes do Claude Code (.md) ou ligue agentes externos por webhook." },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-10 sm:px-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold"><Workflow className="h-5 w-5 text-accent" /> AgentFlow</div>
        <Link href="/login" className="rounded-lg border border-line px-4 py-2 text-sm hover:border-accent">Entrar</Link>
      </header>
      <section className="py-20 text-center">
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Times de agentes <span className="text-accent">Claude</span> que criam, validam e aprovam.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-muted">
          Monte o fluxo no canvas, ligue MCP, banco de dados e GitHub, e veja três agentes trabalhando juntos em tempo real.
        </p>
        <Link href="/login" className="mt-8 inline-flex rounded-lg bg-accent px-6 py-3 font-medium text-white hover:brightness-110">Começar agora</Link>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-line bg-panel p-5">
            <f.icon className="h-5 w-5 text-accent" />
            <h3 className="mt-3 font-medium">{f.title}</h3>
            <p className="mt-1 text-sm text-muted">{f.text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
