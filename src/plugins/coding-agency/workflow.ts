import type { Agent, Approval, Project, QualityGateSummary, ReportCard, ReviewVerdict, Task, TaskCheckpoint, TaskStage, TaskState } from "../../core/types.js";
import type { TaskOutcome, WorkTypePlugin, WorkflowEnv } from "../types.js";
import type { TaskWorkspace } from "../../workspace/manager.js";
import { asStringArray, extractJson } from "../../core/orchestration/llmJson.js";
import { implementPrompt, planPrompt, reviewPrompt, fixFeedbackFromGate } from "./prompts.js";
import { runQualityGate, summarizeGate } from "../../quality/gate.js";
import { budgetFor } from "../../core/usage/budget.js";
import { reportCardText } from "../../core/orchestration/progress.js";
import { ACTION_POLICIES, type ApprovalMode } from "../../core/approvals/policy.js";
import { approvalButtons, approvalCard } from "../../core/approvals/card.js";
import { AUTOPILOT_BUDGET_EXTENSIONS, autopilotCovers } from "../../core/approvals/autopilot.js";
import { captureScreenshot, previewUrlFor } from "./preview.js";
import { scanDiff, scanFiles, describeFindings } from "../../security/secretScan.js";
import { applyBaseline } from "../../quality/baseline.js";
import type { Difficulty } from "../../core/types.js";
import { nowIso } from "../../util/ids.js";

const DIFFICULTIES: Difficulty[] = ["trivial", "easy", "medium", "hard", "epic"];

/** Internal control-flow marker: the PR exists, only the push was needed. */
class PrAlreadyOpen extends Error {}

interface PlanJson {
  summary?: string;
  acceptance_criteria?: unknown;
  difficulty?: string;
  architecture_change?: boolean;
  scope_expansion?: boolean;
  core_feature?: boolean;
  risks?: unknown;
  questions?: unknown;
  subtasks?: Array<{ title?: unknown; description?: unknown; acceptance_criteria?: unknown }>;
  message?: string;
}

interface ImplJson {
  summary?: string;
  changes?: unknown;
  tests_added?: unknown;
  open_issues?: unknown;
  message?: string;
}

interface ReviewJson {
  approved?: boolean;
  summary?: string;
  issues?: Array<{ severity?: string; description?: string; file?: string }>;
  /** Things only the user can do (deploy, a real URL, an account) — asked instead of retried. */
  needs_user?: Array<{ what?: string; how?: string }>;
  message?: string;
}

/**
 * Coding Agency workflow (PRD §5): plan → (approval) → implement → quality gate → cross review
 * → bounded fix loop → PR (+preview) → merge approval → done. Every step checkpoints to the task
 * row so a restart resumes from the last completed stage, and every external side effect
 * (push, PR, merge) goes through the idempotency ledger.
 */
export class CodingAgencyPlugin implements WorkTypePlugin {
  readonly id: string = "coding";
  readonly name: string = "Coding Agency";
  /** Whether execution steps may use the executor's web tools (research work). */
  protected allowWeb = false;

  /* ---------- work-type hooks (overridden by other agencies, e.g. Research) ---------- */

  protected planPromptFor(task: Task, context: string): string {
    return planPrompt({ task, context, style: "" });
  }

  protected implementPromptFor(task: Task, context: string, feedback: string | undefined, attempt: number): string {
    return implementPrompt({ task, context, style: "", feedback, attempt });
  }

  protected reviewPromptFor(task: Task, diff: string, gate: string, style: string, implementerName: string): string {
    return reviewPrompt({ task, diff, gate, style, implementerName });
  }

  /** Work-type checks (the secret scan is always added on top and is blocking). */
  protected async runChecks(env: WorkflowEnv, _task: Task, ws: TaskWorkspace): Promise<{ checks: QualityGateSummary["checks"]; blocking: string[]; flaky: Array<{ name: string; attempts: number }>; ranAt: string }> {
    return runQualityGate({
      dir: ws.dir,
      sandbox: ws.sandbox,
      settings: env.project.settings,
      playwright: await env.ctx.flags.isEnabled("quality.playwright", env.user.id),
      security: await env.ctx.flags.isEnabled("quality.security_scan", env.user.id),
    });
  }

  /** Called after the result report card is posted. */
  protected async afterReport(_env: WorkflowEnv, _task: Task, _ws: TaskWorkspace): Promise<void> {}

  protected async setState(env: WorkflowEnv, task: Task, patch: Partial<Task> & { state?: TaskState; stage?: TaskStage }): Promise<Task> {
    const updated = await env.ctx.repos.tasks.update(task.id, { ...patch, checkpoint: { ...(patch.checkpoint ?? {}), ...(patch.stage ? { stage: patch.stage } : {}) } });
    env.ctx.events.emit("task.updated", { task: updated });
    await env.refreshProgress();
    return updated;
  }

  protected async approvalMode(env: WorkflowEnv, project: Project): Promise<ApprovalMode> {
    if (project.settings.approvalMode) return project.settings.approvalMode;
    if (await env.ctx.flags.isEnabled("approvals.auto_within_scope", env.user.id)) return "auto_within_scope";
    return "default";
  }

  protected async agentOrNull(env: WorkflowEnv, id: string | null): Promise<Agent | null> {
    return (await env.ctx.repos.agents.find(id)) ?? null;
  }

  protected async requestApproval(env: WorkflowEnv, task: Task, action: Approval["action"], summary: string, scope: Record<string, unknown> = {}, speaker?: Agent | null): Promise<TaskOutcome> {
    // 자동 진행: grant routine checkpoints at once and keep going (risky actions still ask).
    const project = await env.ctx.repos.projects.get(env.project.id);
    let capNote = "";
    if (project.settings.autopilot && autopilotCovers(action)) {
      const used = Number(task.checkpoint.autoExtensions ?? 0);
      if (action !== "budget_exceed" || used < AUTOPILOT_BUDGET_EXTENSIONS) {
        const req = await env.ctx.approvals.request({ actorId: env.user.id, projectId: project.id, taskId: task.id, action, summary, scope });
        const granted = await env.ctx.repos.approvals.setStatus(req.id, "approved", "autopilot");
        await env.ctx.repos.audit.record("autopilot", "approval.auto_approved", `approval:${req.id}`, "success", { action, taskId: task.id, projectId: project.id });
        const t = action === "budget_exceed" ? await env.ctx.repos.tasks.checkpoint(task.id, { autoExtensions: used + 1 }) : task;
        await env.comm.say({
          user: env.user,
          project,
          speaker: { kind: "system" },
          listener: { kind: "user" },
          situation: "report",
          body: `🤖 자동 진행 — ${ACTION_POLICIES[action].labelKo}${action === "budget_exceed" ? ` (${used + 1}/${AUTOPILOT_BUDGET_EXTENSIONS})` : ""}: ${summary.split("\n")[0]!.slice(0, 120)}`,
          machineState: { kind: "approval.auto", taskId: task.id, projectId: project.id, data: { approvalId: req.id, action } },
        });
        return (await this.onApprovalDecided({ ...env, project }, t, granted)) ?? { kind: "requeue" };
      }
      capNote = `\n\n🤖 자동 진행은 예산을 ${AUTOPILOT_BUDGET_EXTENSIONS}번까지만 늘려요. 같은 문제가 반복되는 것 같아 확인을 요청드려요.`;
    }
    summary += capNote;
    const approval = await env.ctx.approvals.request({ actorId: env.user.id, projectId: env.project.id, taskId: task.id, action, summary, scope });
    await this.setState(env, task, { state: "awaiting_approval", checkpoint: { pendingApprovalId: approval.id } });
    await env.comm.say({
      user: env.user,
      project: env.project,
      speaker: speaker ? { kind: "agent", agent: speaker } : { kind: "moderator" },
      listener: { kind: "user" },
      situation: "approval_request",
      body: approvalCard(approval),
      buttons: approvalButtons(approval),
      machineState: { kind: "approval.request", taskId: task.id, projectId: env.project.id, data: { approvalId: approval.id, action, risk: approval.riskLevel } },
    });
    return { kind: "awaiting_approval", approvalId: approval.id };
  }

  async runTask(env: WorkflowEnv, initial: Task): Promise<TaskOutcome> {
    let task = initial;
    const { ctx, project } = env;
    if (!task.checkpoint.startedAt) task = await ctx.repos.tasks.checkpoint(task.id, { startedAt: nowIso() });

    /* ---------- team assignment ---------- */
    if (!task.assignedAgentId) {
      const mentioned = (task.checkpoint.mentionedAgentIds as string[] | undefined) ?? [];
      const asg = await ctx.team.assign(project, { difficulty: task.difficulty, mentionedAgentIds: mentioned }, ["implementer", "reviewer"], { optimize: await ctx.flags.isEnabled("analytics.team_optimization", env.user.id) });
      if (!asg) return this.block(env, task, "사용 가능한 공식 구독 실행기를 가진 에이전트가 없습니다. 서버에서 aa config → AI 구독으로 실행기 연결 상태를 확인해 주세요.");
      task = await this.setState(env, task, { assignedAgentId: asg.implementer.id, reviewerAgentId: asg.reviewer?.id ?? null, state: "planning" });
      await env.comm.say({
        user: env.user,
        project,
        speaker: { kind: "moderator" },
        listener: { kind: "team" },
        situation: "instruction",
        body: `'${task.title}' 작업을 배정할게요.\n${asg.reasons.join("\n")}`,
        machineState: { kind: "task.assigned", taskId: task.id, data: { implementer: asg.implementer.id, reviewer: asg.reviewer?.id ?? null } },
      });
      // The one line people see at the start: the implementer, in character.
      await env.comm.say({
        user: env.user,
        project,
        speaker: { kind: "agent", agent: asg.implementer },
        listener: { kind: "user" },
        situation: "report",
        body: startLine(task.title, (await ctx.repos.personas.find(asg.implementer.personaId))?.preset),
        machineState: { kind: "task.started", taskId: task.id },
      });
    }
    const implementer = await this.agentOrNull(env, task.assignedAgentId);
    if (!implementer) return this.block(env, task, "담당 에이전트를 찾을 수 없습니다.");
    const reviewer = (await this.agentOrNull(env, task.reviewerAgentId)) ?? implementer;
    const leader = (await this.agentOrNull(env, project.leaderAgentId)) ?? implementer;

    /* ---------- workspace ---------- */
    let ws: TaskWorkspace;
    try {
      ws = await ctx.workspaces.prepareTask(project, task);
    } catch (e) {
      return this.block(env, task, `작업 공간 준비 실패: ${(e as Error).message}`);
    }
    if (task.branch !== ws.branch) task = await ctx.repos.tasks.update(task.id, { branch: ws.branch });

    /* ---------- planning ---------- */
    if (task.stage === "requirements") {
      const stop = await env.checkStop(task.id);
      if (stop) return { kind: stop };
      task = await this.setState(env, task, { state: "planning" });
      const built = await ctx.contextBuilder.build({ userId: env.user.id, agent: leader, project, task, stylePolicy: await env.comm.styleFor(env.user, leader, { kind: "user" }, "report", "leader") });
      const out = await env.runner.runWithHandoff(project, { agent: leader, task, purpose: "plan", prompt: this.planPromptFor(task, built.text), cwd: ws.dir, mode: "readonly", sandbox: ws.sandbox, timeoutMs: 10 * 60_000 });
      if (out.needsApproval) return this.requestApproval(env, task, "paid_api_usage", "구독 실행기를 사용할 수 없어 종량제 유료 API 사용이 필요합니다. 비용이 발생할 수 있습니다.");
      if (out.status !== "succeeded") return this.execFailure(env, task, "기획", out.error ?? out.status);
      const plan = extractJson<PlanJson>(out.text) ?? {};
      const criteria = asStringArray(plan.acceptance_criteria, 15);
      const difficulty = DIFFICULTIES.includes(plan.difficulty as Difficulty) ? (plan.difficulty as Difficulty) : task.difficulty;
      task = await ctx.repos.tasks.update(task.id, {
        acceptanceCriteria: criteria.length ? criteria : task.acceptanceCriteria.length ? task.acceptanceCriteria : [task.title],
        difficulty,
        budget: budgetFor(difficulty),
        checkpoint: { plan: { summary: plan.summary ?? "", risks: asStringArray(plan.risks), coreFeature: !!plan.core_feature, architectureChange: !!plan.architecture_change, scopeExpansion: !!plan.scope_expansion } },
      });
      await ctx.memory.remember(project.id, "requirement", `${task.title}: ${plan.summary ?? task.description}\n수락 기준: ${task.acceptanceCriteria.join(" / ")}`, { certainty: "proposal", sourceRefs: [task.id, out.executionId] });
      await env.comm.say({
        user: env.user,
        project,
        speaker: { kind: "agent", agent: out.agent },
        listener: { kind: "user" },
        situation: "report",
        body: plan.message ?? `계획: ${plan.summary ?? task.title}\n수락 기준:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
        inCharacter: !!plan.message,
        machineState: { kind: "task.planned", taskId: task.id, executionId: out.executionId, data: { criteria: task.acceptanceCriteria, difficulty } },
      });
      const subtasks = (Array.isArray(plan.subtasks) ? plan.subtasks : []).filter((x) => x && typeof x.title === "string" && x.title.trim()).slice(0, 5);
      if (subtasks.length >= 2 && !task.checkpoint.parentTaskId) {
        const children: Task[] = [];
        for (const [i, st] of subtasks.entries()) {
          const crit = asStringArray(st.acceptance_criteria, 10);
          children.push(
            await ctx.repos.tasks.create({
              projectId: project.id,
              requestId: task.requestId,
              title: String(st.title).slice(0, 80),
              description: `${typeof st.description === "string" ? st.description : ""}\n\n(상위 작업: ${task.title})`,
              acceptanceCriteria: crit.length ? crit : [String(st.title)],
              difficulty,
              budget: budgetFor(difficulty),
              priority: Math.max(0, task.priority - i), // keep the leader's order
              stage: "implementation",
              assignedAgentId: task.assignedAgentId,
              reviewerAgentId: task.reviewerAgentId,
              checkpoint: { parentTaskId: task.id, mentionedAgentIds: task.checkpoint.mentionedAgentIds ?? [], plan: { summary: String(st.title) } },
            }),
          );
        }
        await ctx.repos.decisions.create({ projectId: project.id, taskId: task.id, title: `작업 분할: ${task.title}`, rationale: children.map((c) => c.title).join(" / "), alternatives: [], approvalRef: null, sourceRefs: [task.id, out.executionId], status: "proposed" });
        await env.comm.say({
          user: env.user,
          project,
          speaker: { kind: "agent", agent: out.agent },
          listener: { kind: "user" },
          situation: "report",
          body: `작업이 커서 ${children.length}개로 나눠 순서대로 진행할게요.\n${children.map((c, i) => `${i + 1}. ${c.title}`).join("\n")}`,
          machineState: { kind: "task.split", taskId: task.id, data: { children: children.map((c) => c.id) } },
        });
        const childIds = children.map((c) => c.id);
        if (plan.architecture_change || plan.scope_expansion) {
          // Hold every child until the whole plan is approved on the parent.
          for (const c of children) await ctx.repos.tasks.update(c.id, { state: "blocked", blockedReason: "상위 작업 승인 대기" });
          await ctx.repos.tasks.update(task.id, { checkpoint: { childTaskIds: childIds } });
          return this.requestApproval(env, await ctx.repos.tasks.get(task.id), plan.architecture_change ? "architecture_change" : "scope_expansion", `분할된 계획에 ${plan.architecture_change ? "주요 아키텍처 변경" : "범위 확대"}이 포함됩니다.\n${plan.summary ?? ""}\n${children.map((c, i) => `${i + 1}. ${c.title}`).join("\n")}`, {}, out.agent);
        }
        await this.setState(env, task, { state: "done", stage: "complete", completedAt: nowIso(), checkpoint: { internal: true, kind: "split", childTaskIds: childIds } });
        return { kind: "spawned", taskIds: childIds };
      }
      const questions = asStringArray(plan.questions, 3);
      task = await this.setState(env, task, { stage: "implementation" });
      const mode = await this.approvalMode(env, project);
      const withinScope = !plan.scope_expansion && !plan.architecture_change;
      if (plan.architecture_change) return this.requestApproval(env, task, "architecture_change", `주요 아키텍처 변경이 포함된 계획입니다.\n${plan.summary ?? ""}\n위험: ${asStringArray(plan.risks).join(", ") || "없음"}`, {}, out.agent);
      if (plan.scope_expansion) return this.requestApproval(env, task, "scope_expansion", `요청 범위를 넘어서는 기능 추가가 포함됩니다.\n${plan.summary ?? ""}`, {}, out.agent);
      // Real questions are asked in chat, not as an approval card: the answer (or "알아서") starts the work.
      // In 자동 진행 the user asked not to be interrupted: go with the recommended defaults.
      if (questions.length && !(await ctx.repos.projects.get(project.id)).settings.autopilot) return this.askQuestions(env, task, out.agent, questions);
      if (ctx.approvals.needsApproval("plan_scope", mode, { withinApprovedScope: withinScope })) {
        return this.requestApproval(env, task, "plan_scope", `${plan.summary ?? task.title}\n수락 기준:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}${questions.length ? `\n\n확인이 필요한 질문:\n${questions.map((q) => `- ${q}`).join("\n")}` : ""}`, {}, out.agent);
      }
    }

    /* ---------- implement → gate → review → fix ---------- */
    if (["implementation", "testing", "review", "fix"].includes(task.stage)) {
      const outcome = await this.buildLoop(env, task, ws, implementer, reviewer);
      if (outcome) return outcome;
      task = await ctx.repos.tasks.get(task.id);
    }

    /* ---------- PR ---------- */
    if (task.stage === "pr") return this.openPr(env, task, ws, implementer);
    if (task.stage === "complete") return { kind: "done" };
    return { kind: "blocked", reason: `알 수 없는 단계: ${task.stage}` };
  }

  private elapsedMinutes(task: Task): number {
    const s = task.checkpoint.startedAt ? new Date(String(task.checkpoint.startedAt)).getTime() : Date.now();
    return (Date.now() - s) / 60_000;
  }

  private async buildLoop(env: WorkflowEnv, initial: Task, ws: TaskWorkspace, implementer: Agent, reviewer: Agent): Promise<TaskOutcome | null> {
    const { ctx, project } = env;
    let task = initial;
    const maxAttempts = task.budget.maxRetries + 1;
    while (true) {
      const stop = await env.checkStop(task.id);
      if (stop) return { kind: stop };
      if ((task.stage === "implementation" || task.stage === "fix") && task.attempts >= maxAttempts) {
        return this.requestApproval(env, task, "budget_exceed", `자동 수정 재시도 한도(${maxAttempts}회)에 도달했습니다. 남은 문제:\n${String(task.checkpoint.lastFeedback ?? "").slice(0, 1200)}\n추가 재시도를 승인하시겠어요?`, { kind: "retries", attempts: task.attempts });
      }
      if (this.elapsedMinutes(task) > task.budget.maxMinutes && !task.checkpoint.timeBudgetExtended) {
        return this.requestApproval(env, task, "budget_exceed", `작업 시간 예산(${task.budget.maxMinutes}분)을 초과했습니다. 계속 진행할까요?`, { kind: "time" });
      }

      /* implement (or fix) */
      if (task.stage === "implementation" || task.stage === "fix") {
        task = await this.setState(env, task, { state: "in_progress", attempts: task.attempts + 1 });
        const feedback = task.stage === "fix" ? String(task.checkpoint.lastFeedback ?? "") : undefined;
        const built = await ctx.contextBuilder.build({ userId: env.user.id, agent: implementer, project, task, peers: [reviewer], stylePolicy: await env.comm.styleFor(env.user, implementer, reviewer.id === implementer.id ? { kind: "user" } : { kind: "agent", agent: reviewer }, reviewer.id === implementer.id ? "report" : "handoff", "implementer") });
        const out = await env.runner.runWithHandoff(project, {
          agent: implementer,
          task,
          purpose: task.stage === "fix" ? "fix" : "implement",
          prompt: this.implementPromptFor(task, built.text, feedback, task.attempts),
          cwd: ws.dir,
          mode: "write",
          allowWeb: this.allowWeb,
          sandbox: ws.sandbox,
          resumeSessionRef: task.stage === "fix" ? ((task.checkpoint.lastSessionRef as string | undefined) ?? null) : null,
          timeoutMs: Math.max(10, task.budget.maxMinutes) * 60_000,
        });
        if (out.needsApproval) return this.requestApproval(env, task, "paid_api_usage", "구독 실행기를 사용할 수 없어 종량제 유료 API 사용이 필요합니다. 비용이 발생할 수 있습니다.");
        if (out.status === "cancelled") return { kind: "cancelled" };
        if (out.status !== "succeeded") return this.execFailure(env, task, "구현", out.error ?? out.status);
        const impl = extractJson<ImplJson>(out.text) ?? {};
        const sha = await ctx.workspaces.git.commitAll(ws.dir, `${task.stage === "fix" ? "fix" : "feat"}: ${task.title}\n\nAgentAgency task ${task.id} (attempt ${task.attempts}) by ${out.agent.name}`);
        if (!sha && !(await ctx.workspaces.git.changedFiles(ws.dir, ws.base)).length) {
          await ctx.memory.remember(project.id, "lesson", `'${task.title}' 시도 ${task.attempts}: 코드 변경 없이 종료됨`, { sourceRefs: [task.id, out.executionId] });
          const streak = Number(task.checkpoint.noChangeStreak ?? 0) + 1;
          // First empty attempt: maybe nothing needs changing (the code already does it). Let the
          // reviewer judge the existing code; approval finishes the task, a rejection gives the
          // next attempt concrete feedback instead of "you changed nothing".
          if (streak === 1) {
            task = await this.setState(env, task, { stage: "review", state: "review", checkpoint: { noChangeStreak: streak, noDiff: true } });
            continue;
          }
          // The same agent keeps ending without touching a file (e.g. its executor cannot write in
          // this environment): hand the work to another agent instead of looping until the budget.
          const alt = streak >= 2 ? await ctx.team.alternativeFor(project, out.agent) : null;
          if (alt) {
            await this.setState(env, task, {
              assignedAgentId: alt.id,
              reviewerAgentId: alt.id === task.reviewerAgentId ? out.agent.id : task.reviewerAgentId,
              stage: "implementation",
              attempts: 0, // a fresh budget for the new implementer
              checkpoint: { noChangeStreak: 0, lastFeedback: null, startedAt: nowIso(), timeBudgetExtended: false },
            });
            await env.comm.say({
              user: env.user,
              project,
              speaker: { kind: "moderator" },
              listener: { kind: "team" },
              situation: "instruction",
              body: `${out.agent.name}이(가) ${streak}번 연속 파일을 바꾸지 못했어요. 이 작업은 ${alt.name}이(가) 이어받을게요.`,
              machineState: { kind: "task.reassigned", taskId: task.id, data: { from: out.agent.id, to: alt.id, reason: "no_changes" } },
            });
            await ctx.memory.remember(project.id, "handoff", `${out.agent.name} → ${alt.name}: '${task.title}' 구현이 ${streak}번 연속 변경 없이 끝나 인계`, { sourceRefs: [task.id] });
            return { kind: "requeue" };
          }
          task = await this.setState(env, task, { stage: "fix", checkpoint: { noChangeStreak: streak, lastFeedback: "이전 시도에서 파일 변경이 없었습니다. 실제로 코드를 수정해야 합니다." } });
          continue;
        }
        task = await this.setState(env, task, {
          stage: "testing",
          checkpoint: { noChangeStreak: 0, noDiff: false, commitSha: sha ?? task.checkpoint.commitSha, impl: { summary: impl.summary ?? "", changes: asStringArray(impl.changes), testsAdded: asStringArray(impl.tests_added), openIssues: asStringArray(impl.open_issues) } },
        });
        await env.comm.say({
          user: env.user,
          project,
          speaker: { kind: "agent", agent: out.agent },
          // With a single agent there is nobody to hand off to: report to the user instead of self-talk.
          listener: reviewer.id === out.agent.id ? { kind: "user" } : { kind: "agent", agent: reviewer },
          situation: reviewer.id === out.agent.id ? "report" : "handoff",
          body: impl.message ?? `'${task.title}' 구현을 마쳤어요. ${impl.summary ?? ""}`,
          inCharacter: !!impl.message,
          machineState: { kind: "task.implemented", taskId: task.id, executionId: out.executionId, data: { commit: sha, attempt: task.attempts } },
        });
      }

      /* quality gate */
      if (task.stage === "testing") {
        // Secret scan of the net change (blocking): nothing secret may reach GitHub.
        const findings = [...scanFiles(await ctx.workspaces.git.changedFiles(ws.dir, ws.base)), ...scanDiff(await ctx.workspaces.git.diff(ws.dir, ws.base, 5_000_000))];
        const gate = await this.runChecks(env, task, ws);
        const checks: QualityGateSummary["checks"] = [
          findings.length ? { name: "secrets", status: "failed", durationMs: 0, summary: `비밀정보 의심 ${findings.length}건: ${describeFindings(findings)}` } : { name: "secrets", status: "passed", durationMs: 0, summary: "비밀정보 없음" },
          ...gate.checks,
        ];
        // Imported repos: checks already failing on the untouched baseline are reported but judged as "no regression".
        const verdict = applyBaseline(checks, new Set([...gate.blocking, "secrets"]), project.settings.baseline);
        for (const c of checks) if (verdict.preexisting.includes(c.name)) c.summary = `${c.summary} — 기존 실패(기준선), 이번 변경의 회귀 아님`;
        const summary: QualityGateSummary = { passed: verdict.passed, checks, ranAt: gate.ranAt, preexisting: verdict.preexisting };
        const logs = await ctx.files.put("logs", `${task.id}-gate.log`, gate.checks.map((c) => `## ${c.name} ${c.status}\n${c.details ?? ""}`).join("\n\n"));
        await ctx.repos.artifacts.add({ taskId: task.id, kind: "quality_gate_log", storageRef: logs.ref, githubRef: null, retentionClass: "detailed_log", metadata: { passed: summary.passed, flaky: gate.flaky.map((f) => f.name), preexisting: verdict.preexisting } });
        if (gate.flaky.length) {
          await ctx.memory.remember(project.id, "lesson", `Flaky 의심: ${gate.flaky.map((f) => `${f.name}(${f.attempts}회 시도)`).join(", ")} — 첫 실패 로그 보관, 전체 게이트 재실행으로 확정`, { sourceRefs: [task.id, logs.ref] });
        }
        await env.comm.say({
          user: env.user,
          project,
          speaker: { kind: "system" },
          listener: { kind: "user" },
          situation: "report",
          body: `🧪 품질 게이트 ${summary.passed ? (verdict.preexisting.length ? `통과 (기존 실패 ${verdict.preexisting.length}건은 회귀 여부만 판단)` : "통과") : "실패"} (시도 ${task.attempts})\n${summarizeGate(summary)}${gate.flaky.length ? `\n⚠️ flaky 의심: ${gate.flaky.map((f) => f.name).join(", ")}` : ""}${verdict.preexisting.length ? `\nℹ️ 기존 코드에서 이미 실패하던 검사: ${verdict.preexisting.join(", ")} (회귀만 차단)` : ""}`,
          machineState: { kind: "quality.gate", taskId: task.id, status: summary.passed ? "passed" : "failed", data: { checks: checks.map((c) => ({ name: c.name, status: c.status })), preexisting: verdict.preexisting } },
        });
        if (!summary.passed) {
          const failing = checks.filter((c) => c.status !== "passed" && !verdict.preexisting.includes(c.name));
          const secretHint = findings.length ? "\n\n비밀정보로 보이는 값이나 파일이 커밋되었습니다. 값을 코드에서 제거하고 환경변수 이름으로만 참조하세요. 해당 파일은 삭제하고 .gitignore에 추가하세요." : "";
          const fb = fixFeedbackFromGate(summarizeGate(summary), failing.map((c) => `### ${c.name}\n${c.details ?? c.summary}`)) + secretHint;
          task = await this.setState(env, task, { stage: "fix", checkpoint: { qualityGate: summary, lastFeedback: fb } });
          continue;
        }
        task = await this.setState(env, task, { stage: "review", state: "review", checkpoint: { qualityGate: summary } });
      }

      /* cross review */
      if (task.stage === "review") {
        task = await this.setState(env, task, { state: "review" });
        const diff = await ctx.workspaces.git.diff(ws.dir, ws.base);
        const gateText = task.checkpoint.qualityGate ? summarizeGate(task.checkpoint.qualityGate) : "미실행";
        const style = await env.comm.styleFor(env.user, reviewer, reviewer.id === implementer.id ? { kind: "user" } : { kind: "agent", agent: implementer }, reviewer.id === implementer.id ? "report" : "discussion", "reviewer");
        const out = await env.runner.runWithHandoff(project, {
          agent: reviewer,
          task,
          purpose: "review",
          prompt: this.reviewPromptFor(task, diff, gateText, style, implementer.name) + (task.checkpoint.noDiff ? "\n\n## 참고\n이번 시도에서 구현 담당이 바꾼 코드가 없습니다(diff 없음). 현재 저장소의 코드가 이미 작업과 수용 기준을 충족하는지 직접 확인해 판단하세요. 충족하면 approved=true로 승인하고, 부족하면 무엇을 고쳐야 하는지 구체적으로 적으세요." : ""),
          cwd: ws.dir,
          mode: "readonly",
          sandbox: ws.sandbox,
          kinds: ["local_cli", "paid_api"],
          timeoutMs: 15 * 60_000,
        });
        if (out.needsApproval) return this.requestApproval(env, task, "paid_api_usage", "리뷰용 구독 실행기를 사용할 수 없어 종량제 유료 API 사용이 필요합니다.");
        if (out.status !== "succeeded") return this.execFailure(env, task, "리뷰", out.error ?? out.status);
        const rj = extractJson<ReviewJson>(out.text);
        const issues: ReviewVerdict["issues"] = (rj?.issues ?? [])
          .filter((i) => i && typeof i.description === "string")
          .map((i) => ({ severity: (["blocker", "major", "minor"].includes(String(i.severity)) ? i.severity : "major") as "blocker" | "major" | "minor", description: String(i.description), file: i.file }));
        // Unparseable reviews never count as approval. Only real defects (major/blocker) can hold a
        // change back: a rejection that lists nothing but minor points is treated as approval, so
        // nitpicks or "please verify again" cannot loop the fix step until the retry limit.
        const blocking = issues.some((i) => i.severity === "blocker" || i.severity === "major");
        const approved = !!rj && !issues.some((i) => i.severity === "blocker") && (!!rj.approved || (issues.length > 0 && !blocking));
        const verdict: ReviewVerdict = { reviewerAgentId: out.agent.id, approved, summary: rj?.summary ?? "리뷰 결과를 구조화하지 못했습니다.", issues };
        if (out.agent.id !== implementer.id && (await ctx.flags.isEnabled("relationships.evolve", env.user.id))) {
          await ctx.repos.relationships.recordInteraction(env.user.id, out.agent.id, implementer.id, approved ? "positive" : "neutral", `${task.title} 리뷰 ${approved ? "승인" : "수정 요청"}`);
        }
        await env.comm.say({
          user: env.user,
          project,
          speaker: { kind: "agent", agent: out.agent },
          listener: out.agent.id === implementer.id ? { kind: "user" } : { kind: "agent", agent: implementer },
          situation: out.agent.id === implementer.id ? "report" : "discussion",
          body: rj?.message ?? `리뷰 결과: ${approved ? "승인" : "수정 필요"} — ${verdict.summary}`,
          inCharacter: !!rj?.message,
          machineState: { kind: "review.verdict", taskId: task.id, executionId: out.executionId, status: approved ? "approved" : "changes_requested", data: { issues: issues.length } },
        });
        if (!approved) {
          // What is left needs the user (deploy, a real URL, an account): ask once with how-to
          // steps instead of sending the implementer round after round at something it cannot do.
          const needsUser = [
            ...(rj?.needs_user ?? []).filter((n) => n && typeof n.what === "string" && n.what.trim()).map((n) => ({ what: String(n.what), how: typeof n.how === "string" ? n.how : undefined })),
            ...issues.filter((i) => i.severity !== "minor" && EXTERNAL_WORK.test(i.description)).map((i) => ({ what: i.description, how: undefined as string | undefined })),
          ];
          const codeBlocking = issues.filter((i) => i.severity !== "minor" && !EXTERNAL_WORK.test(i.description));
          if (needsUser.length && !codeBlocking.length) return this.askUser(env, task, implementer, needsUser);
          // The same objection again after a fix round means the fix loop cannot resolve it (often a
          // criterion code cannot meet, e.g. a real deployment URL). Stop looping: open the PR with
          // the objection recorded, and let the user decide at the merge step.
          const sig = reviewSignature(issues, verdict.summary);
          const prevSig = String(task.checkpoint.lastRejectSignature ?? "");
          if (prevSig && similarity(sig, prevSig) >= 0.5) {
            const unresolved = issues.filter((i) => i.severity !== "minor").map((i) => `${i.description}${i.file ? ` (${i.file})` : ""}`);
            await env.comm.say({
              user: env.user,
              project,
              speaker: { kind: "moderator" },
              listener: { kind: "user" },
              situation: "report",
              body: `리뷰어가 같은 지적을 반복해서 수정을 멈췄어요. PR을 열고 남은 지적은 PR에 적어 둘게요: ${unresolved[0] ?? verdict.summary}`.slice(0, 600),
              machineState: { kind: "review.repeated", taskId: task.id },
            });
            await this.setState(env, task, { stage: "pr", checkpoint: { reviewVerdict: verdict, unresolvedReview: unresolved, lastRejectSignature: null } });
            return null;
          }
          const fb = `교차 리뷰에서 수정 요청이 있었습니다: ${verdict.summary}\n${issues.map((i) => `- [${i.severity}] ${i.description}${i.file ? ` (${i.file})` : ""}`).join("\n")}`;
          task = await this.setState(env, task, { stage: "fix", checkpoint: { reviewVerdict: verdict, lastFeedback: fb, lastRejectSignature: sig } });
          continue;
        }
        if (task.checkpoint.noDiff && !(await ctx.workspaces.git.changedFiles(ws.dir, ws.base)).length) {
          await this.complete(env, await this.setState(env, task, { checkpoint: { reviewVerdict: verdict, noDiff: false } }), "기존 코드가 이미 작업 내용을 충족해서 바꿀 것이 없었어요 (리뷰 확인).");
          return { kind: "done" };
        }
        await this.setState(env, task, { stage: "pr", checkpoint: { reviewVerdict: verdict, noDiff: false } });
        return null;
      }
      return null;
    }
  }

  private async openPr(env: WorkflowEnv, task: Task, ws: TaskWorkspace, implementer: Agent): Promise<TaskOutcome> {
    const { ctx, project } = env;
    const cp = task.checkpoint as TaskCheckpoint & { impl?: { summary: string; changes: string[]; testsAdded: string[]; openIssues: string[] }; plan?: { coreFeature?: boolean } };
    let prUrl: string | null = task.prRef;
    let prNumber: number | null = (cp.prNumber as number | undefined) ?? null;
    if (project.repoRef && ctx.github) {
      try {
        // Push every new commit (revisions update the same PR); the ledger key makes it idempotent.
        await ctx.repos.effects.once(`push:${task.id}:${String(cp.commitSha ?? "")}`, "git_push", task.id, async () => {
          await this.ensureCleanHistory(env, task, ws);
          await ctx.workspaces.git.push(ws.dir, ws.branch);
          return { branch: ws.branch };
        });
        if (prUrl) throw new PrAlreadyOpen();
        const body = this.prBody(task, cp);
        const pr = await ctx.repos.effects.once(`pr:${task.id}`, "github_pr", task.id, async () => {
          const p = await ctx.github!.createPullRequest(project.repoRef!, { head: ws.branch, base: project.defaultBranch, title: task.title, body });
          return { number: p.number, url: p.url };
        });
        prUrl = String(pr.url);
        prNumber = Number(pr.number);
        task = await ctx.repos.tasks.update(task.id, { prRef: prUrl, checkpoint: { prNumber } });
      } catch (e) {
        if (!(e instanceof PrAlreadyOpen)) return this.block(env, task, `PR 생성 실패: ${(e as Error).message}`);
        if (cp.userRevision && ctx.github) {
          await ctx.github.commentOnPr(project.repoRef, prNumber!, `사용자 수정 요청 반영 (${String(cp.userRevision)}차): ${String(cp.lastFeedback ?? "").slice(0, 500)}\n\n---\n_AgentAgency_`).catch(() => undefined);
        }
      }
    }
    let previewUrl: string | null = null;
    const openIssues = [...(cp.impl?.openIssues ?? [])];
    if (await ctx.flags.isEnabled("coding.preview_deploy", env.user.id)) {
      previewUrl = previewUrlFor(project.settings.previewUrl, { branch: ws.branch, pr: prNumber, slug: project.slug });
      if (previewUrl) {
        const shot = await captureScreenshot(previewUrl, ctx.files, `${task.id}-preview`).catch((e: Error) => ({ ref: null, note: e.message }));
        if (shot.ref) await ctx.repos.artifacts.add({ taskId: task.id, kind: "screenshot", storageRef: shot.ref, githubRef: null, retentionClass: "detailed_log", metadata: { url: previewUrl } });
        else openIssues.push(shot.note);
      }
    }
    if (!project.repoRef) openIssues.push("GitHub 저장소가 연결되지 않아 PR 대신 로컬 브랜치에만 커밋했습니다.");
    if (cp.qualityGate?.preexisting?.length) openIssues.push(`기존 코드에서 이미 실패하던 검사(이번 변경과 무관): ${cp.qualityGate.preexisting.join(", ")}`);
    const card: ReportCard = {
      projectName: project.name,
      taskTitle: task.title,
      feature: cp.impl?.summary || task.description || task.title,
      changes: cp.impl?.changes ?? (await ctx.workspaces.git.changedFiles(ws.dir, ws.base)),
      tests: cp.qualityGate ?? null,
      review: cp.reviewVerdict ?? null,
      prUrl,
      previewUrl,
      openIssues,
      requiresUserConfirmation: true,
    };
    task = await this.setState(env, task, { state: project.repoRef ? "pr_open" : "awaiting_approval", stage: "pr" });
    await env.comm.say({
      user: env.user,
      project,
      speaker: { kind: "system" },
      listener: { kind: "user" },
      situation: "report",
      body: reportCardText(card),
      preformatted: true,
      machineState: { kind: "report.card", taskId: task.id, data: { prUrl, previewUrl } },
    });
    await ctx.repos.tasks.checkpoint(task.id, { reportCard: card });
    // What people see at the end: the implementer says what was done and asks about what is left.
    await env.comm.say({
      user: env.user,
      project,
      speaker: { kind: "agent", agent: implementer },
      listener: { kind: "user" },
      situation: "report",
      body: doneLine(card),
      buttons: [[{ text: "📋 자세히", data: `t:report:${task.id}` }]],
      machineState: { kind: "task.finished", taskId: task.id, data: { prUrl } },
    });
    env.ctx.events.emit("report.ready", { projectId: project.id, taskId: task.id, card });
    await this.afterReport(env, task, ws).catch((e) => ctx.logger.warn({ err: (e as Error).message }, "afterReport failed"));
    await ctx.memory.remember(project.id, "task", `완료 보고: ${task.title} → ${prUrl ?? ws.branch}`, { sourceRefs: [task.id] });

    const mode = await this.approvalMode(env, project);
    if (cp.plan?.coreFeature && !(await ctx.approvals.isApproved("feature_complete", { taskId: task.id, projectId: project.id }))) {
      return this.requestApproval(env, task, "feature_complete", `핵심 기능 '${task.title}' 결과를 최종 확인해 주세요.${prUrl ? `\nPR: ${prUrl}` : ""}${previewUrl ? `\n프리뷰: ${previewUrl}` : ""}`, {}, implementer);
    }
    if (project.repoRef && prNumber != null) {
      if (ctx.approvals.needsApproval("pr_merge", mode)) {
        return this.requestApproval(env, task, "pr_merge", `PR #${prNumber} 병합을 승인해 주세요.\n${prUrl}`, { pr: prNumber }, implementer);
      }
      return this.merge(env, task, prNumber);
    }
    return this.requestApproval(env, task, "feature_complete", `'${task.title}' 결과를 확인해 주세요 (로컬 브랜치 ${ws.branch}).`, {}, implementer);
  }

  /**
   * Before pushing, check every not-yet-pushed commit. If an intermediate commit contained a secret
   * that a later commit removed, squash the unpushed commits so the secret never reaches GitHub.
   */
  private async ensureCleanHistory(env: WorkflowEnv, task: Task, ws: TaskWorkspace): Promise<void> {
    const git = env.ctx.workspaces.git;
    const upstream = (await git.run(ws.dir, ["rev-parse", "--verify", `origin/${ws.branch}`], { allowFail: true })) ? `origin/${ws.branch}` : ws.base;
    const shas = (await git.run(ws.dir, ["rev-list", `${upstream}..HEAD`], { allowFail: true })).split("\n").filter(Boolean);
    let dirty = false;
    for (const sha of shas) {
      const show = await git.run(ws.dir, ["show", "--format=", "--name-only", sha], { allowFail: true });
      const patch = await git.run(ws.dir, ["show", "--format=", sha], { allowFail: true });
      if (scanFiles(show.split("\n").filter(Boolean)).length || scanDiff(patch).length) {
        dirty = true;
        break;
      }
    }
    if (!dirty) return;
    const net = [...scanFiles(await git.changedFiles(ws.dir, upstream)), ...scanDiff(await git.run(ws.dir, ["diff", `${upstream}..HEAD`], { allowFail: true }))];
    if (net.length) throw new Error(`푸시 중단: 최종 변경에 비밀정보 의심 항목이 있습니다 (${describeFindings(net)})`);
    await git.run(ws.dir, ["reset", "--soft", upstream]);
    await git.commitAll(ws.dir, `${task.title}\n\nAgentAgency task ${task.id} (squashed: removed secret traces from intermediate commits)`);
    await env.ctx.repos.audit.record("system", "git.squash_secret_history", `task:${task.id}`, "success", { commits: shas.length });
  }

  private prBody(task: Task, cp: any): string {
    const lines = [`## 작업\n${task.description || task.title}`, `\n## 수락 기준\n${task.acceptanceCriteria.map((c) => `- [x] ${c}`).join("\n")}`];
    if (cp.impl?.changes?.length) lines.push(`\n## 변경 내용\n${cp.impl.changes.map((c: string) => `- ${c}`).join("\n")}`);
    if (cp.qualityGate) lines.push(`\n## 품질 게이트\n${summarizeGate(cp.qualityGate)}`);
    if (cp.reviewVerdict) lines.push(`\n## 교차 리뷰\n${cp.reviewVerdict.approved ? "승인" : "수정 필요"} — ${cp.reviewVerdict.summary}`);
    if (cp.impl?.openIssues?.length) lines.push(`\n## 미해결 이슈\n${cp.impl.openIssues.map((c: string) => `- ${c}`).join("\n")}`);
    if (cp.unresolvedReview?.length) lines.push(`\n## 리뷰에서 반복된 지적 (수정 루프로 해결되지 않아 남김)\n${cp.unresolvedReview.map((c: string) => `- ${c}`).join("\n")}`);
    lines.push(`\n---\n_AgentAgency task \`${task.id}\`_`);
    return lines.join("\n");
  }

  protected async merge(env: WorkflowEnv, task: Task, prNumber: number): Promise<TaskOutcome> {
    const { ctx, project } = env;
    try {
      const r = await ctx.repos.effects.once(`merge:${task.id}:${prNumber}`, "github_merge", task.id, async () => {
        const m = await ctx.github!.mergePullRequest(project.repoRef!, prNumber, "squash");
        if (!m.merged) throw new Error(m.message);
        return { merged: m.merged, sha: m.sha };
      });
      await ctx.repos.decisions.create({ projectId: project.id, taskId: task.id, title: `PR #${prNumber} 병합: ${task.title}`, rationale: "품질 게이트 통과·교차 리뷰 승인·사용자 승인", alternatives: [], approvalRef: (task.checkpoint.pendingApprovalId as string | undefined) ?? null, sourceRefs: [task.id] });
      await this.complete(env, task, `PR #${prNumber} 병합 완료${r.sha ? ` (${String(r.sha).slice(0, 7)})` : ""}`);
      await ctx.workspaces.cleanupTask(project, task.id).catch(() => undefined);
      return { kind: "done" };
    } catch (e) {
      return this.block(env, task, `PR 병합 실패: ${(e as Error).message}`);
    }
  }

  protected async complete(env: WorkflowEnv, task: Task, note: string): Promise<void> {
    await this.setState(env, task, { state: "done", stage: "complete", completedAt: nowIso(), blockedReason: null });
    await env.ctx.memory.remember(env.project.id, "task", `${task.title}: ${note}`, { sourceRefs: [task.id] });
    // Confirmed requirement once the user accepted the result.
    await env.ctx.memory.remember(env.project.id, "requirement", `${task.title} (완료): ${task.acceptanceCriteria.join(" / ")}`, { certainty: "confirmed", sourceRefs: [task.id] });
    await env.comm.say({
      user: env.user,
      project: env.project,
      speaker: { kind: "moderator" },
      listener: { kind: "user" },
      situation: "report",
      body: `'${task.title}' 작업을 마무리했어요. ${note}`,
      machineState: { kind: "task.done", taskId: task.id, status: "done" },
    });
  }

  /** The leader asks before starting; the next message in the topic (or "알아서 해 줘") starts the work. */
  protected async askQuestions(env: WorkflowEnv, task: Task, speaker: Agent, questions: string[]): Promise<TaskOutcome> {
    const { ctx, project } = env;
    await this.setState(env, task, { state: "blocked", blockedReason: "사용자 답변 대기", checkpoint: { awaitingUser: { items: questions, askedAt: nowIso(), resumeStage: "implementation" } } });
    await ctx.repos.settings.set("user", env.user.id, TASK_INPUT_KEY, { taskId: task.id, projectId: project.id, chatId: project.chatId, topicId: project.topicId });
    await env.comm.say({
      user: env.user,
      project,
      speaker: { kind: "agent", agent: speaker },
      listener: { kind: "user" },
      situation: "request_help",
      body: `시작 전에 ${questions.length > 1 ? "몇 가지" : "하나만"} 물어볼게요.\n${questions.map((q) => `• ${q.slice(0, 160)}`).join("\n")}`,
      buttons: [[{ text: "👌 알아서 해 줘", data: `t:skipask:${task.id}` }]],
      machineState: { kind: "task.question", taskId: task.id, data: { questions } },
    });
    return { kind: "blocked", reason: "사용자 답변 대기" };
  }

  /** Ask the user for something the team cannot do; their next message in the topic continues the task. */
  protected async askUser(env: WorkflowEnv, task: Task, speaker: Agent, items: Array<{ what: string; how?: string }>): Promise<TaskOutcome> {
    const { ctx, project } = env;
    const unique = [...new Map(items.map((i) => [i.what.slice(0, 80), i])).values()].slice(0, 3);
    const how = unique.map((i) => i.how).find(Boolean) ?? howToFor(unique.map((i) => i.what).join(" "), project.repoRef);
    await this.setState(env, task, { state: "blocked", blockedReason: "사용자 답변 대기", checkpoint: { awaitingUser: { items: unique.map((i) => i.what), askedAt: nowIso() } } });
    await ctx.repos.settings.set("user", env.user.id, TASK_INPUT_KEY, { taskId: task.id, projectId: project.id, chatId: project.chatId, topicId: project.topicId });
    await env.comm.say({
      user: env.user,
      project,
      speaker: { kind: "agent", agent: speaker },
      listener: { kind: "user" },
      situation: "request_help",
      body: `이건 제가 직접 할 수 없어서 도와주셔야 해요:\n${unique.map((i) => `• ${i.what.slice(0, 160)}`).join("\n")}${how ? `\n${how}` : ""}\n여기에 답해 주시면 이어서 할게요. 이 부분 없이 진행하려면 ⏭를 눌러 주세요.`,
      buttons: [[{ text: "⏭ 이 부분 빼고 진행", data: `t:skipask:${task.id}` }, { text: "🛑 취소", data: `t:cancel:${task.id}` }]],
      machineState: { kind: "task.needs_user", taskId: task.id, data: { items: unique.map((i) => i.what) } },
    });
    return { kind: "blocked", reason: "사용자 답변 대기" };
  }

  protected async block(env: WorkflowEnv, task: Task, reason: string): Promise<TaskOutcome> {
    if (env.ctx.lifecycle.shuttingDown) {
      // Interrupted by a server stop, not a real failure: resume from the checkpoint on next start.
      await env.ctx.repos.tasks.update(task.id, { state: "queued", blockedReason: null });
      return { kind: "paused" };
    }
    await this.setState(env, task, { state: "blocked", blockedReason: reason });
    await env.comm.say({
      user: env.user,
      project: env.project,
      speaker: { kind: "moderator" },
      listener: { kind: "user" },
      situation: "error",
      body: `'${task.title}' 작업이 막혔어요.\n사유: ${reason}`,
      buttons: [[{ text: "🔁 재시도", data: `t:retry:${task.id}` }, { text: "🛑 취소", data: `t:cancel:${task.id}` }]],
      machineState: { kind: "task.blocked", taskId: task.id, status: "blocked", data: { reason } },
    });
    return { kind: "blocked", reason };
  }

  protected async execFailure(env: WorkflowEnv, task: Task, step: string, error: string): Promise<TaskOutcome> {
    if (env.ctx.lifecycle.shuttingDown) return this.block(env, task, error);
    await env.ctx.memory.remember(env.project.id, "lesson", `'${task.title}' ${step} 실패: ${error.slice(0, 300)}`, { sourceRefs: [task.id] });
    return this.block(env, task, `${step} 실행 실패: ${error.slice(0, 600)}`);
  }

  async onApprovalDecided(env: WorkflowEnv, task: Task, approval: Approval): Promise<TaskOutcome | null> {
    const approved = approval.status === "approved";
    switch (approval.action) {
      case "plan_scope":
      case "architecture_change":
      case "scope_expansion":
        if (!approved) return this.cancelWithNote(env, task, `${ACTION_POLICIES[approval.action].labelKo}이(가) 승인되지 않아 작업을 중단했어요. 수정 지시를 주시면 다시 기획할게요.`);
        await env.ctx.repos.decisions.create({ projectId: env.project.id, taskId: task.id, title: `${ACTION_POLICIES[approval.action].labelKo} 승인: ${task.title}`, rationale: String((task.checkpoint.plan as any)?.summary ?? task.description), alternatives: [], approvalRef: approval.id, sourceRefs: [task.id] });
        {
          const children = (task.checkpoint.childTaskIds as string[] | undefined) ?? [];
          if (children.length) {
            for (const id of children) await env.ctx.repos.tasks.update(id, { state: "queued", blockedReason: null });
            await env.ctx.repos.tasks.update(task.id, { state: "done", stage: "complete", completedAt: nowIso(), checkpoint: { internal: true, kind: "split" } });
            return { kind: "spawned", taskIds: children };
          }
        }
        await env.ctx.repos.tasks.update(task.id, { state: "queued", stage: "implementation" });
        return { kind: "requeue" };
      case "paid_api_usage":
        if (!approved) return this.block(env, task, "유료 API 사용이 승인되지 않았습니다. 구독 실행기 복구 후 재시도해 주세요.");
        await env.ctx.repos.tasks.update(task.id, { state: "queued" });
        return { kind: "requeue" };
      case "budget_exceed": {
        if (!approved) return this.block(env, task, "예산 초과 진행이 승인되지 않았습니다.");
        const kind = (approval.scope as any).kind;
        const t = await env.ctx.repos.tasks.get(task.id);
        await env.ctx.repos.tasks.update(task.id, {
          state: "queued",
          budget: kind === "retries" ? { ...t.budget, maxRetries: t.budget.maxRetries + 2 } : t.budget,
          checkpoint: { ...(kind === "time" ? { timeBudgetExtended: true } : {}) },
        });
        return { kind: "requeue" };
      }
      case "feature_complete": {
        if (!approved) return this.block(env, task, "사용자 최종 확인에서 수정이 요청되었습니다. 수정 내용을 프로젝트 Topic에 알려 주세요.");
        const t = await env.ctx.repos.tasks.get(task.id);
        const prNumber = t.checkpoint.prNumber as number | undefined;
        if (env.project.repoRef && prNumber != null) {
          const mode = await this.approvalMode(env, env.project);
          if (env.ctx.approvals.needsApproval("pr_merge", mode)) return this.requestApproval(env, t, "pr_merge", `PR #${prNumber} 병합을 승인해 주세요.\n${t.prRef}`, { pr: prNumber });
          return this.merge(env, t, prNumber);
        }
        await this.complete(env, t, "사용자 확인 완료");
        return { kind: "done" };
      }
      case "pr_merge": {
        const t = await env.ctx.repos.tasks.get(task.id);
        if (!approved) return this.block(env, t, "PR 병합이 승인되지 않았습니다. PR은 열린 상태로 유지됩니다.");
        const prNumber = (approval.scope as any).pr ?? t.checkpoint.prNumber;
        return this.merge(env, t, Number(prNumber));
      }
      default:
        return null;
    }
  }

  async onFeedback(env: WorkflowEnv, initial: Task, approval: Approval, feedback: string): Promise<TaskOutcome> {
    const { ctx } = env;
    const task = await ctx.repos.tasks.get(initial.id);
    const fb = `사용자 수정 요청: ${feedback}`;
    switch (approval.action) {
      case "plan_scope":
      case "architecture_change":
      case "scope_expansion": {
        // Replan from requirements with the feedback as the newest explicit instruction.
        for (const id of (task.checkpoint.childTaskIds as string[] | undefined) ?? []) await ctx.repos.tasks.update(id, { state: "cancelled", blockedReason: "상위 작업 재기획" });
        await ctx.repos.tasks.update(task.id, { state: "queued", stage: "requirements", blockedReason: null, description: `${task.description}\n\n[사용자 수정 의견] ${feedback}`, checkpoint: { lastFeedback: fb, childTaskIds: [] } });
        return { kind: "requeue" };
      }
      case "pr_merge":
      case "feature_complete": {
        const revision = Number(task.checkpoint.userRevision ?? 0) + 1;
        await ctx.repos.tasks.update(task.id, {
          state: "queued",
          stage: "fix",
          blockedReason: null,
          budget: { ...task.budget, maxRetries: Math.max(task.budget.maxRetries, task.attempts) + 1 },
          checkpoint: { lastFeedback: fb, userRevision: revision },
        });
        return { kind: "requeue" };
      }
      default:
        return { kind: "blocked", reason: "이 승인 유형은 수정 의견으로 재진행할 수 없습니다." };
    }
  }

  protected async cancelWithNote(env: WorkflowEnv, task: Task, note: string): Promise<TaskOutcome> {
    await this.setState(env, task, { state: "cancelled", blockedReason: note });
    await env.comm.say({ user: env.user, project: env.project, speaker: { kind: "moderator" }, listener: { kind: "user" }, situation: "report", body: note, machineState: { kind: "task.cancelled", taskId: task.id, status: "cancelled" } });
    return { kind: "cancelled" };
  }
}

export { approvalButtons } from "../../core/approvals/card.js";

/** Words of a review's blocking issues, to notice the same objection coming back. */
function reviewSignature(issues: Array<{ severity: string; description: string }>, summary: string): string {
  const text = issues.filter((i) => i.severity !== "minor").map((i) => i.description).join(" ") || summary;
  return [...new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2))].sort().join(" ");
}

function similarity(a: string, b: string): number {
  const x = new Set(a.split(" ").filter(Boolean));
  const y = new Set(b.split(" ").filter(Boolean));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}

/** Work the team cannot do from code: deployment, real service URLs, accounts, devices. */
export const EXTERNAL_WORK = /(배포|deploy|vercel|netlify|cloudflare\s*pages|production\s*url|프로덕션\s*(url|주소)|실제\s*(서비스\s*)?(url|주소)|미리보기\s*(url|주소)|도메인|domain|api\s*키|api\s*key|계정\s*(생성|설정|연결)|결제|실기기|실제\s*기기|앱\s*스토어|app\s*store)/i;

/** Pending "the agent asked the user something" per user (one at a time). */
export const TASK_INPUT_KEY = "task.input.pending";

/** Short how-to for the common cases, so the user knows exactly what to do. */
function howToFor(text: string, repoRef: string | null): string {
  if (/(vercel|배포|deploy|production|프로덕션|미리보기)/i.test(text))
    return `방법(Vercel): vercel.com 로그인 → Add New → Project → GitHub 저장소${repoRef ? ` ${repoRef}` : ""} Import → Deploy. 끝나면 나오는 https://…vercel.app 주소를 보내 주세요. 한 번 연결해 두면 이후 병합될 때마다 자동으로 배포돼요.`;
  if (/(api\s*키|api\s*key)/i.test(text)) return "키 값은 채팅에 올리지 말고 서버의 .env에 넣어 주세요. 넣은 뒤 변수 이름만 알려 주시면 돼요.";
  return "";
}

const START_LINES: Record<string, string> = {
  careful: "'{t}' 제가 맡을게요. 꼼꼼히 볼게요.",
  bold: "'{t}' 바로 들어갑니다!",
  friendly: "'{t}' 제가 해 볼게요 😊",
  analytical: "'{t}' 맡았어요. 구조부터 잡고 시작할게요.",
  mentor: "'{t}' 제가 할게요. 끝나면 어떻게 했는지 알려 드릴게요.",
  pragmatic: "'{t}' 할게요. 금방 끝낼게요.",
};

/** One short line when work starts, in the implementer's personality. */
export function startLine(title: string, preset?: string | null): string {
  const t = title.length > 30 ? `${title.slice(0, 29)}…` : title;
  return (START_LINES[preset ?? ""] ?? "'{t}' 시작할게요.").replace("{t}", t);
}

/** One or two lines when work is done: what was done, and a question about what is left. */
export function doneLine(card: { feature: string; prUrl: string | null; openIssues: string[] }): string {
  const what = card.feature.split("\n")[0]!.replace(/[.。]+$/, "").slice(0, 90);
  const lines = [`다 했어요! ${what}.${card.prUrl ? ` PR 올렸어요 → ${card.prUrl}` : ""}`];
  if (card.openIssues.length) lines.push(`근데 ${card.openIssues[0]!.slice(0, 120)} — 이건 어떻게 할까요?`);
  return lines.join("\n");
}
