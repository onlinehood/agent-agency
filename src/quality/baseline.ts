import type { QualityCheckResult } from "../core/types.js";

/**
 * Baseline of an imported repository's quality gate, taken on the untouched default branch before
 * any agent change (Phase 3 "기존 저장소 가져오기"). Checks that already fail there would otherwise
 * block every task, so they are judged as "no regression" instead: still executed and reported,
 * never hidden, but only checks that passed at baseline (or are new) can block.
 */
export interface Baseline {
  ranAt: string;
  commit: string | null;
  checks: Array<{ name: string; status: QualityCheckResult["status"]; summary: string }>;
}

export interface BaselineVerdict {
  passed: boolean;
  /** Blocking checks failing now that also failed at baseline (reported, not blocking). */
  preexisting: string[];
  /** Checks that passed at baseline (or are new) and fail now. */
  regressions: string[];
}

export function applyBaseline(checks: QualityCheckResult[], blocking: Set<string>, baseline: Baseline | undefined): BaselineVerdict {
  const failedAtBaseline = new Set((baseline?.checks ?? []).filter((c) => c.status === "failed" || c.status === "error").map((c) => c.name));
  const failing = checks.filter((c) => blocking.has(c.name) && c.status !== "passed");
  const preexisting = failing.filter((c) => failedAtBaseline.has(c.name)).map((c) => c.name);
  const regressions = failing.filter((c) => !failedAtBaseline.has(c.name)).map((c) => c.name);
  return { passed: regressions.length === 0, preexisting, regressions };
}

export function baselineSummary(b: Baseline): string {
  if (!b.checks.length) return "실행 가능한 검사를 찾지 못했습니다.";
  return b.checks.map((c) => `${c.status === "passed" ? "✅" : c.status === "skipped" ? "⏭️" : "❌"} ${c.name}: ${c.summary}`).join("\n");
}
