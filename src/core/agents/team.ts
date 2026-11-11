import type { Repos } from "../../db/repositories.js";
import type { ExecutorRegistry } from "../../executors/registry.js";
import type { Agent, Difficulty, FunctionalRole, Project, Task } from "../types.js";

/**
 * Agent Team Coordinator (PRD §5-3). Assignment considers explicit @mention, executor
 * availability (any official subscription kind for the agent's provider), current load,
 * provider diversity for cross review and historical success rate. Affinity and worldview
 * are intentionally NOT inputs (PRD §2.2).
 */
export interface Assignment {
  implementer: Agent;
  reviewer: Agent | null;
  tester: Agent | null;
  reasons: string[];
}

export class TeamCoordinator {
  constructor(
    private repos: Repos,
    private executors: ExecutorRegistry,
  ) {}

  /** An agent can work if any non-paid executor of its provider is usable (cloud or local). */
  canWork(agent: Agent): boolean {
    const pinned = this.executors.get(agent.adapterId);
    return this.executors.providerUsable(pinned?.provider ?? agent.provider) || this.executors.isUsable(agent.adapterId);
  }

  async usableAgents(ownerId: string): Promise<Agent[]> {
    return (await this.repos.agents.listByOwner(ownerId, true)).filter((a) => this.canWork(a));
  }

  async projectAgents(project: Project): Promise<Agent[]> {
    const members = await this.repos.projects.listAgents(project.id);
    const ids = new Set(members.map((m) => m.agentId));
    const all = await this.repos.agents.listByOwner(project.ownerId, true);
    const agents = all.filter((a) => ids.has(a.id));
    return agents.length ? agents : all;
  }

  async successRate(agentId: string): Promise<number> {
    const { ok, total } = await this.repos.executions.successStats(agentId, "implement");
    return (ok + 1) / (total + 2);
  }

  async load(agentId: string): Promise<number> {
    const r = await this.repos.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM tasks WHERE assigned_agent_id=$1 AND state IN ('planning','in_progress','review')", [agentId]);
    return r[0]?.n ?? 0;
  }

  /** Pick 1–3 agents for a discussion; explicit mentions first, then the leader. */
  async convene(project: Project | null, ownerId: string, mentioned: string[], max = 3): Promise<Agent[]> {
    const pool = (project ? await this.projectAgents(project) : await this.repos.agents.listByOwner(ownerId, true)).filter((a) => this.canWork(a));
    const chosen: Agent[] = [];
    for (const id of mentioned) {
      const a = pool.find((x) => x.id === id);
      if (a && !chosen.includes(a)) chosen.push(a);
    }
    const leader = project?.leaderAgentId ? pool.find((a) => a.id === project.leaderAgentId) : undefined;
    if (leader && !chosen.includes(leader)) chosen.splice(mentioned.length ? chosen.length : 0, 0, leader);
    for (const a of pool) {
      if (chosen.length >= max) break;
      if (!chosen.includes(a)) chosen.push(a);
    }
    return chosen.slice(0, max);
  }

  /**
   * Performance-aware scores (Phase 4 "협업 성과 최적화", flag `analytics.team_optimization`).
   * Smoothed so agents without history start neutral. Only selection changes; every task still runs
   * the full quality gate and cross review.
   */
  async performanceScores(project: Project, pool: Agent[]): Promise<Map<string, { score: number; note: string }>> {
    const since = new Date(Date.now() - 90 * 86400_000).toISOString();
    const perf = new Map((await this.repos.executions.agentPerformance(project.ownerId, since)).map((p) => [p.agentId, p]));
    const out = new Map<string, { score: number; note: string }>();
    for (const a of pool) {
      const p = perf.get(a.id);
      const firstPass = ((p?.firstPass ?? 0) + 1) / ((p?.tasksDone ?? 0) + 2);
      const lead = Math.min((p?.avgLeadMinutes ?? 0) / 120, 1);
      const success = await this.successRate(a.id);
      const load = await this.load(a.id);
      out.set(a.id, { score: firstPass * 2 + success - load * 0.5 - lead * 0.3, note: `첫 시도 통과 ${Math.round(firstPass * 100)}%·성공 ${Math.round(success * 100)}%·진행 중 ${load}건` });
    }
    return out;
  }

  async assign(project: Project, task: Pick<Task, "difficulty"> & { mentionedAgentIds?: string[] }, roles: FunctionalRole[] = ["implementer", "reviewer"], opts: { optimize?: boolean } = {}): Promise<Assignment | null> {
    const pool = (await this.projectAgents(project)).filter((a) => this.canWork(a));
    if (!pool.length) return null;
    const reasons: string[] = [];
    const scores = new Map<string, number>();
    const perf = opts.optimize ? await this.performanceScores(project, pool) : null;
    for (const a of pool) scores.set(a.id, perf ? perf.get(a.id)!.score : (await this.successRate(a.id)) * 2 - (await this.load(a.id)) * 0.5 + difficultyBias(task.difficulty) * (a.id === project.leaderAgentId ? 0.1 : 0));
    let implementer: Agent | undefined;
    for (const id of task.mentionedAgentIds ?? []) {
      implementer = pool.find((a) => a.id === id);
      if (implementer) {
        reasons.push(`${implementer.name}: 사용자 @멘션으로 우선 배정 (리더가 우선순위·충돌 조율)`);
        break;
      }
    }
    if (!implementer) {
      implementer = [...pool].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))[0]!;
      reasons.push(perf ? `${implementer.name}: 성과 기반 배정 (${perf.get(implementer.id)!.note})` : `${implementer.name}: 성공률·현재 부하·가용 구독 기준 배정`);
    }
    let reviewer: Agent | null = null;
    if (roles.includes("reviewer")) {
      const others = pool.filter((a) => a.id !== implementer!.id);
      const diverse = others.filter((a) => a.provider !== implementer!.provider);
      const candidates = diverse.length ? diverse : others;
      if (opts.optimize && candidates.length > 1) {
        // Prefer reviewers whose approvals rarely needed a later user revision.
        const quality = new Map<string, number>();
        for (const c of candidates) {
          const st = await this.repos.executions.reviewerStats(c.id);
          quality.set(c.id, 1 - (st.userRevisions + 1) / (st.reviewed + 2));
        }
        reviewer = [...candidates].sort((a, b) => (quality.get(b.id) ?? 0) - (quality.get(a.id) ?? 0))[0] ?? null;
        if (reviewer) reasons.push(`${reviewer.name}: 리뷰 품질 기반 선택 (승인 후 사용자 수정 없음 ${Math.round((quality.get(reviewer.id) ?? 0) * 100)}%)`);
      } else {
        reviewer = candidates[0] ?? null;
      }
      if (reviewer) reasons.push(`${reviewer.name}: 교차 리뷰${reviewer.provider !== implementer.provider ? " (다른 공급자)" : ""}`);
      else reasons.push("교차 리뷰 가능한 다른 에이전트가 없어 같은 에이전트의 별도 세션 자체 점검으로 대체");
    }
    let tester: Agent | null = null;
    if (roles.includes("tester")) tester = pool.find((a) => a.id !== implementer!.id && a.id !== reviewer?.id) ?? null;
    return { implementer, reviewer, tester, reasons };
  }

  /** Alternative agent on a different provider for handoff when every executor of the first is down. */
  async alternativeFor(project: Project, failed: Agent): Promise<Agent | null> {
    const failedProvider = this.executors.get(failed.adapterId)?.provider ?? failed.provider;
    return (await this.projectAgents(project)).find((a) => a.id !== failed.id && (this.executors.get(a.adapterId)?.provider ?? a.provider) !== failedProvider && this.canWork(a)) ?? null;
  }
}

function difficultyBias(d: Difficulty): number {
  return { trivial: 0, easy: 0, medium: 0.5, hard: 1, epic: 1 }[d];
}
