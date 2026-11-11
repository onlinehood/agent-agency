import type { Difficulty, TaskBudget } from "../types.js";

/**
 * Budget allocation by difficulty (PRD §9). Exceeding requires user approval.
 */
export const BUDGET_BY_DIFFICULTY: Record<Difficulty, TaskBudget> = {
  trivial: { maxMinutes: 10, maxRetries: 1, maxAgents: 1, maxQualityGateRuns: 2 },
  easy: { maxMinutes: 20, maxRetries: 2, maxAgents: 2, maxQualityGateRuns: 3 },
  medium: { maxMinutes: 45, maxRetries: 2, maxAgents: 3, maxQualityGateRuns: 3 },
  hard: { maxMinutes: 90, maxRetries: 3, maxAgents: 3, maxQualityGateRuns: 4 },
  epic: { maxMinutes: 180, maxRetries: 3, maxAgents: 3, maxQualityGateRuns: 5 },
};

export function budgetFor(d: Difficulty): TaskBudget {
  return { ...BUDGET_BY_DIFFICULTY[d] };
}

/** Very small heuristic difficulty estimator for incoming requests. */
export function estimateDifficulty(text: string, criteriaCount = 0): Difficulty {
  const t = text.toLowerCase();
  const len = text.length;
  let score = 0;
  if (len > 200) score++;
  if (len > 600) score++;
  if (criteriaCount > 3) score++;
  if (/(아키텍처|architecture|마이그레이션|migration|리팩터|refactor|인증|auth|결제|payment|분산|multi)/.test(t)) score += 2;
  if (/(오타|typo|문구|copy|색상|color|readme|주석)/.test(t)) score -= 1;
  if (score <= -1) return "trivial";
  if (score === 0) return "easy";
  if (score <= 2) return "medium";
  if (score <= 3) return "hard";
  return "epic";
}

export type WorkClass = "incident" | "high_priority" | "normal" | "maintenance";

/** Execution order under subscription scarcity: incident → high priority project → normal → maintenance (PRD §9). */
export const WORK_CLASS_ORDER: Record<WorkClass, number> = { incident: 0, high_priority: 1, normal: 2, maintenance: 3 };

export function classifyWork(input: { taskPriority: number; projectPriority: number; isIncident?: boolean; isMaintenance?: boolean }): WorkClass {
  if (input.isIncident) return "incident";
  if (input.isMaintenance) return "maintenance";
  if (input.projectPriority >= 70 || input.taskPriority >= 80) return "high_priority";
  return "normal";
}
