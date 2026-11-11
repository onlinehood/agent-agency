import type { ApprovalAction, RiskLevel } from "../types.js";

/**
 * Approval policy (PRD §5.1). Organization mode / affinity NEVER influence this module.
 */

export type ApprovalMode = "default" | "strict" | "auto_within_scope";

export interface ActionPolicy {
  risk: RiskLevel;
  /** Always requires an explicit approval regardless of mode (except none). */
  alwaysRequired: boolean;
  /** Requires a second confirmation step (재확인) */
  reconfirm: boolean;
  /** Default TTL in minutes */
  ttlMinutes: number;
  labelKo: string;
}

export const ACTION_POLICIES: Record<ApprovalAction, ActionPolicy> = {
  create_project: { risk: "medium", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "신규 프로젝트 생성" },
  import_project: { risk: "medium", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "기존 저장소 연결" },
  plan_scope: { risk: "medium", alwaysRequired: false, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "작업 범위/계획" },
  architecture_change: { risk: "high", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "주요 아키텍처 변경" },
  scope_expansion: { risk: "high", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "새 기능/범위 확대" },
  pr_merge: { risk: "medium", alwaysRequired: false, reconfirm: false, ttlMinutes: 7 * 24 * 60, labelKo: "PR 병합" },
  deploy_production: { risk: "critical", alwaysRequired: true, reconfirm: true, ttlMinutes: 60, labelKo: "운영 배포" },
  prod_db_change: { risk: "critical", alwaysRequired: true, reconfirm: true, ttlMinutes: 60, labelKo: "운영 DB 변경" },
  cost_increase: { risk: "high", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "비용 발생" },
  budget_exceed: { risk: "medium", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "작업 예산 초과" },
  destructive_operation: { risk: "critical", alwaysRequired: true, reconfirm: true, ttlMinutes: 60, labelKo: "파괴적 작업" },
  security_change: { risk: "high", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "보안 관련 변경" },
  feature_complete: { risk: "medium", alwaysRequired: true, reconfirm: false, ttlMinutes: 7 * 24 * 60, labelKo: "핵심 기능 최종 확인" },
  project_complete: { risk: "medium", alwaysRequired: true, reconfirm: false, ttlMinutes: 7 * 24 * 60, labelKo: "프로젝트 완료 확인" },
  permanent_delete: { risk: "critical", alwaysRequired: true, reconfirm: true, ttlMinutes: 30, labelKo: "영구 삭제" },
  external_service_change: { risk: "high", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "외부 서비스 설정 변경" },
  risky_command: { risk: "high", alwaysRequired: false, reconfirm: false, ttlMinutes: 60, labelKo: "위험 명령 실행" },
  upgrade: { risk: "high", alwaysRequired: true, reconfirm: false, ttlMinutes: 24 * 60, labelKo: "앱 업데이트" },
  smoke_test: { risk: "low", alwaysRequired: true, reconfirm: false, ttlMinutes: 60, labelKo: "스모크 테스트 실행" },
  paid_api_usage: { risk: "high", alwaysRequired: true, reconfirm: true, ttlMinutes: 24 * 60, labelKo: "종량제 유료 API 사용" },
};

/**
 * Decide whether an action needs explicit user approval.
 * - default: alwaysRequired actions + PR merge need approval; plan_scope is autonomous within approved goals.
 * - strict: everything except low-risk needs approval.
 * - auto_within_scope: only alwaysRequired actions (critical/high/cost/delete/deploy/etc.) need approval.
 */
export function requiresApproval(action: ApprovalAction, mode: ApprovalMode, ctx: { withinApprovedScope?: boolean; riskyCommandMode?: boolean } = {}): boolean {
  const p = ACTION_POLICIES[action];
  if (p.alwaysRequired) return true;
  switch (action) {
    case "pr_merge":
      return mode !== "auto_within_scope";
    case "plan_scope":
      if (mode === "strict") return true;
      return !ctx.withinApprovedScope;
    case "risky_command":
      return mode === "strict" || !!ctx.riskyCommandMode;
    default:
      return mode === "strict" ? p.risk !== "low" : false;
  }
}

/** Categories that can never be performed without approval (PRD §12-5). */
export const NEVER_WITHOUT_APPROVAL: ApprovalAction[] = ["deploy_production", "prod_db_change", "cost_increase", "permanent_delete", "destructive_operation", "paid_api_usage"];
