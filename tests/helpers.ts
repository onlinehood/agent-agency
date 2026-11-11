import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config/index.js";
import { createApp, type App } from "../src/app.js";
import { openAndMigrate } from "../src/db/index.js";
import { RecordingOutboundPort } from "../src/core/orchestration/ports.js";
import { FakeGitHubService } from "../src/github/fake.js";
import { SimulatorAdapter, type SimulatorHandler } from "../src/executors/simulator.js";
import type { ExecutorAdapter } from "../src/executors/types.js";

export const ADMIN_TG = 1001;

export function tmpDir(prefix = "aa-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestApp extends App {
  out: RecordingOutboundPort;
  github: FakeGitHubService;
  claude: SimulatorAdapter;
  codex: SimulatorAdapter;
  dataDir: string;
  bareRoot: string;
}

export async function makeTestApp(opts: { claude?: SimulatorHandler; codex?: SimulatorHandler; extraAdapters?: ExecutorAdapter[]; databaseUrl?: string; env?: Record<string, string> } = {}): Promise<TestApp> {
  const dataDir = tmpDir();
  const bareRoot = tmpDir("aa-bare-");
  const config = loadConfig({ AA_DATA_DIR: dataDir, TELEGRAM_ADMIN_USER_IDS: String(ADMIN_TG), AA_MAX_CONCURRENT_PROJECTS: "2", LOG_LEVEL: "silent", ...(opts.env ?? {}) } as NodeJS.ProcessEnv);
  const db = await openAndMigrate(opts.databaseUrl ? { databaseUrl: opts.databaseUrl } : {});
  const out = new RecordingOutboundPort();
  const github = new FakeGitHubService();
  const claude = new SimulatorAdapter("claude-cli", opts.claude ?? (() => "{}"), 0, { provider: "anthropic" });
  const codex = new SimulatorAdapter("codex-cli", opts.codex ?? (() => "{}"), 0, { provider: "openai" });
  const app = await createApp(config, {
    db,
    out,
    github,
    adapters: [...(opts.extraAdapters ?? []), claude, codex],
    masterKey: randomBytes(32),
    remoteUrlFor: (ref) => path.join(bareRoot, `${ref.replace("/", "__")}.git`),
  });
  await app.start({ scheduler: false, maintenance: false });
  await app.ctx.flags.set("quality.security_scan", false);
  return Object.assign(app, { out, github, claude, codex, dataDir, bareRoot });
}

/** Create a bare "remote" repo with a tiny node project whose test checks hello.js. */
export function seedRemote(app: TestApp, repoRef: string): string {
  const bare = path.join(app.bareRoot, `${repoRef.replace("/", "__")}.git`);
  const work = tmpDir("aa-seed-");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  git(work, "init", "-b", "main");
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node test.js" } }, null, 2));
  fs.writeFileSync(path.join(work, "test.js"), `const fs=require('fs');if(!fs.existsSync('hello.js')){console.log('no hello.js yet');process.exit(0)}const h=require('./hello.js');if(h()!=='hello'){console.error('bad');process.exit(1)}console.log('ok')`);
  git(work, "add", "-A");
  git(work, "commit", "-m", "init");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-u", "origin", "main");
  app.github.repos.set(repoRef, { fullName: repoRef, defaultBranch: "main", private: true, htmlUrl: `https://github.com/${repoRef}`, cloneUrl: bare });
  return bare;
}

export async function seedUserAndAgents(app: TestApp) {
  const user = await app.ctx.repos.users.upsertByTelegram(ADMIN_TG, "대표");
  const p1 = await app.ctx.repos.personas.create("careful");
  const p2 = await app.ctx.repos.personas.create("bold");
  const claude = await app.ctx.repos.agents.create({ ownerId: user.id, name: "클로드", provider: "anthropic", adapterId: "claude-cli", modelPolicy: "auto", authMode: "official_subscription", personaId: p1.id, organizationRole: "auto", dialoguePolicy: "relationship_aware", memoryEnabled: true, relationshipHistory: true, enabled: true });
  const codex = await app.ctx.repos.agents.create({ ownerId: user.id, name: "코덱스", provider: "openai", adapterId: "codex-cli", modelPolicy: "auto", authMode: "official_subscription", personaId: p2.id, organizationRole: "auto", dialoguePolicy: "relationship_aware", memoryEnabled: true, relationshipHistory: true, enabled: true });
  await app.ctx.repos.users.updateProfile(user.id, { loungeChatId: "-100123" });
  return { user, claude, codex };
}

/** Simulator behaviour that plans, implements (writes hello.js), and reviews. */
export function codingHandler(opts: { failFirstImpl?: boolean; rejectFirstReview?: boolean } = {}): SimulatorHandler {
  let impl = 0;
  let reviews = 0;
  return (req) => {
    const p = req.prompt;
    if (p.includes("프로젝트 리더입니다")) {
      return JSON.stringify({ summary: "hello 함수 추가", acceptance_criteria: ["hello()가 'hello'를 반환", "npm test 통과"], difficulty: "easy", architecture_change: false, scope_expansion: false, core_feature: false, risks: [], questions: [], message: "계획 세웠습니다." });
    }
    if (p.includes("코드 리뷰어")) {
      reviews++;
      if (opts.rejectFirstReview && reviews === 1) return JSON.stringify({ approved: false, summary: "주석 필요", issues: [{ severity: "major", description: "설명 주석 추가" }], message: "주석 하나만 부탁해요." });
      return JSON.stringify({ approved: true, summary: "문제 없음", issues: [], message: "좋네요, 승인합니다." });
    }
    if (p.includes("구현 담당")) {
      impl++;
      const body = opts.failFirstImpl && impl === 1 ? "module.exports=()=>'nope'" : "module.exports=()=>'hello'";
      fs.writeFileSync(path.join(req.cwd, "hello.js"), body + "\n");
      return JSON.stringify({ summary: "hello.js 추가", changes: ["hello.js 추가"], tests_added: [], open_issues: [], message: "구현 끝났어요, 봐주세요." });
    }
    if (p.includes("JSON만 출력: {\"position\"")) return JSON.stringify({ position: "동의", agree: true, message: "좋아요, 그렇게 하죠." });
    return "답변입니다.";
  };
}
