import type { QualityCheckResult, QualityGateSummary, ProjectSettings } from "../core/types.js";
import { minimalEnv, runOnce } from "../executors/process.js";
import { maskSecrets } from "../security/masking.js";
import type { Sandbox } from "../workspace/sandbox.js";
import { detectChecks, type CheckCommand } from "./detect.js";
import { nowIso } from "../util/ids.js";

export interface GateOptions {
  dir: string;
  sandbox: Sandbox;
  settings?: ProjectSettings;
  playwright?: boolean;
  security?: boolean;
  /** Re-runs of a failed test step used to detect flakiness (PRD §5-7). */
  flakyReruns?: number;
  /** Override detection (tests) */
  checks?: CheckCommand[];
}

export interface GateResult extends QualityGateSummary {
  flaky: Array<{ name: string; attempts: number; firstFailure: string }>;
  /** Names of checks whose failure blocks the gate. */
  blocking: string[];
}

function tail(s: string, n = 3000): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}

async function runCheck(c: CheckCommand, o: GateOptions): Promise<QualityCheckResult & { raw: string }> {
  const w = o.sandbox.wrap(c.cmd, c.args, o.dir);
  const env = minimalEnv({ CI: "true", FORCE_COLOR: "0" });
  const r = await runOnce(w.cmd, w.args, { cwd: w.cwd, env, timeoutMs: c.timeoutMs });
  const raw = maskSecrets(`${r.stdout}\n${r.stderr}`);
  if (r.spawnError) {
    return { name: c.name, status: "error", durationMs: r.durationMs, summary: `실행 불가: ${r.spawnError}`, details: tail(raw), raw };
  }
  if (r.timedOut) {
    return { name: c.name, status: "failed", durationMs: r.durationMs, summary: `시간 초과 (${Math.round(c.timeoutMs / 1000)}s)`, details: tail(raw), raw };
  }
  const ok = r.code === 0;
  return { name: c.name, status: ok ? "passed" : "failed", durationMs: r.durationMs, summary: ok ? "통과" : `실패 (exit ${r.code})`, details: tail(raw), raw };
}

/**
 * Run the quality gate. Mandatory checks are never skipped to improve metrics (PRD §9).
 * Flaky handling: a failing test/playwright step is re-run; if it then passes, we record the
 * flake with the first failure log for comparison and re-run the whole gate once more so the
 * final verdict comes from a clean, complete run.
 */
export async function runQualityGate(o: GateOptions): Promise<GateResult> {
  const checks = o.checks ?? detectChecks(o.dir, o.settings ?? {}, { playwright: o.playwright, security: o.security });
  const flaky: GateResult["flaky"] = [];
  const execute = async (allowFlakyRetry: boolean): Promise<QualityCheckResult[]> => {
    const results: QualityCheckResult[] = [];
    let blockedByInstall = false;
    for (const c of checks) {
      if (blockedByInstall) {
        results.push({ name: c.name, status: "skipped", durationMs: 0, summary: "의존성 설치 실패로 건너뜀" });
        continue;
      }
      let res = await runCheck(c, o);
      if (res.status === "failed" && allowFlakyRetry && (c.name === "test" || c.name === "playwright")) {
        const reruns = o.flakyReruns ?? 2;
        for (let i = 1; i <= reruns; i++) {
          const again = await runCheck(c, o);
          if (again.status === "passed") {
            flaky.push({ name: c.name, attempts: i + 1, firstFailure: tail(res.raw, 1500) });
            res = { ...again, summary: `통과 (재실행 ${i}회 후 — flaky 의심)` };
            break;
          }
        }
      }
      const { raw: _raw, ...clean } = res;
      results.push(clean);
      if (c.name === "install" && res.status !== "passed") blockedByInstall = true;
    }
    return results;
  };

  let results = await execute(true);
  if (flaky.length) {
    // Re-run the full gate without flaky retries to confirm.
    results = await execute(false);
  }
  const blockingNames = new Set(checks.filter((c) => c.blocking).map((c) => c.name));
  const passed = results.every((r) => !blockingNames.has(r.name as CheckCommand["name"]) || r.status === "passed");
  return { passed: checks.length === 0 ? true : passed, checks: results, ranAt: nowIso(), flaky, blocking: [...blockingNames] };
}

export function summarizeGate(g: QualityGateSummary): string {
  if (!g.checks.length) return "실행 가능한 검사 항목을 찾지 못했습니다 (테스트 스크립트 없음).";
  return g.checks.map((c) => `${c.status === "passed" ? "✅" : c.status === "skipped" ? "⏭️" : "❌"} ${c.name}: ${c.summary}`).join("\n");
}
