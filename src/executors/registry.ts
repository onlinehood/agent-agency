import type { AdapterStatus, ExecutorAdapter, ExecutorKind } from "./types.js";
import type { UsageTracker } from "../core/usage/tracker.js";

export interface VerificationRecord {
  adapterId: string;
  verifiedAt: string;
  /** what was observed: e.g. job id, status transitions, diff collected */
  evidence: string;
  version: string | null;
}

/**
 * Adapters plus their last detected status and verification evidence.
 * Usable = installed + authenticated through an official subscription + run supported
 * (or, for cloud executors whose CLI surface is experimental, a recorded verification run).
 * Paid API executors are never usable unless explicitly allowed for a specific call.
 */
export class ExecutorRegistry {
  private adapters = new Map<string, ExecutorAdapter>();
  private status = new Map<string, AdapterStatus>();
  private verified = new Map<string, VerificationRecord>();
  private disabled = new Map<string, string>();

  constructor(private usage?: UsageTracker) {}

  register(adapter: ExecutorAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ExecutorAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ExecutorAdapter[] {
    return [...this.adapters.values()];
  }

  byProvider(provider: string): ExecutorAdapter[] {
    return this.list().filter((a) => a.provider === provider);
  }

  async detectAll(): Promise<AdapterStatus[]> {
    const out: AdapterStatus[] = [];
    for (const a of this.adapters.values()) {
      let s: AdapterStatus;
      try {
        s = await a.detect();
      } catch (e) {
        s = {
          adapterId: a.id,
          installed: false,
          version: null,
          authenticated: false,
          subscriptionAuth: false,
          authDetail: (e as Error).message,
          capabilities: { run: "unverified", cancel: "unverified", resume: "unverified", modelSelection: "unverified", usageInfo: "unverified", quotaSignal: "unverified", imageInput: "unverified", audioInput: "unverified" },
          notes: ["상태 확인 중 오류"],
          checkedAt: new Date().toISOString(),
        };
      }
      this.status.set(a.id, s);
      out.push(s);
    }
    return out;
  }

  setStatus(s: AdapterStatus): void {
    this.status.set(s.adapterId, s);
  }

  getStatus(id: string): AdapterStatus | undefined {
    return this.status.get(id);
  }

  /** Executors switched off by feature flags (adapter id → reason). */
  setDisabled(d: Map<string, string>): void {
    this.disabled = d;
  }

  setVerification(rec: VerificationRecord): void {
    this.verified.set(rec.adapterId, rec);
  }

  getVerification(id: string): VerificationRecord | undefined {
    return this.verified.get(id);
  }

  /** Why an adapter is (not) usable — shown to the user verbatim. */
  usabilityReason(id: string, opts: { allowPaid?: boolean } = {}): { usable: boolean; reason: string } {
    const a = this.adapters.get(id);
    if (!a) return { usable: false, reason: "등록되지 않은 실행기" };
    const off = this.disabled.get(id);
    if (off) return { usable: false, reason: off };
    const s = this.status.get(id);
    if (!s) return { usable: false, reason: "상태 미확인 (진단 필요)" };
    if (a.kind === "paid_api" && !opts.allowPaid) return { usable: false, reason: "종량제 유료 API는 기본 비활성이며 명시적 승인 없이는 사용하지 않습니다" };
    if (!s.installed) return { usable: false, reason: "미설치 또는 기능 없음" };
    if (!s.authenticated) return { usable: false, reason: "미인증 또는 인증 만료" };
    if (a.kind !== "paid_api" && !s.subscriptionAuth) return { usable: false, reason: "공식 구독 인증이 아님 (API 키 등) — 유료 API로 자동 전환하지 않음" };
    if (s.capabilities.run === "unsupported") return { usable: false, reason: "실행 미지원" };
    if (s.capabilities.run === "unverified") {
      if (!this.verified.has(id)) return { usable: false, reason: "공식 자동화 지원 미확인 (검증 실행 기록 없음)" };
    }
    if (this.usage && this.usage.quotaState(id) === "exhausted") return { usable: false, reason: "구독 사용량 한도 소진 (추정)" };
    return { usable: true, reason: this.verified.has(id) && s.capabilities.run === "unverified" ? "검증 실행 기록으로 활성화" : "사용 가능" };
  }

  isUsable(id: string, opts: { allowPaid?: boolean } = {}): boolean {
    return this.usabilityReason(id, opts).usable;
  }

  usableIds(): string[] {
    return this.list()
      .map((a) => a.id)
      .filter((id) => this.isUsable(id));
  }

  /** Is any executor usable for this provider (any kind except paid)? */
  providerUsable(provider: string): boolean {
    return this.byProvider(provider).some((a) => this.isUsable(a.id));
  }

  kindOf(id: string): ExecutorKind | undefined {
    return this.adapters.get(id)?.kind;
  }

  /** "auto" or a model the adapter officially lists. Never fall back to unsupported/paid models. */
  resolveModel(adapterId: string, policy: string): string {
    const a = this.adapters.get(adapterId);
    if (!a || policy === "auto") return "auto";
    if (a.knownModels.includes(policy)) return policy;
    const s = this.status.get(adapterId);
    if (s?.capabilities.modelSelection === "supported" && a.modelPattern?.test(policy)) return policy;
    return "auto";
  }
}
