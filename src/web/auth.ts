import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { Repos } from "../db/repositories.js";

/**
 * Admin web authentication (PRD §18 step 2). First run: a one-time setup token (printed to
 * the server log or AA_SETUP_TOKEN) authorizes creating the admin password. Sessions are
 * HMAC-signed cookies; state-changing requests carry a per-session CSRF token.
 */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return ["scrypt", salt.toString("base64"), scryptSync(pw, salt, 32).toString("base64")].join(":");
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split(":");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, "base64"), 32);
  const b = Buffer.from(hash, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class WebAuth {
  private secret: Buffer | null = null;

  constructor(private repos: Repos) {}

  private async key(): Promise<Buffer> {
    if (this.secret) return this.secret;
    let s = await this.repos.settings.get<string>("system", "", "web.session_secret");
    if (!s) {
      s = randomBytes(32).toString("base64");
      await this.repos.settings.set("system", "", "web.session_secret", s);
    }
    this.secret = Buffer.from(s, "base64");
    return this.secret;
  }

  async hasAdmin(): Promise<boolean> {
    return !!(await this.repos.settings.get<string>("system", "", "web.admin_password"));
  }

  /** Create the one-time setup token if needed. Only its hash is stored. */
  async ensureSetupToken(envToken?: string): Promise<string | null> {
    if (await this.hasAdmin()) return null;
    if (envToken) {
      await this.repos.settings.set("system", "", "web.setup_token_hash", sha(envToken));
      return envToken;
    }
    const existing = await this.repos.settings.get<string>("system", "", "web.setup_token_hash");
    if (existing) return null; // printed earlier; regenerate with the CLI `setup-token` command
    return this.regenerateSetupToken();
  }

  async regenerateSetupToken(): Promise<string> {
    const t = randomBytes(18).toString("base64url");
    await this.repos.settings.set("system", "", "web.setup_token_hash", sha(t));
    return t;
  }

  async createAdmin(setupToken: string, password: string): Promise<void> {
    if (await this.hasAdmin()) throw new Error("관리자가 이미 설정되었습니다.");
    const h = await this.repos.settings.get<string>("system", "", "web.setup_token_hash");
    if (!h || h !== sha(setupToken)) throw new Error("설정 토큰이 올바르지 않습니다.");
    if (password.length < 12) throw new Error("비밀번호는 12자 이상이어야 합니다.");
    await this.repos.settings.set("system", "", "web.admin_password", hashPassword(password));
    await this.repos.settings.delete("system", "", "web.setup_token_hash");
    await this.repos.audit.record("web", "admin.create", "web", "success");
  }

  /**
   * Set or change the dashboard password from the server console (`agent-agency config`). Whoever
   * can run commands in the container already controls the installation, so no setup token.
   */
  async setPassword(password: string): Promise<void> {
    if (password.length < 12) throw new Error("비밀번호는 12자 이상이어야 합니다.");
    await this.repos.settings.set("system", "", "web.admin_password", hashPassword(password));
    await this.repos.settings.delete("system", "", "web.setup_token_hash");
    // Rotate the session secret: existing browser sessions end (in a running service, at its next start).
    await this.repos.settings.delete("system", "", "web.session_secret");
    this.secret = null;
    await this.repos.audit.record("cli", "admin.password", "web", "success");
  }

  async login(password: string): Promise<string | null> {
    const stored = await this.repos.settings.get<string>("system", "", "web.admin_password");
    if (!stored || !verifyPassword(password, stored)) {
      await this.repos.audit.record("web", "admin.login", "web", "denied");
      return null;
    }
    await this.repos.audit.record("web", "admin.login", "web", "success");
    return this.issue();
  }

  async issue(ttlMs = 12 * 3600_000): Promise<string> {
    const payload = `${Date.now() + ttlMs}.${randomBytes(9).toString("base64url")}`;
    const sig = createHmac("sha256", await this.key()).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  async verify(cookie: string | undefined): Promise<boolean> {
    if (!cookie) return false;
    const i = cookie.lastIndexOf(".");
    if (i < 0) return false;
    const payload = cookie.slice(0, i);
    const sig = Buffer.from(cookie.slice(i + 1));
    const expect = Buffer.from(createHmac("sha256", await this.key()).update(payload).digest("base64url"));
    if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) return false;
    return Number(payload.split(".")[0]) > Date.now();
  }

  async csrf(session: string): Promise<string> {
    return createHmac("sha256", await this.key()).update(`csrf:${session}`).digest("base64url");
  }
}
