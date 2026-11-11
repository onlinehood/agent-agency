import { spawn } from "node:child_process";

export interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
  spawnError?: string;
}

export interface ProcHandle {
  pid: number | undefined;
  kill(): boolean;
  done: Promise<ProcResult>;
}

/** Variables that would silently switch a subscription CLI to paid API billing — always stripped (PRD §1.1-5, §12-6). */
export const PAID_API_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  // Cursor CLI API keys bypass the interactive subscription login; never forwarded.
  "CURSOR_API_KEY",
];

/** Build a minimal environment for a child CLI process: only what it needs, never app secrets. */
export function minimalEnv(extra: Record<string, string> = {}, passthrough: string[] = []): Record<string, string> {
  const base = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", ...passthrough];
  const env: Record<string, string> = {};
  for (const k of base) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  for (const k of PAID_API_ENV_VARS) delete env[k];
  return env;
}

export function runProcess(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string; maxBuffer?: number } = {}): ProcHandle {
  const started = Date.now();
  const maxBuffer = opts.maxBuffer ?? 20 * 1024 * 1024;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let killed = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? (process.env as Record<string, string>), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch (e) {
    return {
      pid: undefined,
      kill: () => false,
      done: Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, killed: false, durationMs: 0, spawnError: (e as Error).message }),
    };
  }

  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  };

  const done = new Promise<ProcResult>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        setTimeout(() => killTree("SIGKILL"), 5000).unref();
      }, opts.timeoutMs);
    }
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < maxBuffer) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < maxBuffer) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, killed, durationMs: Date.now() - started, spawnError: err.message });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, killed, durationMs: Date.now() - started });
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });

  return {
    pid: child.pid,
    kill: () => {
      killed = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5000).unref();
      return true;
    },
    done,
  };
}

export async function runOnce(cmd: string, args: string[], opts: Parameters<typeof runProcess>[2] = {}): Promise<ProcResult> {
  return runProcess(cmd, args, opts).done;
}
