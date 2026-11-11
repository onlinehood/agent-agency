import fs from "node:fs";
import path from "node:path";
import type { Project, Task } from "../core/types.js";
import { Git } from "./git.js";
import type { TokenSource } from "../github/appAuth.js";
import { DockerSandbox, LocalSandbox, type Sandbox } from "./sandbox.js";

export interface WorkspaceManagerOptions {
  root: string;
  mode: "local" | "docker";
  image: string;
  gitToken?: TokenSource;
  /** Host directories with CLI subscription auth to mount read-only into docker sandboxes. */
  authMounts?: Array<{ host: string; container: string; readonly?: boolean }>;
  /** Override clone URL resolution (tests / GitHub Enterprise). */
  remoteUrlFor?: (repoRef: string) => string;
  network?: string;
  cpus?: number;
  memory?: string;
}

export interface TaskWorkspace {
  repoDir: string;
  dir: string;
  branch: string;
  base: string;
  sandbox: Sandbox;
}

/**
 * Per-project base clone + per-task git worktree on its own branch (PRD §5-4).
 */
export class WorkspaceManager {
  readonly git: Git;
  private sandboxes = new Map<string, Sandbox>();

  constructor(private o: WorkspaceManagerOptions) {
    this.git = new Git(o.gitToken);
    fs.mkdirSync(o.root, { recursive: true, mode: 0o700 });
  }

  projectDir(project: Pick<Project, "slug" | "id">): string {
    return path.join(this.o.root, `${project.slug}-${project.id.slice(-6)}`);
  }

  repoDir(project: Pick<Project, "slug" | "id">): string {
    return path.join(this.projectDir(project), "repo");
  }

  remoteUrl(repoRef: string): string {
    return this.o.remoteUrlFor ? this.o.remoteUrlFor(repoRef) : `https://github.com/${repoRef}.git`;
  }

  sandboxFor(project: Pick<Project, "slug" | "id">): Sandbox {
    const key = project.id;
    let sb = this.sandboxes.get(key);
    if (!sb) {
      sb =
        this.o.mode === "docker"
          ? new DockerSandbox({ name: `aa-ws-${project.slug}-${project.id.slice(-6)}`.toLowerCase(), image: this.o.image, hostRoot: this.projectDir(project), extraMounts: this.o.authMounts, network: this.o.network, cpus: this.o.cpus, memory: this.o.memory })
          : new LocalSandbox();
      this.sandboxes.set(key, sb);
    }
    return sb;
  }

  /** Ensure base clone exists and is up to date. */
  async ensureRepo(project: Project): Promise<string> {
    const dir = this.repoDir(project);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      if (!project.repoRef) {
        await this.git.init(dir, project.defaultBranch);
      } else {
        await this.git.clone(this.remoteUrl(project.repoRef), dir);
      }
    } else if (project.repoRef) {
      await this.git.fetch(dir).catch(() => undefined);
    }
    return dir;
  }

  branchName(task: Pick<Task, "id" | "title">): string {
    const slug = task.title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    return `agency/${task.id.slice(-8)}${slug ? `-${slug}` : ""}`;
  }

  async prepareTask(project: Project, task: Task): Promise<TaskWorkspace> {
    const repoDir = await this.ensureRepo(project);
    const branch = task.branch ?? this.branchName(task);
    const dir = path.join(this.projectDir(project), "tasks", task.id);
    const hasRemote = !!project.repoRef;
    let base = hasRemote ? `origin/${project.defaultBranch}` : project.defaultBranch;
    // Fresh repo with no commits: create an initial commit so worktrees have a base.
    const head = await this.git.run(repoDir, ["rev-parse", "--verify", "HEAD"], { allowFail: true });
    if (!head) {
      fs.writeFileSync(path.join(repoDir, ".gitkeep"), "");
      await this.git.commitAll(repoDir, "chore: initialize repository");
      base = project.defaultBranch;
    } else if (hasRemote) {
      const remoteHead = await this.git.run(repoDir, ["rev-parse", "--verify", base], { allowFail: true });
      if (!remoteHead) base = "HEAD";
    }
    await this.git.addWorktree(repoDir, dir, branch, base);
    const sandbox = this.sandboxFor(project);
    await sandbox.ensure();
    return { repoDir, dir, branch, base, sandbox };
  }

  /** Read-only detached checkout of the default branch for a baseline quality gate. */
  async prepareBaseline(project: Project): Promise<{ dir: string; sandbox: Sandbox; commit: string | null; cleanup: () => Promise<void> }> {
    const repoDir = await this.ensureRepo(project);
    const dir = path.join(this.projectDir(project), "baseline");
    await this.git.removeWorktree(repoDir, dir);
    fs.rmSync(dir, { recursive: true, force: true });
    await this.git.run(repoDir, ["worktree", "prune"], { allowFail: true });
    const remoteRef = `origin/${project.defaultBranch}`;
    const ref = (await this.git.run(repoDir, ["rev-parse", "--verify", remoteRef], { allowFail: true })) ? remoteRef : "HEAD";
    await this.git.addDetachedWorktree(repoDir, dir, ref);
    const sandbox = this.sandboxFor(project);
    await sandbox.ensure();
    const commit = (await this.git.run(dir, ["rev-parse", "HEAD"], { allowFail: true })) || null;
    return {
      dir,
      sandbox,
      commit,
      cleanup: async () => {
        await this.git.removeWorktree(repoDir, dir);
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  async cleanupTask(project: Project, taskId: string): Promise<void> {
    const dir = path.join(this.projectDir(project), "tasks", taskId);
    await this.git.removeWorktree(this.repoDir(project), dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Release execution resources when a project is archived (keeps GitHub/topic/memory). */
  async releaseProject(project: Project): Promise<void> {
    const sb = this.sandboxes.get(project.id);
    if (sb) await sb.destroy().catch(() => undefined);
    this.sandboxes.delete(project.id);
    fs.rmSync(path.join(this.projectDir(project), "tasks"), { recursive: true, force: true });
  }

  async deleteProjectFiles(project: Project): Promise<void> {
    await this.releaseProject(project);
    fs.rmSync(this.projectDir(project), { recursive: true, force: true });
  }

  diskUsageBytes(): number {
    let total = 0;
    const walk = (p: string, depth: number) => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp, depth + 1);
        else
          try {
            total += fs.statSync(fp).size;
          } catch {}
      }
    };
    walk(this.o.root, 0);
    return total;
  }
}
