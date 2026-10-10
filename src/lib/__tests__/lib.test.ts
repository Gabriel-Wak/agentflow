/**
 * Testes das partes críticas do servidor: segurança (redirecionamento, SQL, criptografia),
 * importação de agentes e o motor de execução dos times. Rode com: npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Edge, Node } from "@xyflow/react";
import { safeNextPath } from "../safe-next";
import { checkReadOnlySql } from "../integrations/database";
import { parseAgentMarkdown } from "../agent-import";
import { executionOrder } from "../orchestrator";
import { parseVerdict } from "../roles";
import { reasoningParams, fallbackParams } from "../anthropic";
import { defaultFlow } from "../flow-template";

describe("safeNextPath (destino pós-login)", () => {
  it("aceita caminhos internos", () => {
    assert.equal(safeNextPath("/orquestra"), "/orquestra");
    assert.equal(safeNextPath("/flows/abc?x=1#y"), "/flows/abc?x=1#y");
  });
  it("bloqueia redirecionamento para fora", () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "evil.com", ""]) {
      assert.equal(safeNextPath(bad), "/dashboard", bad);
    }
    assert.equal(safeNextPath(null, "/x"), "/x");
  });
});

describe("checkReadOnlySql (consultas dos agentes)", () => {
  it("deixa passar leitura", () => {
    for (const q of ["select 1", "WITH x AS (select 1) select * from x", "explain select * from t", "show search_path", "select 'copy (' as texto", "-- nota\nselect * from t where obs = 'dblink('"]) {
      assert.doesNotThrow(() => checkReadOnlySql(q), q);
    }
  });
  it("bloqueia escrita e funções que escapam do READ ONLY", () => {
    for (const q of ["delete from t", "update t set a = 1", "/* x */ insert into t values (1)", "copy (select 1) to program 'id'", "select dblink_exec('c', 'delete from t')", "select pg_read_file('/etc/passwd')", "select pg_terminate_backend(1)", "select lo_export(1, '/tmp/x')", "select set_config('a', 'b', false)", "select nextval('s')", "commit", ""]) {
      assert.throws(() => checkReadOnlySql(q), q);
    }
  });
});

describe("crypto (segredos)", () => {
  it("criptografa, abre e avisa quando a chave muda", async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    const { encrypt, decrypt, decryptFor, mask } = await import("../crypto");
    const box = encrypt("ghp_segredo123");
    assert.notEqual(box, "ghp_segredo123");
    assert.equal(decrypt(box), "ghp_segredo123");
    assert.equal(decrypt(null), "");
    assert.equal(mask("ghp_segredo123"), "ghp_••••o123");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
    assert.throws(() => decrypt(box), /ENCRYPTION_KEY mudou/);
    assert.throws(() => decryptFor(box, "Produção"), /"Produção"/);
    assert.throws(() => decrypt("lixo"), /formato inválido/);
  });
});

describe("parseAgentMarkdown (subagentes do Claude Code)", () => {
  it("lê frontmatter e corpo", () => {
    const a = parseAgentMarkdown("---\nname: revisor\ndescription: \"Revisa PRs\"\nmodel: haiku\ntools: Read, Grep\n---\nVocê revisa código.");
    assert.equal(a.name, "revisor");
    assert.equal(a.description, "Revisa PRs");
    assert.equal(a.model, "claude-haiku-5-5");
    assert.equal(a.system_prompt, "Você revisa código.");
    assert.deepEqual(a.config, { tools: "Read, Grep" });
  });
  it("sem frontmatter usa padrões", () => {
    const a = parseAgentMarkdown("Só o prompt.");
    assert.equal(a.name, "Subagente importado");
    assert.equal(a.model, "claude-opus-5-5");
  });
});

describe("executionOrder (motor dos times)", () => {
  const ids = (ns: Node[]) => ns.map((n) => n.id);
  it("segue o time padrão do início ao fim", () => {
    const { nodes, edges } = defaultFlow();
    assert.deepEqual(ids(executionOrder(nodes, edges)), ["creator", "validator", "approver"]);
  });
  it("ignora a aresta de volta do loop de revisão e nós soltos", () => {
    const { nodes, edges } = defaultFlow();
    const loop: Edge = { id: "back", source: "approver", target: "creator" };
    const solto: Node = { id: "solto", type: "agent", position: { x: 0, y: 0 }, data: {} };
    assert.deepEqual(ids(executionOrder([...nodes, solto], [...edges, loop])), ["creator", "validator", "approver"]);
  });
  it("exige nó de Tarefa", () => {
    assert.throws(() => executionOrder([], []), /Tarefa/);
  });
});

describe("parseVerdict (revisores)", () => {
  it("vale o último veredito, com ou sem negrito", () => {
    assert.equal(parseVerdict("ok\nVEREDITO: APROVADO"), "approved");
    assert.equal(parseVerdict("VEREDITO: **REPROVADO**"), "rejected");
    assert.equal(parseVerdict("antes VEREDITO: APROVADO\ndepois\nveredito: reprovado"), "rejected");
    assert.equal(parseVerdict("sem veredito"), undefined);
  });
});

describe("parâmetros da API da Claude", () => {
  it("thinking adaptativo + effort na geração atual, nada no Haiku 4.5", () => {
    assert.deepEqual(reasoningParams("claude-opus-5-5", "high"), { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    assert.ok("thinking" in reasoningParams("claude-haiku-5-5"));
    assert.deepEqual(reasoningParams("claude-haiku-4-5"), {});
  });
  it("fallback de recusa só onde a API aceita", () => {
    assert.ok("fallbacks" in fallbackParams("claude-opus-5-5"));
    assert.ok("fallbacks" in fallbackParams("claude-fable-5-1"));
    assert.ok(!("fallbacks" in fallbackParams("claude-haiku-5-5")));
  });
});
