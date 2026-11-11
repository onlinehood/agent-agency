import type { AppContext } from "../context.js";
import type { Orchestrator, TaskScheduler } from "../orchestration/orchestrator.js";
import type { Project, Task } from "../types.js";
import { decide, snapshot, type ResourceDecision, type ResourceSnapshot } from "../../ops/resources.js";
import { newId } from "../../util/ids.js";

/**
 * Execution Scheduler (PRD §6, §8.2; §16).
 * - Durable PostgreSQL job queue (jobs table, SKIP LOCKED).
 * - At most one running task per project (avoids git/branch conflicts) and a global project
 *   concurrency limit (default 2) further reduced by real host resources.
 * - Priority under scarcity: incident → high-priority project → normal → maintenance.
 * - Restart recovery: stale running jobs are re-queued, interrupted local executions are marked,
 *   tasks in active states are resumed from their checkpoint.
 * - Safe stop (Phase 3): shutdown waits a bounded grace period, then really cancels the runs it
 *   can't wait for and puts those tasks back to "queued" so the next start resumes them.
 * - Maintenance mode: running work finishes, nothing new is claimed (safe point for updates).
 */
export interface SchedulerOptions {
  pollMs?: number;
  maxConcurrentProjects?: number;
  resourceProbe?: () => ResourceSnapshot;
}

export class Scheduler implements TaskScheduler {
  readonly workerId = newId("wrk");
  private timer: NodeJS.Timeout | null = null;
  private runningProjects = new Map<string, Promise<void>>();
  /** projectId → taskId (null for project-level jobs such as baselines) */
  private runningTasks = new Map<string, string | null>();
  private maintenance = false;
  private lastDecision: ResourceDecision | null = null;
  private alerted = false;
  private ticking = false;

  constructor(
    private ctx: AppContext,
    private orch: Orchestrator,
    private opts: SchedulerOptions = {},
  ) {
    orch.setScheduler(this);
  }

  async enqueueTask(task: Task, project: Project, o: { incident?: boolean; maintenance?: boolean } = {}): Promise<void> {
    await this.ctx.repos.jobs.enqueue("task.run", { taskId: task.id, projectId: project.id }, { dedupeKey: `task:${task.id}`, priority: this.orch.workPriority(task, project, o), maxAttempts: 3 });
    this.kick();
  }

  async enqueueBaseline(project: Project): Promise<void> {
    await this.ctx.repos.jobs.enqueue("project.baseline", { projectId: project.id }, { dedupeKey: `baseline:${project.id}`, priority: 150, maxAttempts: 2 });
    this.kick();
  }

  setMaintenance(on: boolean): void {
    this.maintenance = on;
    if (!on) this.kick();
  }

  get inMaintenance(): boolean {
    return this.maintenance;
  }

  /** Wait until nothing is running (used to reach a safe update point). */
  async waitIdle(timeoutMs: number, pollMs = 1000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.runningProjects.size > 0) {
      if (Date.now() > deadline) return false;
      await Promise.race([...this.runningProjects.values(), new Promise((r) => setTimeout(r, pollMs))]);
    }
    return true;
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.ctx.repos.jobs.cancelByDedupe(`task:${taskId}`);
  }

  resources(): ResourceDecision {
    const snap = (this.opts.resourceProbe ?? (() => snapshot(this.ctx.config.dataDir)))();
    return decide(snap, this.opts.maxConcurrentProjects ?? this.ctx.config.AA_MAX_CONCURRENT_PROJECTS);
  }

  get running(): number {
    return this.runningProjects.size;
  }

  lastResourceDecision(): ResourceDecision | null {
    return this.lastDecision;
  }

  async recover(): Promise<{ requeuedJobs: number; interrupted: number; resumed: number }> {
    const requeuedJobs = await this.ctx.repos.jobs.requeueStale(0);
    let interrupted = 0;
    for (const e of await this.ctx.repos.executions.listByStatus(["running", "pending"])) {
      // Local processes died with the old server. Cloud jobs keep their external ref so the
      // duplicate-run guard can check them before any fallback.
      if (!e.externalRef) {
        await this.ctx.repos.executions.finish(e.id, { status: "failed", error: "서버 재시작으로 중단됨 (체크포인트에서 재개)" });
        interrupted++;
      }
    }
    let resumed = 0;
    for (const t of await this.ctx.repos.tasks.listByStates(["queued", "planning", "in_progress", "review"])) {
      if (t.checkpoint.internal) continue;
      const p = await this.ctx.repos.projects.find(t.projectId);
      if (!p || p.status !== "active") continue;
      await this.enqueueTask(t, p);
      resumed++;
    }
    await this.ctx.repos.audit.record("system", "scheduler.recover", "scheduler", "info", { requeuedJobs, interrupted, resumed });
    return { requeuedJobs, interrupted, resumed };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.opts.pollMs ?? 2000);
    this.kick();
  }

  async stop(): Promise<void> {
    await this.shutdown(this.ctx.config.AA_SHUTDOWN_GRACE_MS);
  }

  /**
   * Graceful stop: stop claiming, give running work `graceMs` to finish, then attempt a real
   * cancellation of what is still running and re-queue those tasks for the next start.
   */
  async shutdown(graceMs: number): Promise<{ interrupted: string[] }> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ctx.lifecycle.shuttingDown = true;
    // Clear the grace timer once work settles: a pending timer would keep short CLI commands alive.
    let graceTimer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      Promise.allSettled([...this.runningProjects.values()]).then(() => true),
      new Promise<boolean>((r) => {
        graceTimer = setTimeout(() => r(false), Math.max(0, graceMs));
      }),
    ]);
    clearTimeout(graceTimer);
    const interrupted: string[] = [];
    if (!finished) {
      for (const taskId of this.runningTasks.values()) {
        if (!taskId) continue;
        interrupted.push(taskId);
        await this.orch.runner.cancelTask(taskId).catch(() => undefined);
      }
      let cancelTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.runningProjects.values()]),
        new Promise((r) => {
          cancelTimer = setTimeout(r, 5000);
        }),
      ]);
      clearTimeout(cancelTimer);
      for (const taskId of interrupted) {
        const t = await this.ctx.repos.tasks.find(taskId);
        if (t && !["done", "cancelled", "awaiting_approval", "pr_open"].includes(t.state)) await this.ctx.repos.tasks.update(taskId, { state: "queued", blockedReason: null });
      }
    }
    await this.ctx.repos.audit.record("system", "scheduler.shutdown", "scheduler", "info", { graceMs, interrupted });
    return { interrupted };
  }

  kick(): void {
    if (!this.timer) return; // not started (CLI tools/tests drive tick() explicitly)
    void this.tick().catch((e) => this.ctx.logger.error({ err: (e as Error).message }, "scheduler tick failed"));
  }

  async tick(): Promise<number> {
    if (this.ticking || this.maintenance || this.ctx.lifecycle.shuttingDown) return 0;
    this.ticking = true;
    try {
      const d = this.resources();
      this.lastDecision = d;
      if (!d.acceptNewWork) {
        if (!this.alerted) this.ctx.events.emit("alert", { level: "warn", message: `서버 자원 부족으로 신규 작업을 연기합니다: ${d.reasons.join(", ")}` });
        this.alerted = true;
        return 0;
      }
      this.alerted = false;
      let started = 0;
      while (this.runningProjects.size < d.allowedConcurrency) {
        const [job] = await this.ctx.repos.jobs.claim(this.workerId, 1, ["task.run", "project.baseline"]);
        if (!job) break;
        const projectId = String(job.payload.projectId ?? "");
        if (this.runningProjects.has(projectId)) {
          await this.ctx.repos.jobs.reschedule(job.id, new Date(Date.now() + 1500));
          // Avoid spinning on the same job: stop claiming this tick.
          break;
        }
        const isBaseline = job.kind === "project.baseline";
        const p = (isBaseline ? this.runBaselineJob(job.id, projectId) : this.runJob(job.id, String(job.payload.taskId), projectId)).finally(() => {
          this.runningProjects.delete(projectId);
          this.runningTasks.delete(projectId);
          this.kick();
        });
        this.runningProjects.set(projectId, p);
        this.runningTasks.set(projectId, isBaseline ? null : String(job.payload.taskId));
        started++;
      }
      return started;
    } finally {
      this.ticking = false;
    }
  }

  private async runJob(jobId: string, taskId: string, _projectId: string): Promise<void> {
    try {
      const outcome = await this.orch.runTask(taskId);
      await this.ctx.repos.jobs.complete(jobId);
      if (outcome.kind === "requeue") {
        const t = await this.ctx.repos.tasks.get(taskId);
        await this.enqueueTask(t, await this.ctx.repos.projects.get(t.projectId));
      }
      if (outcome.kind === "spawned") {
        for (const id of outcome.taskIds) {
          const t = await this.ctx.repos.tasks.get(id);
          await this.enqueueTask(t, await this.ctx.repos.projects.get(t.projectId));
        }
      }
    } catch (e) {
      this.ctx.logger.error({ err: (e as Error).message, taskId }, "task job failed");
      await this.ctx.repos.jobs.fail(jobId, (e as Error).message, 30_000);
      const t = await this.ctx.repos.tasks.find(taskId);
      if (t && !["done", "cancelled"].includes(t.state)) await this.ctx.repos.tasks.update(taskId, { state: "blocked", blockedReason: `내부 오류: ${(e as Error).message.slice(0, 300)}` });
    }
  }

  private async runBaselineJob(jobId: string, projectId: string): Promise<void> {
    try {
      await this.orch.runBaseline(projectId);
      await this.ctx.repos.jobs.complete(jobId);
    } catch (e) {
      this.ctx.logger.warn({ err: (e as Error).message, projectId }, "baseline job failed");
      await this.ctx.repos.jobs.fail(jobId, (e as Error).message, 60_000);
    }
  }

  /** Test helper: wait until no job is running and the queue has no ready job. */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.tick();
      if (this.runningProjects.size === 0) {
        // Wait for delayed jobs too (e.g. rescheduled while the project was busy), within the timeout.
        const queued = (await this.ctx.repos.jobs.list("queued")).filter((j) => new Date(j.runAt).getTime() <= deadline);
        if (!queued.length) return;
      }
      await Promise.race([...this.runningProjects.values(), new Promise((r) => setTimeout(r, 50))]);
    }
    throw new Error("scheduler drain timeout");
  }
}
