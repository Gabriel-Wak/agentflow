"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Database, GitBranch, LayoutDashboard, LogOut, Menu, Music, Plug, Sparkles, Workflow, X } from "lucide-react";
import { useState } from "react";

const NAV = [
  { href: "/dashboard", label: "Painel", icon: LayoutDashboard },
  { href: "/orquestra", label: "Orquestra", icon: Music },
  { href: "/flows", label: "Times de agentes", icon: Workflow },
  { href: "/agents", label: "Meus agentes", icon: Bot },
  { href: "/prompts", label: "Prompts", icon: Sparkles },
  { section: "Conexões" },
  { href: "/connections/mcp", label: "Servidores MCP", icon: Plug },
  { href: "/connections/database", label: "Banco de dados", icon: Database },
  { href: "/connections/github", label: "GitHub", icon: GitBranch },
] as const;

export default function Sidebar({ email }: { email: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <Link href="/dashboard" className="mb-4 flex items-center gap-2 px-2 pt-2 font-semibold">
        <Workflow className="h-5 w-5 text-accent" /> AgentFlow
      </Link>
      {NAV.map((item) =>
        "section" in item ? (
          <div key={item.section} className="mt-4 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted/70">{item.section}</div>
        ) : (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${
              path === item.href || path.startsWith(item.href + "/") ? "bg-accent/15 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg"
            }`}
          >
            <item.icon className="h-4 w-4" /> {item.label}
          </Link>
        ),
      )}
      <div className="mt-auto border-t border-line pt-3">
        <div className="truncate px-2 text-xs text-muted">{email}</div>
        <form action="/auth/signout" method="post">
          <button className="mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted hover:bg-panel-2 hover:text-fg">
            <LogOut className="h-4 w-4" /> Sair
          </button>
        </form>
      </div>
    </nav>
  );

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-line bg-panel md:block">{nav}</aside>
      <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-3 md:hidden">
        <span className="flex items-center gap-2 font-semibold"><Workflow className="h-5 w-5 text-accent" /> AgentFlow</span>
        <button onClick={() => setOpen(true)} aria-label="Abrir menu"><Menu className="h-5 w-5" /></button>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/60 md:hidden" onClick={() => setOpen(false)}>
          <aside className="h-full w-64 border-r border-line bg-panel" onClick={(e) => e.stopPropagation()}>
            <button className="absolute right-4 top-4" onClick={() => setOpen(false)} aria-label="Fechar"><X className="h-5 w-5" /></button>
            {nav}
          </aside>
        </div>
      )}
    </>
  );
}
