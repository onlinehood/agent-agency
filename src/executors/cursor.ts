import { newId, nowIso } from "../util/ids.js";
import { minimalEnv, runOnce, runProcess } from "./process.js";
import { ClaudeCliAdapter } from "./claude.js";
import { UNSUPPORTED_CAPS, detectAuthExpired, detectQuota, emptyResult, type AdapterStatus, type ExecRequest, type ExecResult, type ExecutorAdapter, type RunningHandle } from "./types.js";

/**
 * Cursor Agent CLI adapter (Phase 4, behind `executors.cursor`).
 *
 * Verified CLI surface (cursor-agent 2026.11.05 `--help`, official package from downloads.cursor.com):
 * `-p/--print`, `--output-format json`, `--mode plan` (read-only), `-f/--force`, `--model`,
 * `--resume [chatId]`, `--workspace`, `--trust`, `status --format json`. Only an interactive `cursor-agent login`
 * (Cursor subscription) is accepted; `--api-key`/CURSOR_API_KEY is stripped and never used.
 */
export class CursorCliAdapter implements ExecutorAdapter {
  readonly id = "cursor-cli";
  readonly kind = "local_cli" as const;
  readonly provider = "cursor" as const;
  readonly displayName = "Cursor Agent CLI (Cursor subscription)";
  readonly knownModels = ["auto"];
  readonly modelPattern = /^[a-z0-9][a-z0-9.-]{1,40}$/;

  constructor(private readonly bin = "cursor-agent") {}

  static parseStatus(stdout: string): { authenticated: boolean; detail: string; apiKey: boolean } {
    const text = stdout.trim();
    try {
      const j = JSON.parse(text) as any;
      const authenticated = !!(j.authenticated ?? j.loggedIn ?? j.isAuthenticated ?? j.email ?? j.user);
      const method = String(j.authMethod ?? j.method ?? "").toLowerCase();
      return { authenticated, detail: `authenticated=${authenticated}${method ? ` method=${method}` : ""}`, apiKey: method.includes("api") };
    } catch {
      const authenticated = /logged in|authenticated/i.test(text) && !/not logged in/i.test(text);
      return { authenticated, detail: text.split("\n")[0]?.slice(0, 120) ?? "", apiKey: /api key/i.test(text) };
    }
  }

  async detect(): Promise<AdapterStatus> {
    const env = minimalEnv();
    const ver = await runOnce(this.bin, ["--version"], { env, timeoutMs: 20000 });
    if (ver.spawnError || ver.code !== 0) {
      return { adapterId: this.id, installed: false, version: null, authenticated: false, subscriptionAuth: false, authDetail: ver.spawnError ?? ver.stderr.slice(0, 200), capabilities: UNSUPPORTED_CAPS, notes: ["Cursor Agent CLI가 없습니다. Cursor 공식 설치 안내에 따라 설치한 뒤 `cursor-agent login`을 실행하세요."], checkedAt: nowIso() };
    }
    const st = await runOnce(this.bin, ["status", "--format", "json"], { env, timeoutMs: 20000 });
    const s = CursorCliAdapter.parseStatus(`${st.stdout}${st.stdout ? "" : st.stderr}`);
    const subscriptionAuth = s.authenticated && !s.apiKey;
    return {
      adapterId: this.id,
      installed: true,
      version: ver.stdout.trim() || null,
      authenticated: s.authenticated,
      subscriptionAuth,
      authDetail: s.detail,
      capabilities: { ...UNSUPPORTED_CAPS, run: subscriptionAuth ? "unverified" : "unsupported", cancel: "supported", resume: "unverified", modelSelection: "supported", usageInfo: "unverified" },
      notes: ["실제 실행 검증 전에는 자동 선택하지 않습니다 (`verify-executor cursor-cli`).", ...(s.apiKey ? ["API 키 인증은 사용하지 않습니다. `cursor-agent login`으로 구독 로그인하세요."] : [])],
      checkedAt: nowIso(),
    };
  }

  buildArgs(req: ExecRequest): string[] {
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
    // Headless runs cannot answer Cursor's "Workspace Trust Required" prompt. AgentAgency picks the
    // directory itself (an isolated task workspace or its own data dir), so it trusts that folder.
    // --trust only marks the folder trusted; it does not auto-approve commands like --force/--yolo.
    const args = ["-p", "--output-format", "json", "--workspace", ".", "--trust"];
    if (req.mode === "readonly") args.push("--mode", "plan");
    else if (req.isolated) args.push("--force");
    if (req.model && req.model !== "auto") args.push("--model", req.model);
    if (req.resumeSessionRef) args.push("--resume", req.resumeSessionRef);
    args.push(prompt);
    return args;
  }

  start(req: ExecRequest): RunningHandle {
    const env = minimalEnv(req.env ?? {});
    const w = req.wrap ? req.wrap(this.bin, this.buildArgs(req), req.cwd) : { cmd: this.bin, args: this.buildArgs(req), cwd: req.cwd as string | undefined };
    const proc = runProcess(w.cmd, w.args, { cwd: w.cwd, env, timeoutMs: req.timeoutMs ?? 30 * 60_000 });
    const result = proc.done.then((r): ExecResult => {
      if (r.spawnError) return emptyResult({ error: r.spawnError, durationMs: r.durationMs });
      // Cursor's json result mirrors Claude Code's single result object; parse it the same tolerant way.
      const p = ClaudeCliAdapter.parseOutput(r.stdout);
      const status: ExecResult["status"] = r.timedOut ? "timeout" : r.killed ? "cancelled" : r.code === 0 && !p.isError ? "succeeded" : "failed";
      return {
        status,
        text: p.text,
        sessionRef: p.sessionRef,
        model: req.model && req.model !== "auto" ? req.model : null,
        usage: p.usage,
        usageSource: Object.keys(p.usage).length ? "official" : "none",
        quotaExhausted: status !== "succeeded" && detectQuota(r.stderr),
        authExpired: status !== "succeeded" && detectAuthExpired(r.stderr),
        error: status === "succeeded" ? null : (r.stderr.trim() || p.text || `exit ${r.code}`).slice(0, 2000),
        durationMs: r.durationMs,
      };
    });
    return { id: newId("run"), cancel: async () => ({ cancelled: proc.kill(), detail: "Cursor Agent 프로세스에 종료 신호를 보냈습니다." }), result };
  }
}
