import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openAndMigrate } from "../src/db/index.js";
import { Repos } from "../src/db/repositories.js";
import { exportDatabase, encodeBackup, decodeBackup, importDatabase, createLocalBackup, listBackups } from "../src/backup/backup.js";
import { signS3Put } from "../src/backup/s3.js";
import { decide, availableMemBytes } from "../src/ops/resources.js";
import { Scheduler } from "../src/core/scheduler/scheduler.js";
import { renderHtml, splitText, keyboard } from "../src/telegram/format.js";
import { classify } from "../src/core/orchestration/classifier.js";
import { appJwt } from "../src/github/appAuth.js";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { LocalFileStore } from "../src/storage/fileStore.js";
import { tmpDir, makeTestApp } from "./helpers.js";
import type { Agent } from "../src/core/types.js";

describe("job queue", () => {
  it("dedupes, claims with priority, retries, and recovers stale jobs", async () => {
    const db = await openAndMigrate({});
    const r = new Repos(db);
    await r.jobs.enqueue("task.run", { n: 1 }, { dedupeKey: "a", priority: 10 });
    await r.jobs.enqueue("task.run", { n: 1 }, { dedupeKey: "a", priority: 10 });
    await r.jobs.enqueue("task.run", { n: 2 }, { dedupeKey: "b", priority: 90 });
    expect(await r.jobs.list("queued")).toHaveLength(2);
    const [first] = await r.jobs.claim("w", 1);
    expect(first!.dedupeKey).toBe("b");
    await r.jobs.fail(first!.id, "boom", 0);
    expect((await r.jobs.list("queued")).length).toBe(2);
    const claimed = await r.jobs.claim("w", 5);
    expect(claimed).toHaveLength(2);
    expect(await r.jobs.requeueStale(0)).toBe(2);
    await db.close();
  });
});

describe("backup / restore (engine-neutral, provider migration)", () => {
  it("round-trips all data, supports encryption and refuses newer schemas", async () => {
    const src = await openAndMigrate({});
    const rs = new Repos(src);
    const u = await rs.users.upsertByTelegram(42, "boss");
    const p = await rs.projects.create({ ownerId: u.id, name: "P", slug: "p", stack: ["a", "b"], settings: { testCommand: "npm test" } });
    await rs.memories.add(p.id, "decision", "keep me", { sourceRefs: ["x"] });
    await rs.audit.record("t", "a", "r", "info", { k: 1 });
    await rs.settings.set("system", "", "telegram.lounge_chat_id", "-100");
    const doc = await exportDatabase(src);
    const enc = encodeBackup(doc, "pass phrase");
    expect(() => decodeBackup(enc)).toThrow(/암호/);
    expect(() => decodeBackup(enc, "wrong")).toThrow();
    const dst = await openAndMigrate({});
    await new Repos(dst).users.upsertByTelegram(7, "other");
    const res = await importDatabase(dst, decodeBackup(enc, "pass phrase"));
    expect(res.rows).toBeGreaterThan(4);
    const rd = new Repos(dst);
    expect((await rd.users.list()).map((x) => x.telegramUserId)).toEqual([42]);
    expect((await rd.projects.get(p.id)).stack).toEqual(["a", "b"]);
    expect((await rd.projects.get(p.id)).settings.testCommand).toBe("npm test");
    expect((await rd.memories.list(p.id))[0]!.sourceRefs).toEqual(["x"]);
    expect(await rd.settings.get("system", "", "telegram.lounge_chat_id")).toBe("-100");
    await rd.audit.record("t", "after-restore", "r", "info");
    await expect(importDatabase(dst, { ...doc, schemaVersion: 999 })).rejects.toThrow(/새롭습니다/);
    const dir = tmpDir();
    for (let i = 0; i < 3; i++) await createLocalBackup(src, dir, { keep: 2 });
    expect(listBackups(dir)).toHaveLength(2);
    await src.close();
    await dst.close();
  });

  it("signs S3-compatible uploads (any provider)", () => {
    const s = signS3Put({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK", prefix: "aa" }, "f.gz", Buffer.from("x"), new Date("2026-01-01T00:00:00Z"));
    expect(s.url).toBe("https://s3.example.com/b/aa/f.gz");
    expect(s.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20260101\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});

describe("resources", () => {
  it("scales concurrency to the real host and defers work when disk/memory are low", () => {
    const base = { cpus: 4, load1: 0.5, totalMemBytes: 16 * 1024 ** 3, freeMemBytes: 8 * 1024 ** 3, diskFreeBytes: 50 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3 };
    expect(decide(base, 2)).toMatchObject({ allowedConcurrency: 2, acceptNewWork: true });
    expect(decide({ ...base, totalMemBytes: 1 * 1024 ** 3 }, 2).allowedConcurrency).toBe(1); // e.g. 1GB micro VM
    expect(decide({ ...base, diskFreeBytes: 1024 ** 3 }, 2).acceptNewWork).toBe(false);
    expect(decide({ ...base, freeMemBytes: 100 * 1024 ** 2 }, 2).acceptNewWork).toBe(false);
    // Informational limits (small RAM, high load) never block work or appear as blocking reasons.
    const small = decide({ ...base, totalMemBytes: 1024 ** 3, load1: 9 }, 2);
    expect(small.acceptNewWork).toBe(true);
    expect(small.blocking).toEqual([]);
    expect(decide({ ...base, freeMemBytes: 100 * 1024 ** 2 }, 2).blocking[0]).toMatch(/사용 가능한 메모리 100MB/);
  });

  it("reads MemAvailable (reclaimable cache counts as available), not MemFree", () => {
    const meminfo = "MemTotal:        1000000 kB\nMemFree:           40000 kB\nMemAvailable:     600000 kB\nBuffers:            1000 kB\n";
    expect(availableMemBytes(meminfo)).toBe(600000 * 1024);
    // free swap counts half
    expect(availableMemBytes(meminfo + "SwapTotal:       4000000 kB\nSwapFree:        4000000 kB\n")).toBe((600000 + 2000000) * 1024);
  });

  it("alerts about deferred work only when work is waiting, and not repeatedly", async () => {
    const app = await makeTestApp();
    try {
      const low = () => ({ cpus: 1, load1: 4, totalMemBytes: 1024 ** 3, freeMemBytes: 100 * 1024 ** 2, diskFreeBytes: 50 * 1024 ** 3, diskTotalBytes: 100 * 1024 ** 3 });
      const sched = new Scheduler(app.ctx, app.orchestrator, { resourceProbe: low });
      const alerts: string[] = [];
      app.ctx.events.on("alert", (a) => alerts.push(a.message));
      await sched.tick();
      await sched.tick();
      expect(alerts).toEqual([]); // nothing queued: nothing to tell
      await app.ctx.repos.jobs.enqueue("task.run", { projectId: "p1", taskId: "t1" });
      for (let i = 0; i < 5; i++) await sched.tick();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatch(/대기 중인 작업을 잠시 미룹니다: 사용 가능한 메모리 100MB/);
      expect(alerts[0]).toMatch(/RAM이 작아요/);
      expect(alerts[0]).not.toMatch(/load/);
    } finally {
      await app.stop();
    }
  });
});

describe("telegram formatting", () => {
  it("escapes HTML, splits long messages and validates callback size", () => {
    const chunks = renderHtml({ header: "A <b>", text: "x".repeat(9000) });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toContain("A &lt;b&gt;");
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(splitText("a\nb", 10)).toEqual(["a\nb"]);
    expect(() => keyboard([[{ text: "x", data: "a".repeat(65) }]])).toThrow();
  });
});

describe("classifier", () => {
  const agents = [{ id: "a1", name: "클로드" }, { id: "a2", name: "코덱스" }] as Agent[];
  it("classifies requests and extracts mentions", () => {
    expect(classify("새 프로젝트 만들어줘 \"가계부\"", agents, { inProjectTopic: false })).toMatchObject({ classification: "new_project", projectName: "가계부" });
    expect(classify("https://github.com/a/b 가져와", agents, { inProjectTopic: false })).toMatchObject({ classification: "import_project", repoRef: "a/b" });
    expect(classify("@코덱스 로그인 버튼 추가해줘", agents, { inProjectTopic: true })).toMatchObject({ classification: "task_request", mentionedAgentIds: ["a2"] });
    expect(classify("나중에 다크모드 있으면 좋겠다", agents, { inProjectTopic: true }).classification).toBe("idea");
    expect(classify("지금 진행 상황이 어때?", agents, { inProjectTopic: true }).classification).toBe("question");
  });
});

describe("github app auth", () => {
  it("creates a valid RS256 app JWT", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt("123", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), 1_700_000_000);
    const [h, p, s] = jwt.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(payload).toMatchObject({ iss: "123", iat: 1_700_000_000 - 60 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("file store retention", () => {
  it("purges files older than the cutoff", async () => {
    const root = tmpDir();
    const fsx = new LocalFileStore(root);
    const f = await fsx.put("logs", "a.log", "hello");
    const old = path.join(root, "logs", "2000-01-01");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "x.log"), "old");
    expect(await fsx.purgeOlderThan("logs", new Date(Date.now() - 86400_000))).toBe(1);
    expect((await fsx.get(f.ref)).toString()).toBe("hello");
    await expect(fsx.get("../../etc/passwd")).rejects.toThrow();
  });
});
