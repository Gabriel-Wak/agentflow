import Link from "next/link";
import { Bot, CheckCircle2, Circle, Database, GitBranch, Plug, Sparkles, Workflow } from "lucide-react";
import { requireUser } from "@/lib/supabase/server";
import { Badge, Card } from "@/components/ui";

export default async function Dashboard() {
  const { supabase } = await requireUser();
  const count = (table: string, kind?: string) => {
    let q = supabase.from(table).select("id", { count: "exact", head: true });
    if (kind) q = q.eq("kind", kind);
    return q.then((r) => r.count ?? 0);
  };
  const [flows, agents, prompts, mcp, db, gh, runs] = await Promise.all([
    count("flows"),
    count("agents"),
    count("prompts"),
    count("connections", "mcp"),
    count("connections", "database"),
    count("connections", "github"),
    supabase.from("runs").select("id, task, status, created_at, flow_id").order("created_at", { ascending: false }).limit(8),
  ]);

  const stats = [
    { label: "Times de agentes", value: flows, href: "/flows", icon: Workflow },
    { label: "Agentes", value: agents, href: "/agents", icon: Bot },
    { label: "Servidores MCP", value: mcp, href: "/connections/mcp", icon: Plug },
    { label: "Bancos", value: db, href: "/connections/database", icon: Database },
    { label: "Repositórios", value: gh, href: "/connections/github", icon: GitBranch },
    { label: "Prompts", value: prompts, href: "/prompts", icon: Sparkles },
  ];
  const steps = [
    { done: gh > 0, text: "Conecte um repositório do GitHub", href: "/connections/github" },
    { done: db > 0, text: "Conecte seu banco de dados", href: "/connections/database" },
    { done: mcp > 0, text: "Adicione um servidor MCP", href: "/connections/mcp" },
    { done: flows > 0, text: "Crie um time Criador → Validador → Aprovador", href: "/flows" },
  ];
  const tone = (s: string) => (s === "approved" ? "ok" : s === "rejected" || s === "error" ? "bad" : "warn") as "ok" | "bad" | "warn";
  const statusLabel: Record<string, string> = { approved: "aprovado", rejected: "reprovado", error: "erro", running: "rodando" };

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <h1 className="text-xl font-semibold">Painel</h1>
      <p className="mt-1 text-sm text-muted">Visão geral do seu espaço de agentes.</p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="rounded-xl border border-line bg-panel p-4 hover:border-accent/50">
            <s.icon className="h-4 w-4 text-accent" />
            <div className="mt-3 text-2xl font-semibold">{s.value}</div>
            <div className="text-xs text-muted">{s.label}</div>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <h2 className="font-medium">Primeiros passos</h2>
          <ul className="mt-4 space-y-3">
            {steps.map((s) => (
              <li key={s.text}>
                <Link href={s.href} className="flex items-center gap-3 text-sm hover:text-accent">
                  {s.done ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <Circle className="h-4 w-4 text-muted" />}
                  <span className={s.done ? "text-muted line-through" : ""}>{s.text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="font-medium">Execuções recentes</h2>
          {runs.data?.length ? (
            <ul className="mt-4 divide-y divide-line">
              {runs.data.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <Link href={`/flows/${r.flow_id}`} className="truncate hover:text-accent">{r.task}</Link>
                  <Badge tone={tone(r.status)}>{statusLabel[r.status] ?? r.status}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted">Nenhuma execução ainda. Abra um time de agentes e clique em Executar.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
