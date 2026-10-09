# AgentFlow

Times de agentes **Claude** que criam, validam e aprovam — montados visualmente com [React Flow](https://reactflow.dev).

## O que tem

| Tela | O que faz |
| --- | --- |
| **Times de agentes** (`/flows`) | Canvas React Flow com Tarefa → Criador → Validador → Aprovador → Entrega. Execução em tempo real (streaming); se um revisor reprovar, o fluxo volta ao Criador com o feedback até aprovar ou atingir o limite de rodadas. Salvamento automático. |
| **Servidores MCP** (`/connections/mcp`) | Conecta servidores MCP remotos (Streamable HTTP/SSE), testa e lista as ferramentas. Na execução, a API da Claude conecta direto no servidor (MCP connector). |
| **Banco de dados** (`/connections/database`) | Conecta PostgreSQL (Supabase, Neon, RDS...). Agentes leem o esquema e rodam SQL **somente leitura** (transação READ ONLY, um comando por vez). |
| **GitHub** (`/connections/github`) | Conecta o repositório completo (público ou privado com token). Agentes listam e leem qualquer arquivo. |
| **Prompts** (`/prompts`) | Reescreve prompts com objetivo, contexto, critérios de aceite e formato de saída. Biblioteca para salvar. |
| **Meus agentes** (`/agents`) | Agentes Claude próprios, subagentes do **Claude Code** importados do `.md`, ou agentes externos por **webhook** (n8n, LangChain, CrewAI...). |
| **Login** | Supabase Auth (e-mail/senha e GitHub). Cada usuário só vê os próprios dados (RLS). |

Tokens e senhas são criptografados com AES-256-GCM antes de ir para o banco.

## Configuração

1. Crie um projeto no [Supabase](https://supabase.com) e rode `supabase/schema.sql` no **SQL Editor**.
2. (Opcional) Login com GitHub: Supabase → Authentication → Providers → GitHub.
3. Em Authentication → URL Configuration, adicione `https://SEU-DOMINIO/auth/callback` (e `http://localhost:3000/auth/callback`).
4. Copie `.env.example` para `.env.local` e preencha:

| Variável | Descrição |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API |
| `ANTHROPIC_API_KEY` | Chave da API da Claude |
| `ANTHROPIC_MODEL` | Padrão `claude-opus-5-5` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` — não troque depois, ou os segredos salvos deixam de abrir |

```bash
npm install
npm run dev   # http://localhost:3000
```

## Deploy na Vercel

Importe o repositório na Vercel, cadastre as mesmas variáveis de ambiente e faça o deploy. A rota de execução usa `maxDuration = 300` (limite do plano Hobby); no Pro dá para subir.

## Arquitetura

```
src/
├── proxy.ts                     # sessão Supabase + proteção das rotas
├── app/
│   ├── (app)/                   # telas logadas (painel, fluxos, agentes, conexões, prompts)
│   ├── login/  auth/            # login, callback OAuth, sair
│   └── api/                     # connections, agents, prompts, flows, flows/[id]/run
├── components/flow/             # editor React Flow, nós, inspetor, painel de execução
└── lib/
    ├── orchestrator.ts          # executa o time: ordem topológica, ferramentas, loop de revisão
    ├── integrations/            # github.ts, database.ts, mcp.ts
    ├── roles.ts                 # prompts padrão de Criador/Validador/Aprovador + veredito
    └── crypto.ts                # AES-256-GCM para segredos
```
