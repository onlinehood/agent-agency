import type { Provider } from "../core/types.js";

/**
 * Executor Adapter Layer (PRD §6.1-5).
 * Every capability is reported honestly as supported / unsupported / unverified.
 * Unverified features must never be presented as supported (PRD §11 Phase 0-5).
 */
export type CapabilityStatus = "supported" | "unsupported" | "unverified";

/**
 * Executor kinds (PRD §15). Default priority: cloud → local_cli. paid_api is disabled by
 * default and is never selected automatically.
 */
export type ExecutorKind = "cloud" | "local_cli" | "paid_api";

export interface ExecutorCapabilities {
  run: CapabilityStatus;
  /** Querying the status of a previously submitted external job (cloud). */
  statusQuery?: CapabilityStatus;
  /** Collecting the result (diff / output) of an external job. */
  resultCollection?: CapabilityStatus;
  cancel: CapabilityStatus;
  resume: CapabilityStatus;
  modelSelection: CapabilityStatus;
  usageInfo: CapabilityStatus;
  quotaSignal: CapabilityStatus;
  imageInput: CapabilityStatus;
  audioInput: CapabilityStatus;
}

export interface AdapterStatus {
  adapterId: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  /** true only when authenticated through an official subscription (not a paid API key) */
  subscriptionAuth: boolean;
  authDetail: string;
  capabilities: ExecutorCapabilities;
  notes: string[];
  checkedAt: string;
}

export type ExecMode = "readonly" | "write";

export interface ExecRequest {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  mode: ExecMode;
  /** "auto" or explicit model id */
  model?: string;
  resumeSessionRef?: string | null;
  timeoutMs?: number;
  /** true when running inside an isolated container workspace */
  isolated?: boolean;
  /** env vars to inject (already minimal & scoped) */
  env?: Record<string, string>;
  /** Allow web search/fetch tools (research work); fetched content is untrusted. */
  allowWeb?: boolean;
  /** files (absolute paths) attached for analysis, e.g. images */
  attachments?: string[];
  /** Called as soon as an external job id is known (cloud), so it is checkpointed before completion. */
  onExternalRef?: (ref: string) => void | Promise<void>;
  /** Cloud executors: git branch / environment hints */
  cloud?: { environmentId?: string; branch?: string };
  /** Optional command wrapper (e.g. docker exec into the project sandbox). */
  wrap?: (cmd: string, args: string[], cwd: string) => { cmd: string; args: string[]; cwd: string | undefined };
}

export interface ExecResult {
  status: "succeeded" | "failed" | "cancelled" | "timeout";
  text: string;
  sessionRef: string | null;
  model: string | null;
  usage: Record<string, unknown>;
  /** whether usage numbers are official or estimates */
  usageSource: "official" | "estimate" | "none";
  quotaExhausted: boolean;
  authExpired: boolean;
  error: string | null;
  durationMs: number;
}

export interface RunningHandle {
  id: string;
  cancel(): Promise<{ cancelled: boolean; detail: string }>;
  result: Promise<ExecResult>;
}

export type ExternalJobState = "running" | "finished" | "failed" | "unknown";

export interface ExecutorAdapter {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly provider: Provider;
  readonly displayName: string;
  /** Known model identifiers (officially documented). "auto" lets the CLI pick its default. */
  readonly knownModels: string[];
  /** Explicit model ids accepted beyond knownModels (only when model selection is supported). */
  readonly modelPattern?: RegExp;
  detect(): Promise<AdapterStatus>;
  start(req: ExecRequest): RunningHandle;
  /** Check whether a previously started external job is still running (used before fallback). */
  externalStatus?(externalRef: string): Promise<ExternalJobState>;
}

export const UNVERIFIED_CAPS: ExecutorCapabilities = {
  run: "unverified",
  statusQuery: "unverified",
  resultCollection: "unverified",
  cancel: "unverified",
  resume: "unverified",
  modelSelection: "unverified",
  usageInfo: "unverified",
  quotaSignal: "unverified",
  imageInput: "unverified",
  audioInput: "unverified",
};

export const UNSUPPORTED_CAPS: ExecutorCapabilities = {
  run: "unsupported",
  statusQuery: "unsupported",
  resultCollection: "unsupported",
  cancel: "unsupported",
  resume: "unsupported",
  modelSelection: "unsupported",
  usageInfo: "unsupported",
  quotaSignal: "unsupported",
  imageInput: "unsupported",
  audioInput: "unsupported",
};

export function emptyResult(partial: Partial<ExecResult>): ExecResult {
  return {
    status: "failed",
    text: "",
    sessionRef: null,
    model: null,
    usage: {},
    usageSource: "none",
    quotaExhausted: false,
    authExpired: false,
    error: null,
    durationMs: 0,
    ...partial,
  };
}

const QUOTA_PATTERNS = [/usage limit/i, /rate limit/i, /quota/i, /limit reached/i, /too many requests/i, /429/];
const AUTH_PATTERNS = [/not logged in/i, /please run .*login/i, /authentication (failed|required)/i, /invalid api key/i, /oauth token (has )?expired/i, /401/];

export function detectQuota(text: string): boolean {
  return QUOTA_PATTERNS.some((r) => r.test(text));
}

export function detectAuthExpired(text: string): boolean {
  return AUTH_PATTERNS.some((r) => r.test(text));
}
