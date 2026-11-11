import { newId, nowIso } from "../util/ids.js";
import { minimalEnv, runOnce, runProcess } from "./process.js";
import { UNSUPPORTED_CAPS, detectAuthExpired, detectQuota, emptyResult, type AdapterStatus, type ExecRequest, type ExecResult, type ExecutorAdapter, type RunningHandle } from "./types.js";

/**
 * Claude Code CLI adapter using the user's official subscription login
 * (`claude auth login` / `claude setup-token`). Paid API env vars are stripped so the
 * CLI can never silently fall back to API billing.
 *
 * Headless contract used (verified against Claude Code 2.x `--help`):
 *   claude -p <prompt> --output-format json [--model M] [--resume SID]
 *          [--permission-mode acceptEdits|bypassPermissions|plan] [--append-system-prompt S]
 *          [--allowedTools ...] [--disallowedTools ...]
 */
export class ClaudeCliAdapter implements ExecutorAdapter {
  readonly id = "claude-cli";
  readonly kind = "local_cli" as const;
  readonly provider = "anthropic" as const;
  readonly displayName = "Claude Code (official subscription CLI)";
  readonly knownModels = ["auto", "opus", "sonnet", "haiku"];
  readonly modelPattern = /^claude-[a-z0-9.-]+(\[1m\])?$/;

  constructor(
    private readonly bin: string = "claude",
    private readonly passthroughEnv: string[] = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
  ) {}

  async detect(): Promise<AdapterStatus> {
    const notes: string[] = [];
    const ver = await runOnce(this.bin, ["--version"], { env: minimalEnv({}, this.passthroughEnv), timeoutMs: 15000 });
    if (ver.spawnError || ver.code !== 0) {
      return {
        adapterId: this.id,
        installed: false,
        version: null,
        authenticated: false,
        subscriptionAuth: false,
        authDetail: ver.spawnError ?? ver.stderr.trim().slice(0, 300),
        capabilities: UNSUPPORTED_CAPS,
        notes: ["Claude CLI를 찾을 수 없습니다. `npm i -g @anthropic-ai/claude-code` 후 `claude auth login` 으로 구독 로그인하세요."],
        checkedAt: nowIso(),
      };
    }
    const version = ver.stdout.trim().split("\n")[0] ?? null;
    const auth = await runOnce(this.bin, ["auth", "status", "--json"], { env: minimalEnv({}, this.passthroughEnv), timeoutMs: 20000 });
    let authenticated = false;
    let subscriptionAuth = false;
    let authDetail: string;
    try {
      const j = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
      authenticated = !!j.loggedIn;
      const method = (j.authMethod ?? "").toLowerCase();
      const provider = (j.apiProvider ?? "firstParty").toLowerCase();
      subscriptionAuth = authenticated && !method.includes("api_key") && !method.includes("apikey") && provider === "firstparty";
      authDetail = `loggedIn=${authenticated} method=${j.authMethod ?? "?"} provider=${j.apiProvider ?? "?"}`;
      if (authenticated && !subscriptionAuth) notes.push("API 키/서드파티 공급자 인증이 감지되었습니다. 유료 API로 자동 전환하지 않으므로 이 실행기는 비활성화됩니다.");
    } catch {
      authDetail = (auth.stderr || auth.stdout).trim().slice(0, 300) || "auth status unavailable";
      notes.push("`claude auth status --json` 결과를 해석하지 못했습니다. 인증 상태는 미확인입니다.");
    }
    return {
      adapterId: this.id,
      installed: true,
      version,
      authenticated,
      subscriptionAuth,
      authDetail,
      capabilities: {
        run: subscriptionAuth ? "supported" : "unverified",
        // We own the child process, so cancellation is a real process termination.
        cancel: "supported",
        resume: "supported",
        modelSelection: "supported",
        // json output carries token usage; cost fields are API-equivalent estimates under a subscription.
        usageInfo: "supported",
        // Remaining subscription quota is not exposed officially; only limit-hit messages are detectable.
        quotaSignal: "unverified",
        imageInput: "unverified",
        audioInput: "unsupported",
      },
      notes,
      checkedAt: nowIso(),
    };
  }

  buildArgs(req: ExecRequest): string[] {
    const args = ["-p", req.prompt, "--output-format", "json"];
    if (req.model && req.model !== "auto") args.push("--model", req.model);
    if (req.resumeSessionRef) args.push("--resume", req.resumeSessionRef);
    if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
    const web = req.allowWeb ? ["WebFetch", "WebSearch"] : [];
    if (req.mode === "readonly") {
      args.push("--permission-mode", "default", "--allowedTools", "Read", "Grep", "Glob", ...web, "--disallowedTools", "Edit", "Write", "Bash", ...(req.allowWeb ? [] : ["WebFetch"]));
    } else if (req.isolated) {
      // Inside an isolated non-root container: commands are allowed by default (PRD §8.1).
      args.push("--permission-mode", "bypassPermissions");
    } else {
      args.push("--permission-mode", "acceptEdits", "--allowedTools", "Read", "Grep", "Glob", "Edit", "Write", "Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)", "Bash(yarn *)", "Bash(node *)", "Bash(python *)", "Bash(pytest *)", "Bash(git status*)", "Bash(git diff*)", "Bash(ls *)", "Bash(cat *)", ...web);
    }
    return args;
  }

  static parseOutput(stdout: string): { text: string; sessionRef: string | null; usage: Record<string, unknown>; model: string | null; isError: boolean } {
    const trimmed = stdout.trim();
    // json mode emits a single result object; be tolerant of extra lines.
    const lines = trimmed.split("\n").reverse();
    for (const line of [trimmed, ...lines]) {
      try {
        const j = JSON.parse(line) as Record<string, any>;
        if (j && (j.type === "result" || "result" in j)) {
          const usage: Record<string, unknown> = { ...(j.usage ?? {}) };
          if (typeof j.total_cost_usd === "number") usage.api_equivalent_cost_usd_estimate = j.total_cost_usd;
          if (typeof j.num_turns === "number") usage.num_turns = j.num_turns;
          if (typeof j.duration_ms === "number") usage.duration_ms = j.duration_ms;
          const model = j.modelUsage ? Object.keys(j.modelUsage)[0] ?? null : (j.model ?? null);
          return { text: String(j.result ?? ""), sessionRef: j.session_id ?? null, usage, model, isError: !!j.is_error || j.subtype === "error" };
        }
      } catch {}
    }
    return { text: trimmed, sessionRef: null, usage: {}, model: null, isError: false };
  }

  start(req: ExecRequest): RunningHandle {
    const id = newId("run");
    const env = minimalEnv(req.env ?? {}, this.passthroughEnv);
    const w = req.wrap ? req.wrap(this.bin, this.buildArgs(req), req.cwd) : { cmd: this.bin, args: this.buildArgs(req), cwd: req.cwd as string | undefined };
    const proc = runProcess(w.cmd, w.args, { cwd: w.cwd, env, timeoutMs: req.timeoutMs ?? 30 * 60_000 });
    const result = proc.done.then((r): ExecResult => {
      if (r.spawnError) return emptyResult({ error: r.spawnError, durationMs: r.durationMs });
      const parsed = ClaudeCliAdapter.parseOutput(r.stdout);
      const quota = detectQuota(r.stderr) || (parsed.isError && detectQuota(parsed.text));
      const authExpired = detectAuthExpired(r.stderr) || (parsed.isError && detectAuthExpired(parsed.text));
      const status: ExecResult["status"] = r.timedOut ? "timeout" : r.killed ? "cancelled" : r.code === 0 && !parsed.isError ? "succeeded" : "failed";
      return {
        status,
        text: parsed.text,
        sessionRef: parsed.sessionRef,
        model: parsed.model ?? (req.model && req.model !== "auto" ? req.model : null),
        usage: parsed.usage,
        usageSource: Object.keys(parsed.usage).length ? "official" : "none",
        quotaExhausted: quota,
        authExpired,
        error: status === "succeeded" ? null : (r.stderr.trim() || parsed.text || `exit ${r.code}`).slice(0, 2000),
        durationMs: r.durationMs,
      };
    });
    return {
      id,
      cancel: async () => {
        const ok = proc.kill();
        return { cancelled: ok, detail: ok ? "Claude CLI 프로세스에 종료 신호를 보냈습니다." : "프로세스를 찾을 수 없습니다." };
      },
      result,
    };
  }
}
