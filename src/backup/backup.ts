import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import type { Database } from "../db/index.js";
import { currentSchemaVersion, latestSchemaVersion } from "../db/index.js";

/**
 * Logical, engine-neutral backup (PRD §8.2, §16/§17).
 * All tables are exported as JSON in FK order, gzip-compressed and optionally encrypted with a
 * backup passphrase that is kept separate from the vault master key. Because the format is
 * plain rows, a backup taken on one host/provider restores on any other (PGlite ↔ PostgreSQL,
 * OCI ↔ AWS ↔ on-prem). Vault ciphertexts are included; restoring them needs the same master key,
 * which is intentionally NOT in the backup (key separation).
 */
export const BACKUP_TABLES = [
  "users",
  "organization_profiles",
  "agent_personas",
  "agents",
  "agent_relationships",
  "projects",
  "project_agents",
  "requests",
  "ideas",
  "tasks",
  "executions",
  "approvals",
  "conversation_messages",
  "conversation_summaries",
  "decisions",
  "project_memories",
  "artifacts",
  "service_connections",
  "secrets",
  "audit_events",
  "feature_flags",
  "settings",
  "external_effects",
  "jobs",
] as const;

export interface BackupDoc {
  format: "agent-agency-backup";
  version: 1;
  schemaVersion: number;
  createdAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

const MAGIC = Buffer.from("AAENC1");

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}

export async function exportDatabase(db: Database): Promise<BackupDoc> {
  const tables: BackupDoc["tables"] = {};
  for (const t of BACKUP_TABLES) {
    const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${t}`);
    tables[t] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, normalize(v)])));
  }
  return { format: "agent-agency-backup", version: 1, schemaVersion: await currentSchemaVersion(db), createdAt: new Date().toISOString(), tables };
}

export function encodeBackup(doc: BackupDoc, passphrase?: string): Buffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(doc)));
  if (!passphrase) return gz;
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}

export function decodeBackup(buf: Buffer, passphrase?: string): BackupDoc {
  let gz = buf;
  if (buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (!passphrase) throw new Error("암호화된 백업입니다. 백업 암호(AA_BACKUP_PASSPHRASE)가 필요합니다.");
    const o = MAGIC.length;
    const salt = buf.subarray(o, o + 16);
    const iv = buf.subarray(o + 16, o + 28);
    const tag = buf.subarray(o + 28, o + 44);
    const d = createDecipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
    d.setAuthTag(tag);
    gz = Buffer.concat([d.update(buf.subarray(o + 44)), d.final()]);
  }
  const doc = JSON.parse(gunzipSync(gz).toString("utf8")) as BackupDoc;
  if (doc.format !== "agent-agency-backup") throw new Error("AgentAgency 백업 파일이 아닙니다.");
  return doc;
}

/** Restore into an already-migrated database (same or newer schema). Replaces all data. */
export async function importDatabase(db: Database, doc: BackupDoc): Promise<{ tables: number; rows: number }> {
  const appVersion = latestSchemaVersion();
  if (doc.schemaVersion > appVersion) throw new Error(`백업 스키마(v${doc.schemaVersion})가 현재 앱(v${appVersion})보다 새롭습니다. 앱을 업그레이드한 뒤 복원하세요.`);
  let rows = 0;
  await db.tx(async (q) => {
    await q.query(`TRUNCATE ${BACKUP_TABLES.join(", ")} CASCADE`);
    for (const t of BACKUP_TABLES) {
      const data = doc.tables[t] ?? [];
      if (!data.length) continue;
      const colRows = await q.query<{ column_name: string; data_type: string }>("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t]);
      const cols = new Set(colRows.map((c) => c.column_name));
      const jsonCols = new Set(colRows.filter((c) => c.data_type === "jsonb" || c.data_type === "json").map((c) => c.column_name));
      for (const r of data) {
        const keys = Object.keys(r).filter((k) => cols.has(k));
        const vals = keys.map((k) => {
          const v = r[k];
          if (v === null || v === undefined) return null;
          return jsonCols.has(k) ? JSON.stringify(v) : v;
        });
        await q.query(`INSERT INTO ${t} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
        rows++;
      }
    }
    await q.query("SELECT setval(pg_get_serial_sequence('audit_events','seq'), GREATEST(COALESCE((SELECT MAX(seq) FROM audit_events), 0), 1))");
  });
  return { tables: BACKUP_TABLES.length, rows };
}

export interface LocalBackupResult {
  file: string;
  bytes: number;
  sha256: string;
  encrypted: boolean;
}

export async function createLocalBackup(db: Database, dir: string, opts: { passphrase?: string; keep?: number } = {}): Promise<LocalBackupResult> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const buf = encodeBackup(await exportDatabase(db), opts.passphrase);
  const name = `aa-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz${opts.passphrase ? ".enc" : ""}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  pruneBackups(dir, opts.keep ?? 7);
  return { file, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), encrypted: !!opts.passphrase };
}

export function listBackups(dir: string): Array<{ name: string; bytes: number; createdAt: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("aa-backup-"))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, bytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function pruneBackups(dir: string, keep: number): void {
  for (const b of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, b.name), { force: true });
}

/**
 * Restore test (PRD §8.2 "복원 테스트"): import the backup into a throwaway embedded PostgreSQL and
 * compare per-table row counts with the backup document.
 */
export async function verifyBackup(buf: Buffer, passphrase?: string): Promise<{ ok: boolean; rows: number; tables: number; reason?: string }> {
  let doc: BackupDoc;
  try {
    doc = decodeBackup(buf, passphrase);
  } catch (e) {
    return { ok: false, rows: 0, tables: 0, reason: (e as Error).message };
  }
  const { openAndMigrate } = await import("../db/index.js");
  const scratch = await openAndMigrate({});
  try {
    const r = await importDatabase(scratch, doc);
    for (const t of BACKUP_TABLES) {
      const expected = doc.tables[t]?.length ?? 0;
      const got = Number((await scratch.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`))[0]?.n ?? 0);
      if (got !== expected) return { ok: false, rows: r.rows, tables: BACKUP_TABLES.length, reason: `${t}: 기대 ${expected}행, 복원 ${got}행` };
    }
    return { ok: true, rows: r.rows, tables: BACKUP_TABLES.length };
  } catch (e) {
    return { ok: false, rows: 0, tables: 0, reason: (e as Error).message };
  } finally {
    await scratch.close();
  }
}

export async function restoreFromFile(db: Database, file: string, passphrase?: string): Promise<{ tables: number; rows: number; schemaVersion: number }> {
  const doc = decodeBackup(fs.readFileSync(file), passphrase);
  const r = await importDatabase(db, doc);
  return { ...r, schemaVersion: doc.schemaVersion };
}
