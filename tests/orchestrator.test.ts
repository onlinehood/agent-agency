import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp, seedRemote, seedUserAndAgents, codingHandler, ADMIN_TG, type TestApp } from "./helpers.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const msg = (text: string, extra: Partial<{ chatId: string; topicId: number | null; telegramUserId: number }> = {}) => ({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text, ...extra });

describe("orchestrator", () => {
  it("rejects users that are not in the numeric admin allow-list", async () => {
    app = await makeTestApp();
    await app.orchestrator.handleMessage(msg("/status", { telegramUserId: 999 }));
    expect(app.out.lounge).toHaveLength(0);
    expect((await app.ctx.repos.audit.list(10)).some((e) => e.action === "auth.denied")).toBe(true);
  });

  it("a question to the team (\"아무도 아이디어 없어?\") gets answers from the agents, not an idea memo", async () => {
    const reply = (who: string) => (req: { prompt: string }) =>
      req.prompt.includes('"position"') ? JSON.stringify({ position: `${who}의 앱 아이디어`, agree: true, message: `${who}: 습관 기록 앱 어떠세요?` }) : "{}";
    app = await makeTestApp({ claude: reply("클로드"), codex: reply("코덱스") });
    const { user } = await seedUserAndAgents(app);
    await app.orchestrator.handleMessage(msg("아무도 아이디어 없어?"));
    const text = app.out.allText();
    expect(text).toContain("클로드: 습관 기록 앱 어떠세요?");
    expect(text).toContain("코덱스: 습관 기록 앱 어떠세요?");
    expect(text).not.toContain("아이디어 후보 목록에 저장");
    expect(await app.ctx.repos.ideas.list(null)).toHaveLength(0);
    // A real idea statement is still filed.
    await app.orchestrator.handleMessage(msg("나중에 다크모드 있으면 좋겠다"));
    expect((await app.ctx.repos.ideas.list(null)).map((i) => i.text)).toEqual(["나중에 다크모드 있으면 좋겠다"]);
    void user;
  });

  it("proposes a new project via discussion and creates repo + topic only after approval", async () => {
    const h = codingHandler();
    app = await makeTestApp({
      claude: (req) => (req.prompt.includes("다음 JSON만 출력: {\"name\"") ? JSON.stringify({ name: "Todo 앱", slug: "todo-app", description: "할 일 관리", stack: ["TypeScript", "React"], team: [] }) : h(req)),
      codex: h,
    });
    const { user } = await seedUserAndAgents(app);
    await app.orchestrator.handleMessage(msg('새 프로젝트 만들어줘 "Todo 앱"'));
    const [project] = (await app.ctx.repos.projects.listByOwner(user.id, true)).filter((p) => p.workType !== "lounge");
    expect(project).toMatchObject({ name: "Todo 앱", slug: "todo-app", status: "proposed" });
    expect(app.github.calls.some((c) => c.startsWith("createPrivateRepo"))).toBe(false);
    const convo = app.out.allText();
    expect(convo).toContain("좋아요, 그렇게 하죠."); // real agent discussion turn visible
    const approval = (await app.ctx.repos.approvals.listPending(user.id)).find((a) => a.action === "create_project")!;
    await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `a:ok:${approval.id}:${approval.nonce}`, chatId: "-100123", messageId: 5 });
    const active = await app.ctx.repos.projects.get(project!.id);
    expect(active.status).toBe("active");
    expect(active.repoRef).toBe("tester/todo-app");
    expect(active.topicId).not.toBeNull();
    expect((await app.ctx.repos.projects.listAgents(active.id)).length).toBeGreaterThan(0);
    // Approving twice does nothing (already decided) and never creates a second repo.
    const again = await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `a:ok:${approval.id}:${approval.nonce}`, chatId: "-100123", messageId: 5 });
    expect(again.toast).toContain("이미 처리");
    expect(app.github.calls.filter((c) => c.startsWith("createPrivateRepo"))).toHaveLength(1);
  });

  it("imports an existing repository read-only and links it only after approval", async () => {
    app = await makeTestApp({ claude: codingHandler(), codex: codingHandler() });
    const { user } = await seedUserAndAgents(app);
    seedRemote(app, "acme/legacy");
    await app.orchestrator.handleMessage(msg("https://github.com/acme/legacy 가져와줘"));
    const [p] = (await app.ctx.repos.projects.listByOwner(user.id, true)).filter((x) => x.workType !== "lounge");
    expect(p).toMatchObject({ repoRef: "acme/legacy", repoMode: "imported", status: "proposed" });
    expect(app.github.calls.filter((c) => /create|merge/.test(c))).toEqual([]); // GET-only analysis
    expect((await app.ctx.repos.memories.list(p!.id, ["import_analysis"])).length).toBe(1);
    const a = (await app.ctx.repos.approvals.listPending(user.id)).find((x) => x.action === "import_project")!;
    await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `a:no:${a.id}:${a.nonce}`, chatId: "-100123", messageId: 1 });
    expect((await app.ctx.repos.projects.get(p!.id)).status).toBe("archived");
  });

  it("switching worldview keeps projects, tasks, identities and memories; only expression changes", async () => {
    app = await makeTestApp({ claude: codingHandler(), codex: codingHandler() });
    const { user, claude } = await seedUserAndAgents(app);
    seedRemote(app, "tester/demo");
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed" });
    const project = await app.orchestrator.activateProject(user, p.id, [{ agentId: claude.id, role: "leader" }]);
    await app.ctx.memory.remember(project.id, "decision", "React 사용");
    const before = { tasks: await app.ctx.repos.tasks.listByProject(project.id), mem: await app.ctx.repos.memories.list(project.id) };
    for (const mode of ["construction", "campus", "corporate"] as const) {
      await app.orchestrator.handleMessage(msg(`/mode ${mode}`));
    }
    await app.orchestrator.handleMessage(msg("/mode construction"));
    expect(app.out.lounge.at(-1)!.msg.text).toContain("건물주님");
    expect(app.out.lounge.at(-1)!.msg.header).toContain("십장");
    expect((await app.ctx.repos.memories.list(project.id)).length).toBe(before.mem.length);
    expect((await app.ctx.repos.tasks.listByProject(project.id)).length).toBe(before.tasks.length);
    expect((await app.ctx.repos.agents.get(claude.id)).name).toBe("클로드");
  });

  it("renaming / changing model keeps id-linked history (PRD §12-2)", async () => {
    app = await makeTestApp();
    const { user, claude, codex } = await seedUserAndAgents(app);
    await app.ctx.repos.relationships.recordInteraction(user.id, claude.id, codex.id, "positive");
    await app.orchestrator.handleMessage(msg("/agent rename 클로드 클로이"));
    await app.orchestrator.handleMessage(msg("/agent model 클로이 sim-1"));
    await app.orchestrator.handleMessage(msg("/agent model 클로이 gpt-unknown"));
    const a = await app.ctx.repos.agents.get(claude.id);
    expect(a).toMatchObject({ name: "클로이", modelPolicy: "sim-1" });
    expect(app.out.lounge.at(-1)!.msg.text).toContain("공식 지원이 확인되지 않아");
    expect((await app.ctx.repos.relationships.listForAgent(claude.id)).length).toBe(1);
  });

  it("stores loose ideas as candidates and answers /status", async () => {
    app = await makeTestApp();
    await seedUserAndAgents(app);
    await app.orchestrator.handleMessage(msg("나중에 다크모드 있으면 좋겠다"));
    expect((await app.ctx.repos.ideas.list(null)).map((i) => i.text)).toEqual(["나중에 다크모드 있으면 좋겠다"]);
    await app.orchestrator.handleMessage(msg("/status"));
    expect(app.out.lounge.at(-1)!.msg.text).toContain("프로젝트가 없습니다");
  });

  it("@mention gives the mentioned agent priority", async () => {
    const h = codingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    seedRemote(app, "tester/demo");
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed" });
    const project = await app.orchestrator.activateProject(user, p.id, [{ agentId: claude.id, role: "leader" }, { agentId: codex.id, role: "reviewer" }]);
    await app.orchestrator.handleMessage(msg("@코덱스 hello 함수를 추가해줘", { chatId: project.chatId!, topicId: project.topicId! }));
    await app.scheduler.drain(60_000);
    const [t] = (await app.ctx.repos.tasks.listByProject(project.id)).filter((x) => !x.checkpoint.internal);
    expect(t!.assignedAgentId).toBe(codex.id);
    expect(t!.reviewerAgentId).toBe(claude.id);
  }, 60_000);

  it("pause cancels and resume continues from checkpoint", async () => {
    app = await makeTestApp({ claude: codingHandler(), codex: codingHandler() });
    const { user, claude } = await seedUserAndAgents(app);
    seedRemote(app, "tester/demo");
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed" });
    const project = await app.orchestrator.activateProject(user, p.id, [{ agentId: claude.id, role: "leader" }]);
    const task = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.orchestrator.handleMessage(msg("/pause", { chatId: project.chatId!, topicId: project.topicId! }));
    await app.scheduler.drain(10_000);
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("queued");
    await app.orchestrator.handleMessage(msg("/resume", { chatId: project.chatId!, topicId: project.topicId! }));
    await app.scheduler.drain(60_000);
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("awaiting_approval");
  }, 60_000);
});
