# Always Flow

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

Modelos: Claude Opus 5.5 (padrão), Sonnet 5.5, Haiku 5.5 e Fable 5.1, com thinking adaptativo, nível de esforço por agente e fallback automático em caso de recusa.

## Segurança

- **Segredos** (tokens, senhas, connection strings) criptografados com AES-256-GCM antes de ir para o banco; a tela só mostra uma dica mascarada. Se a `ENCRYPTION_KEY` mudar, o erro diz qual conexão precisa ser cadastrada de novo.
- **Isolamento por usuário** com Row Level Security em todas as tabelas.
- **Banco dos agentes somente leitura**, em camadas: transação `READ ONLY`, um comando por vez, só `SELECT/WITH/EXPLAIN/SHOW/VALUES`, e bloqueio de funções que escapam da transação (`COPY`, `dblink`, `lo_*`, `pg_read_file`, `pg_terminate_backend`...). Se a connection string for de um usuário administrador, a tela avisa — use um usuário com `GRANT SELECT`.
- **Entradas validadas** (zod) em todas as rotas da API; corpo inválido responde 400 com o campo errado.
- **Login sem redirecionamento aberto**: o `?next=` só aceita caminhos internos.
- **Servidores MCP** precisam ser `https://` públicos (quem conecta na execução é a API da Claude, pela internet).
- **Execuções canceladas de verdade**: fechar a aba ou clicar em Parar interrompe as chamadas à API no servidor (nada continua gastando em segundo plano).

## Orquestra (agentes de verdade no seu computador)

A tela **Orquestra** (`/orquestra`) é um canvas infinito onde cada agente é um **terminal real** — Claude Code, Codex ou shell — rodando na sua máquina. Ligue um terminal ao outro e eles conversam sozinhos.

```bash
npm run orquestra   # daemon local: abre os terminais e faz a ponte entre os agentes
```

Abra o link que ele imprime (`http://localhost:3001/orquestra#token=...`).

- **Modo Maestro** (botão 👑 **Maestro**, ou a coroa no cabeçalho de qualquer Claude Code): um agente que vê e comanda **todos** os outros. Você pede em português no compositor (sem @, a mensagem vai para o Maestro) e ele monta a equipe, delega, acompanha e entrega. Funciona com o navegador fechado: o que ele fizer aparece no canvas quando você reabrir.
  - Ferramentas exclusivas: `criar_agente` (Claude Code, Codex ou terminal, com papel e instruções), `ligar_agentes`, `desligar_agentes`, `definir_papel`, `reiniciar_agente`, `parar_agente`, `remover_agente`, `agendar_rotina`, `listar_rotinas`, `cancelar_rotina`.
  - Fala e lê o terminal de qualquer agente, ligado a ele ou não.
- **Rotinas** (botão **Rotinas**): mensagens repetidas para um agente em intervalo fixo (ex.: ciclo do Vigia a cada 15 min). Criadas por você ou pelo Maestro; ficam em `~/.agentflow/rotinas.json` e rodam enquanto o daemon estiver ligado.
- **Notificações**: qualquer agente usa `notificar`; aparece no canvas e, se for urgente ou ninguém estiver olhando, como notificação do macOS.
- **Ligações = permissões**: um agente comum só fala com quem está ligado a ele no canvas.
- **Fila de confiança**: numa pasta nova o Claude Code pergunta se você confia nela. Só um terminal pergunta; os outros esperam "na fila" e abrem assim que você responde.
- **Ferramentas MCP dos agentes** (servidor `orquestra`, configurado automaticamente no Claude Code):
  `listar_agentes`, `enviar_mensagem`, `ler_terminal`, `escrever_nota`, `ler_notas`, `notificar`, `limite_claude` (+ as do Maestro acima).
- **Compositor com @menção**: `@Criador implemente X` digita a mensagem no terminal do Criador.
- **Trio**: cria Criador → Validador → Aprovador (Claude Code) já ligados em ciclo.
- **Notas**: os agentes escrevem progresso e decisões em notas no canvas.
- **Central AF**: monta a Central de Pedidos Always Fit — **Maestro** ligado a Atendente, Vigia, Investigador, Executor e Escriba, cada um com seu prompt (ícone 📜 no terminal para ver/editar) e ferramentas proibidas por papel (ícone 🛡; só o Executor roda `actions.py`). O Maestro já nasce em Modo Maestro e leituras (`db_reads.py`, `integration_reads.py`, `mysql --login-path=alwaysfit-readonly`...) rodam sem pedir permissão; o resto o Claude Code pergunta no terminal. Cria também as notas "Política de autonomia" e "Pendências" (campos `<...>` do prompt a preencher). Prompt em `src/lib/orquestra/presets/af-orquestra.ts`.
- **Limite do Claude**: anéis no topo, como no Maestri (de fora para dentro: sessão de 5h, semanal, limite por modelo). Clique para ver % e quando renova. O daemon lê pela própria CLI (`claude -p` + `get_usage`) a cada 5 min (`ORQUESTRA_USAGE_SECONDS`), no máximo 1x/min. Os agentes consultam o mesmo número pela ferramenta `limite_claude` — o Maestro usa para desacelerar o Vigia acima de 80%.
- **Partituras**: salve a formação (agentes, papéis, notas, ligações) e reuse; ficam em `~/.agentflow/partituras`.
- **Pasta do projeto**: escolha no topo da tela; os agentes novos abrem nela. Na primeira vez numa pasta, o Claude Code pergunta se você confia nela — responda no próprio terminal.

Variáveis úteis do daemon: `ORQUESTRA_PORT` (padrão 4545), `ORQUESTRA_HOME` (padrão `~/.agentflow`), `ORQUESTRA_ORIGINS` (outras origens do canvas), `ORQUESTRA_USAGE_SECONDS` (intervalo do contador de limite) e `ORQUESTRA_CLAUDE_BIN` (outra CLI do Claude). O daemon escreve um log discreto (sem tokens nem texto das mensagens) e `GET /health` responde versão e contagem de agentes.

> Mensagens e rotinas **digitam** no terminal do agente. Num agente do tipo *terminal* (shell), o texto + Enter roda como comando — com o mesmo poder que você digitando. Use agentes Claude Code para tarefas em linguagem natural.

Segurança: o daemon só escuta em `127.0.0.1`, exige o token de `~/.agentflow/orquestra-token`, aceita apenas origens conhecidas (`ORQUESTRA_ORIGINS` para adicionar seu domínio) e cada agente recebe uma chave MCP própria. Qualquer CLI com MCP pode usar a variável `ORQUESTRA_MCP_URL` disponível dentro de cada terminal.

## Always Fit 24h

A Orquestra se conecta aos sistemas da Always Fit e pode ficar analisando 24 horas por dia neste Mac — **só lendo e reportando**: nenhum agente altera código, banco, nem faz commit/push/PR.

**1. Conectar o banco (uma vez, você digita a senha):**

```bash
mysql_config_editor set --login-path=alwaysfit-readonly \
  --host=read-db-homolog-mysql.c3q0u4ksqqea.sa-east-1.rds.amazonaws.com --port=3306 \
  --user=gabriel.bezerra --password
```

A senha fica criptografada em `~/.mylogin.cnf`; o Always Flow só usa o nome do perfil e nunca lê esse arquivo. As consultas dos agentes passam por um filtro de leitura (SELECT/SHOW/DESCRIBE/EXPLAIN, uma por vez, transação READ ONLY, tempo máximo) e **CPF, e-mail e telefone saem mascarados**.

**2. Repositórios:** com o `gh` logado, o daemon mantém cópias de leitura de todos os repositórios da organização [AlwaysFit](https://github.com/AlwaysFit) em `~/.agentflow/alwaysfit/repos` (atualizadas de hora em hora). Suas pastas de trabalho em `~/Developer/AlwaysFit` não são tocadas.

**3. Na Orquestra:** painel **Always Fit** (também no menu lateral) mostra o status do banco e dos repositórios, os **relatórios** dos agentes e o botão **Manter esta formação rodando 24h**. Em cada terminal, o botão **Conectar** liga agentes entre si e aos sistemas (banco/repositórios).

**4. Formação "Sustentação 24h"**, com rodadas de 1 em 1 hora:

| Agente | Vigia |
|---|---|
| Maestro | coordena, agenda as rodadas, consolida o resumo diário, avisa o que é crítico |
| Vigia de Incidentes | Central de Sustentação (`central_de_sustentacao`): monitores, filas, erros de integração, incidentes |
| Analista de Chamados | AlwaysTicket (`always-ticket`): chamados parados, SLA estourando, padrões, sugestão de resposta |
| Vigia de Pedidos | fluxo da Central AF no banco: checkout → pagamento → hub → ERP → NF → logística |
| Auditor de Código | saúde dos repositórios: bugs, segurança, testes |

Relatórios ficam em `~/.agentflow/relatorios/` (por dia) e no painel; os críticos também viram notificação do macOS. O Maestro desacelera sozinho quando o limite do Claude passa de 80%.

**5. Ligar o 24h (uma vez):**

```bash
scripts/alwaysflow-24h.sh instalar     # compila, instala os serviços do macOS e impede o Mac de dormir
scripts/alwaysflow-24h.sh status       # está tudo no ar?
scripts/alwaysflow-24h.sh logs         # últimas linhas dos logs
scripts/alwaysflow-24h.sh reiniciar    # depois de atualizar o código
scripts/alwaysflow-24h.sh desinstalar
```

A primeira sincronização clona os ~90 repositórios (clone parcial, alguns minutos); as seguintes só buscam o que mudou.

Ajustes por variável de ambiente do daemon: `ORQUESTRA_AF_SYNC_MINUTES` (intervalo da sincronização, padrão 60), `ORQUESTRA_AF_ORG` (padrão `AlwaysFit`), `ORQUESTRA_AF_LOGIN_PATH` (padrão `alwaysfit-readonly`), `ORQUESTRA_DAILY_RESTART` (hora do reinício diário dos agentes, padrão `04:00`; vazio desliga) e `ORQUESTRA_CAFFEINATE=0` (não segurar o Mac acordado).

Os serviços reiniciam sozinhos se caírem e sobem com o Mac. A formação marcada como 24h volta sozinha quando o daemon inicia, e os agentes Claude são reiniciados de madrugada para não acumular contexto. **MacBook: com a tampa fechada o Mac dorme** (a menos que esteja na tomada com monitor externo) — deixe a tampa aberta.

## Rodar localmente (recomendado para desenvolver)

Requisitos: Node 20+ e Docker.

```bash
npm install
npx supabase start          # sobe Postgres + Auth locais e aplica supabase/migrations
cp .env.example .env.local  # preencha com a URL/ANON_KEY que o comando acima mostra
npm run dev -- -p 3001      # http://localhost:3001
```

- Painel do banco (Supabase Studio): http://127.0.0.1:54323
- E-mails de confirmação/login (Mailpit): http://127.0.0.1:54324
- Parar: `npx supabase stop` (os dados ficam salvos) · zerar o banco: `npx supabase db reset`
- Mudou o banco? Crie um arquivo novo em `supabase/migrations/` e rode `npx supabase migration up` (ou `db reset` para zerar).

Verificação:

```bash
npm run typecheck        # TypeScript
npm run lint             # ESLint
npm test                 # testes do servidor (segurança, SQL, criptografia, motor dos times)
npm run test:orquestra   # testes do daemon da Orquestra (sobe um daemon isolado, não gasta seu plano)
```

## Login com GitHub

Precisa de um **OAuth App** no GitHub (uma vez):

1. Abra [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps** → **New OAuth App**.
2. Preencha:
   - **Homepage URL**: `http://localhost:3001`
   - **Authorization callback URL**: `http://127.0.0.1:54321/auth/v1/callback` (é o Supabase local que recebe o retorno)
3. Crie, copie o **Client ID** e gere um **Client secret**.
4. `cp supabase/.env.example supabase/.env` e cole os dois valores (o arquivo fica fora do git).
5. Em `supabase/config.toml`, na seção `[auth.external.github]`, troque `enabled = false` para `true`.
6. `npx supabase stop && npx supabase start` (os dados ficam salvos).

O botão "Continuar com GitHub" fica desativado, com um aviso, enquanto o provedor não estiver ligado. Em produção: Supabase → Authentication → Providers → GitHub, com o callback `https://SEU-PROJETO.supabase.co/auth/v1/callback`.

## Configuração em produção

1. Crie um projeto no [Supabase](https://supabase.com) e rode `supabase/migrations/*.sql` no **SQL Editor** (ou `npx supabase db push`).
2. (Opcional) Login com GitHub: veja a seção acima.
3. Em Authentication → URL Configuration, adicione `https://SEU-DOMINIO/auth/callback`.
4. Copie `.env.example` para `.env.local` e preencha:

| Variável | Descrição |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API |
| `ANTHROPIC_API_KEY` | Chave da API da Claude |
| `ANTHROPIC_MODEL` | Padrão `claude-opus-5-5` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` — não troque depois, ou os segredos salvos deixam de abrir |

## Deploy na Vercel

Importe o repositório na Vercel, cadastre as mesmas variáveis de ambiente e faça o deploy. A rota de execução usa `maxDuration = 300` (limite do plano Hobby); no Pro dá para subir.

## Arquitetura

```
orquestra/daemon.ts              # daemon local: PTYs, WebSocket e servidor MCP dos agentes
orquestra/usage.ts               # leitura dos limites do plano do Claude Code
orquestra/support.ts             # fila de confiança, rotinas, notificações, ambiente limpo dos agentes
src/
├── proxy.ts                     # sessão Supabase + proteção das rotas
├── app/
│   ├── (app)/                   # telas logadas (painel, fluxos, agentes, conexões, prompts)
│   ├── login/  auth/            # login, callback OAuth, sair
│   └── api/                     # connections, agents, prompts, flows, flows/[id]/run
├── components/flow/             # editor React Flow, nós, inspetor, painel de execução
├── components/orquestra/        # canvas da Orquestra: terminais xterm, notas, compositor, partituras
└── lib/
    ├── orchestrator.ts          # executa o time: ordem topológica, ferramentas, loop de revisão
    ├── integrations/            # github.ts, database.ts, mcp.ts
    ├── roles.ts                 # prompts padrão de Criador/Validador/Aprovador + veredito
    └── crypto.ts                # AES-256-GCM para segredos
```
