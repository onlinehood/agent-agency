import type { Database } from "../../db/index.js";
import { newId } from "../../util/ids.js";

/**
 * Feature flags (PRD §10). Defaults are conservative: anything experimental or
 * unverified starts disabled. Owner-scoped values override global ones.
 */
export const FLAG_DEFAULTS = {
  /** B 선택형 실험: 모드별 협업 스타일 변화 */
  "dialogue.style_variant_b": false,
  /**
   * LLM-polished moderator speech (fact-preserving, cached). Off by default: every polished
   * message costs a subscription call and adds latency (PRD §13 renderer cost/latency).
   */
  "dialogue.llm_renderer": false,
  /** Relationship affinity changes over time */
  "relationships.evolve": true,
  /** Additional executors (Gemini/Cursor) */
  "executors.gemini": false,
  "executors.cursor": false,
  /** Preview deployment step */
  "coding.preview_deploy": false,
  /** Playwright browser verification in quality gate */
  "quality.playwright": true,
  /** Security scan (npm audit / pip-audit) in quality gate */
  "quality.security_scan": true,
  /** Fully automatic mode within allowed scope */
  "approvals.auto_within_scope": false,
  /** Risky command approval mode in dev containers */
  "security.risky_command_approval": false,
  /** Team performance auto-optimization (later phase) */
  "analytics.team_optimization": false,
  /** Optional encrypted remote backup (any S3-compatible object storage; not tied to a cloud) */
  "backup.remote": false,
  /** Paid metered API executors — off by default, never automatic (PRD §15) */
  "executors.paid_api": false,
  /** Official cloud executors (enabled only once verified) */
  "executors.cloud": true,
  /** pgvector semantic memory search (P2) */
  "memory.pgvector": false,
  /** Deployment monitoring/auto maintenance */
  "ops.deploy_monitor": false,
  /** Multi-user / team permissions */
  "users.multi_user": false,
} as const;

export type FlagKey = keyof typeof FLAG_DEFAULTS;

export class FeatureFlags {
  constructor(private db: Database) {}

  async isEnabled(key: FlagKey | string, ownerId?: string | null): Promise<boolean> {
    const rows = await this.db.query<{ owner_id: string; enabled: boolean }>("SELECT owner_id, enabled FROM feature_flags WHERE flag_key=$1 AND owner_id IN ('', $2)", [key, ownerId ?? ""]);
    const own = ownerId ? rows.find((r) => r.owner_id === ownerId) : undefined;
    if (own) return !!own.enabled;
    const global = rows.find((r) => r.owner_id === "");
    if (global) return !!global.enabled;
    return (FLAG_DEFAULTS as Record<string, boolean>)[key] ?? false;
  }

  async set(key: FlagKey | string, enabled: boolean, ownerId: string | null = null, rolloutScope = "global"): Promise<void> {
    await this.db.query(
      `INSERT INTO feature_flags(id, owner_id, flag_key, enabled, rollout_scope) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id, flag_key) DO UPDATE SET enabled=EXCLUDED.enabled, rollout_scope=EXCLUDED.rollout_scope, updated_at=now()`,
      [newId("flg"), ownerId ?? "", key, enabled, rolloutScope],
    );
  }

  async all(ownerId?: string | null): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const k of Object.keys(FLAG_DEFAULTS)) out[k] = await this.isEnabled(k, ownerId);
    return out;
  }
}
