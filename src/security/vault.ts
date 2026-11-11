import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { iso, type Database } from "../db/index.js";
import { newId } from "../util/ids.js";
import { AppError } from "../util/errors.js";

/**
 * Encrypted secrets vault (PRD §8.1, §6.1-10).
 * AES-256-GCM with a master key that lives outside the database
 * (env AA_MASTER_KEY or a 0600 key file in the data dir) — key separation for backups.
 */

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const b = Buffer.from(trimmed, "base64");
  if (b.length === 32) return b;
  // Allow passphrases: derive a key deterministically.
  return scryptSync(trimmed, "agent-agency-vault-v1", 32);
}

/** Resolve master key from env or key file; create key file if neither exists. */
export function resolveMasterKey(dataDir: string, envKey?: string, create = true): Buffer {
  if (envKey) return parseMasterKey(envKey);
  const keyFile = path.join(dataDir, "master.key");
  if (fs.existsSync(keyFile)) return parseMasterKey(fs.readFileSync(keyFile, "utf8"));
  if (!create) throw new AppError("master key not found", "vault_no_key");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const k = generateMasterKey();
  fs.writeFileSync(keyFile, k + "\n", { mode: 0o600 });
  return parseMasterKey(k);
}

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encrypt(key: Buffer, plaintext: string, aad?: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decrypt(key: Buffer, blob: EncryptedBlob, aad?: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export interface SecretMeta {
  ref: string;
  ownerId: string;
  projectId: string | null;
  label: string;
  revoked: boolean;
  createdAt: string;
  updatedAt: string;
}

export class Vault {
  private maskCache = new Map<string, string[]>();

  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
  ) {}

  async put(ownerId: string, label: string, value: string, projectId: string | null = null, ref?: string): Promise<string> {
    const r = ref ?? newId("sec");
    const blob = encrypt(this.key, value, r);
    await this.db.query(
      `INSERT INTO secrets(ref, owner_id, project_id, label, ciphertext, iv, tag, revoked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)
       ON CONFLICT (ref) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv, tag=EXCLUDED.tag, label=EXCLUDED.label, revoked=false, updated_at=now()`,
      [r, ownerId, projectId, label, blob.ciphertext, blob.iv, blob.tag],
    );
    this.maskCache.delete(ownerId);
    return r;
  }

  /**
   * Read a secret. Access is checked against owner and project scope: project-scoped secrets
   * are only returned for that project (PRD §12-7).
   */
  async get(ref: string, access: { ownerId: string; projectId?: string | null }): Promise<string> {
    const rows = await this.db.query<{ owner_id: string; project_id: string | null; ciphertext: string; iv: string; tag: string; revoked: boolean }>("SELECT * FROM secrets WHERE ref=$1", [ref]);
    const row = rows[0];
    if (!row) throw new AppError("secret not found", "secret_not_found", { ref });
    if (row.owner_id !== access.ownerId) throw new AppError("secret access denied", "secret_denied", { ref });
    if (row.project_id && row.project_id !== (access.projectId ?? null)) throw new AppError("secret is scoped to another project", "secret_denied", { ref });
    if (row.revoked) throw new AppError("secret is revoked/blocked", "secret_revoked", { ref });
    return decrypt(this.key, { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }, ref);
  }

  async has(ref: string): Promise<boolean> {
    return (await this.db.query("SELECT 1 FROM secrets WHERE ref=$1 AND NOT revoked", [ref])).length > 0;
  }

  /** Immediately block locally (PRD §8.1). */
  async revoke(ref: string): Promise<void> {
    await this.db.query("UPDATE secrets SET revoked=true, updated_at=now() WHERE ref=$1", [ref]);
    this.maskCache.clear();
  }

  async delete(ref: string): Promise<void> {
    await this.db.query("DELETE FROM secrets WHERE ref=$1", [ref]);
    this.maskCache.clear();
  }

  async list(ownerId: string): Promise<SecretMeta[]> {
    const rows = await this.db.query<any>("SELECT ref, owner_id, project_id, label, revoked, created_at, updated_at FROM secrets WHERE owner_id=$1 ORDER BY created_at", [ownerId]);
    return rows.map((r) => ({ ref: r.ref, ownerId: r.owner_id, projectId: r.project_id, label: r.label, revoked: !!r.revoked, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
  }

  /** All active secret values of an owner, used only to mask outgoing text — never displayed. */
  async allValuesForMasking(ownerId: string): Promise<string[]> {
    const cached = this.maskCache.get(ownerId);
    if (cached) return cached;
    const rows = await this.db.query<{ ref: string; ciphertext: string; iv: string; tag: string }>("SELECT ref, ciphertext, iv, tag FROM secrets WHERE owner_id=$1 AND NOT revoked", [ownerId]);
    const out: string[] = [];
    for (const r of rows) {
      try {
        out.push(decrypt(this.key, r, r.ref));
      } catch {}
    }
    this.maskCache.set(ownerId, out);
    return out;
  }
}
