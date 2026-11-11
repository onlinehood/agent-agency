import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeTestApp, seedRemote, seedUserAndAgents, codingHandler, ADMIN_TG, type TestApp } from "./helpers.js";
import type { SimulatorHandler } from "../src/executors/simulator.js";
import { preservesFacts, preservedTokens } from "../src/core/organization/stylist.js";
import { approvalCard } from "../src/core/approvals/card.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

/** Like codingHandler, but every implement/fix call changes hello.js so each attempt commits. */
function revisingHandler(): SimulatorHandler {
  const base = codingHandler();
  let n = 0;
  return (req) => {
    if (req.prompt.includes("구현 담당입니다")) {
      n++;
      fs.writeFileSync(path.join(req.cwd, "hello.js"), `// revision ${n}\nmodule.exports=()=>'hello'\n`);
      return JSON.stringify({ summary: `rev ${n}`, changes: ["hello.js"], message: "고쳤어요." });
    }
    return base(req);
  };
}

async function setupProject(t: TestApp, settings: Record<string, unknown> = {}) {
  const { user, claude, codex } = await seedUserAndAgents(t);
  seedRemote(t, "tester/demo");
  const p = await t.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed", settings });
  const project = await t.orchestrator.activateProject(user, p.id, [
    { agentId: claude.id, role: "leader" },
    { agentId: codex.id, role: "reviewer" },
  ]);
  await t.scheduler.drain(60_000); // baseline first
  return { user, claude, codex, project };
}

const click = (t: TestApp, data: string, chatId: string, topicId: number | null = null) => t.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data, chatId, messageId: 1, topicId });

describe("Phase 2 approval UX: 수정 요청 → feedback → revision", () => {
  it("rejecting a merge collects the next message as feedback and updates the same PR", async () => {
    const h = revisingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user, project } = await setupProject(app);
    const task = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const merge = (await app.ctx.repos.approvals.listPending(user.id)).find((a) => a.action === "pr_merge")!;
    const r = await click(app, `a:no:${merge.id}:${merge.nonce}`, project.chatId!, project.topicId!);
    expect(r.toast).toContain("메시지");
    expect(app.out.edits.at(-1)!.msg.text).toContain("고칠 점을 이 채팅에");
    expect((await app.ctx.repos.tasks.get(task.id)).blockedReason).toBe("사용자 수정 의견 대기");

    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "hello.js 상단에 설명 주석을 달아줘" });
    await app.scheduler.drain(60_000);

    const t = await app.ctx.repos.tasks.get(task.id);
    expect(t.state).toBe("awaiting_approval");
    expect(t.checkpoint.userRevision).toBe(1);
    expect((await app.ctx.repos.approvals.get(merge.id)).feedback).toBe("hello.js 상단에 설명 주석을 달아줘");
    expect((await app.ctx.repos.approvals.listPending(user.id)).some((a) => a.action === "pr_merge" && a.id !== merge.id)).toBe(true);
    // Same PR, new commit pushed, revision noted on the PR.
    expect(app.github.calls.filter((c) => c.startsWith("createPullRequest"))).toHaveLength(1);
    const bare = path.join(app.bareRoot, "tester__demo.git");
    const log = execFileSync("git", ["log", "--oneline", t.branch!], { cwd: bare }).toString().trim().split("\n");
    expect(log.length).toBeGreaterThanOrEqual(3); // init + implement + revision
    expect(app.github.comments.at(-1)!.body).toContain("사용자 수정 요청 반영 (1차)");
    // The feedback became the newest confirmed requirement in memory.
    expect((await app.ctx.repos.memories.list(project.id, ["requirement"])).some((m) => m.content.includes("설명 주석"))).toBe(true);
    // The fix prompt carried the feedback.
    expect(app.claude.calls.some((c) => c.prompt.includes("사용자 수정 요청: hello.js 상단에 설명 주석을 달아줘"))).toBe(true);
  }, 120_000);

  it("rejecting a plan replans with the feedback as the latest instruction", async () => {
    const h = revisingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user, project } = await setupProject(app, { approvalMode: "strict" });
    const task = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const plan = (await app.ctx.repos.approvals.listPending(user.id)).find((a) => a.action === "plan_scope")!;
    await click(app, `a:no:${plan.id}:${plan.nonce}`, project.chatId!, project.topicId!);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "TypeScript로 작성해줘" });
    await app.scheduler.drain(60_000);
    const t = await app.ctx.repos.tasks.get(task.id);
    expect(t.description).toContain("[사용자 수정 의견] TypeScript로 작성해줘");
    expect(app.claude.calls.filter((c) => c.prompt.includes("프로젝트 리더입니다"))).toHaveLength(2);
    expect((await app.ctx.repos.approvals.listPending(user.id)).filter((a) => a.action === "plan_scope")).toHaveLength(1);
  }, 120_000);

  it("rejecting a project proposal re-proposes with the feedback", async () => {
    const h = codingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user } = await seedUserAndAgents(app);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text: '새 프로젝트 만들어줘 "메모장"' });
    const a = (await app.ctx.repos.approvals.listPending(user.id)).find((x) => x.action === "create_project")!;
    await click(app, `a:no:${a.id}:${a.nonce}`, "-100123");
    expect((await app.ctx.repos.projects.get(a.projectId!)).status).toBe("archived");
    // A message in another topic is not taken as feedback.
    expect(await app.orchestrator.consumeFeedback(user, "-100123", 999, "무시")).toBe(false);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text: "모바일 우선으로 해줘" });
    const again = (await app.ctx.repos.approvals.listPending(user.id)).find((x) => x.action === "create_project")!;
    expect(again.id).not.toBe(a.id);
    expect((await app.ctx.repos.projects.get(again.projectId!)).description).toContain("모바일 우선으로 해줘");
  });

  it("ignores feedback after the window expires", async () => {
    app = await makeTestApp({ claude: codingHandler(), codex: codingHandler() });
    const { user } = await seedUserAndAgents(app);
    await app.ctx.repos.settings.set("user", user.id, "feedback.pending", { approvalId: "x", action: "pr_merge", projectId: null, taskId: null, chatId: "-1", topicId: null, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await app.orchestrator.consumeFeedback(user, "-1", null, "늦은 의견")).toBe(false);
    expect(await app.ctx.repos.settings.get("user", user.id, "feedback.pending")).toBeUndefined();
  });
});

describe("Phase 2 approval cards and reminders", () => {
  it("cards show risk, reconfirm and expiry; long-lived approvals are reminded once", async () => {
    app = await makeTestApp();
    const { user } = await seedUserAndAgents(app);
    const merge = await app.ctx.approvals.request({ actorId: user.id, action: "pr_merge", summary: "PR #1 병합" });
    const deploy = await app.ctx.approvals.request({ actorId: user.id, action: "deploy_production", summary: "운영 배포" });
    expect(approvalCard(merge)).toMatch(/\[PR 병합\] 위험도 🟡 중간\nPR #1 병합\n만료: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(approvalCard(deploy)).toContain("🔴 매우 높음 · 재확인 필요");
    await app.ctx.repos.db.query("UPDATE approvals SET expires_at = now() + interval '30 minutes' WHERE id = ANY($1)", [[merge.id, deploy.id]]);
    await app.ctx.repos.db.query("UPDATE approvals SET created_at = now() - interval '1 day' WHERE id=$1", [merge.id]);
    expect(await app.orchestrator.remindApprovals()).toBe(1); // deploy is short-lived → no reminder spam
    expect(app.out.lounge.at(-1)!.msg.text).toContain("곧 만료되는 승인 요청");
    expect(app.out.lounge.at(-1)!.msg.buttons?.[0]?.[0]?.data).toBe(`a:ok:${merge.id}:${merge.nonce}`);
    expect(await app.orchestrator.remindApprovals()).toBe(0);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text: "/approvals" });
    expect(app.out.lounge.filter((m) => m.msg.buttons?.[0]?.[0]?.data.startsWith("a:ok:")).length).toBeGreaterThanOrEqual(3);
  });
});

describe("Phase 2 pinned progress and task cards", () => {
  it("pinned message has controls that pause/resume the project and lists other tasks", async () => {
    app = await makeTestApp({ claude: codingHandler(), codex: codingHandler() });
    const { user, project } = await setupProject(app);
    expect(app.out.pinnedButtons.get(project.id)?.[0]?.[0]?.data).toBe(`p:pause:${project.id}`);
    const t1 = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.orchestrator.createTask(user, project, "README 작성해줘", []);
    const ack = app.out.project.filter((m) => m.msg.buttons?.some((row) => row.some((b) => b.data === `t:cancel:${t1.id}`)));
    expect(ack).toHaveLength(1);
    expect(app.out.pinned.get(project.id)).toContain("다른 작업");
    await click(app, `p:pause:${project.id}`, project.chatId!, project.topicId!);
    expect((await app.ctx.repos.projects.get(project.id)).status).toBe("paused");
    expect(app.out.pinnedButtons.get(project.id)?.[0]?.[0]?.data).toBe(`p:resume:${project.id}`);
    const r = await app.orchestrator.handleCallback({ telegramUserId: 4242, data: `p:resume:${project.id}`, chatId: project.chatId!, messageId: 1 });
    expect(r.toast).toContain("권한");
  });
});

describe("Phase 2 persona and relationships", () => {
  it("/agent tone edits tone bounds that the dialogue policy honours; /team shows relationships", async () => {
    app = await makeTestApp();
    const { user, claude, codex } = await seedUserAndAgents(app);
    const send = (text: string) => app!.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text });
    await send("/agent tone 클로드 informal off");
    await send("/agent tone 클로드 humor 0.2");
    const persona = await app.ctx.repos.personas.get((await app.ctx.repos.agents.get(claude.id)).personaId!);
    expect(persona.toneBounds).toEqual({ informalAllowed: false, humor: 0.2 });
    for (let i = 0; i < 12; i++) await app.ctx.repos.relationships.recordInteraction(user.id, claude.id, codex.id, "positive", `협업 ${i}`);
    await app.ctx.repos.users.updateProfile(user.id, { mode: "campus" });
    // Even with high affinity, Claude stays polite with Codex because informal speech is off.
    const style = await app.orchestrator.comm.styleFor(user, claude, { kind: "agent", agent: codex }, "discussion");
    expect(style).toContain("자연스러운 존댓말");
    const codexStyle = await app.orchestrator.comm.styleFor(user, codex, { kind: "agent", agent: claude }, "discussion");
    expect(codexStyle).toContain("반말");
    await send("/team");
    expect(app.out.lounge.at(-1)!.msg.text).toMatch(/클로드 ↔ 코덱스: 편한 사이 \(친밀도 0\.\d+, 협업 12회\)/);
  });
});

describe("Phase 2 natural moderator speech (fact-preserving LLM polish)", () => {
  it("guards facts: numbers, quotes, URLs and paths must survive; no new numbers", () => {
    const src = "'로그인 화면' 작업 2건을 배정했어요. PR: https://github.com/a/b/pull/3 브랜치 agency/x1";
    expect(preservedTokens(src)).toEqual(expect.arrayContaining(["'로그인 화면'", "https://github.com/a/b/pull/3", "2"]));
    expect(preservesFacts(src, "교수님, '로그인 화면' 작업 2건 배정 끝났습니다! PR은 https://github.com/a/b/pull/3 이고 브랜치는 agency/x1 이에요.").ok).toBe(true);
    expect(preservesFacts(src, "'로그인 화면' 작업 3건을 배정했어요. https://github.com/a/b/pull/3 agency/x1").ok).toBe(false);
    expect(preservesFacts(src, "작업을 배정했어요.").ok).toBe(false);
  });

  it("uses the polished text when enabled and valid, falls back otherwise, and caches", async () => {
    let calls = 0;
    let reply = "교수님~ 준비 다 됐어요. 2개 프로젝트 기다리고 있어요!";
    app = await makeTestApp({
      claude: (req) => {
        if (req.prompt.includes("말투 지침에 맞게")) {
          calls++;
          return reply;
        }
        return "{}";
      },
    });
    const { user, claude } = await seedUserAndAgents(app);
    await app.ctx.repos.users.updateProfile(user.id, { moderatorAgentId: claude.id, mode: "campus" });
    const say = (body: string) => app!.orchestrator.comm.say({ user, speaker: { kind: "moderator" }, listener: { kind: "user" }, situation: "report", body, machineState: { kind: "t" } });
    await say("준비됐어요. 2개 프로젝트가 대기 중이에요.");
    expect(app.out.lounge.at(-1)!.msg.text).toContain("교수님, 준비됐어요"); // flag off → template, no call
    expect(calls).toBe(0);
    await app.ctx.flags.set("dialogue.llm_renderer", true);
    await say("준비됐어요. 2개 프로젝트가 대기 중이에요.");
    expect(app.out.lounge.at(-1)!.msg.text).toBe("교수님~ 준비 다 됐어요. 2개 프로젝트 기다리고 있어요!");
    await say("준비됐어요. 2개 프로젝트가 대기 중이에요.");
    expect(calls).toBe(1); // cache hit
    reply = "교수님, 준비됐어요. 3개 프로젝트가 대기 중이에요.";
    await say("준비됐어요. 4개 작업이 남았어요.");
    expect(app.out.lounge.at(-1)!.msg.text).toContain("4개 작업"); // changed number → template
    // Approval cards are never polished.
    const before = calls;
    await app.orchestrator.comm.say({ user, speaker: { kind: "moderator" }, listener: { kind: "user" }, situation: "approval_request", body: "승인 필요 1건", machineState: { kind: "t" } });
    expect(calls).toBe(before);
  });
});
