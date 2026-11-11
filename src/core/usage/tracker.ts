/**
 * Usage tracking (PRD §9). Provider-official numbers are preferred; anything we compute
 * ourselves is always labelled as an estimate.
 */
export interface UsageSignal {
  adapterId: string;
  source: "official" | "estimate";
  /** e.g. remaining percentage or tokens; free-form per adapter */
  metric: string;
  value: number | string;
  observedAt: string;
  note?: string;
}

export type QuotaState = "ok" | "low" | "exhausted" | "unknown";

export class UsageTracker {
  private signals = new Map<string, UsageSignal[]>();
  private quota = new Map<string, { state: QuotaState; until?: string; source: "official" | "estimate" }>();

  record(signal: UsageSignal): void {
    const list = this.signals.get(signal.adapterId) ?? [];
    list.push(signal);
    while (list.length > 200) list.shift();
    this.signals.set(signal.adapterId, list);
  }

  setQuota(adapterId: string, state: QuotaState, source: "official" | "estimate", until?: string): void {
    this.quota.set(adapterId, { state, source, until });
  }

  quotaState(adapterId: string, now = new Date()): QuotaState {
    const q = this.quota.get(adapterId);
    if (!q) return "unknown";
    if (q.until && new Date(q.until).getTime() <= now.getTime()) {
      this.quota.delete(adapterId);
      return "unknown";
    }
    return q.state;
  }

  describe(adapterId: string): string {
    const q = this.quota.get(adapterId);
    const last = (this.signals.get(adapterId) ?? []).slice(-1)[0];
    const parts: string[] = [];
    if (q) parts.push(`쿼터: ${q.state}${q.source === "estimate" ? " (추정)" : " (공식)"}${q.until ? ` ~${q.until}` : ""}`);
    if (last) parts.push(`${last.metric}=${last.value}${last.source === "estimate" ? " (추정치)" : ""}`);
    return parts.join(", ") || "사용량 정보 없음 (공급자가 공식 제공하지 않음)";
  }

  snapshot(): Record<string, { quota: QuotaState; last?: UsageSignal }> {
    const out: Record<string, { quota: QuotaState; last?: UsageSignal }> = {};
    const ids = new Set([...this.signals.keys(), ...this.quota.keys()]);
    for (const id of ids) out[id] = { quota: this.quotaState(id), last: (this.signals.get(id) ?? []).slice(-1)[0] };
    return out;
  }
}
