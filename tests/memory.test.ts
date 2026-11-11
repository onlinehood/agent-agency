import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp, seedUserAndAgents, type TestApp } from "./helpers.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

describe("PostgreSQL memory + Context Builder (PRD §17)", () => {
  it("builds the 4 sections, separates confirmed vs proposed, puts the latest instruction first, and isolates projects", async () => {
    app = await makeTestApp();
    const { user, claude, codex } = await seedUserAndAgents(app);
    const a = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Alpha", slug: "alpha", status: "active", stack: ["Go"] });
    const b = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Beta", slug: "beta", status: "active" });
    await app.ctx.repos.projects.setAgents(a.id, [{ agentId: claude.id, functionalRole: "leader", orgRole: "팀장" }]);
    await app.ctx.repos.decisions.create({ projectId: a.id, taskId: null, title: "DB", rationale: "PostgreSQL 사용", alternatives: [], approvalRef: null });
    await app.ctx.repos.decisions.create({ projectId: a.id, taskId: null, title: "캐시", rationale: "Redis 검토", alternatives: [], approvalRef: null, status: "proposed" });
    await app.ctx.memory.remember(a.id, "requirement", "로그인 필요", { certainty: "proposal" });
    await app.ctx.memory.remember(b.id, "requirement", "BETA-SECRET-CONTEXT");
    await app.ctx.repos.relationships.recordInteraction(user.id, claude.id, codex.id, "positive", "리뷰 협업");
    const task = await app.ctx.repos.tasks.create({ projectId: a.id, title: "로그인", acceptanceCriteria: ["세션 유지"], branch: "agency/x", checkpoint: { stage: "testing", qualityGate: { passed: false, ranAt: "", checks: [{ name: "test", status: "failed", durationMs: 1, summary: "x" }] } } });
    await app.ctx.repos.conversations.add({ projectId: a.id, taskId: task.id, speakerAgentId: claude.id, listenerRef: codex.id, kind: "discussion.turn", renderedText: "세션은 쿠키로 하죠", machineState: { kind: "discussion.turn" } });
    const built = await app.ctx.contextBuilder.build({ userId: user.id, agent: claude, project: a, task, peers: [codex], stylePolicy: "[말투] 테스트", latestInstruction: "OAuth는 쓰지 마" });
    const t = built.text;
    expect(t.indexOf("## 1.")).toBeLessThan(t.indexOf("## 2."));
    expect(t.indexOf("## 3.")).toBeLessThan(t.indexOf("## 4."));
    expect(t).toContain("최신 사용자 지시 (기존 기억보다 우선)\nOAuth는 쓰지 마");
    expect(t).toContain("확정 결정");
    expect(t).toContain("미확정 제안");
    expect(t).toContain("[제안] 로그인 필요");
    expect(t).toContain("세션은 쿠키로 하죠");
    expect(t).toContain("협업 1회");
    expect(t).toContain("최근 품질 게이트: 실패");
    expect(t).not.toContain("BETA-SECRET-CONTEXT");
    expect(built.sourceRefs).toContain(task.id);
  });

  it("identity and memory survive an executor change (rebuilt from the same store)", async () => {
    app = await makeTestApp();
    const { user, claude } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "P", slug: "p", status: "active" });
    await app.ctx.memory.remember(p.id, "lesson", "flaky e2e 주의");
    const before = await app.ctx.contextBuilder.build({ userId: user.id, agent: claude, project: p });
    await app.ctx.repos.agents.update(claude.id, { adapterId: "codex-cli", provider: "openai", modelPolicy: "auto" });
    const after = await app.ctx.contextBuilder.build({ userId: user.id, agent: await app.ctx.repos.agents.get(claude.id), project: p });
    expect(after.text).toContain("flaky e2e 주의");
    expect(after.sections.identity).toBe(before.sections.identity);
  });

  it("summarizes raw conversation with links back to source events", async () => {
    app = await makeTestApp();
    const { user } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "P", slug: "p", status: "active" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await app.ctx.repos.conversations.add({ projectId: p.id, taskId: null, speakerAgentId: null, listenerRef: null, kind: "discussion.turn", renderedText: `msg ${i}`, machineState: { kind: "discussion.turn", data: { position: `입장 ${i}` } } })).id);
    const s = await app.ctx.memory.summarizeIfNeeded(p.id, { threshold: 5 });
    expect(s).toContain("입장 4");
    const [sum] = await app.ctx.repos.summaries.list(p.id);
    expect(sum!.sourceMessageIds.sort()).toEqual(ids.sort());
    expect(await app.ctx.memory.summarizeIfNeeded(p.id, { threshold: 5 })).toBeNull();
  });

  it("repeated feedback becomes a preference only from the second time", async () => {
    app = await makeTestApp();
    const { user } = await seedUserAndAgents(app);
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "P", slug: "p", status: "active" });
    await app.ctx.memory.learnPreference(p.id, "앞으로 커밋 메시지는 영어로");
    expect(await app.ctx.memory.activePreferences(p.id)).toEqual([]);
    await app.ctx.memory.learnPreference(p.id, "앞으로  커밋 메시지는 영어로");
    expect(await app.ctx.memory.activePreferences(p.id)).toHaveLength(1);
  });
});
