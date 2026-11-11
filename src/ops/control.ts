import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config/index.js";

/**
 * Local control channel between the running service and the interactive CLI (`agent-agency
 * setup` / `config`), which runs as a separate process in the same container. The service writes
 * a random token to the data directory (mode 600, readable only by the app user); the CLI reads
 * it and asks the service to apply changes at once (restart the Telegram bot, reload GitHub, ...).
 */
export interface ControlActions {
  /** "pause" frees the bot token for a one-off getUpdates (group detection). */
  telegram?: "pause" | "restart";
  github?: boolean;
  /** Reload executor verification records, feature-flag gates and detection. */
  executors?: boolean;
  /** Reload custom worldviews from the database. */
  modes?: boolean;
  /** Moderator greets the admin in the lounge (end of setup). */
  greet?: boolean;
}

export const CONTROL_HEADER = "x-aa-control";
const tokenPath = (config: Pick<Config, "dataDir">) => path.join(config.dataDir, "control.token");

export function ensureControlToken(config: Pick<Config, "dataDir">): string {
  const t = randomBytes(24).toString("base64url");
  fs.writeFileSync(tokenPath(config), t, { mode: 0o600 });
  return t;
}

export function readControlToken(config: Pick<Config, "dataDir">): string | null {
  try {
    return fs.readFileSync(tokenPath(config), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function controlTokenMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ControlResult {
  reached: boolean;
  detail: string;
  telegram?: boolean;
}

export type ControlClient = (actions: ControlActions) => Promise<ControlResult>;

/** Ask the running service to apply changes. If it is not running, they apply on its next start. */
export function httpControlClient(config: Pick<Config, "dataDir" | "AA_WEB_PORT">): ControlClient {
  return async (actions) => {
    const token = readControlToken(config);
    if (!token) return { reached: false, detail: "서비스가 실행 중이 아닙니다. 다음 시작 때 적용됩니다." };
    try {
      const res = await fetch(`http://127.0.0.1:${config.AA_WEB_PORT}/internal/control`, {
        method: "POST",
        headers: { "content-type": "application/json", [CONTROL_HEADER]: token },
        body: JSON.stringify(actions),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { detail?: string; telegram?: boolean };
      return { reached: res.ok, detail: body.detail ?? `HTTP ${res.status}`, telegram: body.telegram };
    } catch {
      return { reached: false, detail: "서비스에 연결하지 못했습니다. 다음 시작 때 적용됩니다." };
    }
  };
}
