import { newId, nowIso } from "../util/ids.js";
import { minimalEnv, runOnce, runProcess } from "./process.js";
import { UNSUPPORTED_CAPS, detectAuthExpired, detectQuota, emptyResult, type AdapterStatus, type ExecRequest, type ExecResult, type ExecutorAdapter, type RunningHandle } from "./types.js";

/**
 * OpenAI Codex CLI adapter using ChatGPT-plan sign-in (`codex login`).
 * API-key login is detected and refused — no automatic switch to paid API.
 *
 * Headless contract used:
 *   codex exec --json --skip-git-repo-check -C <cwd> [--sandbox read-only|workspace-write] [-m M] <prompt>
 *   codex exec resume <SESSION_ID> --json ... <prompt>
 * Output is JSONL events; parsing is defensive because the event schema has changed across versions.
 */
export class CodexCliAdapter implements ExecutorAdapter {
  readonly id = "codex-cli";
  readonly kind = "local_cli" as const;
  readonly provider = "openai" as const;
  readonly displayName = "OpenAI Codex (official subscription CLI)";
  readonly knownModels = ["auto"];

  constructor(
    private readonly bin: string = "codex",
    private readonly passthroughEnv: string[] = ["CODEX_HOME"],
  ) {}

  async detect(): Promise<AdapterStatus> {
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
        notes: ["Codex CLI를 찾을 수 없습니다. `npm i -g @openai/codex` 후 `codex login` (ChatGPT 로그인)을 실행하세요."],
        checkedAt: nowIso(),
      };
    }
    const version = ver.stdout.trim().split("\n")[0] ?? null;
    const st = await runOnce(this.bin, ["login", "status"], { env: minimalEnv({}, this.passthroughEnv), timeoutMs: 20000 });
    const out = `${st.stdout}\n${st.stderr}`.trim();
    const authenticated = st.code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
    const apiKey = /api key/i.test(out);
    const subscriptionAuth = authenticated && !apiKey && /chatgpt/i.test(out);
    const notes: string[] = [];
    if (authenticated && apiKey) notes.push("API 키 로그인이 감지되었습니다. 유료 API로 자동 전환하지 않으므로 이 실행기는 비활성화됩니다. `codex login` 으로 ChatGPT 로그인하세요.");
    if (authenticated && !apiKey && !subscriptionAuth) notes.push("로그인 방식을 확인할 수 없어 구독 인증 여부가 미확인입니다.");
    return {
      adapterId: this.id,
      installed: true,
      version,
      authenticated,
      subscriptionAuth,
      authDetail: out.slice(0, 300),
      capabilities: {
        run: subscriptionAuth ? "supported" : "unverified",
        cancel: "supported",
        resume: "unverified",
        modelSelection: "unverified",
        usageInfo: "unverified",
        quotaSignal: "unverified",
        imageInput: "unverified",
        audioInput: "unsupported",
      },
      notes,
      checkedAt: nowIso(),
    };
  }

  buildArgs(req: ExecRequest): string[] {
    const args = ["exec"];
    if (req.resumeSessionRef) args.push("resume", req.resumeSessionRef);
    // cwd is set on the process (or via docker exec -w), so point codex at "."
    args.push("--json", "--skip-git-repo-check", "-C", ".");
    args.push("--sandbox", req.mode === "readonly" ? "read-only" : "workspace-write");
    if (req.model && req.model !== "auto") args.push("-m", req.model);
    for (const a of req.attachments ?? []) args.push("-i", a);
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
    args.push(prompt);
    return args;
  }

  static parseOutput(stdout: string): { text: string; sessionRef: string | null; usage: Record<string, unknown>; isError: boolean; errorText: string | null } {
    let text = "";
    let sessionRef: string | null = null;
    let usage: Record<string, unknown> = {};
    let isError = false;
    let errorText: string | null = null;
    for (const line of stdout.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{")) continue;
      let ev: any;
      try {
        ev = JSON.parse(s);
      } catch {
        continue;
      }
      const type = ev.type ?? ev.msg?.type;
      if (type === "thread.started" && ev.thread_id) sessionRef = ev.thread_id;
      if (type === "session_configured" && (ev.session_id || ev.msg?.session_id)) sessionRef = ev.session_id ?? ev.msg.session_id;
      if (ev.session_id && !sessionRef) sessionRef = ev.session_id;
      if (type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") text = ev.item.text;
      if (type === "agent_message" && typeof (ev.message ?? ev.msg?.message) === "string") text = ev.message ?? ev.msg.message;
      if (type === "turn.completed" && ev.usage) usage = ev.usage;
      if (type === "token_count" && (ev.info || ev.msg?.info)) usage = ev.info ?? ev.msg.info;
      if (type === "turn.failed" || type === "error") {
        isError = true;
        errorText = ev.error?.message ?? ev.message ?? ev.msg?.message ?? "codex error";
      }
    }
    return { text, sessionRef, usage, isError, errorText };
  }

  start(req: ExecRequest): RunningHandle {
    const id = newId("run");
    const env = minimalEnv(req.env ?? {}, this.passthroughEnv);
    const w = req.wrap ? req.wrap(this.bin, this.buildArgs(req), req.cwd) : { cmd: this.bin, args: this.buildArgs(req), cwd: req.cwd as string | undefined };
    const proc = runProcess(w.cmd, w.args, { cwd: w.cwd, env, timeoutMs: req.timeoutMs ?? 30 * 60_000 });
    const result = proc.done.then((r): ExecResult => {
      if (r.spawnError) return emptyResult({ error: r.spawnError, durationMs: r.durationMs });
      const p = CodexCliAdapter.parseOutput(r.stdout);
      const errBlob = `${p.errorText ?? ""}\n${r.stderr}`;
      const status: ExecResult["status"] = r.timedOut ? "timeout" : r.killed ? "cancelled" : r.code === 0 && !p.isError ? "succeeded" : "failed";
      return {
        status,
        text: p.text,
        sessionRef: p.sessionRef,
        model: req.model && req.model !== "auto" ? req.model : null,
        usage: p.usage,
        usageSource: Object.keys(p.usage).length ? "official" : "none",
        quotaExhausted: status !== "succeeded" && detectQuota(errBlob),
        authExpired: status !== "succeeded" && detectAuthExpired(errBlob),
        error: status === "succeeded" ? null : (p.errorText ?? r.stderr.trim() ?? `exit ${r.code}`).slice(0, 2000),
        durationMs: r.durationMs,
      };
    });
    return {
      id,
      cancel: async () => {
        const ok = proc.kill();
        return { cancelled: ok, detail: ok ? "Codex CLI 프로세스에 종료 신호를 보냈습니다." : "프로세스를 찾을 수 없습니다." };
      },
      result,
    };
  }
}
