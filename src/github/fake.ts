import type { CheckSummary, GitHubService, PullRequestInfo, RepoAnalysis, RepoInfo } from "./client.js";

/** In-memory GitHub used by tests and offline demos. Records every call for assertions. */
export class FakeGitHubService implements GitHubService {
  repos = new Map<string, RepoInfo>();
  prs = new Map<string, PullRequestInfo[]>();
  comments: Array<{ repo: string; number: number; body: string }> = [];
  calls: string[] = [];
  login = "tester";

  async whoami() {
    this.calls.push("whoami");
    return { login: this.login, scopes: ["repo"] };
  }

  async createPrivateRepo(owner: string | null, name: string, _description: string): Promise<RepoInfo> {
    this.calls.push(`createPrivateRepo:${name}`);
    const fullName = `${owner ?? this.login}/${name}`;
    const info: RepoInfo = { fullName, defaultBranch: "main", private: true, htmlUrl: `https://github.com/${fullName}`, cloneUrl: `https://github.com/${fullName}.git` };
    this.repos.set(fullName, info);
    return info;
  }

  async getRepo(fullName: string): Promise<RepoInfo> {
    this.calls.push(`getRepo:${fullName}`);
    const r = this.repos.get(fullName);
    if (!r) throw new Error(`repo not found: ${fullName}`);
    return r;
  }

  async analyzeRepo(fullName: string): Promise<RepoAnalysis> {
    this.calls.push(`analyzeRepo:${fullName}`);
    const r = await this.getRepo(fullName);
    return {
      fullName,
      defaultBranch: r.defaultBranch,
      languages: { TypeScript: 1000 },
      topLevel: ["package.json", "src/", "tests/", "README.md", ".github/"],
      readmeExcerpt: "# Example\nA sample project.",
      manifests: { "package.json": JSON.stringify({ name: "example", scripts: { test: "vitest run", lint: "eslint ." } }) },
      ciWorkflows: ["ci.yml"],
      hasTests: true,
      docs: ["README.md"],
    };
  }

  async findOpenPr(fullName: string, head: string): Promise<PullRequestInfo | null> {
    return (this.prs.get(fullName) ?? []).find((p) => p.headBranch === head && p.state === "open") ?? null;
  }

  async createPullRequest(fullName: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRequestInfo> {
    this.calls.push(`createPullRequest:${input.head}`);
    const existing = await this.findOpenPr(fullName, input.head);
    if (existing) return existing;
    const list = this.prs.get(fullName) ?? [];
    const pr: PullRequestInfo = { number: list.length + 1, url: `https://github.com/${fullName}/pull/${list.length + 1}`, state: "open", merged: false, headBranch: input.head, baseBranch: input.base, headSha: "deadbeef" };
    list.push(pr);
    this.prs.set(fullName, list);
    return pr;
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestInfo> {
    const pr = (this.prs.get(fullName) ?? []).find((p) => p.number === number);
    if (!pr) throw new Error("pr not found");
    return pr;
  }

  async mergePullRequest(fullName: string, number: number) {
    this.calls.push(`mergePullRequest:${number}`);
    const pr = await this.getPullRequest(fullName, number);
    if (pr.merged) return { merged: true, sha: null, message: "already merged" };
    pr.merged = true;
    pr.state = "closed";
    return { merged: true, sha: "cafebabe", message: "merged" };
  }

  async commentOnPr(fullName: string, number: number, body: string): Promise<void> {
    this.comments.push({ repo: fullName, number, body });
  }

  async checks(_fullName: string, _ref: string): Promise<CheckSummary> {
    return { state: "none", details: [] };
  }
}
