import type { TaskStage, TaskState } from "../types.js";
import { InvalidTransitionError } from "../../util/errors.js";

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ["planning", "in_progress", "awaiting_approval", "cancelled", "blocked"],
  planning: ["awaiting_approval", "in_progress", "blocked", "cancelled", "failed", "queued"],
  awaiting_approval: ["in_progress", "planning", "cancelled", "blocked", "pr_open", "done", "queued"],
  in_progress: ["review", "blocked", "cancelled", "failed", "awaiting_approval", "in_progress", "queued"],
  blocked: ["queued", "in_progress", "cancelled", "failed", "planning"],
  review: ["in_progress", "pr_open", "blocked", "cancelled", "failed", "awaiting_approval", "queued"],
  pr_open: ["awaiting_approval", "done", "in_progress", "cancelled", "blocked", "queued"],
  done: [],
  cancelled: ["queued"],
  failed: ["queued"],
};

export const TERMINAL_STATES: TaskState[] = ["done", "cancelled", "failed"];
export const ACTIVE_STATES: TaskState[] = ["planning", "in_progress", "review"];

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError("task", from, to);
}

/** Ordered stages shown in the pinned progress message: 요구사항→구현→테스트→리뷰→수정→PR */
export const STAGES: TaskStage[] = ["requirements", "implementation", "testing", "review", "fix", "pr", "complete"];

export const STAGE_LABEL_KO: Record<TaskStage, string> = {
  requirements: "요구사항",
  implementation: "구현",
  testing: "테스트",
  review: "리뷰",
  fix: "수정",
  pr: "PR",
  complete: "완료",
};

export const STATE_LABEL_KO: Record<TaskState, string> = {
  queued: "대기",
  planning: "기획",
  awaiting_approval: "승인 대기",
  in_progress: "진행 중",
  blocked: "차단",
  review: "리뷰",
  pr_open: "PR 오픈",
  done: "완료",
  cancelled: "취소",
  failed: "실패",
};
