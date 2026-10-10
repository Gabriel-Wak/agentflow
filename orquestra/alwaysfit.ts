/**
 * Integração com os sistemas da Always Fit: espelhos dos repositórios do GitHub e a réplica
 * de LEITURA do banco MySQL. A IA só analisa e reporta: nada aqui escreve em repositório
 * remoto, em banco ou nas cópias de trabalho do usuário.
 *
 * - Espelhos em <HOME>/alwaysfit/repos/<nome>: cópias só de leitura, que podem ser resetadas
 *   à vontade. O token do GitHub nunca vai para arquivo nem para a URL do remote: o git pede a
 *   credencial ao `gh auth git-credential` a cada fetch.
 * - Banco pelo perfil `mysql --login-path=alwaysfit-readonly` (criado pelo usuário com
 *   mysql_config_editor). O daemon nunca vê nem guarda a senha.
 */
import fs from "fs";
import path from "path";
import type { AfStatus } from "../src/lib/orquestra/protocol";
import { cleanEnv, log, resolveBin, run, shellQuote } from "./support";

export interface AfConfig {
  /** Pasta da Orquestra (ORQUESTRA_HOME). */
  home: string;
  org: string;
  loginPath: string;
  syncMinutes: number;
  concurrency: number;
}

export interface RepoState {
  name: string;
  branch: string | null;
  pushedAt?: string;
  /** "<hash> <data> <assunto>" do último commit do espelho. */
  lastCommit?: string;
  lastSyncAt?: string;
  error?: string;
}

const CLONE_TIMEOUT = 15 * 60_000;
const GIT_TIMEOUT = 5 * 60_000;
const DB_TIMEOUT = 15_000;
const SQL_TIMEOUT = 25_000; // MAX_EXECUTION_TIME do servidor é 15s; aqui é a rede de segurança
const SQL_MAX_BYTES = 60_000;
const SQL_MAX_ROWS = 200;
// Nome de repositório do GitHub: sem barra, sem "..": nada sai da pasta dos espelhos.
const REPO_NAME = /^[A-Za-z0-9_.-]+$/;

// ---------------------------------------------------------------- validação de SQL

const ALLOWED_START = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const FORBIDDEN_WORDS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|CALL|DO|HANDLER|LOCK|UNLOCK|SET|KILL|FLUSH|RESET|PURGE|INSTALL|UNINSTALL|SHUTDOWN|RESTART|PREPARE|EXECUTE|DEALLOCATE|INTO|OUTFILE|DUMPFILE|LOAD|IMPORT|CLONE|START|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|XA|CACHE|ANALYZE\s+TABLE|OPTIMIZE|REPAIR|CHECKSUM)\b/i;
const FORBIDDEN_FUNCS = /\b(SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|IS_FREE_LOCK|IS_USED_LOCK|LOAD_FILE|MASTER_POS_WAIT|SOURCE_POS_WAIT|WAIT_FOR_EXECUTED_GTID_SET|WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS)\s*\(/i;

/**
 * Esqueleto da consulta para análise: tira comentários e troca literais (strings e
 * identificadores entre crases) por marcadores, para `';'` ou `sleep` dentro de uma string
 * não contarem — e para nada escondido num comentário passar.
 */
function skeleton(sql: string): { ok: true; code: string } | { ok: false; error: string } {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "/" && next === "*") {
      // /*! ... */ e /*+ ... */ são executados pelo MySQL: nunca aceitos.
      if (sql[i + 2] === "!" || sql[i + 2] === "+") return { ok: false, error: "comentários executáveis (/*! */ ou /*+ */) não são permitidos" };
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return { ok: false, error: "comentário /* sem fim" };
      out += " ";
      i = end + 2;
    } else if (c === "#" || (c === "-" && next === "-" && /[\s]/.test(sql[i + 2] ?? " "))) {
      const end = sql.indexOf("\n", i);
      out += " ";
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === "\\" && c !== "`") j++;
        else if (sql[j] === c) {
          if (sql[j + 1] === c) j++; // aspas dobradas
          else break;
        }
      }
      if (j >= sql.length) return { ok: false, error: `${c === "`" ? "identificador" : "texto"} entre ${c} sem fechar` };
      out += c === "`" ? " _ident_ " : " _str_ ";
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { ok: true, code: out };
}

/** Confere se é UMA consulta de leitura. Devolve a consulta limpa (sem `;` final) ou o motivo da recusa. */
export function validateSql(input: string): { ok: true; sql: string } | { ok: false; error: string } {
  const sql = input.trim().replace(/[;\s]+$/, "");
  if (!sql) return { ok: false, error: "consulta vazia" };
  if (sql.length > 20_000) return { ok: false, error: "consulta grande demais (máx. 20 mil caracteres)" };
  const sk = skeleton(sql);
  if (!sk.ok) return sk;
  const code = sk.code.trim();
  if (code.includes(";")) return { ok: false, error: "só uma consulta por vez (sem ; no meio)" };
  if (code.includes("\\")) return { ok: false, error: "barra invertida fora de texto não é permitida" };
  if (!ALLOWED_START.test(code)) return { ok: false, error: "só são permitidos SELECT, WITH, SHOW, DESCRIBE/DESC e EXPLAIN" };
  const word = code.match(FORBIDDEN_WORDS);
  if (word) return { ok: false, error: `"${word[1].toUpperCase()}" não é permitido: a ferramenta é só de leitura` };
  const fn = code.match(FORBIDDEN_FUNCS);
  if (fn) return { ok: false, error: `a função ${fn[1].toUpperCase()}() não é permitida` };
  return { ok: true, sql };
}

// ---------------------------------------------------------------- máscara de dados pessoais

const digits = (s: string) => s.replace(/\D/g, "");

export function maskCpf(v: string) {
  const d = digits(v);
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : v ? "***" : v;
}

export function maskEmail(v: string) {
  const at = v.indexOf("@");
  if (at < 0) return v ? "***" : v;
  return `${v.slice(0, Math.min(2, at))}***${v.slice(at)}`;
}

export function maskPhone(v: string) {
  let d = digits(v);
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length < 8) return v ? "***" : v;
  const last = d.slice(-4);
  return d.length >= 10 ? `(${d.slice(0, 2)}) *****-${last}` : `*****-${last}`;
}

/** CEP: mostra só os 3 últimos dígitos (região aproximada sem identificar o endereço). */
export function maskCep(v: string) {
  const d = digits(v);
  return d.length === 8 ? `*****-${d.slice(5)}` : v ? "***" : v;
}

const hidden = (v: string) => (v ? "***" : v);

// Ordem importa: a primeira regra que casar vale (ex.: email_address é e-mail, não endereço).
// Palavras curtas (cep, rua, zip) só como palavra inteira no nome: "recepcao" não é CEP.
const SENSITIVE_COLUMNS: [RegExp, (v: string) => string][] = [
  [/cpf/i, maskCpf],
  [/e-?mail/i, maskEmail],
  [/fone|celular|phone|whats|^tel$|^tel_|_tel$/i, maskPhone],
  [/(^|_)(cep|zip|zipcode|zip_code)($|_)|postal/i, maskCep],
  [/endere[cç]o|logradouro|(^|_)rua($|_)|complemento|bairro|address|street/i, hidden],
];

/** Máscara em texto livre: vale para qualquer coluna (ex.: JSON, observações). */
export function maskText(text: string) {
  return text
    .replace(/([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, "$1***@$2")
    .replace(/(?<![\d.])(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})(?![\d])/g, "***.$2.$3-**")
    .replace(/(?:\+?55[\s-]?)?\((\d{2})\)\s?9?\d{4}[\s-]?(\d{4})(?!\d)/g, "($1) *****-$2")
    .replace(/(?<![\d*])(?:\+?55[\s-]?)?(\d{2})[\s-]9?\d{4}[\s-](\d{4})(?!\d)/g, "($1) *****-$2")
    .replace(/(?<![\d.*-])\d{5}-(\d{3})(?![\d-])/g, "*****-$1");
}

/**
 * Mascara a saída do `mysql --batch` (TSV com cabeçalho): colunas com nome sensível (cpf,
 * email, telefone...) inteiras, e CPF/e-mail/telefone soltos em qualquer outra coluna.
 */
export function maskTsv(tsv: string) {
  const lines = tsv.split("\n");
  if (!lines.length) return tsv;
  const header = lines[0].split("\t");
  const byColumn = header.map((h) => SENSITIVE_COLUMNS.find(([re]) => re.test(h))?.[1]);
  return [
    lines[0],
    ...lines.slice(1).map((line) =>
      line
        .split("\t")
        .map((cell, i) => (cell === "NULL" ? cell : byColumn[i] ? byColumn[i]!(cell) : maskText(cell)))
        .join("\t"),
    ),
  ].join("\n");
}

// ---------------------------------------------------------------- integração

export class AlwaysFit {
  readonly reposDir: string;
  private stateFile: string;
  private repos = new Map<string, RepoState>();
  private timer?: NodeJS.Timeout;
  private syncing: Promise<void> | null = null;
  private bins: { gh: string | null; git: string | null; mysql: string | null; editor: string | null } = { gh: null, git: null, mysql: null, editor: null };
  status: AfStatus;

  constructor(
    private cfg: AfConfig,
    private onChange: (s: AfStatus) => void,
  ) {
    const base = path.join(cfg.home, "alwaysfit");
    this.reposDir = path.join(base, "repos");
    this.stateFile = path.join(base, "repos.json");
    fs.mkdirSync(this.reposDir, { recursive: true, mode: 0o700 });
    try {
      for (const r of JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as RepoState[]) if (r && typeof r.name === "string" && REPO_NAME.test(r.name)) this.repos.set(r.name, r);
    } catch {
      /* primeira vez */
    }
    this.status = {
      db: { configured: false, ok: false },
      repos: { org: cfg.org, total: this.repos.size, synced: this.syncedCount(), syncing: false, dir: this.reposDir },
    };
  }

  /** Verifica o banco, sincroniza ao subir e depois a cada `syncMinutes`. */
  start() {
    this.resolveBins();
    void this.checkDb();
    void this.sync();
    this.timer = setInterval(() => {
      void this.checkDb();
      void this.sync();
    }, this.cfg.syncMinutes * 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private resolveBins() {
    this.bins.gh = resolveBin("gh", "ORQUESTRA_GH_BIN");
    this.bins.git = resolveBin("git", "ORQUESTRA_GIT_BIN");
    this.bins.mysql = resolveBin("mysql", "ORQUESTRA_MYSQL_BIN");
    // O mysql_config_editor vem junto com o cliente (mesma pasta).
    const sibling = this.bins.mysql ? path.join(path.dirname(this.bins.mysql), "mysql_config_editor") : null;
    this.bins.editor = sibling && fs.existsSync(sibling) ? sibling : resolveBin("mysql_config_editor", "ORQUESTRA_MYSQL_CONFIG_EDITOR_BIN");
  }

  private set(patch: { db?: Partial<AfStatus["db"]>; repos?: Partial<AfStatus["repos"]> }) {
    const next: AfStatus = { db: { ...this.status.db, ...patch.db }, repos: { ...this.status.repos, ...patch.repos } };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.onChange(next);
  }

  /** Reverifica binários, banco e repositórios (af:refresh). */
  async refresh() {
    this.resolveBins();
    await Promise.all([this.checkDb(), this.sync()]);
  }

  // ------------------------------------------------ banco

  async checkDb() {
    const checkedAt = new Date().toISOString();
    const { mysql, editor } = this.bins;
    if (!mysql) {
      this.set({ db: { configured: false, ok: false, host: undefined, error: "cliente mysql não encontrado (instale com: brew install mysql-client)", checkedAt } });
      return;
    }
    let host: string | undefined;
    if (editor) {
      // Só o "print" do próprio mysql_config_editor (senha sempre aparece como *****); nunca lemos o ~/.mylogin.cnf.
      const p = await run(editor, ["print", `--login-path=${this.cfg.loginPath}`], { timeoutMs: DB_TIMEOUT });
      if (!p.stdout.includes(`[${this.cfg.loginPath}]`)) {
        this.set({
          db: {
            configured: false,
            ok: false,
            host: undefined,
            error: `perfil "${this.cfg.loginPath}" não existe. Crie com: mysql_config_editor set --login-path=${this.cfg.loginPath} --host=<host> --user=<usuário> --password`,
            checkedAt,
          },
        });
        return;
      }
      host = p.stdout.match(/^host\s*=\s*"?([^"\n]+)"?/m)?.[1];
    }
    const r = await run(mysql, [`--login-path=${this.cfg.loginPath}`, "--batch", "--skip-column-names", "--connect-timeout=10", "-e", "SELECT 1"], {
      timeoutMs: DB_TIMEOUT,
      env: cleanEnv(),
    });
    const ok = r.code === 0 && r.stdout.trim() === "1";
    this.set({ db: { configured: true, ok, host, error: ok ? undefined : mysqlError(r.stderr) || r.error || "o banco não respondeu", checkedAt } });
  }

  /** Roda UMA consulta de leitura e devolve o TSV mascarado (ou lança com o motivo). */
  async sql(query: string, limit = SQL_MAX_ROWS) {
    const v = validateSql(query);
    if (!v.ok) throw new Error(`consulta recusada: ${v.error}`);
    if (!this.bins.mysql || !this.status.db.configured) throw new Error(this.status.db.error ?? "banco não configurado");
    const maxRows = Math.max(1, Math.min(SQL_MAX_ROWS, Math.floor(limit)));
    const r = await run(
      this.bins.mysql,
      [
        `--login-path=${this.cfg.loginPath}`,
        "--batch",
        "--connect-timeout=10",
        "-e",
        // Sessão só de leitura e com tempo máximo, mesmo que o usuário do banco permitisse mais.
        `SET SESSION TRANSACTION READ ONLY; SET SESSION MAX_EXECUTION_TIME=15000; ${v.sql};`,
      ],
      { timeoutMs: SQL_TIMEOUT, maxBytes: SQL_MAX_BYTES, enough: (out) => out.split("\n").length > maxRows + 2, env: cleanEnv() },
    );
    if (r.timedOut) throw new Error("a consulta passou de 25s e foi cancelada; filtre mais (WHERE/LIMIT)");
    if (r.code !== 0 && !r.truncated) throw new Error(mysqlError(r.stderr) || r.error || `mysql saiu com código ${r.code}`);
    const lines = r.stdout.replace(/\n$/, "").split("\n");
    const rows = lines.length - 1;
    const shown = lines.slice(0, maxRows + 1);
    let out = maskTsv(shown.join("\n"));
    if (out.length > SQL_MAX_BYTES) out = out.slice(0, SQL_MAX_BYTES);
    const cut = r.truncated || rows > maxRows;
    if (!r.stdout.trim()) return "(nenhuma linha)";
    return `${out}\n\n(${cut ? `cortado: mostrando ${Math.min(rows, maxRows)} linhas — refine a consulta` : `${rows} linha${rows === 1 ? "" : "s"}`}; dados pessoais mascarados)`;
  }

  // ------------------------------------------------ repositórios

  private syncedCount() {
    return [...this.repos.values()].filter((r) => r.lastSyncAt && !r.error).length;
  }

  private persistRepos() {
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.repos.values()], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  /** Sincroniza todos os espelhos (uma sincronização por vez; chamadas durante uma em curso esperam a mesma). */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private gitEnv() {
    return cleanEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C" });
  }

  /** git com a credencial vinda do gh na hora (nada gravado em .git/config). */
  private git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
    const helper = this.bins.gh ? ["-c", "credential.helper=", "-c", `credential.helper=!${shellQuote(this.bins.gh)} auth git-credential`] : [];
    // Nenhum hook (nem de um core.hooksPath global do usuário) roda nos espelhos.
    return run(this.bins.git!, ["-c", "core.hooksPath=/dev/null", ...helper, ...args], { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT, env: this.gitEnv() });
  }

  private async doSync() {
    const { gh, git } = this.bins;
    if (!gh || !git) {
      this.set({ repos: { syncing: false, error: !gh ? "gh (GitHub CLI) não encontrado: brew install gh && gh auth login" : "git não encontrado" } });
      return;
    }
    this.set({ repos: { syncing: true } });
    const list = await run(gh, ["repo", "list", this.cfg.org, "--limit", "500", "--json", "name,defaultBranchRef,isArchived,pushedAt"], { timeoutMs: 60_000, env: cleanEnv({ GH_PROMPT_DISABLED: "1" }) });
    let remote: { name: string; defaultBranchRef: { name: string } | null; isArchived: boolean; pushedAt?: string }[];
    try {
      if (list.code !== 0) throw new Error(firstLine(list.stderr) || list.error || `gh saiu com código ${list.code}`);
      remote = JSON.parse(list.stdout);
      if (!Array.isArray(remote)) throw new Error("resposta inesperada do gh");
    } catch (e) {
      this.set({ repos: { syncing: false, error: `não consegui listar os repositórios: ${(e as Error).message}` } });
      return;
    }
    const active = remote.filter((r) => r && typeof r.name === "string" && REPO_NAME.test(r.name) && r.name !== "." && r.name !== ".." && !r.isArchived);
    // Arquivados ou apagados no GitHub saem da lista (o espelho em disco fica, sem atrapalhar).
    for (const name of [...this.repos.keys()]) if (!active.some((r) => r.name === name)) this.repos.delete(name);
    this.set({ repos: { total: active.length, error: undefined } });
    const started = Date.now();

    let next = 0;
    const worker = async () => {
      while (next < active.length) {
        const r = active[next++];
        const state: RepoState = { ...this.repos.get(r.name), name: r.name, branch: r.defaultBranchRef?.name ?? null, pushedAt: r.pushedAt };
        try {
          await this.syncRepo(state);
          state.lastSyncAt = new Date().toISOString();
          state.error = undefined;
        } catch (e) {
          state.error = (e as Error).message.slice(0, 300);
        }
        this.repos.set(r.name, state);
        this.set({ repos: { synced: this.syncedCount() } });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.cfg.concurrency) }, worker));
    this.persistRepos();
    const failed = active.map((r) => this.repos.get(r.name)!).filter((r) => r.error);
    this.set({
      repos: {
        syncing: false,
        synced: this.syncedCount(),
        lastSyncAt: new Date().toISOString(),
        error: failed.length ? `${failed.length} repositório${failed.length > 1 ? "s" : ""} com erro: ${failed.slice(0, 5).map((r) => r.name).join(", ")}${failed.length > 5 ? "…" : ""}` : undefined,
      },
    });
    log(`Always Fit: ${this.syncedCount()}/${active.length} repositórios sincronizados em ${Math.round((Date.now() - started) / 1000)}s${failed.length ? ` (${failed.length} com erro)` : ""}`);
  }

  private async syncRepo(state: RepoState) {
    if (!state.branch) throw new Error("repositório vazio (sem branch padrão)");
    const dir = this.repoDir(state.name);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      // Clona numa pasta temporária: um clone interrompido nunca vira espelho pela metade.
      const tmp = path.join(this.reposDir, `.${state.name}.clonando`);
      fs.rmSync(tmp, { recursive: true, force: true });
      const c = await this.git(["clone", "--quiet", "--filter=blob:none", "--no-tags", `https://github.com/${this.cfg.org}/${state.name}.git`, tmp], { cwd: this.reposDir, timeoutMs: CLONE_TIMEOUT });
      if (c.code !== 0) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error(`clone falhou: ${firstLine(c.stderr) || c.error || c.code}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    }
    const f = await this.git(["fetch", "--quiet", "--prune", "--no-tags", "origin", `+refs/heads/${state.branch}:refs/remotes/origin/${state.branch}`], { cwd: dir });
    if (f.code !== 0) throw new Error(`fetch falhou: ${firstLine(f.stderr) || f.error || f.code}`);
    // Espelho é só leitura: o que estiver lá (inclusive mudanças locais) dá lugar ao remoto.
    const co = await this.git(["checkout", "--quiet", "--force", "-B", state.branch, `origin/${state.branch}`], { cwd: dir });
    if (co.code !== 0) throw new Error(`checkout falhou: ${firstLine(co.stderr) || co.error || co.code}`);
    await this.git(["clean", "-ffdq"], { cwd: dir });
    const l = await this.git(["log", "-1", "--format=%h %cs %an: %s"], { cwd: dir, timeoutMs: 30_000 });
    state.lastCommit = l.code === 0 ? l.stdout.trim().slice(0, 200) : undefined;
  }

  repoDir(name: string) {
    if (!REPO_NAME.test(name) || name === "." || name === "..") throw new Error(`nome de repositório inválido: ${name}`);
    return path.join(this.reposDir, name);
  }

  /** Texto para a ferramenta alwaysfit_repos. */
  async describeRepos(name?: string) {
    if (!name) {
      const list = [...this.repos.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
      if (!list.length) return this.status.repos.syncing ? "Sincronizando os repositórios pela primeira vez; tente de novo em alguns minutos." : `Nenhum repositório sincronizado.${this.status.repos.error ? ` ${this.status.repos.error}` : ""}`;
      const s = this.status.repos;
      return [
        `${s.synced}/${s.total} repositórios de ${s.org} espelhados em ${this.reposDir} (só leitura; use Read/Grep/Glob nesses caminhos).${s.lastSyncAt ? ` Última sincronização: ${new Date(s.lastSyncAt).toLocaleString("pt-BR")}.` : ""}${s.syncing ? " Sincronizando agora." : ""}`,
        ...list.map((r) => `- ${r.name} · ${r.branch ?? "vazio"} · ${r.lastCommit ?? "ainda não clonado"}${r.error ? ` · ERRO: ${r.error}` : ""}\n  ${this.repoDir(r.name)}`),
      ].join("\n");
    }
    const r = this.repos.get(name.trim()) ?? [...this.repos.values()].find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!r) throw new Error(`repositório "${name}" não encontrado. Use alwaysfit_repos sem nome para ver a lista.`);
    const dir = this.repoDir(r.name);
    if (!fs.existsSync(path.join(dir, ".git"))) return `${r.name}: ainda não clonado${r.error ? ` (${r.error})` : ""}.`;
    const log15 = await this.git(["log", "--oneline", "-15", "--format=%h %cs %an: %s"], { cwd: dir, timeoutMs: 30_000 });
    return [
      `${r.name} · branch ${r.branch} · espelho em ${dir}`,
      `Último push no GitHub: ${r.pushedAt ? new Date(r.pushedAt).toLocaleString("pt-BR") : "?"} · sincronizado: ${r.lastSyncAt ? new Date(r.lastSyncAt).toLocaleString("pt-BR") : "nunca"}${r.error ? ` · ERRO: ${r.error}` : ""}`,
      "",
      "Últimos commits:",
      log15.code === 0 ? log15.stdout.trim() : `(não consegui ler: ${firstLine(log15.stderr) || log15.error})`,
    ].join("\n");
  }

  /** Resumo sem segredos para o /health. */
  health() {
    const { db, repos } = this.status;
    return { db: { configured: db.configured, ok: db.ok }, repos: { total: repos.total, synced: repos.synced, syncing: repos.syncing, lastSyncAt: repos.lastSyncAt } };
  }
}

const firstLine = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^warning:/i.test(l) && !/\[Warning\]/.test(l)) ?? "";

/** Primeira linha útil do stderr do mysql (sem o aviso de senha na linha de comando etc.). */
const mysqlError = (stderr: string) => firstLine(stderr).replace(/^mysql:\s*/, "").slice(0, 300);
