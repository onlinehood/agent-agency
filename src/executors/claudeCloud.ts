import { nowIso } from "../util/ids.js";
import { minimalEnv, runOnce } from "./process.js";
import { UNSUPPORTED_CAPS, emptyResult, type AdapterStatus, type ExecRequest, type ExecutorAdapter, type RunningHandle } from "./types.js";
import { newId } from "../util/ids.js";

/**
 * Claude Code cloud sessions (Claude Code on the web) — detection only.
 *
 * Verified: Claude Code 2.x exposes `--cloud [description|session_id|url]` to create or attach
 * to a cloud session. Not verified: a documented headless contract to create a session,
 * poll its status and collect its result programmatically. Per PRD §15 the adapter is
 * therefore reported as unverified and is never selected; execution falls back to the
 * isolated local CLI. No unofficial session automation is attempted.
 */
export class ClaudeCloudAdapter implements ExecutorAdapter {
  readonly id = "claude-cloud";
  readonly kind = "cloud" as const;
  readonly provider = "anthropic" as const;
  readonly displayName = "Claude Code cloud session (detection only)";
  readonly knownModels = ["auto"];

  constructor(private readonly bin = "claude") {}

  async detect(): Promise<AdapterStatus> {
    const help = await runOnce(this.bin, ["--help"], { env: minimalEnv({}, ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]), timeoutMs: 15000 });
    const hasFlag = help.code === 0 && /--cloud\b/.test(help.stdout);
    return {
      adapterId: this.id,
      installed: hasFlag,
      version: null,
      authenticated: false,
      subscriptionAuth: false,
      authDetail: hasFlag ? "--cloud 옵션 확인됨" : "--cloud 옵션 없음",
      capabilities: { ...UNSUPPORTED_CAPS, run: hasFlag ? "unverified" : "unsupported", statusQuery: "unverified", resultCollection: "unverified", cancel: "unverified" },
      notes: [
        hasFlag
          ? "Claude Code CLI에 클라우드 세션 생성 옵션(--cloud)이 있으나, 헤드리스 상태에서 상태 조회·결과 수집 계약이 공식 문서로 확인되지 않아 비활성화합니다. 격리된 Local CLI로 실행합니다."
          : "설치된 Claude Code CLI에 클라우드 세션 옵션이 없습니다.",
      ],
      checkedAt: nowIso(),
    };
  }

  start(_req: ExecRequest): RunningHandle {
    return {
      id: newId("run"),
      cancel: async () => ({ cancelled: false, detail: "실행되지 않음" }),
      result: Promise.resolve(emptyResult({ error: "Claude 클라우드 세션 자동화는 공식 지원이 확인되지 않아 비활성화되어 있습니다." })),
    };
  }
}
