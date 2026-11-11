#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { loadConfig, loadDotEnv, ensureDataDirs } from "./config/index.js";
import { createApp } from "./app.js";
import { Runtime } from "./runtime.js";
import { createWebApp } from "./web/server.js";
import { WebAuth } from "./web/auth.js";
import { openAndMigrate, openDatabase, checkSchemaCompatibility, migrate, latestSchemaVersion, currentSchemaVersion } from "./db/index.js";
import { Repos } from "./db/repositories.js";
import { runDiagnostics, diagnosticsMarkdown } from "./ops/diagnostics.js";
import { verifyExecutor } from "./executors/verify.js";
import { runBackup } from "./backup/service.js";
import { restoreFromFile, createLocalBackup } from "./backup/backup.js";
import { logger } from "./util/logger.js";
import { ensureControlToken, httpControlClient } from "./ops/control.js";
import { SetupCli, ttyDeps } from "./cli/setup.js";
import { TtyPrompter, CancelSignal } from "./cli/prompt.js";
import { c } from "./cli/term.js";
import { mascot } from "./cli/sprites.js";

loadDotEnv();

const USAGE = `AgentAgency — Your Agents. Your Agency.

사용법: agent-agency <command>

  setup                 대화형 초기 설정 (Telegram → AI 로그인 → GitHub → 기본 설정 → 점검)
  config                대화형 설정 메뉴 (모든 설정 변경)
  start                 오케스트레이터 + Telegram 봇 + (선택) 관리 웹 실행
  migrate               DB 스키마 마이그레이션
  doctor [--markdown]   전체 연결·실행기 지원 범위 진단
  verify-executor <id>  공식 구독 실행기에 읽기 전용 검증 실행 후 근거 기록
  backup                로컬 백업 생성 + 복원 검증 (AA_BACKUP_PASSPHRASE 설정 시 암호화)
  restore <file>        백업 복원 (복원 전 현재 상태를 자동 백업)
  upgrade-check         업데이트 전 호환성 검사 + 사전 백업
  setup-token           (선택) 웹 초기 설정용 1회용 토큰 재발급
  art                   마스코트 출력
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadConfig();
  ensureDataDirs(config);
  const dbCfg = { databaseUrl: config.DATABASE_URL, pgliteDir: config.pgliteDir };

  switch (cmd) {
    case "start": {
      const app = await createApp(config);
      const rt = new Runtime(app);
      await rt.start();
      const web = createWebApp(rt, { controlToken: ensureControlToken(config) });
      // Optional web console: the token is only for it; `aa token` shows a fresh one when needed.
      await new WebAuth(app.ctx.repos).ensureSetupToken(config.AA_SETUP_TOKEN);
      const server = serve({ fetch: web.fetch, port: config.AA_WEB_PORT, hostname: config.AA_WEB_BIND });
      logger.info({ url: `http://${config.AA_WEB_BIND}:${config.AA_WEB_PORT}` }, "admin web listening");
      if (!(await app.ctx.repos.settings.get<boolean>("system", "", "setup.completed"))) {
        process.stdout.write(`\n==== AgentAgency ====\n초기 설정: 설치 폴더에서  aa setup\n(컨테이너 안에서는  agent-agency setup)\n=====================\n\n`);
      }
      const shutdown = async () => {
        logger.info("shutting down");
        server.close();
        await rt.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      return;
    }
    case "setup":
    case "config": {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(`대화형 터미널이 필요합니다. 설치 폴더에서 aa ${cmd} 를 실행하세요 (docker compose exec -it app agent-agency ${cmd}).`);
        process.exitCode = 2;
        return;
      }
      const app = await createApp(config, { skipDetect: true });
      const cli = new SetupCli(app, ttyDeps(new TtyPrompter(), httpControlClient(config)));
      try {
        // --continue: launched from install.sh / aa, which already showed the banner.
        const banner = !args.includes("--continue");
        if (cmd === "setup") await cli.runSetup({ banner });
        else await cli.runConfig(banner);
      } catch (e) {
        if (!(e instanceof CancelSignal)) throw e;
        console.log(c.dim(`\n중단했어요. 저장된 설정은 그대로이며, 이어서 하려면 aa ${cmd}`));
        process.exitCode = 130;
      } finally {
        await app.stop();
      }
      return;
    }
    case "art": {
      console.log(mascot().join("\n"));
      return;
    }
    case "migrate": {
      const db = await openDatabase(dbCfg);
      const compat = await checkSchemaCompatibility(db);
      if (!compat.ok) throw new Error(compat.reason);
      const r = await migrate(db);
      console.log(`schema v${r.from} → v${r.to}${r.applied.length ? ` (applied: ${r.applied.join(", ")})` : " (up to date)"}`);
      await db.close();
      return;
    }
    case "doctor": {
      const app = await createApp(config, { skipDetect: true });
      const checks = await runDiagnostics(app.ctx);
      if (args.includes("--markdown")) console.log(diagnosticsMarkdown(checks));
      else for (const c of checks) console.log(`${c.status.padEnd(11)} ${c.area} / ${c.name}: ${c.detail}`);
      await app.stop();
      process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
      return;
    }
    case "verify-executor": {
      if (!args[0]) throw new Error("실행기 id가 필요합니다 (예: claude-cli, codex-cli, codex-cloud)");
      const app = await createApp(config, { skipDetect: true });
      const user = (await app.ctx.repos.users.list())[0];
      const r = await verifyExecutor(app.ctx, args[0], { userId: user?.id });
      console.log(r.ok ? `✅ ${r.detail}` : `❌ ${r.detail}`);
      await app.stop();
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "backup": {
      const app = await createApp(config, { skipDetect: true });
      const r = await runBackup(app.ctx);
      console.log(`${r.file} (${r.bytes} bytes, sha256 ${r.sha256}${r.encrypted ? ", encrypted" : ""}${r.remote ? `, remote ${r.remote}` : ""})`);
      console.log(r.verification?.ok ? `복원 검증 통과: ${r.verification.rows}행` : `복원 검증 실패: ${r.verification?.reason ?? "?"}`);
      process.exitCode = r.verification && !r.verification.ok ? 1 : 0;
      await app.stop();
      return;
    }
    case "restore": {
      if (!args[0]) throw new Error("복원할 백업 파일 경로가 필요합니다.");
      const db = await openAndMigrate(dbCfg);
      const pre = await createLocalBackup(db, config.backupsDir, { passphrase: process.env.AA_BACKUP_PASSPHRASE || undefined });
      console.log(`사전 백업: ${pre.file}`);
      const r = await restoreFromFile(db, args[0], process.env.AA_BACKUP_PASSPHRASE || undefined);
      await new Repos(db).audit.record("cli", "backup.restore", "backup", "success", r);
      console.log(`복원 완료: ${r.rows} rows (backup schema v${r.schemaVersion})`);
      await db.close();
      return;
    }
    case "upgrade-check": {
      const db = await openDatabase(dbCfg);
      const compat = await checkSchemaCompatibility(db);
      const repos = new Repos(db);
      const running = (await currentSchemaVersion(db)) > 0 ? await repos.tasks.listByStates(["planning", "in_progress", "review"]) : [];
      console.log(`DB 스키마 v${compat.dbVersion}, 앱 스키마 v${latestSchemaVersion()} — ${compat.ok ? "호환" : `비호환: ${compat.reason}`}`);
      console.log(running.length ? `⚠️ 진행 중인 작업 ${running.length}건 — 안전 시점(작업 완료 또는 /pause) 이후 업데이트하세요.` : "진행 중인 작업 없음 — 안전한 업데이트 시점입니다.");
      if ((await currentSchemaVersion(db)) > 0) {
        const b = await createLocalBackup(db, config.backupsDir, { passphrase: process.env.AA_BACKUP_PASSPHRASE || undefined, keep: 14 });
        console.log(`사전 백업: ${b.file}`);
      }
      await db.close();
      process.exitCode = compat.ok && !running.length ? 0 : 2;
      return;
    }
    case "setup-token": {
      const db = await openAndMigrate(dbCfg);
      const auth = new WebAuth(new Repos(db));
      if (await auth.hasAdmin()) console.log("관리자가 이미 설정되어 있습니다.");
      else console.log(`설정 토큰: ${await auth.regenerateSetupToken()}`);
      await db.close();
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  logger.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
