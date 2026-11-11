import type { AppContext } from "../core/context.js";
import { SECRET_REFS, SYSTEM_OWNER } from "../app.js";

/**
 * Leaked-credential response (PRD §8.1): block locally at once; if the issuer has an official
 * revocation API, call it and report whether it succeeded; otherwise tell the user where to revoke.
 */
export interface RevokeResult {
  ref: string;
  locallyBlocked: boolean;
  official: "revoked" | "failed" | "unsupported";
  detail: string;
}

export async function revokeCredential(ctx: AppContext, ref: string, fetchImpl: typeof fetch = fetch): Promise<RevokeResult> {
  let value: string | null;
  try {
    value = await ctx.vault.get(ref, { ownerId: SYSTEM_OWNER });
  } catch {
    value = null; // already revoked or not a system secret
  }
  await ctx.vault.revoke(ref);
  let official: RevokeResult["official"] = "unsupported";
  let detail: string;
  switch (ref) {
    case SECRET_REFS.githubToken: {
      // GitHub's credential revocation endpoint accepts leaked tokens without authentication.
      try {
        const res = value
          ? await fetchImpl("https://api.github.com/credentials/revoke", { method: "POST", headers: { accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "agent-agency" }, body: JSON.stringify({ credentials: [value] }) })
          : null;
        if (res && res.status >= 200 && res.status < 300) {
          official = "revoked";
          detail = `GitHub에 폐기 요청이 접수되었습니다 (HTTP ${res.status}). github.com/settings/tokens 에서 폐기됐는지 확인하세요.`;
        } else {
          official = "failed";
          detail = `GitHub 공식 폐기 요청이 실패했습니다${res ? ` (HTTP ${res.status})` : ""}. github.com/settings/tokens 에서 직접 폐기하세요.`;
        }
      } catch (e) {
        official = "failed";
        detail = `GitHub 공식 폐기 요청 오류: ${(e as Error).message}. github.com/settings/tokens 에서 직접 폐기하세요.`;
      }
      break;
    }
    case SECRET_REFS.githubAppKey:
      detail = "GitHub App private key는 API로 폐기할 수 없습니다. GitHub App 설정의 Private keys에서 해당 키를 삭제하고 새 키를 등록하세요.";
      break;
    case SECRET_REFS.telegramToken:
      detail = "Telegram 봇 토큰은 API로 폐기할 수 없습니다. @BotFather에서 /revoke 로 토큰을 재발급하고 설정 마법사에서 새 토큰을 등록하세요.";
      break;
    case SECRET_REFS.s3Access:
    case SECRET_REFS.s3Secret:
      detail = "스토리지 액세스 키는 제공업체 콘솔에서 폐기하고 새 키를 등록하세요.";
      break;
    default:
      detail = "이 비밀정보의 발급처에서 직접 폐기하세요.";
  }
  await ctx.repos.audit.record("web", "credential.revoke", `secret:${ref}`, official === "failed" ? "failure" : "success", { official });
  return { ref, locallyBlocked: true, official, detail };
}
