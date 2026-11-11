import { newId, nowIso } from "../util/ids.js";
import { emptyResult, type AdapterStatus, type ExecRequest, type ExecResult, type ExecutorAdapter, type ExecutorKind, type ExternalJobState, type RunningHandle } from "./types.js";
import type { Provider } from "../core/types.js";

/**
 * Deterministic simulator executor for tests, demos and smoke tests of the orchestration
 * pipeline. It is clearly labelled as a simulator everywhere and never reported as an AI
 * subscription executor. Disabled unless explicitly enabled.
 */
export type SimulatorHandler = (req: ExecRequest) => Promise<Partial<ExecResult> | string> | Partial<ExecResult> | string;

export class SimulatorAdapter implements ExecutorAdapter {
  readonly provider: Provider;
  readonly kind: ExecutorKind;
  readonly displayName = "Simulator (테스트용, 실제 AI 아님)";
  readonly knownModels = ["auto", "sim-1"];
  readonly calls: ExecRequest[] = [];

  /** external job states for cloud-kind simulation */
  externalStates = new Map<string, ExternalJobState>();

  constructor(
    readonly id: string = "simulator",
    private handler: SimulatorHandler = () => "OK",
    private delayMs = 0,
    opts: { kind?: ExecutorKind; provider?: Provider } = {},
  ) {
    this.kind = opts.kind ?? "local_cli";
    this.provider = opts.provider ?? "other";
  }

  async externalStatus(ref: string): Promise<ExternalJobState> {
    return this.externalStates.get(ref) ?? "unknown";
  }

  setHandler(h: SimulatorHandler): void {
    this.handler = h;
  }

  async detect(): Promise<AdapterStatus> {
    return {
      adapterId: this.id,
      installed: true,
      version: "sim",
      authenticated: true,
      subscriptionAuth: true,
      authDetail: "simulator",
      capabilities: { run: "supported", cancel: "supported", resume: "supported", modelSelection: "supported", usageInfo: "unsupported", quotaSignal: "unsupported", imageInput: "unsupported", audioInput: "unsupported" },
      notes: ["시뮬레이터: 실제 AI 실행기가 아닙니다."],
      checkedAt: nowIso(),
    };
  }

  start(req: ExecRequest): RunningHandle {
    this.calls.push(req);
    if (this.kind === "cloud") {
      const ref = newId("simjob");
      this.externalStates.set(ref, "running");
      void req.onExternalRef?.(ref);
    }
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    let settle: ((r: ExecResult) => void) | null = null;
    const started = Date.now();
    const result = new Promise<ExecResult>((resolveOuter) => {
      let done = false;
      const resolve = (r: ExecResult) => {
        if (done) return;
        done = true;
        resolveOuter(r);
      };
      settle = resolve;
      const run = async () => {
        if (cancelled) return resolve(emptyResult({ status: "cancelled", durationMs: Date.now() - started }));
        try {
          const out = await this.handler(req);
          if (cancelled) return resolve(emptyResult({ status: "cancelled", durationMs: Date.now() - started }));
          const partial = typeof out === "string" ? { text: out } : out;
          resolve({
            ...emptyResult({}),
            status: "succeeded",
            sessionRef: req.resumeSessionRef ?? newId("simsess"),
            model: req.model && req.model !== "auto" ? req.model : "sim-1",
            ...partial,
            durationMs: Date.now() - started,
          });
        } catch (e) {
          resolve(emptyResult({ status: "failed", error: (e as Error).message, durationMs: Date.now() - started }));
        }
      };
      timer = setTimeout(run, this.delayMs);
    });
    return {
      id: newId("run"),
      cancel: async () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        // Like killing a real process: the result settles immediately as cancelled.
        settle?.(emptyResult({ status: "cancelled", durationMs: Date.now() - started }));
        return { cancelled: true, detail: "시뮬레이터 실행 취소" };
      },
      result,
    };
  }
}
