import type { AppContext } from "../core/context.js";

/** Executors that only become schedulable when their feature flag is on (PRD §10.2, Phase 4). */
export const EXECUTOR_FLAGS: Record<string, string> = {
  "gemini-cli": "executors.gemini",
  "cursor-cli": "executors.cursor",
  "codex-cloud": "executors.cloud",
  "claude-cloud": "executors.cloud",
};

export async function syncExecutorFlags(ctx: Pick<AppContext, "executors" | "flags">): Promise<void> {
  const disabled = new Map<string, string>();
  for (const a of ctx.executors.list()) {
    const flag = EXECUTOR_FLAGS[a.id];
    if (flag && !(await ctx.flags.isEnabled(flag))) disabled.set(a.id, `기능 플래그 ${flag} 꺼짐`);
  }
  ctx.executors.setDisabled(disabled);
}
