import type { Repos } from "../../db/repositories.js";
import type { Approval, ApprovalAction } from "../types.js";
import { ACTION_POLICIES, requiresApproval, type ApprovalMode } from "./policy.js";
import { AppError, PermissionError } from "../../util/errors.js";
import type { EventBus } from "../events.js";

export interface ApprovalRequest {
  actorId: string; // user who must decide
  projectId?: string | null;
  taskId?: string | null;
  action: ApprovalAction;
  summary: string;
  scope?: Record<string, unknown>;
}

export type ApprovalDecision = "approve" | "reject" | "cancel";

export interface DecisionResult {
  approval: Approval;
  /** true when a reconfirm step is still required before the approval is final */
  needsReconfirm: boolean;
  final: boolean;
}

/**
 * Approval Engine (PRD §6.1-8, §8.1). Approvals are bound to requester + project + task +
 * expiry + nonce; callbacks are verified against all of them before a decision is accepted.
 * Organization mode and affinity are never inputs here (PRD §12-9).
 */
export class ApprovalEngine {
  constructor(
    private repos: Repos,
    private events: EventBus,
  ) {}

  needsApproval(action: ApprovalAction, mode: ApprovalMode, ctx?: { withinApprovedScope?: boolean; riskyCommandMode?: boolean }): boolean {
    return requiresApproval(action, mode, ctx);
  }

  async request(req: ApprovalRequest): Promise<Approval> {
    const policy = ACTION_POLICIES[req.action];
    // Re-use an equivalent pending approval so restarts/retries never duplicate prompts.
    const dup = (await this.repos.approvals.listPending(req.actorId)).find(
      (a) => a.action === req.action && a.taskId === (req.taskId ?? null) && a.projectId === (req.projectId ?? null) && JSON.stringify(a.scope) === JSON.stringify(req.scope ?? {}),
    );
    if (dup && !this.isExpired(dup)) return dup;
    const approval = await this.repos.approvals.create({
      actorId: req.actorId,
      projectId: req.projectId,
      taskId: req.taskId,
      action: req.action,
      riskLevel: policy.risk,
      scope: req.scope,
      summary: req.summary,
      requiresReconfirm: policy.reconfirm,
      ttlMinutes: policy.ttlMinutes,
    });
    await this.repos.audit.record(req.actorId, "approval.requested", `approval:${approval.id}`, "info", { action: req.action, risk: policy.risk, taskId: req.taskId, projectId: req.projectId });
    this.events.emit("approval.requested", { approval });
    return approval;
  }

  isExpired(a: Approval, now = new Date()): boolean {
    return new Date(a.expiresAt).getTime() <= now.getTime();
  }

  async verify(approvalId: string, ctx: { actorId: string; nonce: string; projectId?: string | null; taskId?: string | null }): Promise<Approval> {
    const a = await this.repos.approvals.find(approvalId);
    if (!a) throw new AppError("승인 요청을 찾을 수 없습니다.", "approval_not_found");
    if (a.actorId !== ctx.actorId) {
      await this.repos.audit.record(ctx.actorId, "approval.verify", `approval:${a.id}`, "denied", { reason: "actor_mismatch" });
      throw new PermissionError("이 승인 요청을 처리할 권한이 없습니다.");
    }
    if (a.nonce !== ctx.nonce) {
      await this.repos.audit.record(ctx.actorId, "approval.verify", `approval:${a.id}`, "denied", { reason: "nonce_mismatch" });
      throw new PermissionError("승인 요청이 유효하지 않습니다.");
    }
    if (ctx.projectId !== undefined && ctx.projectId !== a.projectId) throw new PermissionError("프로젝트가 일치하지 않습니다.");
    if (ctx.taskId !== undefined && ctx.taskId !== a.taskId) throw new PermissionError("작업이 일치하지 않습니다.");
    if (a.status !== "pending") throw new AppError(`이미 처리된 승인입니다 (${a.status}).`, "approval_not_pending");
    if (this.isExpired(a)) {
      const expired = await this.repos.approvals.setStatus(a.id, "expired", null);
      this.events.emit("approval.decided", { approval: expired });
      throw new AppError("승인 요청이 만료되었습니다.", "approval_expired");
    }
    return a;
  }

  async decide(approvalId: string, decision: ApprovalDecision, ctx: { actorId: string; nonce: string; reconfirm?: boolean }): Promise<DecisionResult> {
    const a = await this.verify(approvalId, ctx);
    // Critical actions need two explicit steps: approve, then reconfirm.
    if (decision === "approve" && a.requiresReconfirm && (!ctx.reconfirm || !a.reconfirmPending)) {
      await this.repos.approvals.setReconfirmPending(a.id, true);
      return { approval: await this.repos.approvals.get(a.id), needsReconfirm: true, final: false };
    }
    const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "cancelled";
    const updated = await this.repos.approvals.setStatus(a.id, status, ctx.actorId);
    await this.repos.audit.record(ctx.actorId, `approval.${status}`, `approval:${a.id}`, "success", { action: a.action, taskId: a.taskId, projectId: a.projectId });
    this.events.emit("approval.decided", { approval: updated });
    return { approval: updated, needsReconfirm: false, final: true };
  }

  async isApproved(action: ApprovalAction, ref: { taskId?: string | null; projectId?: string | null }): Promise<boolean> {
    return this.repos.approvals.hasApproved(action, ref);
  }

  async expireStale(now = new Date()): Promise<number> {
    let n = 0;
    for (const a of await this.repos.approvals.listPending()) {
      if (this.isExpired(a, now)) {
        const updated = await this.repos.approvals.setStatus(a.id, "expired", null);
        this.events.emit("approval.decided", { approval: updated });
        n++;
      }
    }
    return n;
  }
}
