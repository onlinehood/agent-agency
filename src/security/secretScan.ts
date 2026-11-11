/**
 * Secret scanning of agent changes before anything reaches GitHub (PRD §8.1, §12-7).
 * Findings carry file/line/kind only — never the secret value itself.
 */
export interface SecretFinding {
  file: string;
  line: number | null;
  kind: string;
}

const TOKEN_RULES: Array<[RegExp, string]> = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, "Telegram 봇 토큰"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, "GitHub 토큰"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "GitHub 토큰"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "Anthropic API 키"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, "OpenAI API 키"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS 액세스 키"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API 키"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, "Slack 토큰"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "개인 키"],
  [/(?:secret|password|passwd|token|api[_-]?key)["']?\s*[:=]\s*["'][A-Za-z0-9+/_\-.]{16,}["']/i, "하드코딩된 비밀값"],
];

const SENSITIVE_FILES: Array<[RegExp, string]> = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/, ".env 파일"],
  [/\.(pem|p12|pfx|keystore|jks)$/i, "키/인증서 파일"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, "SSH 개인 키"],
  [/(^|\/)(credentials|service-account)[^/]*\.json$/i, "자격 증명 JSON"],
];

export function scanFiles(files: string[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const f of files) {
    for (const [re, kind] of SENSITIVE_FILES) {
      if (re.test(f)) {
        out.push({ file: f, line: null, kind });
        break;
      }
    }
  }
  return out;
}

/** Scan added lines of a unified diff. */
export function scanDiff(diff: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+ (b\/)?/, "").trim();
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const text = raw.slice(1);
      for (const [re, kind] of TOKEN_RULES) {
        if (re.test(text)) {
          out.push({ file, line, kind });
          break;
        }
      }
      line++;
    } else if (!raw.startsWith("-")) {
      line++;
    }
  }
  return out;
}

export function describeFindings(f: SecretFinding[]): string {
  return f
    .slice(0, 10)
    .map((x) => `${x.file}${x.line ? `:${x.line}` : ""} (${x.kind})`)
    .join(", ");
}
