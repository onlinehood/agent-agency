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

  it("a proposal that lists the same agent twice still activates; in the lounge the AI reads the conversation and turns \"알아서 만들어봐\" into the project's first task", async () => {
    const ids: Record<string, string> = {};
    const h = codingHandler();
    app = await makeTestApp({
      claude: (req) => {
        if (req.prompt.includes('다음 JSON만 출력: {"name"')) return JSON.stringify({ name: "simple-calc", slug: "simple-calc", description: "순수 HTML/CSS/JS 계산기", stack: ["HTML", "CSS", "JavaScript"], team: [{ agentId: ids.claude, role: "leader" }, { agentId: ids.codex, role: "implementer" }, { agentId: ids.claude, role: "reviewer" }] });
        if (req.prompt.includes("사용자 메시지: 작업 언제해?")) return JSON.stringify({ intent: "answer", reply: "지시만 주시면 바로 시작할게요. 기본값은 세 파일, 0으로 나누면 Error 표시예요." });
        if (req.prompt.includes("사용자 메시지: 알아서 만들어봐")) return JSON.stringify({ intent: "task", task: "simple-calc를 index.html, style.css, script.js로 만들고 0으로 나누면 Error를 표시", title: "계산기 첫 구현", project: "simple-calc", reply: "바로 시작할게요." });
        return h(req);
      },
      codex: h,
    });
    const { user, claude, codex } = await seedUserAndAgents(app);
    ids.claude = claude.id;
    ids.codex = codex.id;
    await app.orchestrator.handleMessage(msg("새 프로젝트 만들어줘 계산기"));
    const approval = (await app.ctx.repos.approvals.listPending(user.id)).find((a) => a.action === "create_project")!;
    await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `a:ok:${approval.id}:${approval.nonce}`, chatId: "-100123", messageId: 5 });
    const [project] = (await app.ctx.repos.projects.listByOwner(user.id)).filter((p) => p.workType !== "lounge");
    expect(project!.status).toBe("active");
    expect((await app.ctx.repos.projects.listAgents(project!.id)).map((m) => m.functionalRole).sort()).toEqual(["implementer", "leader"]);
    expect(app.out.project.some((m) => m.msg.buttons?.flat().some((b) => b.data === `p:kick:${project!.id}`))).toBe(true);

    // The question is understood and answered in one AI call.
    await app.orchestrator.handleMessage(msg("작업 언제해?"));
    expect(app.claude.calls.filter((r) => r.prompt.includes("작업 언제해?"))).toHaveLength(1);
    expect(app.out.allText()).toContain("0으로 나누면 Error 표시예요");
    // The follow-up is read together with that answer and becomes a task in the only project.
    await app.orchestrator.handleMessage(msg("알아서 만들어봐"));
    const followUp = app.claude.calls.find((r) => r.prompt.includes("사용자 메시지: 알아서 만들어봐"))!;
    expect(followUp.prompt).toContain("## 직전 대화");
    expect(followUp.prompt).toContain("0으로 나누면 Error 표시예요");
    expect(app.out.allText()).not.toContain("아직 프로젝트가 없어요");
    const [task] = await app.ctx.repos.tasks.listByProject(project!.id);
    expect(task!.title).toBe("계산기 첫 구현");
    expect(task!.description).toContain("index.html, style.css, script.js");
    expect(task!.description).toContain("[사용자 원문] 알아서 만들어봐");
    // The kickoff button does nothing once a task exists.
    expect((await app.orchestrator.handleCallback({ telegramUserId: ADMIN_TG, data: `p:kick:${project!.id}`, chatId: "-100123", messageId: 9 })).toast).toContain("이미 작업");
  });

  it("the AI files a later-thought as an idea, and rules still route when the AI gives no usable decision", async () => {
    app = await makeTestApp({
      claude: (req) => (req.prompt.includes("사용자 메시지: 다크모드는 나중에 생각해보자") ? JSON.stringify({ intent: "idea", reply: "다크모드는 후보로 적어 둘게요." }) : req.prompt.includes("질문: 진행 상황 어때?") ? "아직 작업이 없어요." : "{}"),
    });
    const { user } = await seedUserAndAgents(app);
    await app.orchestrator.handleMessage(msg("다크모드는 나중에 생각해보자"));
    expect((await app.ctx.repos.ideas.list(null)).map((i) => i.text)).toEqual(["다크모드는 나중에 생각해보자"]);
    expect(app.out.allText()).toContain("다크모드는 후보로 적어 둘게요.");
    // "{}" from the understanding call → the rule path answers the question as before.
    await app.orchestrator.handleMessage(msg("진행 상황 어때?"));
    expect(app.out.allText()).toContain("아직 작업이 없어요.");
    void user;
  });

  it("a short choice like \"B안으로\" is read against the options at the end of the last long reply", async () => {
    const intro = "계산기를 어떻게 만들지 정리했습니다. ".repeat(40); // pushes the options far past the old 600-char cut
    app = await makeTestApp({
      claude: (req) =>
        req.prompt.includes("사용자 메시지: 어떻게 만들까?")
          ? JSON.stringify({ intent: "answer", reply: `${intro}\nA안: 터미널 계산기\nB안: 브라우저 웹 계산기 (HTML/CSS/JS 한 파일)\n어느 쪽으로 할까요?` })
          : req.prompt.includes("사용자 메시지: B안으로")
            ? JSON.stringify({ intent: "task", task: "브라우저 웹 계산기를 HTML/CSS/JS 한 파일로 만든다", title: "웹 계산기", project: "simple-calc", reply: "B안으로 진행할게요." })
            : "{}",
      codex: () => "{}",
    });
    const { user } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "simple-calc", slug: "simple-calc", description: "계산기", stack: [], status: "active", repoMode: "new", workType: "coding" });
    await app.orchestrator.handleMessage(msg("어떻게 만들까?"));
    await app.orchestrator.handleMessage(msg("B안으로"));
    const prompt = app.claude.calls.find((r) => r.prompt.includes("사용자 메시지: B안으로"))!.prompt;
    expect(prompt).toContain("B안: 브라우저 웹 계산기 (HTML/CSS/JS 한 파일)");
    expect(prompt).toContain("짧은 답은 직전 대화에서 AI가 내놓은 선택지");
    expect((await app.ctx.repos.tasks.listByProject(p.id)).map((t) => t.title)).toEqual(["웹 계산기"]);
  });

  it("a build request in the lounge becomes a task even when the AI tries to do it and reports missing write tools", async () => {
    app = await makeTestApp({
      claude: (req) => (req.prompt.includes("사용자 메시지:") ? "Write/Edit와 Bash 도구 권한이 없어 진행하지 못했습니다. 권한을 열고 다시 지시해 주세요." : "{}"),
      codex: () => "{}",
    });
    const { user } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "simple-calc", slug: "simple-calc", description: "계산기", stack: [], status: "active", repoMode: "new", workType: "coding" });
    await app.orchestrator.handleMessage(msg("simple-calc 구현 진행해"));
    expect(app.out.allText()).not.toContain("권한이 없어");
    expect(app.claude.calls.find((r) => r.prompt.includes("사용자 메시지:"))!.prompt).toContain("권한이 없다는 말은 하지 마세요");
    const tasks = await app.ctx.repos.tasks.listByProject(p.id);
    expect(tasks.map((t) => t.title)).toEqual(["simple-calc 첫 구현"]);
  });

  it("without a usable AI decision, a short lounge follow-up still reaches the only project with the last answer attached", async () => {
    app = await makeTestApp({ claude: (req) => (req.prompt.includes("질문: 작업 언제해?") ? "기본값: 0으로 나누면 Error." : "{}"), codex: () => "{}" });
    const { user } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "simple-calc", slug: "simple-calc", description: "순수 HTML/CSS/JS 계산기", stack: [], status: "active", repoMode: "new", workType: "coding" });
    await app.orchestrator.handleMessage(msg("작업 언제해?"));
    await app.orchestrator.handleMessage(msg("알아서 만들어봐"));
    const [task] = await app.ctx.repos.tasks.listByProject(p.id);
    expect(task!.title).toBe("simple-calc 첫 구현");
    expect(task!.description).toContain("순수 HTML/CSS/JS 계산기");
    expect(task!.description).toContain("[직전 대화");
    expect(task!.description).toContain("0으로 나누면 Error");
  });

  it("an approved project whose activation never finished is completed on startup", async () => {
    app = await makeTestApp({ claude: () => "{}", codex: () => "{}" });
    const { user, claude } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "멈춘 프로젝트", slug: "stuck", description: "계산기", stack: [], status: "proposed", repoMode: "new", workType: "coding" });
    const a = await app.ctx.approvals.request({ actorId: user.id, projectId: p.id, action: "create_project", summary: "s", scope: { team: [{ agentId: claude.id, role: "leader" }] } });
    await app.ctx.repos.approvals.setStatus(a.id, "approved", user.id);
    // Before recovery the lounge says what state the project is in, not "no project".
    await app.orchestrator.handleMessage(msg("알아서 만들어봐"));
    expect(app.out.allText()).toContain("멈춘 프로젝트: ");
    expect(app.out.allText()).not.toContain("아직 프로젝트가 없어요");
    expect(await app.orchestrator.resumeActivationsOnStart()).toEqual([p.id]);
    const after = await app.ctx.repos.projects.get(p.id);
    expect(after.status).toBe("active");
    expect(after.topicId).not.toBeNull();
    expect(await app.orchestrator.resumeActivationsOnStart()).toEqual([]);
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
    expect(app.out.lounge.at(-1)!.msg.header).toContain("현장소장");
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
