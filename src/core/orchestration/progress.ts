import type { Agent, Approval, Project, ReportCard, Task } from "../types.js";
import { STAGES, STAGE_LABEL_KO, STATE_LABEL_KO } from "../tasks/stateMachine.js";
import { summarizeGate } from "../../quality/gate.js";
import { ACTION_POLICIES } from "../approvals/policy.js";

const STATUS_KO: Record<Project["status"], string> = {
  proposed: "제안됨",
  active: "진행 중",
  paused: "일시정지",
  blocked: "차단",
  completed: "완료",
  archived: "보관",
};

export function projectStatusKo(s: Project["status"]): string {
  return STATUS_KO[s];
}

/** Text for the single pinned progress message (PRD §4.2). */
export function isInternal(t: Task): boolean {
  return !!t.checkpoint.internal;
}

export function progressText(project: Project, allTasks: Task[], agents: Map<string, Agent>, pending: Approval[]): string {
  const tasks = allTasks.filter((t) => !isInternal(t));
  const current = tasks.find((t) => ["planning", "in_progress", "review"].includes(t.state)) ?? tasks.find((t) => ["awaiting_approval", "pr_open", "blocked"].includes(t.state));
  const recentDone = tasks.filter((t) => t.state === "done").sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
  const lines: string[] = [];
  lines.push(`📌 ${project.name} — ${projectStatusKo(project.status)}${project.settings?.autopilot ? " · 🤖 자동 진행" : ""}`);
  if (current) {
    const idx = STAGES.indexOf(current.stage);
    const bar = STAGES.slice(0, 6)
      .map((s, i) => (i < idx ? `✅${STAGE_LABEL_KO[s]}` : i === idx ? `▶️${STAGE_LABEL_KO[s]}` : `▫️${STAGE_LABEL_KO[s]}`))
      .join(" → ");
    lines.push(`단계: ${bar}`);
    lines.push(`현재 작업: ${current.title} (${STATE_LABEL_KO[current.state]})`);
    const a = current.assignedAgentId ? agents.get(current.assignedAgentId) : undefined;
    const r = current.reviewerAgentId ? agents.get(current.reviewerAgentId) : undefined;
    lines.push(`담당: ${a?.name ?? "미배정"}${r ? ` / 리뷰: ${r.name}` : ""}`);
    if (current.blockedReason) lines.push(`⛔ 차단 사유: ${current.blockedReason}`);
  } else {
    lines.push("현재 진행 중인 작업이 없습니다.");
  }
  if (recentDone) lines.push(`최근 완료: ${recentDone.title}${recentDone.prRef ? ` (${recentDone.prRef})` : ""}`);
  const open = tasks.filter((t) => t !== current && !["done", "cancelled", "failed"].includes(t.state));
  if (open.length) {
    lines.push(`다른 작업 ${open.length}건:`);
    for (const t of open.slice(0, 5)) {
      const who = t.assignedAgentId ? agents.get(t.assignedAgentId)?.name : undefined;
      lines.push(`  · ${t.title.slice(0, 40)} — ${STATE_LABEL_KO[t.state]}${who ? ` (${who})` : ""}`);
    }
    if (open.length > 5) lines.push(`  · 외 ${open.length - 5}건`);
  }
  if (pending.length) lines.push(`⏳ 승인 대기: ${pending.map((p) => ACTION_POLICIES[p.action].labelKo).join(", ")}`);
  lines.push(`갱신: ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`);
  return lines.join("\n");
}

/** /status summary across all projects (PRD §4.1). */
export function statusSummary(projects: Project[], tasksByProject: Map<string, Task[]>, agents: Map<string, Agent>, pending: Approval[]): string {
  if (!projects.length) return "등록된 프로젝트가 없습니다. 마스터 라운지에서 \"새 프로젝트 만들어줘\" 라고 말해 보세요.";
  const lines: string[] = ["📊 전체 프로젝트 현황"];
  for (const p of projects) {
    const tasks = (tasksByProject.get(p.id) ?? []).filter((t) => !isInternal(t));
    const cur = tasks.find((t) => ["planning", "in_progress", "review", "awaiting_approval", "pr_open", "blocked"].includes(t.state));
    const done = tasks.filter((t) => t.state === "done").length;
    lines.push(`\n• ${p.name} [${projectStatusKo(p.status)}] 우선순위 ${p.priority}`);
    if (cur) {
      const a = cur.assignedAgentId ? agents.get(cur.assignedAgentId)?.name : "미배정";
      lines.push(`  현재: ${cur.title} — ${STATE_LABEL_KO[cur.state]}/${STAGE_LABEL_KO[cur.stage]} (담당 ${a})`);
      if (cur.blockedReason) lines.push(`  ⛔ ${cur.blockedReason}`);
    } else lines.push("  현재: 대기 중");
    lines.push(`  완료 ${done} / 전체 ${tasks.length}`);
    const pp = pending.filter((x) => x.projectId === p.id);
    if (pp.length) lines.push(`  ⏳ 승인 대기 ${pp.length}건: ${pp.map((x) => ACTION_POLICIES[x.action].labelKo).join(", ")}`);
  }
  const orphan = pending.filter((x) => !x.projectId);
  if (orphan.length) lines.push(`\n⏳ 프로젝트 외 승인 대기 ${orphan.length}건: ${orphan.map((x) => ACTION_POLICIES[x.action].labelKo).join(", ")}`);
  return lines.join("\n");
}

/** Structured report card (PRD §4.3). */
export function reportCardText(card: ReportCard): string {
  const lines: string[] = [];
  lines.push(`📋 결과 보고 — ${card.projectName}`);
  lines.push(`작업: ${card.taskTitle}`);
  lines.push(`\n■ 구현 기능\n${card.feature}`);
  if (card.changes.length) lines.push(`\n■ 변경 내용\n${card.changes.map((c) => `- ${c}`).join("\n")}`);
  lines.push(`\n■ 테스트\n${card.tests ? `${card.tests.passed ? "통과" : "실패"}\n${summarizeGate(card.tests)}` : "실행 안 됨"}`);
  if (card.review) {
    lines.push(`\n■ 교차 리뷰\n${card.review.approved ? "승인" : "수정 필요"} — ${card.review.summary}`);
    const issues = card.review.issues.filter((i) => i.severity !== "minor");
    if (issues.length) lines.push(issues.map((i) => `- [${i.severity}] ${i.description}`).join("\n"));
  } else lines.push("\n■ 교차 리뷰\n수행되지 않음");
  lines.push(`\n■ PR\n${card.prUrl ?? "생성되지 않음"}`);
  if (card.previewUrl) lines.push(`\n■ 프리뷰\n${card.previewUrl}`);
  lines.push(`\n■ 미해결 이슈\n${card.openIssues.length ? card.openIssues.map((i) => `- ${i}`).join("\n") : "없음"}`);
  if (card.requiresUserConfirmation) lines.push("\n👉 사용자 최종 확인이 필요합니다.");
  return lines.join("\n");
}
