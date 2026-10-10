/** Integração com GitHub via REST API (token pessoal opcional para repositórios privados). */

export interface GithubConfig {
  repo: string; // "dono/repositorio"
  branch?: string;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

const API = "https://api.github.com";

export function parseRepo(input: string): string {
  const s = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const m = s.match(/github\.com[/:]([^/]+\/[^/]+)/);
  return m ? m[1] : s;
}

async function gh<T>(path: string, token: string, accept = "application/vnd.github+json"): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "always-flow",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
  }
  return (accept.includes("raw") ? await res.text() : await res.json()) as T;
}

export async function testGithub(cfg: GithubConfig, token: string) {
  const repo = await gh<{
    full_name: string;
    default_branch: string;
    private: boolean;
    description: string | null;
    stargazers_count: number;
    language: string | null;
  }>(`/repos/${cfg.repo}`, token);
  const branch = cfg.branch || repo.default_branch;
  const tree = await getTree({ ...cfg, branch }, token);
  const files = tree.filter((e) => e.type === "blob");
  const langs = await gh<Record<string, number>>(`/repos/${cfg.repo}/languages`, token).catch(
    () => ({}) as Record<string, number>,
  );
  return {
    branch,
    meta: {
      fullName: repo.full_name,
      private: repo.private,
      description: repo.description,
      stars: repo.stargazers_count,
      fileCount: files.length,
      languages: Object.keys(langs).slice(0, 6),
      topLevel: tree.filter((e) => !e.path.includes("/")).map((e) => e.path).slice(0, 40),
    },
  };
}

async function getTree(cfg: GithubConfig, token: string): Promise<TreeEntry[]> {
  const data = await gh<{ tree: TreeEntry[] }>(
    `/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch || "HEAD")}?recursive=1`,
    token,
  );
  return data.tree;
}

export async function listFiles(cfg: GithubConfig, token: string, prefix = "", query = "") {
  const tree = await getTree(cfg, token);
  const q = query.toLowerCase();
  const files = tree
    .filter((e) => e.type === "blob")
    .filter((e) => !prefix || e.path.startsWith(prefix.replace(/^\//, "")))
    .filter((e) => !q || e.path.toLowerCase().includes(q))
    .filter((e) => !/(^|\/)(node_modules|\.git|dist|build|\.next)\//.test(e.path));
  const shown = files.slice(0, 400).map((e) => `${e.path} (${e.size ?? 0} B)`);
  return `${files.length} arquivo(s)${files.length > 400 ? " — mostrando 400" : ""}:\n${shown.join("\n")}`;
}

export async function readFile(cfg: GithubConfig, token: string, path: string) {
  const text = await gh<string>(
    `/repos/${cfg.repo}/contents/${path.replace(/^\//, "").split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(cfg.branch || "HEAD")}`,
    token,
    "application/vnd.github.raw+json",
  );
  const LIMIT = 120_000;
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n\n[arquivo cortado em ${LIMIT} caracteres]` : text;
}
