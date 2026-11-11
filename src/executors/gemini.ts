import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId, nowIso } from "../util/ids.js";
import { minimalEnv, runOnce, runProcess } from "./process.js";
import { UNSUPPORTED_CAPS, detectAuthExpired, detectQuota, emptyResult, type AdapterStatus, type ExecRequest, type ExecResult, type ExecutorAdapter, type RunningHandle } from "./types.js";

/**
 * Google Gemini CLI adapter (Phase 4, behind `executors.gemini`).
 *
 * Verified CLI surface (gemini-cli 0.67.0 `--help`): `-p` headless prompt, `-o json`, `-m` model,
 * `--approval-mode plan|auto_edit|yolo`, `--skip-trust`. Auth is chosen in ~/.gemini/settings.json
 * (`security.auth.selectedType`): only "oauth-personal" (Login with Google — subscription/Code Assist)
 * is accepted; "gemini-api-key" and Vertex AI are paid API paths and are refused. `-r` resumes by
 * index/"latest" only (not by session id), so resume is reported as unsupported.
 */
export class GeminiCliAdapter implements ExecutorAdapter {
  readonly id = "gemini-cli";
  readonly kind = "local_cli" as const;
  readonly provider = "google" as const;
  readonly displayName = "Google Gemini CLI (Login with Google)";
  readonly knownModels = ["auto"];
  readonly modelPattern = /^gemini-[a-z0-9.-]+$/;

  constructor(
    private readonly bin = "gemini",
    private readonly home = process.env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini"),
  ) {}

  static authType(settingsJson: string | null): string | null {
    if (!settingsJson) return null;
    try {
      const j = JSON.parse(settingsJson) as any;
      return j?.security?.auth?.selectedType ?? j?.selectedAuthType ?? null;
    } catch {
      return null;
    }
  }

  async detect(): Promise<AdapterStatus> {
    const ver = await runOnce(this.bin, ["--version"], { env: minimalEnv(), timeoutMs: 20000 });
    if (ver.spawnError || ver.code !== 0) {
      return { adapterId: this.id, installed: false, version: null, authenticated: false, subscriptionAuth: false, authDetail: ver.spawnError ?? ver.stderr.slice(0, 200), capabilities: UNSUPPORTED_CAPS, notes: ["Gemini CLI가 없습니다. `npm i -g @google/gemini-cli` 후 `gemini`를 실행해 Login with Google을 선택하세요."], checkedAt: nowIso() };
    }
    const settings = fs.existsSync(path.join(this.home, "settings.json")) ? fs.readFileSync(path.join(this.home, "settings.json"), "utf8") : null;
    const type = GeminiCliAdapter.authType(settings);
    const hasOauth = fs.existsSync(path.join(this.home, "oauth_creds.json"));
    const subscriptionAuth = type === "oauth-personal" && hasOauth;
    const notes: string[] = [];
    if (type && type !== "oauth-personal") notes.push(`인증 방식이 ${type}입니다. API 키/Vertex는 유료 API로 간주해 사용하지 않습니다.`);
    if (type === "oauth-personal" && !hasOauth) notes.push("Login with Google 자격 증명이 없습니다. `gemini`를 실행해 로그인하세요.");
    return {
      adapterId: this.id,
      installed: true,
      version: ver.stdout.trim() || null,
      authenticated: subscriptionAuth,
      subscriptionAuth,
      authDetail: `selectedType=${type ?? "없음"} oauth_creds=${hasOauth}`,
      capabilities: { ...UNSUPPORTED_CAPS, run: subscriptionAuth ? "unverified" : "unsupported", cancel: "supported", modelSelection: "supported", usageInfo: "unverified" },
      notes: [...notes, "실제 실행 검증 전에는 자동 선택하지 않습니다 (`verify-executor gemini-cli`)."],
      checkedAt: nowIso(),
    };
  }

  buildArgs(req: ExecRequest): string[] {
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
    const args = ["-p", prompt, "-o", "json", "--skip-trust"];
    if (req.model && req.model !== "auto") args.push("-m", req.model);
    args.push("--approval-mode", req.mode === "readonly" ? "plan" : req.isolated ? "yolo" : "auto_edit");
    return args;
  }

  static parseOutput(stdout: string): { text: string; sessionRef: string | null; usage: Record<string, unknown>; isError: boolean; errorText: string | null } {
    const first = stdout.indexOf("{");
    const last = stdout.lastIndexOf("}");
    try {
      const j = JSON.parse(first >= 0 ? stdout.slice(first, last + 1) : stdout) as any;
      const usage: Record<string, unknown> = {};
      const models = j?.stats?.models ?? {};
      for (const m of Object.values<any>(models)) {
        const t = m?.tokens ?? {};
        usage.input_tokens = Number(usage.input_tokens ?? 0) + Number(t.prompt ?? t.input ?? 0);
        usage.output_tokens = Number(usage.output_tokens ?? 0) + Number(t.candidates ?? t.output ?? 0);
      }
      if (j?.error) return { text: "", sessionRef: j.session_id ?? null, usage, isError: true, errorText: String(j.error.message ?? "gemini error") };
      return { text: String(j?.response ?? ""), sessionRef: j?.session_id ?? null, usage, isError: false, errorText: null };
    } catch {
      return { text: stdout.trim(), sessionRef: null, usage: {}, isError: false, errorText: null };
    }
  }

  start(req: ExecRequest): RunningHandle {
    const env = minimalEnv(req.env ?? {}, ["GEMINI_HOME"]);
    const w = req.wrap ? req.wrap(this.bin, this.buildArgs(req), req.cwd) : { cmd: this.bin, args: this.buildArgs(req), cwd: req.cwd as string | undefined };
    const proc = runProcess(w.cmd, w.args, { cwd: w.cwd, env, timeoutMs: req.timeoutMs ?? 30 * 60_000 });
    const result = proc.done.then((r): ExecResult => {
      if (r.spawnError) return emptyResult({ error: r.spawnError, durationMs: r.durationMs });
      const p = GeminiCliAdapter.parseOutput(r.stdout);
      const blob = `${p.errorText ?? ""}\n${r.stderr}`;
      const status: ExecResult["status"] = r.timedOut ? "timeout" : r.killed ? "cancelled" : r.code === 0 && !p.isError ? "succeeded" : "failed";
      return {
        status,
        text: p.text,
        sessionRef: p.sessionRef,
        model: req.model && req.model !== "auto" ? req.model : null,
        usage: p.usage,
        usageSource: Object.keys(p.usage).length ? "official" : "none",
        quotaExhausted: status !== "succeeded" && detectQuota(blob),
        authExpired: status !== "succeeded" && (detectAuthExpired(blob) || /auth method/i.test(blob)),
        error: status === "succeeded" ? null : (p.errorText ?? (r.stderr.trim() || `exit ${r.code}`)).slice(0, 2000),
        durationMs: r.durationMs,
      };
    });
    return { id: newId("run"), cancel: async () => ({ cancelled: proc.kill(), detail: "Gemini CLI 프로세스에 종료 신호를 보냈습니다." }), result };
  }
}
