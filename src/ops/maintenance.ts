import type { AppContext } from "../core/context.js";

/**
 * Periodic housekeeping (PRD §8.3, §17):
 * - detailed logs/screenshots: 30 days, temp files: 7 days (configurable via settings)
 * - evidence for in-progress / blocked / approval-pending tasks is exempt
 * - expire stale approvals
 */
export interface RetentionPolicy {
  logDays: number;
  tmpDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { logDays: 30, tmpDays: 7 };

export async function retentionPolicy(ctx: AppContext): Promise<RetentionPolicy> {
  return { ...DEFAULT_RETENTION, ...((await ctx.repos.settings.get<Partial<RetentionPolicy>>("system", "", "retention")) ?? {}) };
}

export async function runRetention(ctx: AppContext, now = new Date()): Promise<{ artifacts: number; files: number; tmp: number; memories: number }> {
  const pol = await retentionPolicy(ctx);
  const logCutoff = new Date(now.getTime() - pol.logDays * 86400_000);
  const tmpCutoff = new Date(now.getTime() - pol.tmpDays * 86400_000);
  const activeTaskIds = new Set((await ctx.repos.tasks.listByStates(["queued", "planning", "in_progress", "review", "blocked", "awaiting_approval", "pr_open"])).map((t) => t.id));
  let artifacts = 0;
  for (const cls of ["detailed_log", "temporary"] as const) {
    const cutoff = cls === "temporary" ? tmpCutoff : logCutoff;
    for (const a of await ctx.repos.artifacts.listExpired(cls, cutoff.toISOString())) {
      if (activeTaskIds.has(a.taskId)) continue; // evidence exemption
      if (a.storageRef) await ctx.files.delete(a.storageRef).catch(() => undefined);
      await ctx.repos.artifacts.delete(a.id);
      artifacts++;
    }
  }
  const files = (await ctx.files.purgeOlderThan("logs", logCutoff)) + (await ctx.files.purgeOlderThan("screenshots", logCutoff));
  const tmp = (await ctx.files.purgeOlderThan("tmp", tmpCutoff)) + (await ctx.files.purgeOlderThan("attachments", logCutoff));
  const memories = await ctx.repos.memories.deleteOlderThan("detailed_log", logCutoff.toISOString());
  await ctx.repos.audit.record("system", "retention.run", "storage", "info", { artifacts, files, tmp, memories, policy: pol });
  return { artifacts, files, tmp, memories };
}

export function startMaintenance(ctx: AppContext, opts: { intervalMs?: number; everyMinute?: Array<() => Promise<unknown>> } = {}): () => void {
  const timers: NodeJS.Timeout[] = [];
  const safe = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((e) => ctx.logger.warn({ err: (e as Error).message }, `${name} failed`));
  };
  timers.push(setInterval(safe("approval expiry", () => ctx.approvals.expireStale()), 60_000));
  for (const [i, fn] of (opts.everyMinute ?? []).entries()) timers.push(setInterval(safe(`minute hook ${i}`, fn), 60_000));
  timers.push(setInterval(safe("retention", () => runRetention(ctx)), opts.intervalMs ?? 6 * 3600_000));
  timers.push(setInterval(safe("executor health", () => ctx.executors.detectAll()), 30 * 60_000));
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}
