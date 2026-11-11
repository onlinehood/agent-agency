import { createSign } from "node:crypto";

/**
 * GitHub App authentication (PRD §18 "GitHub App 연결"). Mints short-lived installation
 * tokens (1h) from the App's private key and caches them until shortly before expiry.
 * Least privilege comes from the App's own permission set and the selected repositories.
 */
export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  apiBase?: string;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function appJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

export class GitHubAppTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private cfg: GitHubAppConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() > 5 * 60_000) return this.cached.token;
    const base = this.cfg.apiBase ?? "https://api.github.com";
    const res = await this.fetchImpl(`${base}/app/installations/${this.cfg.installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${appJwt(this.cfg.appId, this.cfg.privateKeyPem)}`, accept: "application/vnd.github+json", "user-agent": "agent-agency" },
    });
    if (!res.ok) throw new Error(`GitHub App token request failed: ${res.status}`);
    const j = (await res.json()) as { token: string; expires_at: string };
    this.cached = { token: j.token, expiresAt: new Date(j.expires_at).getTime() };
    return j.token;
  }
}

export type TokenSource = string | (() => Promise<string>);

export async function resolveToken(src: TokenSource | undefined): Promise<string | undefined> {
  if (!src) return undefined;
  return typeof src === "string" ? src : src();
}
