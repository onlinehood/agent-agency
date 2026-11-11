import type { Repos } from "../../db/repositories.js";
import type { Agent, Project, Task } from "../types.js";
import { modeDef } from "../organization/modes.js";
import type { MemoryService } from "./service.js";

/**
 * Context Builder (PRD §17). On every AI session start/resume — including after an
 * executor fallback — the context is rebuilt from PostgreSQL (and GitHub/checkpoint refs),
 * selecting only what the current work needs instead of replaying full conversations.
 *
 * Section order:
 *  1. agent identity / persona, organization worldview / role, listener-specific style policy
 *  2. project goal + confirmed decisions (proposals labelled separately), task + acceptance criteria
 *  3. relevant recent conversation, summaries and collaboration history with peers
 *  4. GitHub branch / PR / test results and checkpoint
 * Precedence rule: the newest explicit user instruction beats stored memory.
 */
export interface ContextRequest {
  userId: string;
  agent?: Agent | null;
  project: Project;
  task?: Task | null;
  /** Pre-rendered style instructions for the listener (from the Communicator). */
  stylePolicy?: string;
  /** Peers involved, for collaboration history */
  peers?: Agent[];
  /** Max characters for the whole context */
  budget?: number;
  /** Latest explicit user instruction to place above memory */
  latestInstruction?: string | null;
}

export interface BuiltContext {
  text: string;
  sections: Record<string, string>;
  sourceRefs: string[];
}

const SECTION_SHARE = { identity: 0.15, project: 0.35, conversation: 0.3, engineering: 0.2 } as const;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 2)) + " …";
}

export class ContextBuilder {
  constructor(
    private repos: Repos,
    private memory: MemoryService,
  ) {}

  async build(req: ContextRequest): Promise<BuiltContext> {
    const budget = req.budget ?? 8000;
    const refs: string[] = [];
    const sections: Record<string, string> = {};

    /* 1. identity */
    {
      const lines: string[] = ["## 1. 정체성과 역할"];
      const profile = await this.repos.users.getProfile(req.userId);
      const mode = modeDef(profile.mode);
      lines.push(`조직 세계관: ${mode.labelKo} (${mode.atmosphere})`);
      if (req.agent) {
        const persona = await this.repos.personas.find(req.agent.personaId);
        const members = await this.repos.projects.listAgents(req.project.id);
        const me = members.find((m) => m.agentId === req.agent!.id);
        lines.push(`당신: ${req.agent.name} — 조직 역할 ${me?.orgRole ?? mode.titles.member}, 업무 역할 ${me?.functionalRole ?? "member"}`);
        if (persona) lines.push(`성격 연출 지침: ${persona.preset}${persona.customRules ? ` / ${persona.customRules}` : ""} (연출일 뿐, 업무 정확성과 사용자 지시가 우선)`);
      }
      if (req.stylePolicy) lines.push(req.stylePolicy);
      sections.identity = clip(lines.join("\n"), Math.floor(budget * SECTION_SHARE.identity));
    }

    /* 2. project goals, decisions, task */
    {
      const p = req.project;
      const lines: string[] = ["## 2. 목표·결정·작업"];
      if (req.latestInstruction) lines.push(`### 최신 사용자 지시 (기존 기억보다 우선)\n${req.latestInstruction}`);
      lines.push(`프로젝트: ${p.name}${p.description ? ` — ${p.description}` : ""}`);
      if (p.stack.length) lines.push(`기술 스택: ${p.stack.join(", ")}`);
      const reqs = await this.repos.memories.list(p.id, ["requirement"], 10);
      if (reqs.length) {
        lines.push("### 요구사항");
        for (const m of reqs) {
          lines.push(`- ${m.certainty === "confirmed" ? "" : `[${m.certainty === "proposal" ? "제안" : "추측"}] `}${m.content}`);
          refs.push(m.id);
        }
      }
      const decisions = await this.repos.decisions.list(p.id);
      const confirmed = decisions.filter((d) => d.status === "confirmed").slice(-8);
      const proposed = decisions.filter((d) => d.status === "proposed").slice(-3);
      if (confirmed.length) lines.push("### 확정 결정", ...confirmed.map((d) => `- ${d.title}: ${d.rationale}`));
      if (proposed.length) lines.push("### 미확정 제안 (확정 아님)", ...proposed.map((d) => `- ${d.title}: ${d.rationale}`));
      refs.push(...confirmed.map((d) => d.id));
      const prefs = await this.memory.activePreferences(p.id);
      if (prefs.length) lines.push("### 사용자 선호 (최신 지시·승인 PRD가 우선)", ...prefs.map((x) => `- ${x}`));
      if (req.task) {
        const t = req.task;
        lines.push(`### 담당 작업\n${t.title}\n${t.description}`);
        if (t.acceptanceCriteria.length) lines.push("수락 기준:", ...t.acceptanceCriteria.map((c) => `- ${c}`));
        refs.push(t.id);
      }
      sections.project = clip(lines.join("\n"), Math.floor(budget * SECTION_SHARE.project));
    }

    /* 3. conversation & collaboration */
    {
      const p = req.project;
      const lines: string[] = ["## 3. 관련 대화·협업 이력"];
      const summaries = await this.repos.summaries.list(p.id, 2, req.task?.id ?? undefined);
      const general = summaries.length ? summaries : await this.repos.summaries.list(p.id, 2);
      for (const s of general.reverse()) {
        lines.push(`### 요약 (${s.createdAt.slice(0, 10)})\n${s.summary}`);
        refs.push(s.id);
      }
      const recent = req.task ? await this.repos.conversations.list(p.id, 12, { taskId: req.task.id }) : await this.repos.conversations.list(p.id, 8);
      const meaningful = recent.filter((m) => !m.kind.startsWith("progress"));
      if (meaningful.length) {
        lines.push("### 최근 대화");
        for (const m of meaningful) {
          lines.push(`- ${m.renderedText.replace(/\s+/g, " ").slice(0, 280)}`);
          refs.push(m.id);
        }
      }
      if (req.agent && req.peers?.length) {
        const hist: string[] = [];
        for (const peer of req.peers) {
          if (peer.id === req.agent.id) continue;
          const rel = await this.repos.relationships.get(req.userId, req.agent.id, peer.id);
          if (rel.interactionCount) hist.push(`- ${peer.name}: 협업 ${rel.interactionCount}회${rel.interactionSummary ? `, ${rel.interactionSummary.slice(-200)}` : ""}`);
        }
        if (hist.length) lines.push("### 동료와의 협업 이력 (표현용 메타데이터, 권한과 무관)", ...hist);
      }
      const handoffs = await this.repos.memories.list(p.id, ["handoff", "lesson"], 6);
      if (handoffs.length) lines.push("### 인계·교훈", ...handoffs.map((m) => `- ${m.content}`));
      sections.conversation = clip(lines.join("\n"), Math.floor(budget * SECTION_SHARE.conversation));
    }

    /* 4. engineering state */
    {
      const p = req.project;
      const lines: string[] = ["## 4. 저장소·검증 상태"];
      if (p.repoRef) lines.push(`GitHub: ${p.repoRef} (기본 브랜치 ${p.defaultBranch})`);
      const imp = await this.repos.memories.list(p.id, ["import_analysis"], 1);
      if (imp[0]) lines.push(`저장소 분석: ${imp[0].content.slice(0, 800)}`);
      if (req.task) {
        const t = req.task;
        if (t.branch) lines.push(`작업 브랜치: ${t.branch}`);
        if (t.prRef) lines.push(`PR: ${t.prRef}`);
        const cp = t.checkpoint;
        if (cp.stage) lines.push(`체크포인트 단계: ${cp.stage}`);
        if (cp.commitSha) lines.push(`최근 커밋: ${String(cp.commitSha).slice(0, 12)}`);
        if (cp.qualityGate) lines.push(`최근 품질 게이트: ${cp.qualityGate.passed ? "통과" : "실패"} — ${cp.qualityGate.checks.map((c) => `${c.name}:${c.status}`).join(", ")}`);
        if (cp.reviewVerdict) lines.push(`최근 리뷰: ${cp.reviewVerdict.approved ? "승인" : "수정 필요"} — ${cp.reviewVerdict.summary}`);
      }
      sections.engineering = clip(lines.join("\n"), Math.floor(budget * SECTION_SHARE.engineering));
    }

    const text = [sections.identity, sections.project, sections.conversation, sections.engineering].filter(Boolean).join("\n\n");
    return { text: clip(text, budget), sections, sourceRefs: [...new Set(refs)] };
  }
}
