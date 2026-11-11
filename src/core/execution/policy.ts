import type { Repos } from "../../db/repositories.js";
import type { ExecutorRegistry } from "../../executors/registry.js";
import type { ExecutorAdapter, ExecutorKind } from "../../executors/types.js";
import type { Agent } from "../types.js";

/**
 * Execution policy (PRD §15): official subscription Cloud → isolated Local CLI fallback.
 * Stored per user with optional project- and agent-level overrides (settings table, key
 * "execution.policy"). Paid metered APIs are disabled by default, never chosen automatically,
 * and even when enabled every use needs an explicit approval.
 */
export interface ExecutionPolicy {
  priority: ExecutorKind[];
  autoFallback: boolean;
  paidApi: { enabled: boolean; requireExplicitApproval: true };
  overrides: { perProject: boolean; perAgent: boolean };
  cloud: { codexEnvironmentId?: string };
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  priority: ["cloud", "local_cli"],
  autoFallback: true,
  paidApi: { enabled: false, requireExplicitApproval: true },
  overrides: { perProject: true, perAgent: true },
  cloud: {},
};

export const POLICY_KEY = "execution.policy";

type PolicyPatch = Partial<Omit<ExecutionPolicy, "paidApi" | "overrides" | "cloud">> & {
  paidApi?: Partial<ExecutionPolicy["paidApi"]> & { requireExplicitApproval?: boolean };
  overrides?: Partial<ExecutionPolicy["overrides"]>;
  cloud?: Partial<ExecutionPolicy["cloud"]>;
};

function merge(base: ExecutionPolicy, patch: PolicyPatch | undefined): ExecutionPolicy {
  if (!patch) return base;
  const priority = Array.isArray(patch.priority) ? patch.priority.filter((k): k is ExecutorKind => k === "cloud" || k === "local_cli" || k === "paid_api") : base.priority;
  return {
    priority: priority.length ? [...new Set(priority)] : base.priority,
    autoFallback: typeof patch.autoFallback === "boolean" ? patch.autoFallback : base.autoFallback,
    // requireExplicitApproval cannot be turned off.
    paidApi: { enabled: typeof patch.paidApi?.enabled === "boolean" ? patch.paidApi.enabled : base.paidApi.enabled, requireExplicitApproval: true },
    overrides: { ...base.overrides, ...(patch.overrides ?? {}) },
    cloud: { ...base.cloud, ...(patch.cloud ?? {}) },
  };
}

export async function resolveExecutionPolicy(repos: Repos, ref: { userId: string; projectId?: string | null; agentId?: string | null }): Promise<ExecutionPolicy> {
  let p = merge(DEFAULT_EXECUTION_POLICY, await repos.settings.get<PolicyPatch>("system", "", POLICY_KEY));
  p = merge(p, await repos.settings.get<PolicyPatch>("user", ref.userId, POLICY_KEY));
  if (ref.projectId && p.overrides.perProject) p = merge(p, await repos.settings.get<PolicyPatch>("project", ref.projectId, POLICY_KEY));
  if (ref.agentId && p.overrides.perAgent) p = merge(p, await repos.settings.get<PolicyPatch>("agent", ref.agentId, POLICY_KEY));
  // paid_api is only ever considered when explicitly enabled.
  if (!p.paidApi.enabled) p = { ...p, priority: p.priority.filter((k) => k !== "paid_api") };
  return p;
}

export async function setExecutionPolicy(repos: Repos, scope: "system" | "user" | "project" | "agent", scopeId: string, patch: PolicyPatch): Promise<void> {
  const cur = (await repos.settings.get<PolicyPatch>(scope, scopeId, POLICY_KEY)) ?? {};
  await repos.settings.set(scope, scopeId, POLICY_KEY, { ...cur, ...patch, paidApi: { ...(cur.paidApi ?? {}), ...(patch.paidApi ?? {}) }, cloud: { ...(cur.cloud ?? {}), ...(patch.cloud ?? {}) } });
}

export interface Candidate {
  adapter: ExecutorAdapter;
  usable: boolean;
  reason: string;
  /** paid_api candidates are only runnable after an explicit approval */
  requiresApproval: boolean;
}

/**
 * Ordered executor candidates for an agent: adapters of the agent's provider sorted by the
 * policy's kind priority; the agent's pinned adapter goes first within its kind.
 */
export function executorCandidates(registry: ExecutorRegistry, agent: Agent, policy: ExecutionPolicy): Candidate[] {
  const pinned = registry.get(agent.adapterId);
  const pool = registry.byProvider(pinned?.provider ?? agent.provider);
  if (pinned && !pool.includes(pinned)) pool.push(pinned);
  const order = (a: ExecutorAdapter) => {
    const k = policy.priority.indexOf(a.kind);
    return (k < 0 ? 99 : k) * 10 + (a.id === agent.adapterId ? 0 : 1);
  };
  return pool
    .filter((a) => policy.priority.includes(a.kind))
    .sort((a, b) => order(a) - order(b))
    .map((adapter) => {
      const allowPaid = adapter.kind === "paid_api" && policy.paidApi.enabled;
      const u = registry.usabilityReason(adapter.id, { allowPaid });
      return { adapter, usable: u.usable, reason: u.reason, requiresApproval: adapter.kind === "paid_api" };
    });
}

export function describePolicy(p: ExecutionPolicy): string {
  const names: Record<ExecutorKind, string> = { cloud: "공식 구독 Cloud", local_cli: "격리된 Local CLI", paid_api: "종량제 유료 API" };
  return [
    `실행 우선순위: ${p.priority.map((k) => names[k]).join(" → ")}`,
    `자동 전환: ${p.autoFallback ? "켜짐" : "꺼짐"}`,
    `종량제 유료 API: ${p.paidApi.enabled ? "허용(매 사용 시 명시적 승인 필요)" : "비활성"}`,
  ].join("\n");
}
