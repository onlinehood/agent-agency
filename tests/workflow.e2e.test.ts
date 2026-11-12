import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp, seedRemote, seedUserAndAgents, codingHandler, ADMIN_TG, type TestApp } from "./helpers.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

async function activeProject(t: TestApp, userId: string, team: Array<{ agentId: string; role: string }>) {
  seedRemote(t, "tester/demo");
  const p = await t.ctx.repos.projects.create({ ownerId: userId, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed" });
  const project = await t.orchestrator.activateProject(await t.ctx.repos.users.get(userId), p.id, team);
  await t.scheduler.drain(60_000); // imported repo → baseline quality check runs first
  return project;
}

describe("Phase 1 vertical slice: Telegram request → PR → merge approval", () => {
  it("a review that rejects with only minor points (e.g. 'another agent must verify') does not loop the fix step", async () => {
    const base = codingHandler();
    const picky = (req: { prompt: string }) =>
      req.prompt.includes("코드 리뷰어")
        ? JSON.stringify({ approved: false, summary: "독립 검증 미완료", issues: [{ severity: "minor", description: "다른 에이전트의 독립 실행 검증 기록이 없습니다" }], message: "검증 기록만 남겨 주세요." })
        : base(req as never);
    app = await makeTestApp({ claude: picky as never, codex: picky as never });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "hello 함수를 추가해줘" });
    await app.scheduler.drain(60_000);
    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(task!.checkpoint.reviewVerdict?.approved).toBe(true);
    expect(task!.prRef).toContain("/pull/1");
    expect(task!.attempts).toBe(1); // no extra fix rounds
    // The review prompt tells the reviewer not to reject only because it could not run commands.
    expect(app.codex.calls.concat(app.claude.calls).find((r) => r.prompt.includes("코드 리뷰어"))!.prompt).toContain("명령을 직접 실행하지 못했더라도 그것만으로 반려하지 마세요");
    expect(app.codex.calls.concat(app.claude.calls).find((r) => r.prompt.includes("코드 리뷰어"))!.prompt).toContain("코드로 충족할 수 없는 절차 항목");
  }, 120_000);

  it("runs plan → implement → gate → review → PR → merge with approval", async () => {
    const h = codingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    expect(project.status).toBe("active");
    expect(project.topicId).not.toBeNull();

    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "hello 함수를 추가해줘" });
    await app.scheduler.drain(60_000);

    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(task).toBeDefined();
    expect(task!.state).toBe("awaiting_approval");
    expect(task!.prRef).toContain("/pull/1");
    expect(task!.checkpoint.qualityGate?.passed).toBe(true);
    expect(task!.checkpoint.reviewVerdict?.approved).toBe(true);
    // Implementer and reviewer are different providers (cross review)
    expect(task!.assignedAgentId).not.toBe(task!.reviewerAgentId);

    const pending = await app.ctx.repos.approvals.listPending(user.id);
    const merge = pending.find((a) => a.action === "pr_merge");
    expect(merge).toBeDefined();
    expect(app.github.calls.some((c) => c.startsWith("mergePullRequest"))).toBe(false);

    const r = await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `a:ok:${merge!.id}:${merge!.nonce}`, chatId: project.chatId!, messageId: 1 });
    expect(r.toast).toContain("승인");
    const done = await app.ctx.repos.tasks.get(task!.id);
    expect(done.state).toBe("done");
    expect(app.github.calls.filter((c) => c.startsWith("mergePullRequest"))).toHaveLength(1);

    // Report card + pinned progress were produced; machine state stored separately from text.
    expect(app.out.allText()).toContain("결과 보고");
    expect(app.out.pinned.get(project.id)).toContain("Demo");
    const convo = await app.ctx.repos.conversations.list(project.id, 200);
    expect(convo.some((m) => m.kind === "report.card")).toBe(true);
    expect(convo.some((m) => m.kind === "quality.gate" && m.machineState.status === "passed")).toBe(true);
  }, 120_000);

  it("fixes after a failing quality gate and after review change requests", async () => {
    const h = codingHandler({ failFirstImpl: true, rejectFirstReview: true });
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(task!.state).toBe("awaiting_approval");
    expect(task!.attempts).toBe(3); // impl, fix(gate), fix(review)
    const lessons = await app.ctx.repos.conversations.list(project.id, 200);
    expect(lessons.filter((m) => m.kind === "quality.gate").map((m) => m.machineState.status)).toEqual(["failed", "passed", "passed"]);
  }, 120_000);

  it("survives a restart: resumes from checkpoint without duplicating the PR", async () => {
    const h = codingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    // Simulate crash after PR: force the task back to the PR stage and recover.
    await app.ctx.repos.tasks.update(task!.id, { state: "in_progress", stage: "pr" });
    for (const a of await app.ctx.repos.approvals.listPending()) await app.ctx.repos.approvals.setStatus(a.id, "cancelled", null);
    const rec = await app.scheduler.recover();
    expect(rec.resumed).toBe(1);
    await app.scheduler.drain(60_000);
    expect(app.github.calls.filter((c) => c.startsWith("createPullRequest"))).toHaveLength(1);
    expect((await app.ctx.repos.tasks.get(task!.id)).state).toBe("awaiting_approval");
  }, 120_000);

  it("cancels a running execution for real", async () => {
    let release: () => void = () => undefined;
    const h = codingHandler();
    app = await makeTestApp({
      claude: (req) => (req.prompt.includes("구현 담당입니다") ? new Promise<string>((r) => (release = () => r("{}"))) : h(req)),
      codex: h,
    });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    const task = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", [claude.id]);
    await app.scheduler.tick();
    for (let i = 0; i < 100 && !app.orchestrator.runner.isRunning(task.id); i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 100; i++) {
      const t = await app.ctx.repos.tasks.get(task.id);
      if (t.state === "in_progress" && app.orchestrator.runner.isRunning(task.id)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const detail = await app.orchestrator.cancelTask(user, task.id);
    expect(detail).toContain("실제로 중단");
    release();
    await app.scheduler.drain(30_000);
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("cancelled");
  }, 60_000);
});

describe("leader task splitting (PRD §10.1 작업 분할/배정)", () => {
  it("splits a large request into subtasks that each produce their own PR", async () => {
    const base = codingHandler();
    let planned = false;
    const h = (req: Parameters<typeof base>[0]) => {
      if (req.prompt.includes("프로젝트 리더입니다") && !planned) {
        planned = true;
        return JSON.stringify({ summary: "두 단계", acceptance_criteria: ["a"], difficulty: "medium", subtasks: [{ title: "hello 추가", description: "hello.js", acceptance_criteria: ["hello()"] }, { title: "문서 정리", description: "README", acceptance_criteria: ["문서"] }], message: "둘로 나눌게요." });
      }
      return base(req);
    };
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    const parent = await app.orchestrator.createTask(user, project, "hello 기능과 문서를 함께 만들어줘", []);
    await app.scheduler.drain(90_000);
    const p = await app.ctx.repos.tasks.get(parent.id);
    expect(p.checkpoint.kind).toBe("split");
    const kids = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => t.checkpoint.parentTaskId === parent.id);
    expect(kids.map((k) => k.title).sort()).toEqual(["hello 추가", "문서 정리"]);
    for (const k of kids) {
      expect(k.state).toBe("awaiting_approval");
      expect(k.prRef).toBeTruthy();
    }
  }, 120_000);
});
