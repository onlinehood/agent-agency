import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../core/context.js";
import type { VerificationRecord } from "./registry.js";
import { resolveExecutionPolicy } from "../core/execution/policy.js";

const TOKEN = "AGENT_AGENCY_OK";

/**
 * Phase 0 verification run (PRD §11, §15/§19 P0): actually execute a harmless, read-only
 * request on an official subscription executor and record the observed evidence. Executors whose
 * automation surface is not officially stable (cloud) only become schedulable after this passes.
 */
export async function verifyExecutor(ctx: AppContext, adapterId: string, opts: { userId?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; record?: VerificationRecord; detail: string }> {
  const adapter = ctx.executors.get(adapterId);
  if (!adapter) return { ok: false, detail: "등록되지 않은 실행기" };
  if (adapter.kind === "paid_api") return { ok: false, detail: "유료 API 실행기는 자동 검증 대상이 아닙니다." };
  const status = await adapter.detect();
  ctx.executors.setStatus(status);
  if (!status.installed) return { ok: false, detail: `미설치: ${status.notes.join(" ")}` };
  if (!status.authenticated || !status.subscriptionAuth) return { ok: false, detail: `공식 구독 인증 필요: ${status.authDetail}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-verify-"));
  const policy = opts.userId ? await resolveExecutionPolicy(ctx.repos, { userId: opts.userId }) : null;
  const externalRefs: string[] = [];
  const started = Date.now();
  const h = adapter.start({
    prompt: `Reply with exactly ${TOKEN} and nothing else. Do not create, modify or delete any files.`,
    cwd: dir,
    mode: "readonly",
    model: "auto",
    timeoutMs: opts.timeoutMs ?? (adapter.kind === "cloud" ? 20 * 60_000 : 3 * 60_000),
    onExternalRef: (r) => {
      externalRefs.push(r);
    },
    cloud: { environmentId: policy?.cloud.codexEnvironmentId },
  });
  const r = await h.result;
  fs.rmSync(dir, { recursive: true, force: true });
  const ok = r.status === "succeeded" && (adapter.kind === "cloud" ? externalRefs.length > 0 : r.text.includes(TOKEN));
  const evidence = [
    `status=${r.status}`,
    `duration=${Math.round((Date.now() - started) / 1000)}s`,
    r.sessionRef ? `session=${r.sessionRef}` : "",
    externalRefs.length ? `external_job=${externalRefs.join(",")}` : "",
    `usage_source=${r.usageSource}`,
    `output_ok=${r.text.includes(TOKEN)}`,
    r.error ? `error=${r.error.slice(0, 200)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  await ctx.repos.audit.record("system", "executor.verify", `executor:${adapterId}`, ok ? "success" : "failure", { evidence, version: status.version });
  if (!ok) return { ok: false, detail: `검증 실패: ${evidence}` };
  const record: VerificationRecord = { adapterId, verifiedAt: new Date().toISOString(), evidence, version: status.version };
  await ctx.repos.settings.set("system", "", `executor.verification.${adapterId}`, record);
  ctx.executors.setVerification(record);
  return { ok: true, record, detail: evidence };
}
