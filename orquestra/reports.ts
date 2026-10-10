/**
 * Relatórios dos agentes (rodadas de análise, incidentes, resumo diário).
 * Ficam em <HOME>/relatorios/AAAA-MM-DD/HHMM-<agente>-<slug>.md, com um cabeçalho simples
 * que guarda os metadados. O id é o caminho relativo sem ".md".
 */
import fs from "fs";
import path from "path";
import type { ReportMeta, ReportSeverity } from "../src/lib/orquestra/protocol";

export const SEVERITIES: ReportSeverity[] = ["info", "atencao", "critico"];
const ID = /^(\d{4}-\d{2}-\d{2})\/([\p{L}\p{N}_-]+)$/u;
const MAX_CONTENT = 200_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** Pedaço seguro de nome de arquivo: letras (com acento), números e hífens. */
export function slug(s: string, max = 40) {
  return (
    s
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "relatorio"
  );
}

export class ReportStore {
  readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, "relatorios");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(input: { agent: string; title: string; content: string; severity: ReportSeverity }, now = new Date()): ReportMeta {
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const dayDir = path.join(this.dir, day);
    fs.mkdirSync(dayDir, { recursive: true, mode: 0o700 });
    const base = `${pad(now.getHours())}${pad(now.getMinutes())}-${slug(input.agent, 30)}-${slug(input.title)}`;
    // Mesmo minuto, mesmo agente, mesmo título: numera em vez de sobrescrever.
    let name = base;
    for (let n = 2; fs.existsSync(path.join(dayDir, `${name}.md`)); n++) name = `${base}-${n}`;
    const meta: ReportMeta = { id: `${day}/${name}`, agent: input.agent, title: input.title.trim().slice(0, 200), severity: input.severity, createdAt: now.toISOString() };
    const header = ["---", `titulo: ${JSON.stringify(meta.title)}`, `agente: ${JSON.stringify(meta.agent)}`, `gravidade: ${meta.severity}`, `criado: ${meta.createdAt}`, "---", ""].join("\n");
    fs.writeFileSync(path.join(dayDir, `${name}.md`), header + input.content.slice(0, MAX_CONTENT), { mode: 0o600, flag: "wx" });
    return meta;
  }

  private file(id: string) {
    const m = id.trim().replace(/\.md$/, "").match(ID);
    if (!m) throw new Error(`id de relatório inválido: ${id}`);
    return path.join(this.dir, m[1], `${m[2]}.md`);
  }

  private meta(id: string, raw: string): ReportMeta | null {
    const head = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!head) return null;
    const field = (k: string) => head[1].match(new RegExp(`^${k}: (.*)$`, "m"))?.[1];
    const str = (v: string | undefined) => {
      try {
        return v ? String(JSON.parse(v)) : "";
      } catch {
        return v ?? "";
      }
    };
    const severity = field("gravidade") as ReportSeverity;
    return { id, title: str(field("titulo")), agent: str(field("agente")), severity: SEVERITIES.includes(severity) ? severity : "info", createdAt: field("criado") ?? "" };
  }

  /** Mais recentes primeiro. Filtros opcionais por dia (AAAA-MM-DD) e agente. */
  list(opts: { day?: string; agent?: string; limit?: number } = {}): ReportMeta[] {
    const limit = opts.limit ?? 50;
    const days = fs
      .readdirSync(this.dir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!opts.day || d === opts.day))
      .sort()
      .reverse();
    const out: ReportMeta[] = [];
    for (const day of days) {
      const files = fs.readdirSync(path.join(this.dir, day)).filter((f) => f.endsWith(".md")).sort().reverse();
      for (const f of files) {
        const id = `${day}/${f.slice(0, -3)}`;
        let meta: ReportMeta | null = null;
        try {
          // Só o começo do arquivo: o cabeçalho basta para a lista.
          const fd = fs.openSync(path.join(this.dir, day, f), "r");
          const buf = Buffer.alloc(2048);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          meta = this.meta(id, buf.subarray(0, n).toString("utf8"));
        } catch {
          meta = null;
        }
        if (!meta || (opts.agent && meta.agent.toLowerCase() !== opts.agent.toLowerCase())) continue;
        out.push(meta);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  read(id: string): { meta: ReportMeta; content: string } {
    const file = this.file(id);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      throw new Error(`relatório "${id}" não existe`);
    }
    const cleanId = path.relative(this.dir, file).slice(0, -3);
    const meta = this.meta(cleanId, raw) ?? { id: cleanId, title: cleanId, agent: "?", severity: "info", createdAt: "" };
    return { meta, content: raw };
  }
}
