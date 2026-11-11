import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Helpers around `gemini` interactive login (Login with Google) on a headless server.
 *
 * Gemini CLI remembers the last auth method in ~/.gemini/settings.json. Once "Use Gemini API Key"
 * has been picked, it opens on the API-key prompt, and choosing a method again clears cached
 * credentials. A Gemini process left running in the container keeps rewriting settings.json from
 * its in-memory copy. And when Google refuses the account after sign-in, the full-screen UI
 * falls back to the API-key prompt without saying why. These helpers pin the subscription
 * method, close leftover Gemini processes, and read the reason from Gemini's debug log.
 */

export const geminiHome = (): string => process.env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini");

/** Set security.auth.selectedType = "oauth-personal", keeping any other settings. */
export function pinOAuth(home = geminiHome()): void {
  const file = path.join(home, "settings.json");
  fs.mkdirSync(home, { recursive: true });
  let j: any = {};
  if (fs.existsSync(file)) {
    try {
      j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!j || typeof j !== "object" || Array.isArray(j)) j = {};
    } catch {
      fs.copyFileSync(file, `${file}.bak`);
      j = {};
    }
  }
  delete j.selectedAuthType; // legacy key
  j.security = { ...(j.security ?? {}), auth: { ...(j.security?.auth ?? {}), selectedType: "oauth-personal" } };
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

/** The auth method Gemini currently has saved (null when unset or unreadable). */
export function savedAuthType(home = geminiHome()): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    return j?.security?.auth?.selectedType ?? j?.selectedAuthType ?? null;
  } catch {
    return null;
  }
}

const isGeminiCmd = (argv: string[]): boolean => argv.some((a) => path.basename(a) === "gemini" || a.includes("@google/gemini-cli"));

/** Kill other Gemini CLI processes (not this process or its ancestors). Returns the pids signalled. */
export function killStrayGemini(opts: { procRoot?: string; selfPid?: number; kill?: (pid: number) => void } = {}): number[] {
  const root = opts.procRoot ?? "/proc";
  const self = opts.selfPid ?? process.pid;
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  let entries: string[];
  try {
    entries = fs.readdirSync(root).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const parent = new Map<number, number>();
  const argv = new Map<number, string[]>();
  for (const d of entries) {
    const pid = Number(d);
    try {
      argv.set(pid, fs.readFileSync(path.join(root, d, "cmdline"), "utf8").split("\0").filter(Boolean));
      const stat = fs.readFileSync(path.join(root, d, "stat"), "utf8");
      parent.set(pid, Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {}
  }
  const protectedPids = new Set<number>();
  for (let p: number | undefined = self; p && !protectedPids.has(p); p = parent.get(p)) protectedPids.add(p);
  const killed: number[] = [];
  for (const [pid, a] of argv) {
    if (protectedPids.has(pid) || !isGeminiCmd(a)) continue;
    try {
      kill(pid);
      killed.push(pid);
    } catch {}
  }
  return killed;
}

export interface LoginDiagnosis {
  ok: boolean;
  reason?: string;
  hint?: string;
  /** Last error/warning lines of the debug log when no known reason matched (for a screenshot). */
  logTail?: string;
}

const REASON = /(IneligibleTier|ineligible|not eligible|Account validation required|ValidationRequired|ProjectIdRequired|GOOGLE_CLOUD_PROJECT|Failed to sign in|Failed to authenticate|Error authenticating|invalid_grant|UNSUPPORTED_LOCATION|UNKNOWN_LOCATION|RESTRICTED_AGE|RESTRICTED_NETWORK|DASHER_USER|INELIGIBLE_ACCOUNT|NON_USER_ACCOUNT|permission denied|PERMISSION_DENIED)/i;

/** After `gemini` exits: were Login-with-Google credentials saved? If not, why (from the debug log)? */
export function diagnoseLogin(home = geminiHome(), logFile?: string, fellBack = false): LoginDiagnosis {
  if (fs.existsSync(path.join(home, "oauth_creds.json"))) return { ok: true };
  let all: string[] = [];
  if (logFile && fs.existsSync(logFile)) all = fs.readFileSync(logFile, "utf8").split("\n").map((l) => l.replace(/\s+/g, " ").trim().slice(0, 220));
  const lines = all.filter((l) => REASON.test(l) && !l.includes("[DEBUG]"));
  const reason = [...new Set(lines)].slice(-3).join("\n") || undefined;
  const tail = reason ? undefined : [...new Set(all.filter((l) => /\[(ERROR|WARN)\]/.test(l)))].slice(-6).join("\n") || (all.some(Boolean) ? undefined : "(Gemini 기록이 비어 있어요)");
  return { ok: false, reason, logTail: tail, hint: reason ? hintFor(reason) : fellBack ? FELL_BACK_HINT : hintFor("") };
}

const FELL_BACK_HINT =
  "Google 로그인 직후 Gemini가 스스로 API 키 방식으로 바꿨어요. Google이 이 계정에 무료 Gemini CLI(Code Assist)를 열어 주지 않았다는 뜻이에요. 회사·학교 계정이면 개인 Gmail 계정으로 해 보세요. 개인 계정이라면 Google 쪽 제한(나이 인증, 계정 확인 등)일 수 있어요. Gemini는 선택 사항이라 Claude·Codex만으로도 운영됩니다.";

function hintFor(reason: string): string {
  if (/DASHER_USER|GOOGLE_CLOUD_PROJECT|ProjectIdRequired/i.test(reason)) return "회사·학교(Google Workspace) 계정은 Google Cloud 프로젝트가 있어야 해요. 개인 Gmail 계정으로 다시 로그인해 보세요.";
  if (/UNSUPPORTED_LOCATION|UNKNOWN_LOCATION|RESTRICTED_NETWORK/i.test(reason)) return "Google이 이 서버의 지역이나 네트워크에서 무료 Gemini CLI 사용을 막고 있어요. 다른 지역의 서버에서만 쓸 수 있어요.";
  if (/RESTRICTED_AGE/i.test(reason)) return "만 18세 이상 계정만 Gemini CLI를 쓸 수 있어요.";
  if (/INELIGIBLE_ACCOUNT|NON_USER_ACCOUNT|ineligible|not eligible/i.test(reason)) return "이 Google 계정은 무료 Gemini CLI(Code Assist) 대상이 아니에요. 다른 개인 Gmail 계정으로 해 보세요.";
  if (/validation/i.test(reason)) return "Google 계정 확인이 필요해요. 다시 로그인한 뒤 'Verify your account'를 골라 안내된 주소에서 확인을 마치세요.";
  if (/invalid_grant/i.test(reason)) return "인증 코드가 틀렸거나 만료됐어요. 새 주소로 다시 로그인하고, 코드는 받자마자 붙여 넣으세요.";
  return "Gemini가 이유를 남기지 않았어요. 다시 로그인하고, 코드를 붙여 넣은 뒤 Enter는 한 번만 누르세요. 그다음 선택 화면이 나오면 고르지 말고 화면을 찍어 두세요.";
}
