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
}

export function snapshot(dataDir: string): ResourceSnapshot {
  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const st = fs.statfsSync(dataDir);
    diskFreeBytes = Number(st.bavail) * Number(st.bsize);
    diskTotalBytes = Number(st.blocks) * Number(st.bsize);
  } catch {}
  return { cpus: os.cpus().length || 1, load1: os.loadavg()[0] ?? 0, totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), diskFreeBytes, diskTotalBytes };
}

export interface Thresholds {
  minFreeMemBytes: number;
  minFreeDiskBytes: number;
  memPerTaskBytes: number;
  maxLoadPerCpu: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minFreeMemBytes: 512 * 1024 ** 2,
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
  if (s.freeMemBytes < t.minFreeMemBytes) {
    allowed = 1;
    accept = false;
    reasons.push("가용 메모리 부족 — 신규 작업 연기");
  }
  if (s.load1 > s.cpus * t.maxLoadPerCpu) {
    allowed = Math.min(allowed, 1);
    reasons.push(`부하 높음(load ${s.load1.toFixed(1)}) — 동시성 축소`);
  }
  if (s.diskFreeBytes != null && s.diskFreeBytes < t.minFreeDiskBytes) {
    accept = false;
    reasons.push(`디스크 여유 ${(s.diskFreeBytes / 1024 ** 3).toFixed(1)}GB — 신규 작업 연기`);
  }
  return { allowedConcurrency: Math.max(1, allowed), acceptNewWork: accept, reasons };
}
