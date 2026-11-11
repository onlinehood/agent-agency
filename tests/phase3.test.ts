import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeTestApp, seedRemote, seedUserAndAgents, codingHandler, tmpDir, ADMIN_TG, type TestApp } from "./helpers.js";
import type { SimulatorHandler } from "../src/executors/simulator.js";
import { scanDiff, scanFiles } from "../src/security/secretScan.js";
import { encodeBackup, exportDatabase, verifyBackup } from "../src/backup/backup.js";
import { runBackup } from "../src/backup/service.js";
import { revokeCredential } from "../src/security/revoke.js";
import { SECRET_REFS, SYSTEM_OWNER } from "../src/app.js";
import { APP_VERSION } from "../src/version.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

async function project(t: TestApp, repo = "tester/demo") {
  const { user, claude, codex } = await seedUserAndAgents(t);
  if (!t.github.repos.has(repo)) seedRemote(t, repo);
  const p = await t.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: repo.split("/")[1]!, repoRef: repo, repoMode: "imported", status: "proposed" });
  const pr = await t.orchestrator.activateProject(user, p.id, [
    { agentId: claude.id, role: "leader" },
    { agentId: codex.id, role: "reviewer" },
  ]);
  await t.scheduler.drain(60_000);
  return { user, claude, codex, project: await t.ctx.repos.projects.get(pr.id) };
}

/** Remote whose `test` always fails (pre-existing) and whose `lint` fails only if a file contains BAD. */
function seedBrokenRemote(t: TestApp, repoRef: string) {
  const bare = path.join(t.bareRoot, `${repoRef.replace("/", "__")}.git`);
  const work = tmpDir("aa-seed-");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  git(work, "init", "-b", "main");
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "legacy", scripts: { test: "node test.js", lint: "node lint.js" } }));
  fs.writeFileSync(path.join(work, "test.js"), "console.error('legacy test broken');process.exit(1)");
  fs.writeFileSync(path.join(work, "lint.js"), "const fs=require('fs');for(const f of fs.readdirSync('.'))if(f.endsWith('.js')&&f!=='lint.js'&&fs.readFileSync(f,'utf8').includes('BAD')){console.error('lint: '+f);process.exit(1)}");
  git(work, "add", "-A");
  git(work, "commit", "-m", "legacy");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-u", "origin", "main");
  t.github.repos.set(repoRef, { fullName: repoRef, defaultBranch: "main", private: true, htmlUrl: `https://github.com/${repoRef}`, cloneUrl: bare });
}

describe("safe stop and resume (Phase 3)", () => {
  it("cancels runs it cannot wait for, re-queues the task without a failure report, and resumes after restart", async () => {
    const base = codingHandler();
    let hang = true;
    let release: () => void = () => undefined;
    const h: SimulatorHandler = (req) => (req.prompt.includes("구현 담당입니다") && hang ? new Promise<string>((r) => (release = () => r("{}"))) : base(req));
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, project: p } = await project(app);
    const task = await app.orchestrator.createTask(user, p, "hello 함수를 추가해줘", [claude.id]);
    await app.scheduler.tick();
    for (let i = 0; i < 200; i++) {
      if ((await app.ctx.repos.tasks.get(task.id)).state === "in_progress" && app.orchestrator.runner.isRunning(task.id)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const messagesBefore = app.out.project.length;
    const r = await app.scheduler.shutdown(50);
    release();
    expect(r.interrupted).toEqual([task.id]);
    const t = await app.ctx.repos.tasks.get(task.id);
    expect(t.state).toBe("queued");
    expect(t.stage).toBe("implementation"); // checkpoint kept
    expect(app.out.project.slice(messagesBefore).some((m) => m.msg.text.includes("막혔어요"))).toBe(false);
    expect((await app.ctx.repos.executions.listByTask(task.id)).some((e) => e.status === "cancelled")).toBe(true);
    // "Restart"
    hang = false;
    app.ctx.lifecycle.shuttingDown = false;
    expect((await app.scheduler.recover()).resumed).toBe(1);
    await app.scheduler.drain(60_000);
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("awaiting_approval");
  }, 120_000);
});

describe("maintenance mode and safe upgrade point", () => {
  it("claims nothing in maintenance; clears automatically after a version change", async () => {
    app = await makeTestApp({ claude: codingHandler(), codex: codingHandler() });
    const { user, project: p } = await project(app);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text: "/maintenance on" });
    const task = await app.orchestrator.createTask(user, p, "hello 함수를 추가해줘", []);
    expect(await app.scheduler.tick()).toBe(0);
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("queued");
    expect(await app.orchestrator.resumeMaintenanceOnStart()).toBe("kept");
    await app.ctx.repos.settings.set("system", "", "maintenance", { on: true, reason: "업데이트 준비", since: new Date().toISOString(), appVersion: "0.0.0-old" });
    expect(await app.orchestrator.resumeMaintenanceOnStart()).toBe("cleared");
    expect(app.scheduler.inMaintenance).toBe(false);
    await app.scheduler.drain(60_000);
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("awaiting_approval");
  }, 120_000);

  it("/upgrade needs approval, then waits for idle, takes a verified backup and gives update steps", async () => {
    app = await makeTestApp();
    const { user } = await seedUserAndAgents(app);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text: "/upgrade" });
    const a = (await app.ctx.repos.approvals.listPending(user.id)).find((x) => x.action === "upgrade")!;
    expect(a).toBeDefined();
    expect(app.scheduler.inMaintenance).toBe(false); // nothing happens before approval
    await app.orchestrator.prepareUpgrade(user, 5_000);
    expect(app.scheduler.inMaintenance).toBe(true);
    expect(app.out.lounge.at(-1)!.msg.text).toContain(`안전한 업데이트 시점입니다 (v${APP_VERSION})`);
    expect(app.out.lounge.at(-1)!.msg.text).toContain("복원 검증 통과");
    expect((await app.ctx.repos.settings.get<{ verified: boolean }>("system", "", "backup.last"))?.verified).toBe(true);
  });
});

describe("per-executor concurrency limit", () => {
  it("never runs more than AA_MAX_RUNS_PER_EXECUTOR at once on one executor", async () => {
    let active = 0;
    let peak = 0;
    const h: SimulatorHandler = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 60));
      active--;
      return "ok";
    };
    app = await makeTestApp({ claude: h, env: { AA_MAX_RUNS_PER_EXECUTOR: "1" } });
    const { user, claude } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "L", slug: "l", status: "active" });
    const tasks = await Promise.all([0, 1, 2].map((i) => app!.ctx.repos.tasks.create({ projectId: p.id, title: `q${i}` })));
    await Promise.all(tasks.map((task) => app!.orchestrator.runner.run({ agent: claude, task, project: p, purpose: "discuss", prompt: "x", cwd: app!.dataDir, mode: "readonly" })));
    expect(peak).toBe(1);
  });
});

describe("verified backups (restore test)", () => {
  it("restores each backup into a scratch database and compares row counts", async () => {
    app = await makeTestApp();
    await seedUserAndAgents(app);
    const ok = await verifyBackup(encodeBackup(await exportDatabase(app.ctx.repos.db)));
    expect(ok.ok).toBe(true);
    expect(ok.rows).toBeGreaterThan(3);
    const corrupt = await verifyBackup(Buffer.from("not a backup"));
    expect(corrupt.ok).toBe(false);
    const r = await runBackup(app.ctx);
    expect(r.verification?.ok).toBe(true);
    const last = await app.ctx.repos.settings.get<{ verified: boolean; verifyDetail: string }>("system", "", "backup.last");
    expect(last).toMatchObject({ verified: true });
  });
});

describe("imported repository baseline", () => {
  it("records the baseline, treats pre-existing failures as non-regressions, and still blocks regressions", async () => {
    let impl = 0;
    const base = codingHandler();
    const h: SimulatorHandler = (req) => {
      if (req.prompt.includes("구현 담당입니다")) {
        impl++;
        // 1st attempt introduces a lint regression, 2nd fixes it; the legacy test stays broken.
        fs.writeFileSync(path.join(req.cwd, "feature.js"), impl === 1 ? "// BAD\n" : "// fine\n");
        return JSON.stringify({ summary: `feature ${impl}`, changes: ["feature.js"] });
      }
      return base(req);
    };
    app = await makeTestApp({ claude: h, codex: h });
    seedBrokenRemote(app, "acme/legacy");
    const { user, project: p } = await project(app, "acme/legacy");
    expect(p.settings.baseline?.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["lint:passed", "test:failed"]);
    expect(app.out.project.some((m) => m.msg.text.includes("원래부터 실패하는 검사(test)"))).toBe(true);
    const task = await app.orchestrator.createTask(user, p, "feature.js 추가해줘", []);
    await app.scheduler.drain(60_000);
    const gates = (await app.ctx.repos.conversations.list(p.id, 200)).filter((m) => m.kind === "quality.gate");
    expect(gates.map((g) => g.machineState.status)).toEqual(["failed", "passed"]); // lint regression blocked, then fixed
    expect(gates[1]!.renderedText).toContain("기존 실패 1건은 회귀 여부만 판단");
    expect(gates[1]!.renderedText).toContain("기존 실패(기준선), 이번 변경의 회귀 아님");
    const t = await app.ctx.repos.tasks.get(task.id);
    expect(t.state).toBe("awaiting_approval");
    expect(t.checkpoint.qualityGate?.preexisting).toEqual(["test"]);
    expect(app.out.allText()).toContain("기존 코드에서 이미 실패하던 검사(이번 변경과 무관): test");
  }, 120_000);
});

describe("secret scanning before anything reaches GitHub", () => {
  const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

  it("detects tokens and sensitive files, allows .env.example", () => {
    const diff = ["+++ b/src/config.js", "@@ -0,0 +1,2 @@", "+const ok = process.env.GITHUB_TOKEN;", `+const t = "${TOKEN}";`].join("\n");
    expect(scanDiff(diff)).toEqual([{ file: "src/config.js", line: 2, kind: "GitHub 토큰" }]);
    expect(scanFiles([".env", ".env.example", "deploy/key.pem", "src/app.ts"]).map((f) => f.file)).toEqual([".env", "deploy/key.pem"]);
  });

  it("blocks a leaked token in the gate, and squashes history so it never reaches the remote", async () => {
    let impl = 0;
    const base = codingHandler();
    const h: SimulatorHandler = (req) => {
      if (req.prompt.includes("구현 담당입니다")) {
        impl++;
        fs.writeFileSync(path.join(req.cwd, "hello.js"), "module.exports=()=>'hello'\n");
        fs.writeFileSync(path.join(req.cwd, "config.js"), impl === 1 ? `module.exports = { token: "${TOKEN}" };\n` : "module.exports = { token: process.env.GITHUB_TOKEN };\n");
        return JSON.stringify({ summary: `impl ${impl}`, changes: ["hello.js", "config.js"] });
      }
      return base(req);
    };
    app = await makeTestApp({ claude: h, codex: h });
    const { user, project: p } = await project(app);
    const task = await app.orchestrator.createTask(user, p, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const gates = (await app.ctx.repos.conversations.list(p.id, 200)).filter((m) => m.kind === "quality.gate");
    expect(gates[0]!.machineState.status).toBe("failed");
    expect(gates[0]!.renderedText).toContain("비밀정보 의심 1건: config.js:1 (GitHub 토큰)");
    expect(gates[0]!.renderedText).not.toContain(TOKEN);
    const t = await app.ctx.repos.tasks.get(task.id);
    expect(t.state).toBe("awaiting_approval");
    const bare = path.join(app.bareRoot, "tester__demo.git");
    const history = execFileSync("git", ["log", "-p", t.branch!], { cwd: bare }).toString();
    expect(history).not.toContain(TOKEN);
    expect((await app.ctx.repos.audit.list(50)).some((e) => e.action === "git.squash_secret_history")).toBe(true);
  }, 120_000);
});

describe("usage and performance monitoring", () => {
  it("aggregates persisted executions per executor and per agent", async () => {
    const base = codingHandler();
    const h: SimulatorHandler = async (req) => ({ text: String(await base(req)), usage: { input_tokens: 100, output_tokens: 20, api_equivalent_cost_usd_estimate: 0.01 }, usageSource: "official" });
    app = await makeTestApp({ claude: h, codex: h });
    const { user, project: p } = await project(app);
    const task = await app.orchestrator.createTask(user, p, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const merge = (await app.ctx.repos.approvals.listPending(user.id)).find((a) => a.action === "pr_merge")!;
    await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `a:ok:${merge.id}:${merge.nonce}`, chatId: p.chatId!, messageId: 1 });
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("done");
    const since = new Date(Date.now() - 86400_000).toISOString();
    const byAdapter = await app.ctx.repos.executions.usageByAdapter(since);
    const claudeRow = byAdapter.find((r) => r.adapterId === "claude-cli")!;
    expect(claudeRow.runs).toBeGreaterThanOrEqual(2);
    expect(claudeRow.inputTokens).toBe(100 * claudeRow.runs);
    const perf = await app.ctx.repos.executions.agentPerformance(user.id, since);
    expect(perf.find((x) => x.name === "클로드")).toMatchObject({ tasksDone: 1, firstPass: 1 });
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text: "/usage 7" });
    const text = app.out.lounge.at(-1)!.msg.text;
    expect(text).toContain("claude-cli: 실행");
    expect(text).toContain("(추정, 구독 실제 과금 아님)");
    expect(text).toContain("첫 시도 통과율 100%");
    expect(text).toContain("필수 검증·리뷰를 줄이는 데 쓰지 않습니다");
  }, 120_000);
});

describe("leaked credential response", () => {
  it("blocks locally and calls GitHub's official revocation; explains non-revocable tokens", async () => {
    app = await makeTestApp();
    await app.ctx.vault.put(SYSTEM_OWNER, "GitHub token", "ghp_secretvalue123456789012345678901234", null, SECRET_REFS.githubToken);
    await app.ctx.vault.put(SYSTEM_OWNER, "Telegram bot token", "123:abc", null, SECRET_REFS.telegramToken);
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const gh = await revokeCredential(app.ctx, SECRET_REFS.githubToken, fakeFetch);
    expect(gh).toMatchObject({ locallyBlocked: true, official: "revoked" });
    expect(calls[0]!.url).toBe("https://api.github.com/credentials/revoke");
    expect(JSON.parse(calls[0]!.body)).toEqual({ credentials: ["ghp_secretvalue123456789012345678901234"] });
    expect(await app.ctx.vault.has(SECRET_REFS.githubToken)).toBe(false);
    const tg = await revokeCredential(app.ctx, SECRET_REFS.telegramToken, fakeFetch);
    expect(tg.official).toBe("unsupported");
    expect(tg.detail).toContain("@BotFather");
    expect(calls).toHaveLength(1);
    const failing = (async () => new Response(null, { status: 422 })) as unknown as typeof fetch;
    await app.ctx.vault.put(SYSTEM_OWNER, "GitHub token", "ghp_other1234567890123456789012345678", null, SECRET_REFS.githubToken);
    expect((await revokeCredential(app.ctx, SECRET_REFS.githubToken, failing)).official).toBe("failed");
  });
});
