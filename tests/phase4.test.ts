import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTestApp, seedRemote, seedUserAndAgents, codingHandler, ADMIN_TG, type TestApp } from "./helpers.js";
import { SimulatorAdapter, type SimulatorHandler } from "../src/executors/simulator.js";
import { GeminiCliAdapter } from "../src/executors/gemini.js";
import { CursorCliAdapter } from "../src/executors/cursor.js";
import { minimalEnv } from "../src/executors/process.js";
import { syncExecutorFlags } from "../src/executors/flags.js";
import { saveCustomMode, deleteCustomMode, loadCustomModes } from "../src/core/organization/customModes.js";
import { registerCustomModes, modeDef, isOrganizationMode } from "../src/core/organization/modes.js";
import { resolveFormality } from "../src/core/organization/dialogue.js";
import { protocolFor } from "../src/core/organization/collaboration.js";
import { checkReport, reportPathFor } from "../src/plugins/research-agency/workflow.js";
import { detectWorkType } from "../src/core/orchestration/classifier.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
  registerCustomModes([]);
});

const say = (t: TestApp, text: string) => t.orchestrator.handleMessage({ telegramUserId: ADMIN_TG, chatId: "-100123", topicId: null, text });

describe("additional executors: Gemini CLI and Cursor CLI", () => {
  it("parse official outputs and only accept subscription logins", () => {
    const ok = GeminiCliAdapter.parseOutput(JSON.stringify({ session_id: "s1", response: "hello", stats: { models: { "gemini-2.5-pro": { tokens: { prompt: 10, candidates: 5 } } } } }));
    expect(ok).toMatchObject({ text: "hello", sessionRef: "s1", isError: false, usage: { input_tokens: 10, output_tokens: 5 } });
    const err = GeminiCliAdapter.parseOutput(JSON.stringify({ session_id: "s2", error: { message: "Please set an Auth method", code: 41 } }));
    expect(err).toMatchObject({ isError: true, errorText: "Please set an Auth method" });
    expect(GeminiCliAdapter.authType(JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }))).toBe("oauth-personal");
    expect(GeminiCliAdapter.authType(null)).toBeNull();
    const g = new GeminiCliAdapter("gemini");
    expect(g.buildArgs({ prompt: "x", cwd: "/tmp", mode: "readonly" })).toEqual(expect.arrayContaining(["--approval-mode", "plan", "-o", "json"]));
    expect(g.buildArgs({ prompt: "x", cwd: "/tmp", mode: "write", isolated: true })).toContain("yolo");
    expect(CursorCliAdapter.parseStatus("Not logged in").authenticated).toBe(false);
    expect(CursorCliAdapter.parseStatus(JSON.stringify({ authenticated: true, email: "a@b" })).authenticated).toBe(true);
    const c = new CursorCliAdapter("cursor-agent");
    expect(c.buildArgs({ prompt: "x", cwd: "/tmp", mode: "readonly" })).toEqual(expect.arrayContaining(["--mode", "plan", "--output-format", "json"]));
    expect(c.buildArgs({ prompt: "x", cwd: "/tmp", mode: "readonly" })).not.toContain("--force");
    // Non-interactive runs must not stop at Cursor's workspace-trust prompt.
    expect(c.buildArgs({ prompt: "x", cwd: "/tmp", mode: "readonly" })).toContain("--trust");
    process.env.CURSOR_API_KEY = "x";
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
    const env = minimalEnv();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    delete process.env.CURSOR_API_KEY;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  });

  it("stay unusable until their feature flag is on; agents need the flag too", async () => {
    const gem = new SimulatorAdapter("gemini-cli", () => "ok", 0, { provider: "google" });
    app = await makeTestApp({ extraAdapters: [gem] });
    await seedUserAndAgents(app);
    expect(app.ctx.executors.usabilityReason("gemini-cli").reason).toContain("executors.gemini");
    await say(app, "/agent add 제미니 gemini");
    expect(app.out.lounge.at(-1)!.msg.text).toContain("/flag executors.gemini on");
    await say(app, "/flag executors.gemini on");
    expect(app.ctx.executors.isUsable("gemini-cli")).toBe(true);
    await say(app, "/agent add 제미니 gemini");
    const user = (await app.ctx.repos.users.list())[0]!;
    expect((await app.ctx.repos.agents.findByName(user.id, "제미니"))?.provider).toBe("google");
    await app.ctx.flags.set("executors.gemini", false);
    await syncExecutorFlags(app.ctx);
    expect(app.ctx.executors.isUsable("gemini-cli")).toBe(false);
  });
});

describe("user-defined worldviews", () => {
  const startup = {
    slug: "startup",
    labelKo: "스타트업",
    emoji: "🚀",
    atmosphere: "빠르게 실험하고 솔직하게 말하는 초기 스타트업",
    baseMode: "campus",
    titles: { user: "대표", moderator: "PM", member: "메이커" },
    teamAddress: "다들",
    registerOverrides: { "member>user": "polite", "member>member": "casual" },
  };

  it("validates, persists, renders titles and overrides, and reverts users on delete", async () => {
    app = await makeTestApp();
    const { user, claude, codex } = await seedUserAndAgents(app);
    await expect(saveCustomMode(app.ctx.repos, { ...startup, slug: "Bad Slug!" })).rejects.toThrow();
    await expect(saveCustomMode(app.ctx.repos, { ...startup, slug: "campus" })).rejects.toThrow(/기본 세계관/);
    const def = await saveCustomMode(app.ctx.repos, startup);
    expect(def.mode).toBe("custom:startup");
    expect(isOrganizationMode("custom:startup")).toBe(true);
    registerCustomModes([]); // simulate restart
    await loadCustomModes(app.ctx.repos);
    expect(modeDef("custom:startup").titles.user).toBe("대표");
    await say(app, "/mode custom:startup");
    const last = app.out.lounge.at(-1)!.msg;
    expect(last.header).toContain("🚀");
    expect(last.header).toContain("PM");
    expect(last.text.startsWith("대표님,")).toBe(true);
    // Overrides: member→user polite (campus base would be formal); peers informal after warming up.
    expect(resolveFormality({ mode: "custom:startup", speakerRole: "member", listenerRole: "user", situation: "report" })).toBe("polite");
    expect(resolveFormality({ mode: "custom:startup", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 0.1 })).toBe("polite");
    expect(resolveFormality({ mode: "custom:startup", speakerRole: "member", listenerRole: "member", situation: "discussion", affinity: 0.5 })).toBe("casual");
    const style = await app.orchestrator.comm.styleFor(user, claude, { kind: "team" }, "discussion");
    expect(style).toContain('상대 호칭: "다들"');
    expect(style).toContain("꾸며내지"); // hard rules always apply
    void codex;
    expect(await deleteCustomMode(app.ctx.repos, "startup")).toBe(1);
    expect((await app.ctx.repos.users.getProfile(user.id)).mode).toBe("campus");
    expect(isOrganizationMode("custom:startup")).toBe(false);
  });
});

describe("variant B collaboration protocols and A/B experiment", () => {
  it("defines per-worldview protocols", () => {
    expect(protocolFor("corporate", false, 3)).toMatchObject({ variant: "A", maxRounds: 3, minRounds: 1 });
    expect(protocolFor("construction", true, 3)).toMatchObject({ variant: "B", maxRounds: 2, positionLength: "2문장 이내" });
    const campus = protocolFor("campus", true, 3);
    expect(campus.minRounds).toBe(2);
    expect(campus.instruction(1, 1)).toContain("반론자");
    expect(protocolFor("corporate", true, 3).instruction(1, 0)).toContain("결론 → 근거 → 리스크");
  });

  it("runs campus B with a rebuttal round even when everyone agrees, and reports A vs B", async () => {
    const h = codingHandler();
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    await app.ctx.repos.users.updateProfile(user.id, { mode: "campus" });
    const lounge = await app.orchestrator.loungeProject(user);
    const run = async () => app!.orchestrator.discussion.run({ user, project: null, task: await app!.orchestrator.internalTask(lounge, "토론", "discussion"), topic: "DB 선택", context: "", agents: [claude, codex], cwd: app!.dataDir });
    const a = await run();
    expect(a.rounds).toBe(1);
    await app.ctx.flags.set("dialogue.style_variant_b", true);
    const b = await run();
    expect(b.rounds).toBe(2);
    expect(app.claude.calls.concat(app.codex.calls).some((c) => c.prompt.includes("당신은 반론자입니다"))).toBe(true);
    await say(app, "/experiment 30");
    const text = app.out.lounge.at(-1)!.msg.text;
    expect(text).toMatch(/대학 조별과제 A: 토론 1회 · 평균 1\.0라운드/);
    expect(text).toMatch(/대학 조별과제 B: 토론 1회 · 평균 2\.0라운드/);
  });
});

describe("performance-aware team assignment", () => {
  it("prefers the implementer with better first-pass history and the reviewer with fewer later revisions", async () => {
    app = await makeTestApp();
    const { user, claude } = await seedUserAndAgents(app);
    const mk = async (name: string, provider: "anthropic" | "openai", adapterId: string) => app!.ctx.repos.agents.create({ ownerId: user.id, name, provider, adapterId, modelPolicy: "auto", authMode: "official_subscription", personaId: null, organizationRole: "auto", dialoguePolicy: "relationship_aware", memoryEnabled: true, relationshipHistory: true, enabled: true });
    const claude2 = await mk("클로드2", "anthropic", "claude-cli");
    const codexA = await mk("코덱스A", "openai", "codex-cli");
    const codexB = await mk("코덱스B", "openai", "codex-cli");
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "P", slug: "p", status: "active" });
    await app.ctx.repos.projects.setAgents(p.id, [claude, claude2, codexA, codexB].map((a) => ({ agentId: a.id, functionalRole: "implementer", orgRole: "팀장" })));
    for (let i = 0; i < 4; i++) {
      await app.ctx.repos.tasks.create({ projectId: p.id, title: `a${i}`, state: "done", assignedAgentId: claude.id, reviewerAgentId: codexA.id, checkpoint: { reviewVerdict: { approved: true, reviewerAgentId: "r", summary: "ok", issues: [] }, userRevision: 1 } }).then((t) => app!.ctx.repos.tasks.update(t.id, { attempts: 3, completedAt: new Date().toISOString() }));
      await app.ctx.repos.tasks.create({ projectId: p.id, title: `b${i}`, state: "done", assignedAgentId: claude2.id, reviewerAgentId: codexB.id, checkpoint: { reviewVerdict: { approved: true, reviewerAgentId: "r", summary: "ok", issues: [] } } }).then((t) => app!.ctx.repos.tasks.update(t.id, { attempts: 1, completedAt: new Date().toISOString() }));
    }
    const opt = (await app.ctx.team.assign(p, { difficulty: "medium" }, ["implementer", "reviewer"], { optimize: true }))!;
    expect(opt.implementer.id).toBe(claude2.id);
    expect(opt.reviewer?.id).toBe(codexB.id);
    expect(opt.reasons.join(" ")).toContain("성과 기반 배정");
    expect(opt.reasons.join(" ")).toContain("리뷰 품질 기반 선택");
    // An explicit @mention still wins over the optimizer.
    const mentioned = (await app.ctx.team.assign(p, { difficulty: "medium", mentionedAgentIds: [claude.id] }, ["implementer", "reviewer"], { optimize: true }))!;
    expect(mentioned.implementer.id).toBe(claude.id);
  });
});

describe("Research Agency (new work type)", () => {
  it("classifies research requests", () => {
    expect(detectWorkType("AI 코딩 도구 시장 조사 보고서 프로젝트 만들어줘")).toBe("research");
    expect(detectWorkType("가계부 앱 만들어줘")).toBe("coding");
    expect(detectWorkType("경쟁사 웹사이트 분석 보고서")).toBe("coding"); // mentions software → coding stays default
  });

  it("checks report structure", () => {
    expect(checkReport(null)[0]!.status).toBe("failed");
    const good = `# 보고서\n\n${"본문 내용입니다. ".repeat(120)} 주장 [1] 근거 [2] 수치 [3]\n\n## 출처\n1. https://a.example/1\n2. https://b.example/2\n3. https://c.example/3\n`;
    expect(checkReport(good).every((c) => c.status === "passed")).toBe(true);
    expect(checkReport("# 짧음\n## 출처\n1. https://a.example").filter((c) => c.status === "failed").map((c) => c.name)).toEqual(["report_length", "sources", "citations"]);
  });

  it("plans, researches with web tools, fails structural checks, revises, passes fact-check review, opens a PR and delivers the report", async () => {
    let impl = 0;
    const h: SimulatorHandler = (req) => {
      const p = req.prompt;
      if (p.includes("팩트체커입니다")) return JSON.stringify({ approved: true, summary: "출처 확인 완료", issues: [], message: "출처 다 열어 봤어요, 좋아요." });
      if (p.includes("리드 연구원입니다")) return JSON.stringify({ summary: "AI 코딩 도구 비교", acceptance_criteria: ["도구 3개 비교", "출처 3개 이상"], difficulty: "easy", subtasks: [], message: "조사 계획 세웠습니다." });
      if (p.includes("리서치 조직의 연구원입니다")) {
        impl++;
        const rel = /`(reports\/[^`]+\.md)`/.exec(p)![1]!;
        fs.mkdirSync(path.join(req.cwd, "reports"), { recursive: true });
        const body = impl === 1 ? "# 초안\n짧은 메모" : `# AI 코딩 도구 비교\n\n## 요약\n${"비교 결과입니다. ".repeat(120)} A는 빠르다 [1]. B는 정확하다 [2]. C는 저렴하다 [3].\n\n## 출처\n1. https://a.example/doc\n2. https://b.example/doc\n3. https://c.example/doc\n`;
        fs.writeFileSync(path.join(req.cwd, rel), body);
        return JSON.stringify({ summary: `report ${impl}`, changes: [rel], message: "보고서 썼어요." });
      }
      return "{}";
    };
    app = await makeTestApp({ claude: h, codex: h });
    const { user, claude, codex } = await seedUserAndAgents(app);
    seedRemote(app, "tester/research");
    const p0 = await app.ctx.repos.projects.create({ ownerId: user.id, name: "리서치", slug: "research", repoRef: "tester/research", repoMode: "imported", status: "proposed", workType: "research" });
    const project = await app.orchestrator.activateProject(user, p0.id, [{ agentId: claude.id, role: "leader" }, { agentId: codex.id, role: "reviewer" }]);
    expect((await app.ctx.repos.jobs.list()).some((j) => j.kind === "project.baseline")).toBe(false); // no code baseline for reports
    const task = await app.orchestrator.createTask(user, project, "AI 코딩 도구 3개를 비교 조사해줘", []);
    await app.scheduler.drain(60_000);
    const gates = (await app.ctx.repos.conversations.list(project.id, 200)).filter((m) => m.kind === "quality.gate");
    expect(gates.map((g) => g.machineState.status)).toEqual(["failed", "passed"]);
    expect(gates[0]!.renderedText).toContain("출처 섹션(## 출처)이 없습니다");
    const t = await app.ctx.repos.tasks.get(task.id);
    expect(t.state).toBe("awaiting_approval");
    expect(t.prRef).toContain("/pull/1");
    expect(app.claude.calls.concat(app.codex.calls).filter((c) => c.prompt.includes("리서치 조직의 연구원입니다")).every((c) => c.allowWeb === true)).toBe(true);
    expect(app.out.documents).toHaveLength(1);
    expect(app.out.documents[0]!.filename).toBe(path.basename(reportPathFor(t)));
    expect(app.out.documents[0]!.content.toString()).toContain("## 출처");
    expect((await app.ctx.repos.artifacts.listByTask(task.id)).some((a) => a.kind === "research_report")).toBe(true);
  }, 120_000);
});
