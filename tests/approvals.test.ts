import { describe, it, expect } from "vitest";
import { openAndMigrate } from "../src/db/index.js";
import { Repos } from "../src/db/repositories.js";
import { ApprovalEngine } from "../src/core/approvals/engine.js";
import { EventBus } from "../src/core/events.js";
import { requiresApproval, NEVER_WITHOUT_APPROVAL } from "../src/core/approvals/policy.js";

async function setup() {
  const db = await openAndMigrate({});
  const repos = new Repos(db);
  const engine = new ApprovalEngine(repos, new EventBus());
  return { db, repos, engine };
}

describe("approval policy (PRD §5.1, §12-5)", () => {
  it("critical actions always need approval in every mode", () => {
    for (const a of NEVER_WITHOUT_APPROVAL) for (const m of ["default", "strict", "auto_within_scope"] as const) expect(requiresApproval(a, m)).toBe(true);
  });
  it("PR merge needs approval by default, not in auto-within-scope mode", () => {
    expect(requiresApproval("pr_merge", "default")).toBe(true);
    expect(requiresApproval("pr_merge", "auto_within_scope")).toBe(false);
    expect(requiresApproval("plan_scope", "default", { withinApprovedScope: true })).toBe(false);
    expect(requiresApproval("plan_scope", "strict", { withinApprovedScope: true })).toBe(true);
  });
});

describe("approval engine", () => {
  it("binds approvals to actor + nonce + expiry, dedupes, and requires reconfirm for critical actions", async () => {
    const { db, engine } = await setup();
    const a = await engine.request({ actorId: "u1", projectId: "p1", taskId: "t1", action: "deploy_production", summary: "deploy" });
    const dup = await engine.request({ actorId: "u1", projectId: "p1", taskId: "t1", action: "deploy_production", summary: "deploy" });
    expect(dup.id).toBe(a.id);
    await expect(engine.decide(a.id, "approve", { actorId: "intruder", nonce: a.nonce })).rejects.toThrow(/권한/);
    await expect(engine.decide(a.id, "approve", { actorId: "u1", nonce: "forged" })).rejects.toThrow();
    const first = await engine.decide(a.id, "approve", { actorId: "u1", nonce: a.nonce });
    expect(first.needsReconfirm).toBe(true);
    expect(await engine.isApproved("deploy_production", { taskId: "t1", projectId: "p1" })).toBe(false);
    const second = await engine.decide(a.id, "approve", { actorId: "u1", nonce: a.nonce, reconfirm: true });
    expect(second.final).toBe(true);
    expect(await engine.isApproved("deploy_production", { taskId: "t1", projectId: "p1" })).toBe(true);
    await expect(engine.decide(a.id, "approve", { actorId: "u1", nonce: a.nonce })).rejects.toThrow(/이미 처리/);
    await db.close();
  });

  it("expired approvals cannot be used", async () => {
    const { db, repos, engine } = await setup();
    const a = await engine.request({ actorId: "u1", action: "pr_merge", summary: "merge" });
    await db.query("UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE id=$1", [a.id]);
    await expect(engine.decide(a.id, "approve", { actorId: "u1", nonce: a.nonce })).rejects.toThrow(/만료/);
    expect((await repos.approvals.get(a.id)).status).toBe("expired");
    await db.close();
  });
});
