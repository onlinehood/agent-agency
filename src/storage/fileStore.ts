import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * File storage for execution logs, screenshots, attachments and temp files (PRD §17).
 * Default: deployment-local volume. The interface allows swapping in an object store adapter
 * without changing callers; nothing here depends on a specific cloud provider.
 */
export type FileClass = "logs" | "screenshots" | "attachments" | "tmp" | "backups";

export interface StoredFile {
  ref: string; // "<class>/<yyyy-mm-dd>/<uuid>-<name>"
  size: number;
}

export interface FileStore {
  put(cls: FileClass, name: string, data: Buffer | string): Promise<StoredFile>;
  get(ref: string): Promise<Buffer>;
  delete(ref: string): Promise<void>;
  /** Delete files of a class older than cutoff; returns deleted count. */
  purgeOlderThan(cls: FileClass, cutoff: Date): Promise<number>;
  usageBytes(): Promise<number>;
}

export class LocalFileStore implements FileStore {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private abs(ref: string): string {
    const p = path.resolve(this.root, ref);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("invalid file ref");
    return p;
  }

  async put(cls: FileClass, name: string, data: Buffer | string): Promise<StoredFile> {
    const day = new Date().toISOString().slice(0, 10);
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const ref = path.posix.join(cls, day, `${randomUUID()}-${safe}`);
    const p = this.abs(ref);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, data, { mode: 0o600 });
    return { ref, size: Buffer.byteLength(data) };
  }

  async get(ref: string): Promise<Buffer> {
    return fs.readFileSync(this.abs(ref));
  }

  async delete(ref: string): Promise<void> {
    fs.rmSync(this.abs(ref), { force: true });
  }

  async purgeOlderThan(cls: FileClass, cutoff: Date): Promise<number> {
    const dir = path.join(this.root, cls);
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    for (const day of fs.readdirSync(dir)) {
      const dayDir = path.join(dir, day);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoffDay) {
        n += fs.readdirSync(dayDir).length;
        fs.rmSync(dayDir, { recursive: true, force: true });
        continue;
      }
      if (!fs.statSync(dayDir).isDirectory()) continue;
      for (const f of fs.readdirSync(dayDir)) {
        const fp = path.join(dayDir, f);
        if (fs.statSync(fp).mtime < cutoff) {
          fs.rmSync(fp, { force: true });
          n++;
        }
      }
    }
    return n;
  }

  async usageBytes(): Promise<number> {
    let total = 0;
    const walk = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else total += fs.statSync(fp).size;
      }
    };
    if (fs.existsSync(this.root)) walk(this.root);
    return total;
  }
}
