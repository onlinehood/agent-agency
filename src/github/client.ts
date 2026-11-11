import { Octokit } from "@octokit/rest";
import { AppError } from "../util/errors.js";
import { resolveToken, type TokenSource } from "./appAuth.js";

/**
 * GitHub Integration (PRD §6.1-6). GitHub is the source of truth for code, branches and PRs.
 * Interface-first so the orchestrator can be tested with an in-memory fake.
 */
export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
}

export interface RepoAnalysis {
  fullName: string;
  defaultBranch: string;
  languages: Record<string, number>;
  topLevel: string[];
  readmeExcerpt: string | null;
  manifests: Record<string, string>;
  ciWorkflows: string[];
  hasTests: boolean;
  docs: string[];
}

export interface CheckSummary {
  state: "success" | "failure" | "pending" | "none";
  details: Array<{ name: string; conclusion: string | null; status: string }>;
}

export interface GitHubService {
  whoami(): Promise<{ login: string; scopes: string[] }>;
  createPrivateRepo(owner: string | null, name: string, description: string): Promise<RepoInfo>;
  getRepo(fullName: string): Promise<RepoInfo>;
  analyzeRepo(fullName: string): Promise<RepoAnalysis>;
  findOpenPr(fullName: string, head: string): Promise<PullRequestInfo | null>;
  createPullRequest(fullName: string, input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequestInfo>;
  getPullRequest(fullName: string, number: number): Promise<PullRequestInfo>;
  mergePullRequest(fullName: string, number: number, method?: "merge" | "squash" | "rebase"): Promise<{ merged: boolean; sha: string | null; message: string }>;
  commentOnPr(fullName: string, number: number, body: string): Promise<void>;
  checks(fullName: string, ref: string): Promise<CheckSummary>;
}

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new AppError(`invalid repo ref: ${fullName}`, "invalid_repo");
  return { owner, repo };
}

const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json", "Dockerfile", "docker-compose.yml", "compose.yaml", "playwright.config.ts", "tsconfig.json"];

export class OctokitGitHubService implements GitHubService {
  private client: { token: string; o: Octokit } | null = null;

  constructor(
    private readonly tokenSource: TokenSource,
    private readonly baseUrl?: string,
    /** "app" installations cannot call /user; whoami falls back to the installation's repos */
    private readonly mode: "pat" | "app" = "pat",
  ) {}

  private async oc(): Promise<Octokit> {
    const token = (await resolveToken(this.tokenSource))!;
    if (!this.client || this.client.token !== token) this.client = { token, o: new Octokit({ auth: token, baseUrl: this.baseUrl, userAgent: "agent-agency", log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } }) };
    return this.client.o;
  }

  async whoami(): Promise<{ login: string; scopes: string[] }> {
    if (this.mode === "app") {
      const r = await (await this.oc()).apps.listReposAccessibleToInstallation({ per_page: 1 });
      return { login: r.data.repositories[0]?.owner.login ?? "github-app", scopes: ["installation"] };
    }
    const r = await (await this.oc()).users.getAuthenticated();
    const scopes = String(r.headers["x-oauth-scopes"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { login: r.data.login, scopes };
  }

  private toRepo(d: any): RepoInfo {
    return { fullName: d.full_name, defaultBranch: d.default_branch ?? "main", private: !!d.private, htmlUrl: d.html_url, cloneUrl: d.clone_url };
  }

  async createPrivateRepo(owner: string | null, name: string, description: string): Promise<RepoInfo> {
    const me = await this.whoami();
    if (owner && owner !== me.login) {
      const r = await (await this.oc()).repos.createInOrg({ org: owner, name, description, private: true, auto_init: true });
      return this.toRepo(r.data);
    }
    const r = await (await this.oc()).repos.createForAuthenticatedUser({ name, description, private: true, auto_init: true });
    return this.toRepo(r.data);
  }

  async getRepo(fullName: string): Promise<RepoInfo> {
    const { owner, repo } = splitRepo(fullName);
    const r = await (await this.oc()).repos.get({ owner, repo });
    return this.toRepo(r.data);
  }

  /** Read-only analysis — performs only GET requests (PRD §5.2). */
  async analyzeRepo(fullName: string): Promise<RepoAnalysis> {
    const { owner, repo } = splitRepo(fullName);
    const info = await this.getRepo(fullName);
    const languages = (await (await this.oc()).repos.listLanguages({ owner, repo })).data as Record<string, number>;
    let topLevel: string[] = [];
    try {
      const c = await (await this.oc()).repos.getContent({ owner, repo, path: "" });
      if (Array.isArray(c.data)) topLevel = c.data.map((e: any) => (e.type === "dir" ? `${e.name}/` : e.name));
    } catch {}
    let readmeExcerpt: string | null = null;
    try {
      const r = await (await this.oc()).repos.getReadme({ owner, repo });
      readmeExcerpt = Buffer.from((r.data as any).content ?? "", "base64").toString("utf8").slice(0, 3000);
    } catch {}
    const manifests: Record<string, string> = {};
    for (const m of MANIFESTS) {
      if (!topLevel.includes(m)) continue;
      try {
        const c = await (await this.oc()).repos.getContent({ owner, repo, path: m });
        if (!Array.isArray(c.data) && (c.data as any).content) manifests[m] = Buffer.from((c.data as any).content, "base64").toString("utf8").slice(0, 4000);
      } catch {}
    }
    let ciWorkflows: string[] = [];
    try {
      const c = await (await this.oc()).repos.getContent({ owner, repo, path: ".github/workflows" });
      if (Array.isArray(c.data)) ciWorkflows = c.data.map((e: any) => e.name);
    } catch {}
    const hasTests = topLevel.some((n) => /^(tests?|__tests__|spec|e2e)\/$/i.test(n)) || /"test"\s*:/.test(manifests["package.json"] ?? "") || "pyproject.toml" in manifests;
    const docs = topLevel.filter((n) => /^(docs\/|.*\.md$)/i.test(n));
    return { fullName: info.fullName, defaultBranch: info.defaultBranch, languages, topLevel, readmeExcerpt, manifests, ciWorkflows, hasTests, docs };
  }

  private toPr(d: any): PullRequestInfo {
    return { number: d.number, url: d.html_url, state: d.state, merged: !!d.merged || !!d.merged_at, headBranch: d.head.ref, baseBranch: d.base.ref, headSha: d.head.sha };
  }

  async findOpenPr(fullName: string, head: string): Promise<PullRequestInfo | null> {
    const { owner, repo } = splitRepo(fullName);
    const r = await (await this.oc()).pulls.list({ owner, repo, state: "open", head: `${owner}:${head}` });
    return r.data[0] ? this.toPr(r.data[0]) : null;
  }

  async createPullRequest(fullName: string, input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequestInfo> {
    const { owner, repo } = splitRepo(fullName);
    const existing = await this.findOpenPr(fullName, input.head);
    if (existing) return existing;
    const r = await (await this.oc()).pulls.create({ owner, repo, head: input.head, base: input.base, title: input.title, body: input.body, draft: input.draft ?? false });
    return this.toPr(r.data);
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestInfo> {
    const { owner, repo } = splitRepo(fullName);
    const r = await (await this.oc()).pulls.get({ owner, repo, pull_number: number });
    return this.toPr(r.data);
  }

  async mergePullRequest(fullName: string, number: number, method: "merge" | "squash" | "rebase" = "squash"): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const { owner, repo } = splitRepo(fullName);
    const pr = await this.getPullRequest(fullName, number);
    if (pr.merged) return { merged: true, sha: null, message: "already merged" };
    const r = await (await this.oc()).pulls.merge({ owner, repo, pull_number: number, merge_method: method });
    return { merged: r.data.merged, sha: r.data.sha ?? null, message: r.data.message };
  }

  async commentOnPr(fullName: string, number: number, body: string): Promise<void> {
    const { owner, repo } = splitRepo(fullName);
    await (await this.oc()).issues.createComment({ owner, repo, issue_number: number, body });
  }

  async checks(fullName: string, ref: string): Promise<CheckSummary> {
    const { owner, repo } = splitRepo(fullName);
    const r = await (await this.oc()).checks.listForRef({ owner, repo, ref });
    const details = r.data.check_runs.map((c) => ({ name: c.name, conclusion: c.conclusion, status: c.status }));
    if (!details.length) return { state: "none", details };
    if (details.some((d) => d.status !== "completed")) return { state: "pending", details };
    if (details.some((d) => d.conclusion && !["success", "neutral", "skipped"].includes(d.conclusion))) return { state: "failure", details };
    return { state: "success", details };
  }
}
