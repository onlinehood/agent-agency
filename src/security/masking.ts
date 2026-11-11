/**
 * Secret masking used by logs, audit events, memories and Telegram/GitHub output.
 * Conservative by design: better to mask a false positive than to leak a token.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens: 123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[TELEGRAM_TOKEN]"],
  // GitHub tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[GITHUB_TOKEN]"],
  // Anthropic / OpenAI style keys
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "[ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[OPENAI_KEY]"],
  // AWS access keys
  [/\bAKIA[0-9A-Z]{16}\b/g, "[AWS_KEY]"],
  // Generic bearer tokens
  [/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "$1[TOKEN]"],
  // key=value style secrets in env-like text
  [/\b((?:[A-Z0-9_]*)(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\s'"]{6,})/g, "$1=[REDACTED]"],
  // JSON-ish "password": "..."
  [/("(?:[a-zA-Z0-9_]*)(?:secret|password|token|api_key|apiKey|private_key)(?:[a-zA-Z0-9_]*)"\s*:\s*")([^"]{4,})(")/gi, "$1[REDACTED]$3"],
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY]"],
];

export function maskSecrets(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, rep);
  }
  return out;
}

/** Mask known secret values explicitly (e.g. configured tokens), in addition to patterns. */
export function maskKnown(input: string, secrets: Array<string | undefined | null>): string {
  let out = input;
  for (const s of secrets) {
    if (s && s.length >= 6) {
      out = out.split(s).join("[REDACTED]");
    }
  }
  return maskSecrets(out);
}

export function maskObject<T>(value: T): T {
  return JSON.parse(maskSecrets(JSON.stringify(value))) as T;
}
