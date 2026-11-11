import type { Approval, RiskLevel } from "../types.js";
import { ACTION_POLICIES } from "./policy.js";

/** Approval card (Phase 2 approval UX): action, risk badge, reconfirm notice, summary, expiry. */
const RISK: Record<RiskLevel, string> = { low: "🟢 낮음", medium: "🟡 중간", high: "🟠 높음", critical: "🔴 매우 높음" };

export function formatUtc(isoTime: string): string {
  return `${isoTime.replace("T", " ").slice(0, 16)} UTC`;
}

export function approvalCard(a: Approval, opts: { reminder?: boolean } = {}): string {
  const head = `[${ACTION_POLICIES[a.action].labelKo}] 위험도 ${RISK[a.riskLevel]}${a.requiresReconfirm ? " · 재확인 필요" : ""}`;
  return [opts.reminder ? `⏰ 곧 만료되는 승인 요청이에요.\n${head}` : head, a.summary, `만료: ${formatUtc(a.expiresAt)}`].join("\n");
}

export function approvalButtons(a: Approval): Array<Array<{ text: string; data: string }>> {
  return [
    [
      { text: "✅ 승인", data: `a:ok:${a.id}:${a.nonce}` },
      { text: "✏️ 수정 요청", data: `a:no:${a.id}:${a.nonce}` },
    ],
    [{ text: "🛑 취소", data: `a:cx:${a.id}:${a.nonce}` }],
  ];
}

/** Actions whose "수정 요청" collects the user's next message as revision feedback. */
export const FEEDBACK_ACTIONS: ReadonlyArray<Approval["action"]> = ["create_project", "plan_scope", "architecture_change", "scope_expansion", "pr_merge", "feature_complete"];
