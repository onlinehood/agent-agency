import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../core/context.js";
import { currentSchemaVersion, latestSchemaVersion } from "../db/index.js";
import { resolveSecret, SECRET_REFS } from "../app.js";
import { diagnoseTelegram } from "../telegram/gateway.js";
import { decide, snapshot } from "./resources.js";
import type { CapabilityStatus } from "../executors/types.js";

export interface Check {
  area: string;
  name: string;
  status: "ok" | "warn" | "fail" | "unsupported";
  detail: string;
}

const CAP_KO: Record<CapabilityStatus, string> = { supported: "지원", unsupported: "미지원", unverified: "미확인" };

/**
 * Full connection diagnostics (PRD §18 step 7, §10.1). Shows connection state, auth
 * expiry, usable executors and the exact reason for anything unsupported.
 */
export async function runDiagnostics(ctx: AppContext, opts: { detect?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  // DB
  try {
    const v = await currentSchemaVersion(ctx.repos.db);
    checks.push({ area: "데이터베이스", name: `${ctx.repos.db.kind === "postgres" ? "PostgreSQL" : "내장 PostgreSQL(PGlite)"}`, status: v === latestSchemaVersion() ? "ok" : "warn", detail: `스키마 v${v} / 앱 v${latestSchemaVersion()}` });
    if (ctx.repos.db.kind === "pglite") checks.push({ area: "데이터베이스", name: "운영 권장", status: "warn", detail: "운영 환경에서는 Docker Compose의 PostgreSQL(DATABASE_URL) 사용을 권장합니다." });
  } catch (e) {
    checks.push({ area: "데이터베이스", name: "연결", status: "fail", detail: (e as Error).message });
  }
  // Telegram
  const tgToken = await resolveSecret(ctx, ctx.config.TELEGRAM_BOT_TOKEN, SECRET_REFS.telegramToken);
  const lounge = ctx.config.TELEGRAM_LOUNGE_CHAT_ID ?? (await ctx.repos.settings.get<string>("system", "", "telegram.lounge_chat_id"));
  if (!tgToken) checks.push({ area: "Telegram", name: "봇", status: "fail", detail: "봇 토큰 미설정" });
  else {
    try {
      const d = await diagnoseTelegram(tgToken, lounge);
      for (const c of d.checks) checks.push({ area: "Telegram", name: c.name, status: c.ok ? "ok" : "fail", detail: c.detail });
      if (!lounge) checks.push({ area: "Telegram", name: "마스터 라운지", status: "warn", detail: "Topics가 활성화된 그룹 ID 미설정 — 개인 채팅으로 동작하며 프로젝트 Topic을 만들 수 없습니다." });
    } catch (e) {
      checks.push({ area: "Telegram", name: "연결", status: "fail", detail: (e as Error).message });
    }
  }
  const admins = [...ctx.config.TELEGRAM_ADMIN_USER_IDS, ...((await ctx.repos.settings.get<number[]>("system", "", "telegram.admin_ids")) ?? [])];
  checks.push({ area: "Telegram", name: "관리자 사용자 ID", status: admins.length ? "ok" : "fail", detail: admins.length ? admins.join(", ") : "숫자 사용자 ID 미설정 — 아무도 봇을 조작할 수 없습니다." });
  // Executors
  if (opts.detect !== false) await ctx.executors.detectAll();
  for (const a of ctx.executors.list()) {
    const s = ctx.executors.getStatus(a.id);
    const u = ctx.executors.usabilityReason(a.id);
    const caps = s ? `실행 ${CAP_KO[s.capabilities.run]}, 취소 ${CAP_KO[s.capabilities.cancel]}, 재개 ${CAP_KO[s.capabilities.resume]}, 모델선택 ${CAP_KO[s.capabilities.modelSelection]}, 사용량 ${CAP_KO[s.capabilities.usageInfo]}` : "";
    checks.push({
      area: "실행기",
      name: `${a.displayName} [${a.kind}]`,
      status: u.usable ? "ok" : s?.installed ? "warn" : "unsupported",
      detail: `${u.reason}${s?.version ? ` · ${s.version}` : ""}${caps ? ` · ${caps}` : ""}${s?.notes.length ? ` · ${s.notes.join(" ")}` : ""}`,
    });
  }
  checks.push({ area: "실행기", name: "종량제 유료 API", status: "ok", detail: (await ctx.flags.isEnabled("executors.paid_api")) ? "허용됨(매 사용 시 명시적 승인 필요)" : "비활성 — 자동 전환하지 않음" });
  // GitHub
  if (!ctx.github) checks.push({ area: "GitHub", name: "연결", status: "warn", detail: "미연결 — 로컬 저장소로만 작업하며 PR을 만들 수 없습니다." });
  else {
    try {
      const me = await ctx.github.whoami();
      checks.push({ area: "GitHub", name: "인증", status: "ok", detail: `${me.login} (${me.scopes.join(", ") || "fine-grained/app"})` });
    } catch (e) {
      checks.push({ area: "GitHub", name: "인증", status: "fail", detail: (e as Error).message.slice(0, 200) });
    }
  }
  // Resources
  const snap = snapshot(ctx.config.dataDir);
  const d = decide(snap, ctx.config.AA_MAX_CONCURRENT_PROJECTS);
  checks.push({
    area: "서버 자원",
    name: "CPU/RAM/디스크",
    status: d.acceptNewWork ? "ok" : "warn",
    detail: `CPU ${snap.cpus}코어 · RAM ${(snap.totalMemBytes / 1024 ** 3).toFixed(1)}GB(여유 ${(snap.freeMemBytes / 1024 ** 3).toFixed(1)}GB) · 디스크 여유 ${snap.diskFreeBytes != null ? (snap.diskFreeBytes / 1024 ** 3).toFixed(1) + "GB" : "?"} · 동시 실행 ${d.allowedConcurrency}${d.reasons.length ? ` · ${d.reasons.join(", ")}` : ""}`,
  });
  // Storage the app must be able to write (a missing host ./backups is created by Docker as root).
  for (const [name, dir] of [["백업 폴더", ctx.config.backupsDir], ["데이터 폴더", ctx.config.dataDir]] as const) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      checks.push({ area: "저장소", name, status: "ok", detail: `${dir} 쓰기 가능` });
    } catch (e) {
      checks.push({ area: "저장소", name, status: "fail", detail: `${dir}에 쓸 수 없습니다 (${(e as NodeJS.ErrnoException).code ?? "오류"}). 서버에서 \`sudo chown -R 1000:1000 ./backups\` 후 재시작하세요.` });
    }
  }
  checks.push({ area: "작업 공간", name: "격리 방식", status: ctx.config.AA_WORKSPACE_MODE === "docker" ? "ok" : "warn", detail: ctx.config.AA_WORKSPACE_MODE === "docker" ? "프로젝트별 비루트 Docker 컨테이너" : "로컬 모드 — 운영에서는 AA_WORKSPACE_MODE=docker 권장" });
  return checks;
}

export function diagnosticsMarkdown(checks: Check[]): string {
  const icon = { ok: "✅", warn: "⚠️", fail: "❌", unsupported: "⛔" } as const;
  const lines = ["| 영역 | 항목 | 상태 | 상세 |", "|---|---|---|---|"];
  for (const c of checks) lines.push(`| ${c.area} | ${c.name} | ${icon[c.status]} | ${c.detail.replace(/\|/g, "/")} |`);
  return lines.join("\n");
}
