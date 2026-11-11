import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import { Runtime } from "../src/runtime.js";
import { createWebApp } from "../src/web/server.js";
import { WebAuth } from "../src/web/auth.js";
import { SECRET_REFS, SYSTEM_OWNER } from "../src/app.js";
import { summarizeUpdates } from "../src/telegram/gateway.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

function client(web: ReturnType<typeof createWebApp>) {
  let cookie = "";
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await web.request(`http://localhost${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };
  const csrf = async () => /name="_csrf" value="([^"]+)"/.exec(await (await req("/setup")).text())?.[1] ?? "";
  const post = async (path: string, data: Record<string, string>, withCsrf = true) => {
    const body = new URLSearchParams({ ...data, ...(withCsrf ? { _csrf: await csrf() } : {}) });
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  };
  return { req, post };
}

describe("optional web console: setup pages + admin dashboard (PRD §18)", () => {
  it("walks admin → telegram → executors → github → defaults → diagnostics with auth and CSRF", async () => {
    app = await makeTestApp({ claude: (req) => (req.prompt.includes("Reply with exactly") ? "AGENT_AGENCY_OK" : "{}") });
    const rt = new Runtime(app);
    const web = createWebApp(rt);
    const c = client(web);
    expect((await c.req("/api/health")).status).toBe(200);
    expect((await c.req("/")).headers.get("location")).toContain("/setup");
    const token = (await new WebAuth(app.ctx.repos).ensureSetupToken())!;
    expect((await c.post("/setup/admin", { token: "wrong", password: "long-enough-password" }, false)).status).toBe(400);
    expect((await c.post("/setup/admin", { token, password: "short" }, false)).status).toBe(400);
    expect((await c.post("/setup/admin", { token, password: "long-enough-password" }, false)).status).toBe(302);
    // Telegram step: simulate a stored token + admin id (real Telegram API is not called in tests).
    expect(await (await c.req("/setup")).text()).toContain('class="cur">2. Telegram');
    await app.ctx.vault.put(SYSTEM_OWNER, "tg", "123:abc", null, SECRET_REFS.telegramToken);
    await app.ctx.repos.users.upsertByTelegram(1001, null);
    const exec = await (await c.req("/setup")).text();
    expect(exec).toContain('class="cur">3. AI 실행기');
    expect(exec).toContain("claude auth login");
    expect(exec).toContain("검증 실행");
    // CSRF is enforced on authenticated POSTs.
    const bad = await c.req("/setup/executors/confirm", { method: "POST", body: new URLSearchParams({}), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(bad.status).toBe(403);
    expect((await c.post("/setup/executors/verify", { adapter: "claude-cli" })).status).toBe(302);
    expect(await app.ctx.repos.settings.get("system", "", "executor.verification.claude-cli")).toBeTruthy();
    await c.post("/setup/executors/confirm", {});
    expect(await (await c.req("/setup")).text()).toContain('class="cur">4. GitHub');
    await c.post("/setup/github", { mode: "skip" });
    await c.post("/setup/defaults", { priority: "cloud,local_cli", fallback: "on", mode: "campus", claude: "on", claudeName: "클로드", claudePersona: "careful", codex: "on", codexName: "코덱스", codexPersona: "bold" });
    const user = (await app.ctx.repos.users.list())[0]!;
    expect((await app.ctx.repos.users.getProfile(user.id)).mode).toBe("campus");
    expect((await app.ctx.repos.agents.listByOwner(user.id)).map((a) => a.name)).toEqual(["클로드", "코덱스"]);
    const diag = await (await c.req("/setup")).text();
    expect(diag).toContain("전체 연결 진단");
    expect(diag).toContain("종량제 유료 API");
    await c.post("/setup/finish", {});
    const dash = await (await c.req("/")).text();
    expect(dash).toContain("대시보드");
    expect((await c.req("/agents")).status).toBe(200);
    expect((await c.req("/settings")).status).toBe(200);
    expect((await c.req("/audit")).status).toBe(200);
    // backups
    expect((await c.post("/backups/create", {})).status).toBe(302);
    expect(await (await c.req("/backups")).text()).toContain("aa-backup-");
  });

  it("finds Telegram groups and users automatically instead of asking for numeric IDs", async () => {
    const s = summarizeUpdates([
      { message: { chat: { id: -1001, type: "supergroup", title: "라운지", is_forum: true }, from: { id: 7, is_bot: false, first_name: "Kim", username: "kim" } } },
      { my_chat_member: { chat: { id: -1002, type: "group", title: "옛 그룹" }, from: { id: 7, is_bot: false, first_name: "Kim" } } },
      { message: { chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "Kim" } } },
      { message: { chat: { id: -1001, type: "supergroup", title: "라운지" }, from: { id: 99, is_bot: true, first_name: "bot" } } },
    ]);
    expect(s.chats.map((c) => [c.id, c.isForum])).toEqual([
      ["-1001", false],
      ["-1002", false],
    ]);
    expect(s.users).toEqual([{ id: 7, name: "Kim", username: null }]);

    app = await makeTestApp();
    const web = createWebApp(new Runtime(app));
    const auth = new WebAuth(app.ctx.repos);
    await auth.createAdmin((await auth.ensureSetupToken())!, "long-enough-password");
    const c = client(web);
    await c.post("/login", { password: "long-enough-password" }, false);
    // No token yet: only the token form is shown.
    const first = await (await c.req("/setup")).text();
    expect(first).toContain('action="/setup/telegram/token"');
    expect(first).not.toContain("그룹·사용자 찾기");
    // Token saved + a detection result: groups become radio buttons, people become checkboxes.
    await app.ctx.vault.put(SYSTEM_OWNER, "tg", "123:abc", null, SECRET_REFS.telegramToken);
    await app.ctx.repos.settings.set("system", "", "setup.telegram_detect", { at: "now", bot: "my_bot", chats: [{ id: "-1001", title: "라운지", type: "supergroup", isForum: true }, { id: "-1002", title: "옛 그룹", type: "group", isForum: false }], users: [{ id: 7, name: "Kim", username: "kim" }] });
    const page = await (await c.req("/setup?edit=telegram")).text();
    expect(page).toContain("@my_bot");
    expect(page).toContain('name="lounge" value="-1001" checked');
    expect(page).toContain("주제(Topics)가 꺼져 있습니다");
    expect(page).toContain('name="admin_7" checked');
    // Nothing detected yet: a hint to send a message, and manual inputs stay open.
    await app.ctx.repos.settings.set("system", "", "setup.telegram_detect", { at: "now", chats: [], users: [] });
    const empty = await (await c.req("/setup?edit=telegram")).text();
    expect(empty).toContain("메시지를 하나 보내고 다시 찾아");
    expect(empty).toContain("<details open>");
  });

  it("requires login and rejects wrong passwords", async () => {
    app = await makeTestApp();
    const web = createWebApp(new Runtime(app));
    const auth = new WebAuth(app.ctx.repos);
    await auth.createAdmin((await auth.ensureSetupToken())!, "long-enough-password");
    const c = client(web);
    expect((await c.req("/settings")).headers.get("location")).toContain("/login");
    expect((await c.req("/api/status")).status).toBe(401);
    expect((await c.post("/login", { password: "nope" }, false)).status).toBe(401);
    expect((await c.post("/login", { password: "long-enough-password" }, false)).status).toBe(302);
    expect((await c.req("/api/status")).status).toBe(200);
  });
});
