import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { openAndMigrate, migrate } from "../src/db/index.js";
import { Repos } from "../src/db/repositories.js";
import { exportDatabase, importDatabase } from "../src/backup/backup.js";
import { makeTestApp, seedRemote, seedUserAndAgents, codingHandler } from "./helpers.js";

/**
 * Runs only when TEST_DATABASE_URL points at a PostgreSQL server (e.g. the docker compose db or a
 * local cluster). Each test uses a throwaway database.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const d = ADMIN_URL ? describe : describe.skip;

async function tempDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `aa_it_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

d("PostgreSQL integration", () => {
  it("migrations are idempotent and safe under concurrent startup", async () => {
    const t = await tempDb();
    try {
      const [a, b] = await Promise.all([openAndMigrate({ databaseUrl: t.url }), openAndMigrate({ databaseUrl: t.url })]);
      expect((await migrate(a)).applied).toEqual([]);
      await a.close();
      await b.close();
    } finally {
      await t.drop();
    }
  });

  it("runs the full vertical slice on PostgreSQL and survives a process restart", async () => {
    const t = await tempDb();
    try {
      const h = codingHandler();
      let app = await makeTestApp({ claude: h, codex: h, databaseUrl: t.url });
      const { user, claude, codex } = await seedUserAndAgents(app);
      seedRemote(app, "tester/demo");
      const p = await app.ctx.repos.projects.create({ ownerId: user.id, name: "Demo", slug: "demo", repoRef: "tester/demo", repoMode: "imported", status: "proposed" });
      const project = await app.orchestrator.activateProject(user, p.id, [{ agentId: claude.id, role: "leader" }, { agentId: codex.id, role: "reviewer" }]);
      const task = await app.orchestrator.createTask(user, project, "hello 함수를 추가해줘", []);
      await app.stop(); // "restart" before the job ran
      app = await makeTestApp({ claude: h, codex: h, databaseUrl: t.url });
      try {
      const rec = await app.scheduler.recover();
      expect(rec.resumed).toBe(1);
      // workspace dir changed with the new data dir; the bare remote must be re-seeded for the new app
      seedRemote(app, "tester/demo");
      await app.scheduler.drain(60_000);
      const done = await app.ctx.repos.tasks.get(task.id);
      expect(done.state).toBe("awaiting_approval");
      expect(done.prRef).toBeTruthy();
      expect((await app.ctx.repos.agents.get(claude.id)).name).toBe("클로드");
      } finally {
        await app.stop();
      }
    } finally {
      await t.drop();
    }
  }, 120_000);

  it("migrates data between engines/providers via logical backup (PGlite → PostgreSQL)", async () => {
    const t = await tempDb();
    try {
      const lite = await openAndMigrate({});
      const r1 = new Repos(lite);
      const u = await r1.users.upsertByTelegram(5, "boss");
      await r1.projects.create({ ownerId: u.id, name: "P", slug: "p", stack: ["x"] });
      const pgdb = await openAndMigrate({ databaseUrl: t.url });
      await importDatabase(pgdb, await exportDatabase(lite));
      const r2 = new Repos(pgdb);
      expect((await r2.users.findByTelegram(5))?.displayName).toBe("boss");
      expect((await r2.projects.listByOwner(u.id))[0]!.stack).toEqual(["x"]);
      await lite.close();
      await pgdb.close();
    } finally {
      await t.drop();
    }
  });
});
