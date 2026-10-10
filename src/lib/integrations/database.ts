import { Client, type QueryConfig, type QueryResult } from "pg";

/** Banco do usuário (PostgreSQL: Supabase, Neon, RDS, Railway...). Acesso dos agentes é somente leitura. */

function makeClient(connectionString: string) {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const noSsl = /sslmode=disable/.test(connectionString);
  return new Client({
    connectionString,
    ssl: local || noSsl ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 15000,
  });
}

async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = makeClient(connectionString);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function testDatabase(connectionString: string) {
  return withClient(connectionString, async (c) => {
    const v = await c.query<{ version: string }>("select version()");
    // Superusuário burla parte da proteção (ex.: COPY TO PROGRAM, dblink): avisamos na tela da conexão.
    const role = await c.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
      "select rolsuper, rolcreaterole from pg_roles where rolname = current_user",
    ).catch(() => ({ rows: [] as { rolsuper: boolean; rolcreaterole: boolean }[] }));
    const t = await c.query<{ table_schema: string; table_name: string }>(
      `select table_schema, table_name from information_schema.tables
       where table_schema not in ('pg_catalog', 'information_schema')
         and table_schema not like 'pg_%'
       order by table_schema, table_name limit 200`,
    );
    const r = role.rows[0];
    return {
      version: v.rows[0]?.version.split(",")[0] ?? "",
      tables: t.rows.map((r) => `${r.table_schema}.${r.table_name}`),
      ...(r?.rolsuper || r?.rolcreaterole
        ? { warning: "Este usuário do banco é administrador. Para os agentes, prefira um usuário só de leitura (GRANT SELECT)." }
        : {}),
    };
  });
}

export async function describeSchema(connectionString: string, table?: string) {
  return withClient(connectionString, async (c) => {
    const params: string[] = [];
    let filter = "";
    if (table) {
      const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
      params.push(schema, name);
      filter = "and table_schema = $1 and table_name = $2";
    }
    const r = await c.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `select table_schema, table_name, column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg_%'
       ${filter}
       order by table_schema, table_name, ordinal_position limit 1500`,
      params,
    );
    const byTable = new Map<string, string[]>();
    for (const row of r.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const cols = byTable.get(key) ?? [];
      cols.push(`${row.column_name} ${row.data_type}${row.is_nullable === "NO" ? " not null" : ""}`);
      byTable.set(key, cols);
    }
    if (byTable.size === 0) return "Nenhuma tabela encontrada.";
    return [...byTable].map(([t, cols]) => `${t}(\n  ${cols.join(",\n  ")}\n)`).join("\n\n");
  });
}

const READ_STATEMENTS = /^(select|with|explain|show|values|table)\b/i;
/**
 * Funções/comandos que escapam da transação READ ONLY (outra conexão, sistema de arquivos, processos)
 * ou mexem no servidor. É uma segunda camada: a principal é o READ ONLY + um usuário só de leitura.
 */
const DANGEROUS = /\b(copy|dblink\w*|lo_\w+|pg_(read_\w+|write_\w+|stat_file|ls_\w+|terminate_backend|cancel_backend|reload_conf|rotate_logfile|promote|file_\w+|logical_\w+|create_restore_point|switch_wal|backup_\w+)|set_config|txid_current|nextval|setval)\s*\(?/i;

/** Tira comentários e literais para analisar só a estrutura do comando. */
function skeleton(sql: string) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim();
}

/** Valida o SQL antes de ir ao banco. Exportado para teste. */
export function checkReadOnlySql(sql: string) {
  const s = skeleton(sql);
  if (!s) throw new Error("SQL vazio.");
  if (!READ_STATEMENTS.test(s)) throw new Error("Só consultas de leitura (SELECT, WITH, EXPLAIN, SHOW, VALUES) são permitidas.");
  const bad = s.match(DANGEROUS);
  if (bad) throw new Error(`Função ou comando não permitido para os agentes: ${bad[1]}.`);
}

/** Executa SQL dentro de uma transação READ ONLY — escrita é bloqueada pelo próprio Postgres. */
export async function readOnlyQuery(connectionString: string, sql: string) {
  checkReadOnlySql(sql);
  return withClient(connectionString, async (c) => {
    await c.query("begin transaction read only");
    try {
      // Protocolo estendido: aceita um único comando (impede "commit; delete ...").
      const r: QueryResult = await c.query({ text: sql, queryMode: "extended" } as QueryConfig);
      const rows = r.rows ?? [];
      const MAX = 200;
      const json = JSON.stringify(rows.slice(0, MAX), null, 1);
      return `${rows.length} linha(s)${rows.length > MAX ? ` — mostrando ${MAX}` : ""}:\n${json.slice(0, 60_000)}`;
    } finally {
      await c.query("rollback").catch(() => {});
    }
  });
}
