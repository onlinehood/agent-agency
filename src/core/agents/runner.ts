import type { AppContext } from "../context.js";
import type { Agent, Project, Task } from "../types.js";
import type { ExecMode, ExecResult, ExecutorAdapter, RunningHandle } from "../../executors/types.js";
import type { Sandbox } from "../../workspace/sandbox.js";
import { nowIso } from "../../util/ids.js";
import { maskKnown } from "../../security/masking.js";
import { executorCandidates, resolveExecutionPolicy, type Candidate } from "../execution/policy.js";

export interface AgentRunInput {
  agent: Agent;
  task: Task;
  purpose: "plan" | "implement" | "review" | "fix" | "discuss" | "classify" | "analyze" | "test" | "summarize" | "verify";
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  mode: ExecMode;
  sandbox?: Sandbox;
  timeoutMs?: number;
  resumeSessionRef?: string | null;
  /** Project for policy overrides / cloud branch */
  project?: Project | null;
  /** Restrict to these executor kinds (e.g. readonly discussions never need cloud write) */
  kinds?: Array<"cloud" | "local_cli" | "paid_api">;
  /** Allow the executor's web tools (research). Fetched content stays untrusted data. */
  allowWeb?: boolean;
  /** Untrusted attachment files, passed only to executors with verified image input. */
  attachments?: string[];
}

export interface AgentRunOutput extends ExecResult {
  executionId: string;
  agent: Agent;
  adapterId: string;
  attempts: Array<{ adapterId: string; status: string; reason: string | null }>;
  handedOffFrom?: Agent;
  /** set when nothing ran because an approval (paid API) is required */
  needsApproval?: "paid_api_usage";
}

const FALLBACK_WORTHY = (r: ExecResult) => r.quotaExhausted || r.authExpired || /사용 불가|미등록|환경 ID|작업 ID|미확인/.test(r.error ?? "");

/**
 * Executes agent work through the executor adapter layer following the execution policy:
 * official subscription Cloud → isolated Local CLI (PRD §15). Before falling back, any
 * previously started external job is checked so the same work is never run twice. Paid APIs
 * are never chosen automatically and need an explicit approval per task.
 */
/** Minimal FIFO counting semaphore. */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
  get inUse(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }
}

export class AgentRunner {
  private running = new Map<string, Set<RunningHandle>>();
  /** Per-executor concurrency: subscription CLIs are rate limited per account (Phase 3). */
  private slots = new Map<string, Semaphore>();

  constructor(private ctx: AppContext) {}

  private slot(adapterId: string): Semaphore {
    let s = this.slots.get(adapterId);
    if (!s) {
      s = new Semaphore(this.ctx.config.AA_MAX_RUNS_PER_EXECUTOR);
      this.slots.set(adapterId, s);
    }
    return s;
  }

  /** Live executor load for monitoring. */
  executorLoad(): Record<string, { running: number; waiting: number }> {
    return Object.fromEntries([...this.slots].map(([id, s]) => [id, { running: s.inUse, waiting: s.queued }]));
  }

  isRunning(taskId: string): boolean {
    return (this.running.get(taskId)?.size ?? 0) > 0;
  }

  private failure(input: AgentRunInput, executionId: string, adapterId: string, error: string, attempts: AgentRunOutput["attempts"], extra: Partial<AgentRunOutput> = {}): AgentRunOutput {
    return { status: "failed", text: "", sessionRef: null, model: null, usage: {}, usageSource: "none", quotaExhausted: false, authExpired: false, error, durationMs: 0, executionId, agent: input.agent, adapterId, attempts, ...extra };
  }

  /** Has a previous external job for this task still running? (duplicate-run guard) */
  async externalJobStillRunning(taskId: string): Promise<{ running: boolean; detail: string }> {
    const execs = await this.ctx.repos.executions.listByTask(taskId);
    for (const e of execs.filter((x) => x.externalRef && (x.status === "running" || x.status === "cancelled" || x.status === "timeout"))) {
      const adapter = this.ctx.executors.get(e.adapterId);
      if (!adapter?.externalStatus) return { running: true, detail: `${e.adapterId} 작업(${e.externalRef})의 종료 여부를 확인할 수 없어 중복 실행을 막기 위해 대기합니다.` };
      const st = await adapter.externalStatus(e.externalRef!);
      if (st === "running" || st === "unknown") return { running: true, detail: `${adapter.displayName} 작업(${e.externalRef})이 아직 ${st === "running" ? "실행 중" : "상태 미확인"}입니다. 중복 실행을 막기 위해 전환을 보류합니다.` };
    }
    return { running: false, detail: "" };
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const project = input.project ?? (await this.ctx.repos.projects.find(input.task.projectId)) ?? null;
    const policy = await resolveExecutionPolicy(this.ctx.repos, { userId: input.agent.ownerId, projectId: project?.id, agentId: input.agent.id });
    let candidates: Candidate[] = executorCandidates(this.ctx.executors, input.agent, policy);
    if (input.kinds) candidates = candidates.filter((c) => input.kinds!.includes(c.adapter.kind));
    // Cloud executors work on GitHub branches, so they need a repo-backed project.
    if (!project?.repoRef) candidates = candidates.filter((c) => c.adapter.kind !== "cloud");
    const attempts: AgentRunOutput["attempts"] = [];
    let last: AgentRunOutput | null = null;

    for (const c of candidates) {
      if (!c.usable) {
        attempts.push({ adapterId: c.adapter.id, status: "skipped", reason: c.reason });
        continue;
      }
      if (c.requiresApproval) {
        const approved = await this.ctx.approvals.isApproved("paid_api_usage", { taskId: input.task.id, projectId: input.task.projectId });
        if (!approved) {
          attempts.push({ adapterId: c.adapter.id, status: "needs_approval", reason: "종량제 유료 API는 명시적 승인 후에만 사용" });
          const exec = await this.ctx.repos.executions.create({ taskId: input.task.id, agentId: input.agent.id, adapterId: c.adapter.id, executorKind: c.adapter.kind, purpose: input.purpose });
          await this.ctx.repos.executions.finish(exec.id, { status: "failed", error: "paid API requires explicit approval" });
          return this.failure(input, exec.id, c.adapter.id, "종량제 유료 API 사용에는 명시적 승인이 필요합니다.", attempts, { needsApproval: "paid_api_usage" });
        }
      }
      if (last) {
        // Falling back: make sure the previous external job is finished first.
        const guard = await this.externalJobStillRunning(input.task.id);
        if (guard.running) {
          attempts.push({ adapterId: c.adapter.id, status: "deferred", reason: guard.detail });
          await this.ctx.repos.audit.record("system", "executor.deferred", `task:${input.task.id}`, "info", { to: c.adapter.id });
          return { ...last, attempts, error: guard.detail };
        }
      }
      const out = await this.runOn(c.adapter, input, project);
      attempts.push({ adapterId: c.adapter.id, status: out.status, reason: out.error });
      out.attempts = attempts;
      if (out.status === "succeeded" || out.status === "cancelled") return out;
      last = out;
      if (!policy.autoFallback || !FALLBACK_WORTHY(out)) return out;
      this.ctx.events.emit("alert", { level: "warn", message: `${c.adapter.displayName} 실행 실패(${out.quotaExhausted ? "사용량 한도" : out.authExpired ? "인증 만료" : "실행 불가"}) → 다음 실행기로 전환합니다.`, projectId: input.task.projectId });
      await this.ctx.repos.audit.record("system", "executor.fallback", `task:${input.task.id}`, "info", { from: c.adapter.id, reason: out.quotaExhausted ? "quota" : out.authExpired ? "auth" : "unavailable" });
    }
    if (last) return { ...last, attempts };
    const exec = await this.ctx.repos.executions.create({ taskId: input.task.id, agentId: input.agent.id, adapterId: input.agent.adapterId, purpose: input.purpose });
    const reason = `사용 가능한 공식 구독 실행기가 없습니다: ${attempts.map((a) => `${a.adapterId}(${a.reason})`).join(", ") || "후보 없음"}`;
    await this.ctx.repos.executions.finish(exec.id, { status: "failed", error: reason });
    return this.failure(input, exec.id, input.agent.adapterId, reason, attempts);
  }

  private async runOn(adapter: ExecutorAdapter, input: AgentRunInput, project: Project | null): Promise<AgentRunOutput> {
    const release = await this.slot(adapter.id).acquire();
    try {
      return await this.runOnLocked(adapter, input, project);
    } finally {
      release();
    }
  }

  private async runOnLocked(adapter: ExecutorAdapter, input: AgentRunInput, project: Project | null): Promise<AgentRunOutput> {
    // A resumable conversation belongs to one agent on one executor. Asking to resume means
    // "continue this agent's own last session here" — never another agent's (e.g. the reviewer's
    // Codex thread handed to the implementer's Claude, which fails with "No conversation found").
    const sessionKey = `${input.agent.id}:${adapter.id}`;
    const sessions = ((await this.ctx.repos.tasks.get(input.task.id)).checkpoint.sessions as Record<string, string> | undefined) ?? {};
    const resumeRef = input.resumeSessionRef ? (sessions[sessionKey] ?? null) : null;
    input = { ...input, resumeSessionRef: resumeRef };
    const exec = await this.ctx.repos.executions.create({
      taskId: input.task.id,
      agentId: input.agent.id,
      adapterId: adapter.id,
      executorKind: adapter.kind,
      purpose: input.purpose,
      inputSummary: input.prompt.slice(0, 1000),
      sessionRef: input.resumeSessionRef ?? null,
    });
    const model = this.ctx.executors.resolveModel(adapter.id, input.agent.modelPolicy);
    await this.ctx.repos.executions.markRunning(exec.id, model);
    await this.ctx.repos.tasks.checkpoint(input.task.id, { lastExecutionId: exec.id, lastAdapterId: adapter.id });
    const policy = await resolveExecutionPolicy(this.ctx.repos, { userId: input.agent.ownerId, projectId: project?.id, agentId: input.agent.id });
    const handle = adapter.start({
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      cwd: input.cwd,
      mode: input.mode,
      model,
      resumeSessionRef: resumeRef,
      timeoutMs: input.timeoutMs,
      allowWeb: input.allowWeb,
      attachments: this.ctx.executors.getStatus(adapter.id)?.capabilities.imageInput === "supported" ? input.attachments : undefined,
      isolated: input.sandbox?.isolated ?? false,
      wrap: adapter.kind === "local_cli" && input.sandbox && input.sandbox.kind !== "local" ? (c, a, cwd) => input.sandbox!.wrap(c, a, cwd) : undefined,
      onExternalRef: async (ref) => {
        await this.ctx.repos.executions.setExternalRef(exec.id, ref);
      },
      cloud: { environmentId: policy.cloud.codexEnvironmentId, branch: input.task.branch ?? undefined },
    });
    const set = this.running.get(input.task.id) ?? new Set();
    set.add(handle);
    this.running.set(input.task.id, set);
    let result: ExecResult;
    try {
      result = await handle.result;
    } finally {
      set.delete(handle);
    }
    const secrets = await this.ctx.vault.allValuesForMasking(input.agent.ownerId);
    result.text = maskKnown(result.text, secrets);
    if (result.error) result.error = maskKnown(result.error, secrets);
    let logRef: string | null = null;
    try {
      const stored = await this.ctx.files.put("logs", `${exec.id}.log`, `# ${adapter.id} ${input.purpose}\n## status: ${result.status}\n## error\n${result.error ?? ""}\n## output\n${result.text}`);
      logRef = stored.ref;
    } catch {}
    const staleSession = !!resumeRef && result.status === "failed" && STALE_SESSION.test(`${result.error ?? ""} ${result.text}`);
    if (result.sessionRef || staleSession) {
      const cur = ((await this.ctx.repos.tasks.get(input.task.id)).checkpoint.sessions as Record<string, string> | undefined) ?? {};
      const next = { ...cur };
      if (staleSession) delete next[sessionKey];
      if (result.sessionRef && !staleSession) next[sessionKey] = result.sessionRef;
      await this.ctx.repos.tasks.checkpoint(input.task.id, { sessions: next, ...(result.sessionRef && !staleSession ? { lastSessionRef: result.sessionRef } : {}) });
    }
    await this.ctx.repos.executions.finish(exec.id, { status: result.status, outputSummary: result.text, sessionRef: result.sessionRef, usage: { ...result.usage, usage_source: result.usageSource }, error: result.error, model: result.model, logRef });
    for (const [k, v] of Object.entries(result.usage)) {
      if (typeof v === "number") this.ctx.usage.record({ adapterId: adapter.id, source: k.includes("estimate") || result.usageSource !== "official" ? "estimate" : "official", metric: k, value: v, observedAt: nowIso() });
    }
    if (result.quotaExhausted) {
      // The exact reset time is not officially exposed; pause new work on this executor for a while.
      this.ctx.usage.setQuota(adapter.id, "exhausted", "estimate", new Date(Date.now() + 30 * 60_000).toISOString());
      this.ctx.events.emit("alert", { level: "warn", message: `${adapter.displayName}: 구독 사용량 한도 도달 감지 (추정). 30분간 이 실행기 배정을 중단합니다.`, projectId: input.task.projectId });
    }
    if (result.authExpired) {
      await this.ctx.repos.services.upsert(input.agent.ownerId, adapter.id, { health: "failed", healthDetail: "인증 만료/실패 감지 — 공식 로그인 명령으로 갱신이 필요합니다." });
      const st = this.ctx.executors.getStatus(adapter.id);
      if (st) this.ctx.executors.setStatus({ ...st, authenticated: false, notes: [...st.notes, "인증 만료 감지"] });
      this.ctx.events.emit("alert", { level: "error", message: `${adapter.displayName}: 인증이 만료되었습니다. 서버에서 공식 로그인으로 갱신해 주세요.`, projectId: input.task.projectId });
    }
    this.ctx.events.emit("execution.updated", { execution: await this.ctx.repos.executions.get(exec.id) });
    // The saved conversation is gone (CLI data reset, other machine, expired): start fresh once.
    if (staleSession) return this.runOnLocked(adapter, { ...input, resumeSessionRef: null }, project);
    return { ...result, executionId: exec.id, agent: input.agent, adapterId: adapter.id, attempts: [] };
  }

  /** Run; if every executor of this agent's provider is unavailable, hand off once to another provider's agent. */
  async runWithHandoff(project: Project, input: AgentRunInput): Promise<AgentRunOutput> {
    const first = await this.run({ ...input, project });
    if (first.status === "succeeded" || first.status === "cancelled" || first.needsApproval) return first;
    if (!(first.quotaExhausted || first.authExpired || /사용 가능한 공식 구독 실행기가 없습니다/.test(first.error ?? ""))) return first;
    const guard = await this.externalJobStillRunning(input.task.id);
    if (guard.running) return { ...first, error: guard.detail };
    const alt = await this.ctx.team.alternativeFor(project, input.agent);
    if (!alt) return first;
    await this.ctx.memory.remember(project.id, "handoff", `${input.agent.name} → ${alt.name}: ${first.quotaExhausted ? "사용량 한도" : "인증/실행기 문제"}로 '${input.task.title}' ${input.purpose} 작업 인계`, { sourceRefs: [input.task.id, first.executionId] });
    const second = await this.run({ ...input, project, agent: alt, resumeSessionRef: null });
    return { ...second, handedOffFrom: input.agent };
  }

  /** Attempt real cancellation of running executions for a task and report honestly (PRD §5.1). */
  async cancelTask(taskId: string): Promise<{ attempted: number; cancelled: number; details: string[] }> {
    const set = this.running.get(taskId);
    if (!set || !set.size) return { attempted: 0, cancelled: 0, details: ["실행 중인 작업이 없습니다."] };
    const details: string[] = [];
    let cancelled = 0;
    const handles = [...set];
    for (const h of handles) {
      const r = await h.cancel();
      if (r.cancelled) cancelled++;
      details.push(r.detail);
    }
    return { attempted: handles.length, cancelled, details };
  }
}

/** CLI errors meaning the conversation to resume no longer exists. */
const STALE_SESSION = /(no conversation found|conversation not found|session not found|no session found|unknown session|could not find (?:the )?(?:session|thread|conversation)|thread not found|no such (?:session|thread))/i;
