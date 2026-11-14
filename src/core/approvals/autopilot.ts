import type { ApprovalAction } from "../types.js";
import { NEVER_WITHOUT_APPROVAL } from "./policy.js";

/**
 * 자동 진행 (autopilot): the user lets a project run to the end without approving every step.
 *
 * Routine checkpoints are granted automatically and reported in one short line. Anything risky —
 * production deploy/DB, deletion, paid API, cost, security or external-service changes, app
 * upgrades — still asks, whatever the setting (PRD §12-5). Budget extensions are capped so a task
 * that keeps failing cannot burn the subscription forever.
 */
export const AUTOPILOT_ACTIONS: readonly ApprovalAction[] = ["plan_scope", "architecture_change", "scope_expansion", "budget_exceed", "pr_merge", "feature_complete", "project_complete", "risky_command", "smoke_test"];

/** How many times autopilot may extend a task's retry/time budget before asking. */
export const AUTOPILOT_BUDGET_EXTENSIONS = 2;

export function autopilotCovers(action: ApprovalAction): boolean {
  return AUTOPILOT_ACTIONS.includes(action) && !NEVER_WITHOUT_APPROVAL.includes(action);
}

/** "자동으로 진행해", "끝까지 알아서 해", "승인 없이 해" … (short messages only, so a feature request is not mistaken). */
const ON = /(자동\s*(승인|진행|모드)|자동으로\s*(진행|승인|해|하자|가자|돌려)|끝까지\s*(자동|알아서)|승인\s*(없이|안\s*받고)|알아서\s*끝까지|auto\s*-?pilot|auto\s*approve)/i;
const OFF = /((자동\s*(승인|진행|모드)|오토\s*파일럿|autopilot).{0,8}(꺼|끄|중지|해제|그만|멈춰|취소|off))|단계마다\s*(확인|승인|물어)|하나하나\s*(확인|승인)/i;

export function autopilotIntent(text: string): "on" | "off" | null {
  const t = text.trim();
  if (t.length > 40) return null;
  // "자동 승인 기능 추가해줘" is a feature request, not a request to change how we work.
  if (/(기능|화면|버튼|페이지|코드|구현|만들어|추가해|api|모듈)/i.test(t)) return null;
  if (OFF.test(t)) return "off";
  if (ON.test(t)) return "on";
  return null;
}
