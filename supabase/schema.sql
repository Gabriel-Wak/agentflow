-- AgentFlow — schema do Supabase.
-- Rode no SQL Editor do seu projeto Supabase (uma vez).

create extension if not exists "pgcrypto";

-- Conexões: MCP, banco de dados, GitHub. Segredos ficam criptografados (AES-256-GCM) pela aplicação.
create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('mcp', 'database', 'github')),
  name text not null,
  config jsonb not null default '{}'::jsonb,   -- dados públicos (url, repo, branch...)
  secret text,                                 -- token/senha criptografados
  status text not null default 'unknown',
  meta jsonb not null default '{}'::jsonb,     -- resultado do último teste (ferramentas, tabelas...)
  created_at timestamptz not null default now()
);

-- Agentes salvos (próprios, subagentes do Claude Code ou webhooks externos).
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  kind text not null check (kind in ('claude', 'claude_code', 'webhook')),
  role text not null default 'custom',
  description text not null default '',
  system_prompt text not null default '',
  model text not null default 'claude-opus-5-5',
  config jsonb not null default '{}'::jsonb,   -- webhook url, ferramentas...
  secret text,                                 -- header de autorização do webhook (criptografado)
  created_at timestamptz not null default now()
);

-- Biblioteca de prompts melhorados.
create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text not null,
  original text not null,
  improved text not null,
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- Fluxos do React Flow.
create table if not exists public.flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  nodes jsonb not null default '[]'::jsonb,
  edges jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Execuções dos fluxos.
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  flow_id uuid references public.flows(id) on delete cascade,
  task text not null,
  status text not null default 'running',
  events jsonb not null default '[]'::jsonb,
  output text,
  created_at timestamptz not null default now()
);

create index if not exists connections_user_idx on public.connections(user_id);
create index if not exists agents_user_idx on public.agents(user_id);
create index if not exists prompts_user_idx on public.prompts(user_id);
create index if not exists flows_user_idx on public.flows(user_id);
create index if not exists runs_flow_idx on public.runs(flow_id, created_at desc);

-- Row Level Security: cada usuário só enxerga o que é dele.
do $$
declare t text;
begin
  foreach t in array array['connections', 'agents', 'prompts', 'flows', 'runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
  end loop;
end $$;
