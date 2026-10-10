-- Índices para as consultas por usuário (o RLS filtra por user_id em toda leitura)
-- e status "cancelled" das execuções interrompidas pelo navegador.
create index if not exists runs_user_created_idx on public.runs(user_id, created_at desc);
create index if not exists flows_user_updated_idx on public.flows(user_id, updated_at desc);
create index if not exists connections_user_kind_idx on public.connections(user_id, kind, created_at desc);

comment on column public.runs.status is 'running | approved | rejected | error | cancelled';
