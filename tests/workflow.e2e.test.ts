import fs from "node:fs";
import path from "node:path";
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
  it("an empty attempt on code that already does the job finishes the task after review, without a PR", async () => {
    const h = codingHandler();
    const already = (req: { prompt: string; cwd: string }) => (req.prompt.startsWith("당신은 AI 개발 조직의 구현 담당입니다") ? JSON.stringify({ summary: "이미 구현되어 있음", changes: [], tests_added: [], open_issues: [], message: "이미 돼 있어요." }) : h(req as never));
    app = await makeTestApp({ claude: already as never, codex: already as never });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "hello 함수가 있는지 확인하고 없으면 추가해줘" });
    await app.scheduler.drain(60_000);
    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(task!.state).toBe("done");
    expect(task!.prRef).toBeNull();
    expect(app.out.allText()).toContain("바꿀 것이 없었어요");
    expect(app.out.allText()).not.toContain("파일 변경이 없었습니다");
  }, 120_000);

  it("something only the user can do (a real deploy URL) is asked once with how-to steps; the answer continues the task", async () => {
    const base = codingHandler();
    let reviews = 0;
    const needsDeploy = (req: { prompt: string; cwd: string }) => {
      if (!req.prompt.includes("코드 리뷰어")) return base(req as never);
      reviews++;
      return reviews === 1
        ? JSON.stringify({ approved: false, summary: "배포 주소 없음", issues: [{ severity: "major", description: "README에 실제 Vercel Production URL이 없습니다", file: "README.md" }], message: "배포 주소가 필요해요." })
        : JSON.stringify({ approved: true, summary: "좋음", issues: [], message: "좋아요." });
    };
    app = await makeTestApp({ claude: needsDeploy as never, codex: needsDeploy as never });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    const say = (text: string) => app!.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text });
    await say("hello 함수를 추가하고 README에 배포 주소를 적어줘");
    await app.scheduler.drain(60_000);
    let [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(task!.state).toBe("blocked");
    expect(task!.attempts).toBe(1); // asked right away, no retry rounds
    const text = app.out.allText();
    expect(text).toContain("이건 제가 직접 할 수 없어서 도와주셔야 해요");
    expect(text).toContain("vercel.com 로그인 → Add New → Project");
    expect(app.out.project.some((m) => m.msg.buttons?.flat().some((b) => b.data === `t:skipask:${task!.id}`))).toBe(true);
    // The user's next message in the topic is the answer; the task continues with it.
    await say("https://simple-calc.vercel.app");
    await app.scheduler.drain(60_000);
    task = await app.ctx.repos.tasks.get(task!.id);
    expect(task.prRef).toContain("/pull/1");
    const fixPrompt = app.claude.calls.concat(app.codex.calls).filter((r) => r.prompt.startsWith("당신은 AI 개발 조직의 구현 담당입니다")).at(-1)!.prompt;
    expect(fixPrompt).toContain("사용자 답변: https://simple-calc.vercel.app");
  }, 180_000);

  it("⏭ skips what was asked: the PR opens with the item recorded", async () => {
    const base = codingHandler();
    const needsDeploy = (req: { prompt: string; cwd: string }) =>
      req.prompt.includes("코드 리뷰어") ? JSON.stringify({ approved: false, summary: "배포 필요", issues: [], needs_user: [{ what: "Vercel에 배포하고 주소 알려 주기" }], message: "배포는 부탁드려요." }) : base(req as never);
    app = await makeTestApp({ claude: needsDeploy as never, codex: needsDeploy as never });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "hello 함수를 추가해줘" });
    await app.scheduler.drain(60_000);
    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(task!.state).toBe("blocked");
    expect((await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `t:skipask:${task!.id}`, chatId: project.chatId!, messageId: 1 })).toast).toContain("빼고 진행");
    await app.scheduler.drain(60_000);
    expect((await app.ctx.repos.tasks.get(task!.id)).prRef).toContain("/pull/1");
    expect(app.github.prBodies.at(-1)).toContain("Vercel에 배포하고 주소 알려 주기 (사용자 확인 필요)");
  }, 180_000);

  it("the same review objection twice stops the fix loop and opens the PR with the objection recorded", async () => {
    const base = codingHandler();
    let n = 0;
    const stubborn = (req: { prompt: string; cwd: string }) => {
      if (!req.prompt.includes("코드 리뷰어")) return base(req as never);
      n++;
      return JSON.stringify({ approved: false, summary: "에러 문구가 너무 기술적", issues: [{ severity: "major", description: `0으로 나눌 때 에러 문구가 사용자에게 너무 기술적입니다 (${n}차)`, file: "hello.js" }], message: "문구를 쉽게 바꿔 주세요." });
    };
    app = await makeTestApp({ claude: stubborn as never, codex: stubborn as never });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "hello 함수를 추가해줘" });
    await app.scheduler.drain(90_000);
    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(n).toBe(2); // one fix round, then it stops
    expect(task!.prRef).toContain("/pull/1");
    expect(app.out.allText()).toContain("리뷰어가 같은 지적을 반복해서 수정을 멈췄어요");
    expect(app.github.prBodies.at(-1)).toContain("리뷰에서 반복된 지적");
  }, 120_000);

  it("an implementer that keeps ending with no file changes hands the task to another agent", async () => {
    const writes = codingHandler();
    const neverWrites = (req: { prompt: string; cwd: string }) =>
      req.prompt.startsWith("당신은 AI 개발 조직의 구현 담당입니다") ? JSON.stringify({ summary: "샌드박스 오류로 적용 못 함", changes: [], tests_added: [], open_issues: ["bwrap"], message: "적용이 안 돼요." }) : writes(req as never);
    // A realistic reviewer: with no diff and no hello.js, the existing code does not do the job.
    const reviewer = (req: { prompt: string; cwd: string }) =>
      req.prompt.includes("diff 없음") && !fs.existsSync(path.join(req.cwd, "hello.js"))
        ? JSON.stringify({ approved: false, summary: "hello 함수가 없습니다", issues: [{ severity: "major", description: "hello.js가 없습니다" }], message: "아직 없어요." })
        : writes(req as never);
    app = await makeTestApp({ claude: reviewer as never, codex: neverWrites as never });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "implementer" },
    ]);
    await app.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text: "@코덱스 hello 함수를 추가해줘" });
    await app.scheduler.drain(90_000);
    const [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(app.out.allText()).toContain("코덱스이(가) 2번 연속 파일을 바꾸지 못했어요. 이 작업은 클로드이(가) 이어받을게요.");
    expect(task!.assignedAgentId).toBe(claude.id);
    expect(task!.prRef).toContain("/pull/1"); // the new implementer finished it
    expect((await app.ctx.repos.approvals.listPending(user.id)).some((a) => a.action === "budget_exceed")).toBe(false);
  }, 180_000);

  it("자동 진행: offered at project start; on, the task runs to a merged PR with no approval cards; turning it on later grants what is waiting", async () => {
    const h = codingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await activeProject(app, user.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    // The start message asks whether to run to the end automatically.
    expect(app.out.project.some((m) => m.msg.buttons?.flat().some((b) => b.data === `p:auto:${project.id}:on`))).toBe(true);
    const say = (text: string) => app!.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: project.chatId!, topicId: project.topicId!, text });

    // Step-by-step first: the task stops at the merge approval.
    await say("hello 함수를 추가해줘");
    await app.scheduler.drain(60_000);
    let [task] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal);
    expect(task!.state).toBe("awaiting_approval");
    expect((await app.ctx.repos.approvals.listPending(user.id)).some((a) => a.action === "pr_merge")).toBe(true);
    // "자동으로 진행해" mid-way: the waiting merge approval is granted and the PR merges.
    await say("자동으로 진행해");
    await app.scheduler.drain(60_000);
    task = await app.ctx.repos.tasks.get(task!.id);
    expect(task.state).toBe("done");
    expect(app.github.calls.filter((c) => c.startsWith("mergePullRequest"))).toHaveLength(1);
    expect((await app.ctx.repos.projects.get(project.id)).settings.autopilot).toBe(true);
    expect(app.out.pinned.get(project.id)).toContain("자동 진행");

    // With autopilot on, the next task goes all the way with no approval cards at all.
    const cardsBefore = app.out.project.filter((m) => m.msg.buttons?.flat().some((b) => b.data.startsWith("a:ok:"))).length;
    await say("hello 함수에 설명 주석을 추가해줘");
    await app.scheduler.drain(60_000);
    const second = (await app.ctx.repos.tasks.listByProject(project.id)).filter((t) => !t.checkpoint.internal && t.id !== task.id)[0]!;
    expect(second.state).toBe("done");
    expect(app.out.project.filter((m) => m.msg.buttons?.flat().some((b) => b.data.startsWith("a:ok:"))).length).toBe(cardsBefore);
    expect(app.out.allText()).toContain("🤖 자동 진행 — PR 병합");
    expect(await app.ctx.repos.approvals.listPending(user.id)).toHaveLength(0);
  }, 180_000);

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
    expect(app.codex.calls.concat(app.claude.calls).find((r) => r.prompt.includes("코드 리뷰어"))!.prompt).toContain("코드로 충족할 수 없는 항목");
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
