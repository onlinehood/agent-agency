import os from "node:os";
import fs from "node:fs";

/**
 * Host resource detection (PRD §16, §8.2). Concurrency and local workload are scaled
 * from the real CPU/RAM/disk of whatever server this runs on — no cloud-specific APIs.
 */
export interface ResourceSnapshot {
  cpus: number;
  load1: number;
  totalMemBytes: number;
  freeMemBytes: number;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
}

export interface ResourceDecision {
  allowedConcurrency: number;
  acceptNewWork: boolean;
  reasons: string[];
  /** Only the reasons that stop new work (memory, disk) — what an alert should say. */
  blocking: string[];
}

/**
 * Memory available for new work: MemAvailable (free + reclaimable cache) plus half of free swap.
 * os.freemem() is MemFree, which excludes the page cache and is normally tiny on a healthy Linux
 * host — using it made small servers look permanently out of memory. Swap counts half because
 * work still runs when paged out, only slower (small VMs are told to add swap).
 */
export function availableMemBytes(meminfo?: string): number {
  try {
    const text = meminfo ?? fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m").exec(text)?.[1] ?? NaN) * 1024;
    const avail = kb("MemAvailable");
    if (Number.isFinite(avail)) return avail + (Number.isFinite(kb("SwapFree")) ? kb("SwapFree") / 2 : 0);
  } catch {}
  return os.freemem();
}

export function snapshot(dataDir: string): ResourceSnapshot {
  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const st = fs.statfsSync(dataDir);
    diskFreeBytes = Number(st.bavail) * Number(st.bsize);
    diskTotalBytes = Number(st.blocks) * Number(st.bsize);
  } catch {}
  return { cpus: os.cpus().length || 1, load1: os.loadavg()[0] ?? 0, totalMemBytes: os.totalmem(), freeMemBytes: availableMemBytes(), diskFreeBytes, diskTotalBytes };
}

export interface Thresholds {
  minFreeMemBytes: number;
  minFreeDiskBytes: number;
  memPerTaskBytes: number;
  maxLoadPerCpu: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minFreeMemBytes: 300 * 1024 ** 2,
  minFreeDiskBytes: 2 * 1024 ** 3,
  memPerTaskBytes: 1.5 * 1024 ** 3,
  maxLoadPerCpu: 1.5,
};

export function decide(s: ResourceSnapshot, configuredMax: number, t: Thresholds = DEFAULT_THRESHOLDS): ResourceDecision {
  const reasons: string[] = [];
  let allowed = configuredMax;
  const byMem = Math.max(1, Math.floor(s.totalMemBytes / t.memPerTaskBytes));
  if (byMem < allowed) {
    allowed = byMem;
    reasons.push(`RAM ${(s.totalMemBytes / 1024 ** 3).toFixed(1)}GB 기준 동시 실행 ${byMem}개로 제한`);
  }
  if (s.cpus < allowed) {
    allowed = Math.max(1, s.cpus);
    reasons.push(`CPU ${s.cpus}코어 기준 제한`);
  }
  let accept = true;
  const blocking: string[] = [];
  if (s.freeMemBytes < t.minFreeMemBytes) {
    allowed = 1;
    accept = false;
    const why = `사용 가능한 메모리 ${Math.round(s.freeMemBytes / 1024 ** 2)}MB (최소 ${Math.round(t.minFreeMemBytes / 1024 ** 2)}MB)`;
    reasons.push(`${why} — 신규 작업 연기`);
    blocking.push(why);
  }
  if (s.load1 > s.cpus * t.maxLoadPerCpu) {
    allowed = Math.min(allowed, 1);
    reasons.push(`부하 높음(load ${s.load1.toFixed(1)}) — 동시성 축소`);
  }
  if (s.diskFreeBytes != null && s.diskFreeBytes < t.minFreeDiskBytes) {
    accept = false;
    const why = `디스크 여유 ${(s.diskFreeBytes / 1024 ** 3).toFixed(1)}GB`;
    reasons.push(`${why} — 신규 작업 연기`);
    blocking.push(why);
  }
  return { allowedConcurrency: Math.max(1, allowed), acceptNewWork: accept, reasons, blocking };
}
