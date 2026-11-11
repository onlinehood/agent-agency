import path from "node:path";
import { runOnce } from "../executors/process.js";

/**
 * Command sandbox abstraction (PRD §6.2, §8.1).
 * - LocalSandbox: runs on the host in the workspace directory (development / single-user).
 * - DockerSandbox: runs in a per-project non-root container with CPU/RAM limits and a
 *   restricted network. The workspace directory is bind-mounted at /workspace.
 */
export interface WrappedCommand {
  cmd: string;
  args: string[];
  cwd: string | undefined;
}

export interface Sandbox {
  readonly kind: "local" | "docker";
  readonly isolated: boolean;
  ensure(): Promise<void>;
  wrap(cmd: string, args: string[], cwd: string): WrappedCommand;
  destroy(): Promise<void>;
}

export class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  readonly isolated = false;
  async ensure(): Promise<void> {}
  wrap(cmd: string, args: string[], cwd: string): WrappedCommand {
    return { cmd, args, cwd };
  }
  async destroy(): Promise<void> {}
}

export interface DockerSandboxOptions {
  name: string;
  image: string;
  hostRoot: string; // host dir mounted at /workspace
  cpus?: number;
  memory?: string; // e.g. "2g"
  network?: string; // docker network name; "none" for no network
  pidsLimit?: number;
  user?: string; // uid:gid
  /** Read-only mounts for CLI auth (e.g. ~/.claude) */
  extraMounts?: Array<{ host: string; container: string; readonly?: boolean }>;
}

export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly isolated = true;
  constructor(private o: DockerSandboxOptions) {}

  runArgs(): string[] {
    const a = [
      "run",
      "-d",
      "--name",
      this.o.name,
      "--user",
      this.o.user ?? "1000:1000",
      "--cpus",
      String(this.o.cpus ?? 2),
      "--memory",
      this.o.memory ?? "4g",
      "--pids-limit",
      String(this.o.pidsLimit ?? 512),
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--network",
      this.o.network ?? "bridge",
      "-v",
      `${this.o.hostRoot}:/workspace`,
      "-w",
      "/workspace",
    ];
    for (const m of this.o.extraMounts ?? []) a.push("-v", `${m.host}:${m.container}${m.readonly ? ":ro" : ""}`);
    a.push(this.o.image, "sleep", "infinity");
    return a;
  }

  async ensure(): Promise<void> {
    const insp = await runOnce("docker", ["inspect", "-f", "{{.State.Running}}", this.o.name], { timeoutMs: 15000 });
    if (insp.code === 0 && insp.stdout.trim() === "true") return;
    if (insp.code === 0) {
      await runOnce("docker", ["start", this.o.name], { timeoutMs: 30000 });
      return;
    }
    const r = await runOnce("docker", this.runArgs(), { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`docker sandbox start failed: ${r.stderr.trim().slice(0, 500)}`);
  }

  toContainerPath(hostPath: string): string {
    const rel = path.relative(this.o.hostRoot, hostPath);
    if (rel.startsWith("..")) throw new Error(`path ${hostPath} is outside the sandbox root`);
    return path.posix.join("/workspace", rel.split(path.sep).join("/"));
  }

  wrap(cmd: string, args: string[], cwd: string): WrappedCommand {
    return { cmd: "docker", args: ["exec", "-i", "-w", this.toContainerPath(cwd), this.o.name, cmd, ...args], cwd: undefined };
  }

  async destroy(): Promise<void> {
    await runOnce("docker", ["rm", "-f", this.o.name], { timeoutMs: 30000 });
  }
}
