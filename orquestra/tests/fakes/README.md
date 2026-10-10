# Binários falsos da Orquestra (testes)

Imitam `gh`, `git`, `mysql`, `mysql_config_editor` e `claude` sem rede, sem banco e sem gastar o
limite do Claude. Usados por `npm run test:orquestra` e para subir um daemon de teste:

```sh
F=$PWD/orquestra/tests/fakes; T=$(mktemp -d); mkdir -p "$T/state"
ORQUESTRA_HOME="$T/home" ORQUESTRA_PORT=4620 ORQUESTRA_ORIGINS=http://localhost:3003 \
ORQUESTRA_GH_BIN="$F/gh" ORQUESTRA_GIT_BIN="$F/git" ORQUESTRA_MYSQL_BIN="$F/mysql" ORQUESTRA_CLAUDE_BIN="$F/claude" \
FAKE_STATE="$T/state" ORQUESTRA_CAFFEINATE=0 ORQUESTRA_DAILY_RESTART= npx tsx orquestra/daemon.ts
```

Estados (crie/apague arquivos em `$FAKE_STATE` e mande `af:refresh` / `af:sync`):

| arquivo | efeito |
|---|---|
| `mysql-sem-perfil` | perfil `alwaysfit-readonly` não existe (`configured: false`) |
| `mysql-fora` | perfil existe, banco não responde (`ok: false`) |
| `gh-fora` | `gh repo list` falha |
| `repos.json` | substitui a lista de repositórios devolvida pelo `gh` |
| `log` | (criado pelos falsos) cada chamada: `bin<TAB>pasta<TAB>argumentos` |

Consultas do `mysql` falso: `clientes` devolve linhas com CPF/e-mail/telefone/endereço/CEP, `grande` devolve 500
linhas, `lento` demora 60s, `erro` devolve erro de sintaxe; qualquer outra devolve uma linha simples.
