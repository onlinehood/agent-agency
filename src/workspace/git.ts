import fs from "node:fs";
import path from "node:path";
import { minimalEnv, runOnce } from "../executors/process.js";
import { maskKnown } from "../security/masking.js";
import { AppError } from "../util/errors.js";
import { resolveToken, type TokenSource } from "../github/appAuth.js";

/**
 * Thin git wrapper. Tokens are passed per-command through an http extra header and are
 * never written into .git/config or remotes (PRD §8.1).
 */
export interface GitIdentity {
  name: string;
  email: string;
}

export class Git {
  constructor(
    private readonly token?: TokenSource,
    private readonly identity: GitIdentity = { name: "AgentAgency", email: "agent-agency@users.noreply.github.com" },
  ) {}

  private async authArgs(): Promise<{ args: string[]; token?: string }> {
    const token = await resolveToken(this.token);
    if (!token) return { args: [] };
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return { args: ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`], token };
  }

  async run(cwd: string, args: string[], opts: { auth?: boolean; allowFail?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const auth = opts.auth ? await this.authArgs() : { args: [] as string[], token: undefined };
    const full = [...auth.args, "-c", `user.name=${this.identity.name}`, "-c", `user.email=${this.identity.email}`, ...args];
    const r = await runOnce("git", full, { cwd, env: minimalEnv({ GIT_TERMINAL_PROMPT: "0" }), timeoutMs: opts.timeoutMs ?? 120000 });
    if ((r.code !== 0 || r.spawnError) && !opts.allowFail) {
      const msg = maskKnown(`${r.spawnError ?? ""} ${r.stderr || r.stdout}`.trim(), [auth.token]);
      throw new AppError(`git ${args[0]} failed: ${msg.slice(0, 800)}`, "git_failed", { args: args.slice(0, 2) });
    }
    return r.stdout.trim();
  }

  async clone(url: string, dest: string, branch?: string): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const args = ["clone", "--no-tags"];
    if (branch) args.push("--branch", branch);
    args.push(url, dest);
    await this.run(path.dirname(dest), args, { auth: true, timeoutMs: 600000 });
  }

  async init(dir: string, defaultBranch = "main"): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    await this.run(dir, ["init", "-b", defaultBranch]);
  }

  async fetch(repoDir: string, remote = "origin"): Promise<void> {
    await this.run(repoDir, ["fetch", "--prune", remote], { auth: true, timeoutMs: 300000 });
  }

  async addWorktree(repoDir: string, worktreeDir: string, branch: string, base: string): Promise<void> {
    if (fs.existsSync(worktreeDir)) return;
    const exists = (await this.run(repoDir, ["branch", "--list", branch])).length > 0;
    if (exists) await this.run(repoDir, ["worktree", "add", worktreeDir, branch]);
    else await this.run(repoDir, ["worktree", "add", "-b", branch, worktreeDir, base]);
  }

  async addDetachedWorktree(repoDir: string, worktreeDir: string, ref: string): Promise<void> {
    await this.run(repoDir, ["worktree", "add", "--force", "--detach", worktreeDir, ref]);
  }

  async removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
    await this.run(repoDir, ["worktree", "remove", "--force", worktreeDir], { allowFail: true });
  }

  async status(dir: string): Promise<string> {
    return this.run(dir, ["status", "--porcelain"]);
  }

  async hasChanges(dir: string): Promise<boolean> {
    return (await this.status(dir)).length > 0;
  }

  async commitAll(dir: string, message: string): Promise<string | null> {
    await this.run(dir, ["add", "-A"]);
    if (!(await this.run(dir, ["diff", "--cached", "--name-only"]))) return null;
    await this.run(dir, ["commit", "-m", message]);
    return this.headSha(dir);
  }

  async headSha(dir: string): Promise<string> {
    return this.run(dir, ["rev-parse", "HEAD"]);
  }

  async currentBranch(dir: string): Promise<string> {
    return this.run(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async push(dir: string, branch: string, remote = "origin"): Promise<void> {
    await this.run(dir, ["push", "-u", remote, branch], { auth: true, timeoutMs: 300000 });
  }

  async diffStat(dir: string, base: string): Promise<string> {
    return this.run(dir, ["diff", "--stat", `${base}...HEAD`], { allowFail: true });
  }

  async diff(dir: string, base: string, maxChars = 60000): Promise<string> {
    const d = await this.run(dir, ["diff", `${base}...HEAD`], { allowFail: true });
    return d.length > maxChars ? d.slice(0, maxChars) + "\n... (diff truncated)" : d;
  }

  async changedFiles(dir: string, base: string): Promise<string[]> {
    const out = await this.run(dir, ["diff", "--name-only", `${base}...HEAD`], { allowFail: true });
    return out.split("\n").filter(Boolean);
  }

  async log(dir: string, range: string): Promise<string[]> {
    const out = await this.run(dir, ["log", "--pretty=%h %s", range], { allowFail: true });
    return out.split("\n").filter(Boolean);
  }

  async setRemote(dir: string, url: string, name = "origin"): Promise<void> {
    const existing = await this.run(dir, ["remote"], { allowFail: true });
    if (existing.split("\n").includes(name)) await this.run(dir, ["remote", "set-url", name, url]);
    else await this.run(dir, ["remote", "add", name, url]);
  }
}
