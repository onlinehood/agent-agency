import { newId, nowIso } from "../util/ids.js";
import { minimalEnv, runOnce } from "./process.js";
import { UNSUPPORTED_CAPS, detectAuthExpired, detectQuota, emptyResult, type AdapterStatus, type ExecRequest, type ExecResult, type ExecutorAdapter, type ExternalJobState, type RunningHandle } from "./types.js";

/**
 * Codex Cloud adapter (official ChatGPT-plan cloud tasks) — PRD §15 "Cloud First".
 *
 * Verified CLI surface (codex-cli 0.167.0, `codex cloud --help`, marked [EXPERIMENTAL]):
 *   codex cloud exec --env <ENV_ID> [--branch B] <QUERY>   submit a task
 *   codex cloud status <TASK_ID>                            poll status
 *   codex cloud diff <TASK_ID>                              collect the unified diff
 *   codex cloud apply <TASK_ID>                             apply diff to the local worktree
 * There is no cancel subcommand → cancel is reported as unsupported.
 *
 * Output formats of these subcommands are not documented as stable, so run/status/result
 * remain "unverified" until an operator records a successful verification run
 * (`agent-agency verify-executor codex-cloud`). Unverified cloud executors are never selected.
 */
export class CodexCloudAdapter implements ExecutorAdapter {
  readonly id = "codex-cloud";
  readonly kind = "cloud" as const;
  readonly provider = "openai" as const;
  readonly displayName = "OpenAI Codex Cloud (official subscription, experimental)";
  readonly knownModels = ["auto"];

  constructor(
    private readonly bin = "codex",
    private readonly pollIntervalMs = 15_000,
    private readonly passthroughEnv: string[] = ["CODEX_HOME"],
  ) {}

  async detect(): Promise<AdapterStatus> {
    const env = minimalEnv({}, this.passthroughEnv);
    const help = await runOnce(this.bin, ["cloud", "--help"], { env, timeoutMs: 15000 });
    if (help.spawnError || help.code !== 0) {
      return { adapterId: this.id, installed: false, version: null, authenticated: false, subscriptionAuth: false, authDetail: help.spawnError ?? help.stderr.slice(0, 200), capabilities: UNSUPPORTED_CAPS, notes: ["Codex CLI의 cloud 명령을 찾을 수 없습니다."], checkedAt: nowIso() };
    }
    const hasExec = /\bexec\b/.test(help.stdout) && /\bstatus\b/.test(help.stdout) && /\bdiff\b/.test(help.stdout);
    const ver = await runOnce(this.bin, ["--version"], { env, timeoutMs: 15000 });
    const st = await runOnce(this.bin, ["login", "status"], { env, timeoutMs: 20000 });
    const out = `${st.stdout}\n${st.stderr}`;
    const authenticated = st.code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
    const subscriptionAuth = authenticated && /chatgpt/i.test(out) && !/api key/i.test(out);
    return {
      adapterId: this.id,
      installed: hasExec,
      version: ver.stdout.trim() || null,
      authenticated,
      subscriptionAuth,
      authDetail: out.trim().slice(0, 200),
      capabilities: {
        ...UNSUPPORTED_CAPS,
        run: hasExec ? "unverified" : "unsupported",
        statusQuery: hasExec ? "unverified" : "unsupported",
        resultCollection: hasExec ? "unverified" : "unsupported",
        cancel: "unsupported",
      },
      notes: [
        "Codex Cloud 명령은 [EXPERIMENTAL] 표시입니다. 출력 형식이 공식 고정되지 않아 실제 검증 실행 기록 전에는 자동 사용하지 않습니다.",
        "Codex Cloud에는 공식 취소 명령이 없습니다. 중단 요청 시 결과 반영만 중지하며 클라우드 작업 자체는 계속될 수 있습니다.",
        "Codex Cloud 실행에는 Codex 웹에서 만든 환경 ID(--env)가 필요합니다.",
      ],
      checkedAt: nowIso(),
    };
  }

  static parseTaskId(text: string): string | null {
    const url = /\/tasks\/([A-Za-z0-9_-]{6,})/.exec(text);
    if (url) return url[1]!;
    const labeled = /\btask[_ ]?id\b["':\s]*([A-Za-z0-9_-]{6,})/i.exec(text);
    if (labeled) return labeled[1]!;
    const tok = /\b(task_[A-Za-z0-9_-]{6,})\b/.exec(text);
    return tok ? tok[1]! : null;
  }

  static parseState(text: string): ExternalJobState {
    const t = text.toLowerCase();
    if (/\b(ready|completed|complete|succeeded|success|done|applied)\b/.test(t)) return "finished";
    if (/\b(error|failed|failure|cancelled|canceled)\b/.test(t)) return "failed";
    if (/\b(pending|queued|running|in[_ ]progress|working)\b/.test(t)) return "running";
    return "unknown";
  }

  async externalStatus(ref: string): Promise<ExternalJobState> {
    const r = await runOnce(this.bin, ["cloud", "status", ref], { env: minimalEnv({}, this.passthroughEnv), timeoutMs: 30000 });
    if (r.code !== 0) return "unknown";
    return CodexCloudAdapter.parseState(`${r.stdout}\n${r.stderr}`);
  }

  start(req: ExecRequest): RunningHandle {
    const id = newId("run");
    let stopped = false;
    const started = Date.now();
    const env = minimalEnv(req.env ?? {}, this.passthroughEnv);
    const result = (async (): Promise<ExecResult> => {
      if (!req.cloud?.environmentId) return emptyResult({ error: "이 프로젝트에 Codex Cloud 환경 ID가 없습니다 (프로젝트 Topic에서 /exec cloud <환경 ID>)." });
      const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
      const args = ["cloud", "exec", "--env", req.cloud.environmentId];
      if (req.cloud.branch) args.push("--branch", req.cloud.branch);
      args.push(prompt);
      const sub = await runOnce(this.bin, args, { env, cwd: req.cwd, timeoutMs: 120000 });
      const subOut = `${sub.stdout}\n${sub.stderr}`;
      if (sub.code !== 0) return emptyResult({ error: subOut.slice(0, 1500), quotaExhausted: detectQuota(subOut), authExpired: detectAuthExpired(subOut), durationMs: Date.now() - started });
      const taskId = CodexCloudAdapter.parseTaskId(subOut);
      if (!taskId) return emptyResult({ error: "Codex Cloud 작업 ID를 출력에서 확인하지 못했습니다 (출력 형식 미확인).", durationMs: Date.now() - started });
      await req.onExternalRef?.(taskId);
      const deadline = started + (req.timeoutMs ?? 60 * 60_000);
      let state: ExternalJobState = "running";
      while (!stopped && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        state = await this.externalStatus(taskId);
        if (state === "finished" || state === "failed") break;
      }
      if (stopped) return emptyResult({ status: "cancelled", sessionRef: taskId, error: "결과 반영을 중지했습니다. Codex Cloud는 공식 취소를 지원하지 않아 클라우드 작업은 계속될 수 있습니다.", durationMs: Date.now() - started });
      if (state !== "finished") return emptyResult({ status: state === "failed" ? "failed" : "timeout", sessionRef: taskId, error: `Codex Cloud 작업 상태: ${state}`, durationMs: Date.now() - started });
      const diff = await runOnce(this.bin, ["cloud", "diff", taskId], { env, cwd: req.cwd, timeoutMs: 60000 });
      if (req.mode === "write") {
        const apply = await runOnce(this.bin, ["cloud", "apply", taskId], { env, cwd: req.cwd, timeoutMs: 120000 });
        if (apply.code !== 0) return emptyResult({ sessionRef: taskId, error: `diff 적용 실패: ${(apply.stderr || apply.stdout).slice(0, 1000)}`, durationMs: Date.now() - started });
      }
      return {
        status: "succeeded",
        text: diff.stdout.slice(0, 20000),
        sessionRef: taskId,
        model: null,
        usage: {},
        usageSource: "none",
        quotaExhausted: false,
        authExpired: false,
        error: null,
        durationMs: Date.now() - started,
      };
    })();
    return {
      id,
      cancel: async () => {
        stopped = true;
        return { cancelled: false, detail: "Codex Cloud는 공식 취소 명령이 없습니다. 결과 반영만 중지했고 클라우드 작업은 계속될 수 있습니다." };
      },
      result,
    };
  }
}
