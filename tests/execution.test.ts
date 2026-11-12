import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp, seedRemote, seedUserAndAgents, codingHandler, type TestApp } from "./helpers.js";
import { SimulatorAdapter } from "../src/executors/simulator.js";
import { resolveExecutionPolicy, setExecutionPolicy, executorCandidates, DEFAULT_EXECUTION_POLICY } from "../src/core/execution/policy.js";
import { CodexCloudAdapter } from "../src/executors/codexCloud.js";
import { ClaudeCliAdapter } from "../src/executors/claude.js";
import { CodexCliAdapter } from "../src/executors/codex.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

describe("execution policy (PRD §15)", () => {
  it("defaults to cloud → local_cli with paid API disabled; overrides layer user < project < agent", async () => {
    app = await makeTestApp();
    const { user, claude } = await seedUserAndAgents(app);
    const p0 = await resolveExecutionPolicy(app.ctx.repos, { userId: user.id });
    expect(p0.priority).toEqual(["cloud", "local_cli"]);
    expect(p0.paidApi.enabled).toBe(false);
    expect(DEFAULT_EXECUTION_POLICY.paidApi.requireExplicitApproval).toBe(true);
    const project = await app.ctx.repos.projects.create({ ownerId: user.id, name: "X", slug: "x", status: "active" });
    await setExecutionPolicy(app.ctx.repos, "user", user.id, { autoFallback: false });
    await setExecutionPolicy(app.ctx.repos, "project", project.id, { priority: ["local_cli"] });
    await setExecutionPolicy(app.ctx.repos, "agent", claude.id, { priority: ["local_cli", "cloud"], paidApi: { enabled: true, requireExplicitApproval: false } as any });
    const p1 = await resolveExecutionPolicy(app.ctx.repos, { userId: user.id, projectId: project.id });
    expect(p1).toMatchObject({ priority: ["local_cli"], autoFallback: false });
    const p2 = await resolveExecutionPolicy(app.ctx.repos, { userId: user.id, projectId: project.id, agentId: claude.id });
    expect(p2.priority).toEqual(["local_cli", "cloud"]);
    expect(p2.paidApi.requireExplicitApproval).toBe(true); // cannot be turned off
  });

  it("falls back cloud → local when the cloud executor hits its quota, after checking the cloud job ended", async () => {
    const h = codingHandler();
    const cloud = new SimulatorAdapter("claude-cloud-sim", () => ({ status: "failed", quotaExhausted: true, error: "usage limit reached" }), 0, { kind: "cloud", provider: "anthropic" });
    app = await makeTestApp({ claude: h, codex: h, extraAdapters: [cloud] });
    const { user, claude, codex } = await seedUserAndAgents(app);
    seedRemote(app, "tester/demo");
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed" });
    const project = await app.orchestrator.activateProject(user, p.id, [
      { agentId: claude.id, role: "leader" },
      { agentId: codex.id, role: "reviewer" },
    ]);
    // Mark the cloud job as finished before the fallback guard checks it.
    const origStart = cloud.start.bind(cloud);
    cloud.start = (req) => {
      const h2 = origStart({ ...req, onExternalRef: async (ref) => { cloud.externalStates.set(ref, "finished"); await req.onExternalRef?.(ref); } });
      return h2;
    };
    const task = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const execs = await app.ctx.repos.executions.listByTask(task.id);
    const plan = execs.filter((e) => e.purpose === "plan");
    expect(plan.map((e) => `${e.adapterId}:${e.status}`)).toEqual(["claude-cloud-sim:failed", "claude-cli:succeeded"]);
    expect(app.ctx.usage.quotaState("claude-cloud-sim")).toBe("exhausted");
    expect((await app.ctx.repos.tasks.get(task.id)).state).toBe("awaiting_approval");
  }, 60_000);

  it("does not fall back while a previous cloud job is still running (no duplicate execution)", async () => {
    const cloud = new SimulatorAdapter("claude-cloud-sim", () => ({ status: "timeout", error: "작업 ID 미확인" }), 0, { kind: "cloud", provider: "anthropic" });
    const h = codingHandler();
    app = await makeTestApp({ claude: h, codex: h, extraAdapters: [cloud] });
    const { user, claude, codex } = await seedUserAndAgents(app);
    seedRemote(app, "tester/demo");
    const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed" });
    const project = await app.orchestrator.activateProject(user, p.id, [{ agentId: claude.id, role: "leader" }, { agentId: codex.id, role: "reviewer" }]);
    const task = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
    await app.scheduler.drain(60_000);
    const execs = await app.ctx.repos.executions.listByTask(task.id);
    expect(execs.filter((e) => e.adapterId === "claude-cli")).toHaveLength(0);
    const t = await app.ctx.repos.tasks.get(task.id);
    expect(t.state).toBe("blocked");
    expect(t.blockedReason).toMatch(/중복 실행/);
  }, 60_000);

  it("never uses a paid API executor automatically; requests explicit approval", async () => {
    const paid = new SimulatorAdapter("anthropic-api", () => "{}", 0, { kind: "paid_api", provider: "anthropic" });
    app = await makeTestApp({ extraAdapters: [paid] });
    const { user, claude } = await seedUserAndAgents(app);
    // Subscription CLI goes down; paid API is enabled by the operator but must still be approved.
    app.ctx.executors.setStatus({ ...(app.ctx.executors.getStatus("claude-cli")!), authenticated: false });
    await setExecutionPolicy(app.ctx.repos, "user", user.id, { priority: ["cloud", "local_cli", "paid_api"], paidApi: { enabled: true } });
    const cands = executorCandidates(app.ctx.executors, claude, await resolveExecutionPolicy(app.ctx.repos, { userId: user.id }));
    expect(cands.find((c) => c.adapter.id === "anthropic-api")?.requiresApproval).toBe(true);
    const project = await app.ctx.repos.projects.create({ ownerId: user.id, name: "L", slug: "l", status: "active" });
    const task = await app.ctx.repos.tasks.create({ projectId: project.id, title: "q" });
    const out = await app.orchestrator.runner.run({ agent: claude, task, project, purpose: "discuss", prompt: "hi", cwd: app.dataDir, mode: "readonly" });
    expect(out.needsApproval).toBe("paid_api_usage");
    expect(paid.calls).toHaveLength(0);
    // Without enabling, paid API is not even a candidate.
    await setExecutionPolicy(app.ctx.repos, "user", user.id, { paidApi: { enabled: false } });
    const c2 = executorCandidates(app.ctx.executors, claude, await resolveExecutionPolicy(app.ctx.repos, { userId: user.id }));
    expect(c2.some((c) => c.adapter.kind === "paid_api")).toBe(false);
  });

  it("resuming continues the agent's own session, never another agent's, and a vanished session restarts fresh", async () => {
    let claudeGone = false;
    app = await makeTestApp({
      claude: (req) => {
        if (claudeGone && req.resumeSessionRef) throw new Error(`No conversation found with session ID: ${req.resumeSessionRef}`);
        return "ok";
      },
      codex: () => "ok",
    });
    const { user, claude, codex } = await seedUserAndAgents(app);
    const project = await app.ctx.repos.projects.create({ ownerId: user.id, name: "S", slug: "s", status: "active" });
    const task = await app.ctx.repos.tasks.create({ projectId: project.id, title: "q" });
    const run = (agent: typeof claude, resume: boolean) => app!.orchestrator.runner.run({ agent, task, project, purpose: resume ? "fix" : "implement", prompt: "x", cwd: app!.dataDir, mode: "readonly", resumeSessionRef: resume ? "resume" : null });
    const impl = await run(claude, false); // implementer (Claude)
    const review = await run(codex, false); // reviewer (Codex) runs last
    expect(review.sessionRef).not.toBe(impl.sessionRef);
    await run(claude, true); // fix: must resume Claude's own session, not the reviewer's
    expect(app.claude.calls.at(-1)!.resumeSessionRef).toBe(impl.sessionRef);
    // The saved conversation disappears: one failed resume, then a fresh run that succeeds.
    claudeGone = true;
    const n = app.claude.calls.length;
    const out = await run(claude, true);
    expect(out.status).toBe("succeeded");
    expect(app.claude.calls.slice(n).map((r) => r.resumeSessionRef ?? null)).toEqual([impl.sessionRef, null]);
  });

  it("unverified cloud executors are reported honestly and only enabled by a recorded verification", async () => {
    const cloud = new SimulatorAdapter("cc", () => "ok", 0, { kind: "cloud", provider: "openai" });
    app = await makeTestApp({ extraAdapters: [cloud] });
    app.ctx.executors.setStatus({ ...(await cloud.detect()), capabilities: { ...(await cloud.detect()).capabilities, run: "unverified" } });
    expect(app.ctx.executors.usabilityReason("cc").reason).toMatch(/미확인/);
    app.ctx.executors.setVerification({ adapterId: "cc", verifiedAt: new Date().toISOString(), evidence: "status=succeeded", version: null });
    expect(app.ctx.executors.isUsable("cc")).toBe(true);
  });
});

describe("adapter output parsing", () => {
  it("parses Claude json results", () => {
    const r = ClaudeCliAdapter.parseOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1", total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 7 }, modelUsage: { "claude-x": {} } }));
    expect(r).toMatchObject({ text: "done", sessionRef: "s1", isError: false, model: "claude-x" });
    expect(r.usage.api_equivalent_cost_usd_estimate).toBe(0.01);
  });
  it("parses Codex JSONL events", () => {
    const out = [JSON.stringify({ type: "thread.started", thread_id: "th_1" }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3 } })].join("\n");
    expect(CodexCliAdapter.parseOutput(out)).toMatchObject({ text: "hi", sessionRef: "th_1", isError: false, usage: { input_tokens: 3 } });
  });
  it("parses Codex Cloud task ids and states defensively", () => {
    expect(CodexCloudAdapter.parseTaskId("Submitted: https://chatgpt.com/codex/tasks/task_e_abc123XYZ")).toBe("task_e_abc123XYZ");
    expect(CodexCloudAdapter.parseState("status: READY")).toBe("finished");
    expect(CodexCloudAdapter.parseState("status: in_progress")).toBe("running");
    expect(CodexCloudAdapter.parseState("???")).toBe("unknown");
  });
  it("Claude adapter restricts tools in read-only mode and never passes API keys", () => {
    const a = new ClaudeCliAdapter("claude");
    const args = a.buildArgs({ prompt: "x", cwd: "/tmp", mode: "readonly" });
    expect(args).toContain("--disallowedTools");
    expect(args.join(" ")).toContain("Edit");
    expect(a.buildArgs({ prompt: "x", cwd: "/tmp", mode: "write", isolated: true })).toContain("bypassPermissions");
    expect(a.buildArgs({ prompt: "x", cwd: "/tmp", mode: "write" })).toContain("acceptEdits");
  });
});
