import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../core/context.js";
import { createLocalBackup, verifyBackup, type LocalBackupResult } from "./backup.js";
import { s3Put, type S3Target } from "./s3.js";
import { SECRET_REFS, SYSTEM_OWNER } from "../app.js";

export interface RemoteBackupSettings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
}

/** Backup orchestration: local by default, encrypted remote copy optional. */
export interface BackupRecord {
  file: string;
  at: string;
  bytes: number;
  encrypted: boolean;
  verified: boolean | null;
  verifyDetail: string | null;
  remote: string | null;
}

export async function runBackup(ctx: AppContext, opts: { remote?: boolean; verify?: boolean } = {}): Promise<LocalBackupResult & { remote: string | null; verification: { ok: boolean; rows: number; reason?: string } | null }> {
  const passphrase = process.env.AA_BACKUP_PASSPHRASE || undefined;
  const keep = (await ctx.repos.settings.get<number>("system", "", "backup.keep")) ?? 7;
  let local: LocalBackupResult;
  try {
    local = await createLocalBackup(ctx.repos.db, ctx.config.backupsDir, { passphrase, keep });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new Error(`백업 폴더(${ctx.config.backupsDir})에 쓸 권한이 없습니다. 서버에서 \`sudo chown -R 1000:1000 ./backups\` 후 다시 시도하세요.`, { cause: e });
    throw e;
  }
  let remote: string | null = null;
  const wantRemote = opts.remote ?? (await ctx.flags.isEnabled("backup.remote"));
  if (wantRemote) {
    const s = await ctx.repos.settings.get<RemoteBackupSettings>("system", "", "backup.remote");
    if (!s) throw new Error("원격 백업 설정이 없습니다.");
    if (!passphrase) throw new Error("원격 백업은 암호화가 필수입니다. AA_BACKUP_PASSPHRASE를 설정하세요.");
    const target: S3Target = {
      ...s,
      accessKeyId: await ctx.vault.get(SECRET_REFS.s3Access, { ownerId: SYSTEM_OWNER }),
      secretAccessKey: await ctx.vault.get(SECRET_REFS.s3Secret, { ownerId: SYSTEM_OWNER }),
    };
    const key = path.basename(local.file);
    await s3Put(target, key, fs.readFileSync(local.file));
    remote = `${s.bucket}/${[s.prefix, key].filter(Boolean).join("/")}`;
  }
  const verification = opts.verify === false ? null : await verifyBackup(fs.readFileSync(local.file), passphrase);
  const record: BackupRecord = { file: path.basename(local.file), at: new Date().toISOString(), bytes: local.bytes, encrypted: local.encrypted, verified: verification ? verification.ok : null, verifyDetail: verification ? (verification.ok ? `${verification.rows}행 복원 확인` : (verification.reason ?? "실패")) : null, remote };
  await ctx.repos.settings.set("system", "", "backup.last", record);
  await ctx.repos.audit.record("system", "backup.create", "backup", verification && !verification.ok ? "failure" : "success", { ...record });
  if (verification && !verification.ok) ctx.events.emit("alert", { level: "error", message: `백업 복원 검증 실패: ${verification.reason}` });
  return { ...local, remote, verification };
}

export function startBackupSchedule(ctx: AppContext, intervalMs = 24 * 3600_000): () => void {
  const t = setInterval(() => {
    runBackup(ctx).catch((e) => ctx.events.emit("alert", { level: "error", message: `정기 백업 실패: ${(e as Error).message}` }));
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
