import { describe, it, expect, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { makeTestApp, ADMIN_TG, type TestApp } from "./helpers.js";
import { SetupCli, type CliDeps } from "../src/cli/setup.js";
import { ScriptedPrompter, TtyPrompter, BackSignal, BACK } from "../src/cli/prompt.js";
import { width, box, stripAnsi, spinner } from "../src/cli/term.js";
import { mascot, renderPixels } from "../src/cli/sprites.js";
import type { SetupNet } from "../src/setup/service.js";
import type { ControlActions } from "../src/ops/control.js";
import { httpControlClient, ensureControlToken, CONTROL_HEADER } from "../src/ops/control.js";
import { Runtime } from "../src/runtime.js";
import { createWebApp } from "../src/web/server.js";
import { SECRET_REFS } from "../src/app.js";

let app: TestApp | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const OK_TOKEN = "AGENT_AGENCY_OK";
const verifyingHandler = (req: { prompt: string }) => (req.prompt.includes("Reply with exactly") ? OK_TOKEN : "{}");

const fakeNet = (calls: string[]): SetupNet => ({
  diagnoseTelegram: async (_token, lounge) => {
    calls.push(`diagnose:${lounge ?? "-"}`);
    return { ok: true, bot: "my_bot", checks: [{ name: "봇 토큰", ok: true, detail: "@my_bot" }, ...(lounge ? [{ name: "포럼(Topic) 그룹", ok: true, detail: "주제 켜짐" }] : [])] } as never;
  },
  detectTelegramChats: async () => {
    calls.push("detect");
    return { ok: true, bot: "my_bot", chats: [{ id: "-1001", title: "라운지", type: "supergroup", isForum: true }], users: [{ id: ADMIN_TG, name: "Kim", username: "kim" }] };
  },
  githubWhoami: async () => ({ login: "kim" }),
  sendTelegram: async (_t, chat) => {
    calls.push(`send:${chat}`);
    return true;
  },
});

function harness(t: TestApp, answers: unknown[], opts: { loginSets?: () => void } = {}) {
  const lines: string[] = [];
  const control: ControlActions[] = [];
  const logins: string[] = [];
  const netCalls: string[] = [];
  const prompt = new ScriptedPrompter(answers);
  const deps: CliDeps = {
    prompt,
    out: (l) => lines.push(stripAnsi(l)),
    control: async (a) => {
      control.push(a);
      return { reached: true, detail: "ok", telegram: true };
    },
    runLogin: async (cmd, args) => {
      logins.push([cmd, ...args].join(" "));
      opts.loginSets?.();
      return 0;
    },
    spin: () => ({ stop: () => undefined }),
    net: fakeNet(netCalls),
    version: "9.9.9",
  };
  return { cli: new SetupCli(t, deps), lines, control, logins, netCalls, prompt };
}

describe("terminal setup (agent-agency setup)", () => {
  it("walks Telegram → AI login → GitHub → defaults → smoke with auto-detected IDs", async () => {
    app = await makeTestApp({ claude: verifyingHandler, codex: verifyingHandler });
    // Claude starts logged out; the (fake) login command logs it in.
    let claudeLoggedIn = false;
    const orig = app.claude.detect.bind(app.claude);
    app.claude.detect = async () => ({ ...(await orig()), authenticated: claudeLoggedIn, subscriptionAuth: claudeLoggedIn });

    const h = harness(
      app,
      [
        "123456789:AAFabcdefghijklmnopqrstuvwxyz", // bot token
        true, // pause: group ready
        "-1001", // lounge group (detected)
        [ADMIN_TG], // admins (detected)
        ["claude-cli", "codex-cli"], // AIs to log in
        true, // GitHub already connected (fake) → reconnect
        "pat",
        "github_pat_abcdefghijklmnopqrstuvwxyz",
        "kim-org", // owner
        "cloud,local_cli",
        true, // auto fallback
        "campus",
        ["claude-cli", "codex-cli"],
        "클로드",
        "careful",
        "코덱스",
        "bold",
        true, // smoke test
      ],
      { loginSets: () => (claudeLoggedIn = true) },
    );
    await h.cli.runSetup();
    expect(h.prompt.remaining).toBe(0);
    const ctx = app.ctx;
    expect(await ctx.vault.has(SECRET_REFS.telegramToken)).toBe(true);
    expect(await ctx.repos.settings.get("system", "", "telegram.lounge_chat_id")).toBe("-1001");
    expect(await ctx.repos.settings.get("system", "", "telegram.admin_ids")).toEqual([ADMIN_TG]);
    expect(h.logins).toEqual(["claude auth login --claudeai"]);
    expect(ctx.executors.getVerification("claude-cli")).toBeTruthy();
    expect(ctx.executors.getVerification("codex-cli")).toBeTruthy();
    expect(await ctx.vault.has(SECRET_REFS.githubToken)).toBe(true);
    expect(await ctx.repos.settings.get("system", "", "github.owner")).toBe("kim-org");
    const user = (await ctx.repos.users.list())[0]!;
    expect((await ctx.repos.users.getProfile(user.id)).mode).toBe("campus");
    const agents = await ctx.repos.agents.listByOwner(user.id);
    expect(agents.map((a) => a.name)).toEqual(["클로드", "코덱스"]);
    expect((await ctx.repos.users.getProfile(user.id)).moderatorAgentId).toBe(agents[0]!.id);
    expect(await ctx.repos.settings.get("system", "", "setup.completed")).toBe(true);
    expect(h.netCalls).toContain("send:-1001"); // smoke test message to the lounge
    expect(h.control).toContainEqual({ telegram: "restart" });
    expect(h.control.at(-1)).toMatchObject({ greet: true, telegram: "restart" });
    const text = h.lines.join("\n");
    expect(text).toContain("@my_bot 봇을 확인했어요");
    expect(text).toContain("Claude 사용 준비 완료");
    expect(text).toContain("준비 완료!");
    expect(text).not.toContain("123456789:AAF"); // the token is never echoed
  });

  it("Esc skips a step and setup continues", async () => {
    app = await makeTestApp({ claude: verifyingHandler, codex: verifyingHandler });
    const h = harness(app, [BACK, [], false, "local_cli", false, "corporate", [], false]);
    await h.cli.runSetup();
    expect(h.prompt.remaining).toBe(0);
    expect(h.lines.join("\n")).toContain("건너뜀");
    expect(await app.ctx.repos.settings.get("system", "", "setup.completed")).toBe(true);
  });

  it("re-running setup on a finished install offers the settings menu", async () => {
    app = await makeTestApp();
    await app.ctx.repos.settings.set("system", "", "setup.completed", true);
    const h = harness(app, ["config", "exit"]);
    await h.cli.runSetup();
    expect(h.prompt.asked).toEqual(["무엇을 할까요?", "무엇을 바꿀까요?"]);
  });
});

describe("terminal settings (agent-agency config)", () => {
  it("changes worldview and policy, Esc inside an item returns to the menu", async () => {
    app = await makeTestApp();
    const h = harness(app, ["mode", "construction", "policy", BACK, "policy", "local_cli", false, BACK]);
    await h.cli.runConfig();
    const user = (await app.ctx.repos.users.list())[0]!;
    expect((await app.ctx.repos.users.getProfile(user.id)).mode).toBe("construction");
    const { resolveExecutionPolicy } = await import("../src/core/execution/policy.js");
    const pol = await resolveExecutionPolicy(app.ctx.repos, { userId: user.id });
    expect(pol.priority).toEqual(["local_cli"]);
    expect(pol.autoFallback).toBe(false);
  });

  it("paid API needs the exact typed confirmation", async () => {
    app = await makeTestApp();
    const h = harness(app, ["paid", "응", "paid", "유료 허용", "exit"]);
    await h.cli.runConfig();
    expect(await app.ctx.flags.isEnabled("executors.paid_api")).toBe(true);
    expect(h.lines.join("\n")).toContain("바꾸지 않았어요");
  });

  it("adds a custom worldview, edits an agent and sets the dashboard password", async () => {
    app = await makeTestApp();
    const h = harness(app, [
      "custom", "__add", "startup", "스타트업", "🚀", "corporate", "대표", "PM", "메이커", "다들", "빠르게 실험하는 팀", "casual", "",
      "agents", "__add", "리뷰어", "codex-cli", "analytical",
      "web", "long-enough-password", "long-enough-password",
      "exit",
    ]);
    await h.cli.runConfig();
    const { customModes } = await import("../src/core/organization/modes.js");
    expect(customModes().map((m) => m.mode)).toContain("custom:startup");
    expect(h.control).toContainEqual({ modes: true });
    const user = (await app.ctx.repos.users.list())[0]!;
    expect((await app.ctx.repos.agents.listByOwner(user.id)).map((a) => a.name)).toContain("리뷰어");
    const { WebAuth } = await import("../src/web/auth.js");
    expect(await new WebAuth(app.ctx.repos).login("long-enough-password")).toBeTruthy();
  });
});

describe("control channel between the CLI and the running service", () => {
  it("rejects calls without the token and applies actions with it", async () => {
    app = await makeTestApp();
    const rt = new Runtime(app);
    const token = ensureControlToken(app.ctx.config);
    const web = createWebApp(rt, { controlToken: token });
    const post = (headers: Record<string, string>) => web.request("http://localhost/internal/control", { method: "POST", body: JSON.stringify({ modes: true, executors: true }), headers: { "content-type": "application/json", ...headers } });
    expect((await post({})).status).toBe(403);
    expect((await post({ [CONTROL_HEADER]: "wrong" })).status).toBe(403);
    const ok = await post({ [CONTROL_HEADER]: token });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { detail: string }).detail).toContain("modes reloaded");
  });

  it("reports when the service is not running", async () => {
    app = await makeTestApp();
    const r = await httpControlClient({ dataDir: app.dataDir, AA_WEB_PORT: 1 })({ telegram: "restart" });
    expect(r.reached).toBe(false);
  });
});

describe("terminal prompts and rendering", () => {
  function tty() {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    let written = "";
    const output = new Writable({
      write(chunk, _enc, cb) {
        written += String(chunk);
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    const key = (name: string, str?: string) => setImmediate(() => input.emit("keypress", str, { name }));
    return { p: new TtyPrompter(input, output), key, input, out: () => stripAnsi(written) };
  }

  it("select: arrows + Enter, number keys, Esc", async () => {
    const t = tty();
    const q = { message: "고르기", options: [{ value: "a", label: "첫째" }, { value: "b", label: "둘째" }, { value: "c", label: "셋째" }] };
    const r1 = t.p.select(q);
    t.key("down");
    setTimeout(() => t.input.emit("keypress", undefined, { name: "return" }), 5);
    expect(await r1).toBe("b");
    expect(t.out()).toContain("❯ 2. 둘째");
    expect(t.out()).toContain("✔ 고르기 › 둘째");
    // The answered prompt is not drawn again after its answer line.
    expect(t.out().lastIndexOf("❯")).toBeLessThan(t.out().lastIndexOf("✔ 고르기"));
    const r2 = t.p.select(q);
    t.key("3", "3");
    expect(await r2).toBe("c");
    const r3 = t.p.select(q);
    t.key("escape");
    await expect(r3).rejects.toBeInstanceOf(BackSignal);
  });

  it("text and password input with editing; passwords are never echoed", async () => {
    const t = tty();
    const r = t.p.text({ message: "이름" });
    for (const ch of "abc") t.key(ch, ch);
    setTimeout(() => {
      t.input.emit("keypress", undefined, { name: "backspace" });
      t.input.emit("keypress", "한", { name: undefined });
      t.input.emit("keypress", undefined, { name: "return" });
    }, 5);
    expect(await r).toBe("ab한");
    const pw = t.p.password({ message: "토큰" });
    setTimeout(() => {
      for (const ch of "s3cret") t.input.emit("keypress", ch, { name: ch });
      t.input.emit("keypress", undefined, { name: "return" });
    }, 5);
    expect(await pw).toBe("s3cret");
    expect(t.out()).not.toContain("s3cret");
  });

  it("multiselect needs the minimum, then returns the picks", async () => {
    const t = tty();
    const r = t.p.multiselect({ message: "여러 개", options: [{ value: 1, label: "하나" }, { value: 2, label: "둘" }], min: 1 });
    setTimeout(() => {
      t.input.emit("keypress", undefined, { name: "return" }); // nothing picked: refused
      t.input.emit("keypress", " ", { name: "space" });
      t.input.emit("keypress", undefined, { name: "down" });
      t.input.emit("keypress", " ", { name: "space" });
      t.input.emit("keypress", undefined, { name: "return" });
    }, 5);
    expect(await r).toEqual([1, 2]);
    expect(t.out()).toContain("1개 이상 선택하세요");
  });

  it("spinner never wraps, so narrow (phone) terminals do not pile up copies", () => {
    for (const columns of [30, 40, 80]) {
      const frames: string[] = [];
      const stream = { isTTY: true, columns, write: (s: string) => (frames.push(s), true) } as unknown as NodeJS.WriteStream;
      const sp = spinner("Claude 검증 중 (짧은 읽기 전용 요청)", stream);
      sp.stop();
      const drawn = frames.filter((f) => f.startsWith("\r\x1b[2K") && stripAnsi(f).trim().length > 0);
      expect(drawn.length).toBeGreaterThan(0);
      for (const f of drawn) expect(width(stripAnsi(f).replace("\r", "")), `cols ${columns}`).toBeLessThan(columns);
    }
  });

  it("measures Korean as double width and draws aligned boxes and dot art", () => {
    expect(width("한글")).toBe(4);
    expect(width("\x1b[1mab\x1b[0m")).toBe(2);
    const lines = stripAnsi(box(["가나다", "abc"], { title: "제목" })).split("\n");
    expect(new Set(lines.map((l) => width(l))).size).toBe(1);
  });

  it("renders the mascot with two pixels per cell in truecolor, 256 colours or none", () => {
    expect(mascot("truecolor")).toHaveLength(5);
    expect(mascot("truecolor").join("")).toContain("38;2;");
    expect(mascot("256").join("")).toMatch(/38;5;\d+/);
    expect(mascot("256").join("")).not.toContain("38;2;");
    expect(mascot("none").join("")).not.toContain("\x1b");
    // top and bottom pixels with different colours share one cell (fg + bg)
    expect(renderPixels(["a", "b"], { a: ["#000000", 16], b: ["#ffffff", 231] }, "256")[0]).toBe("\x1b[38;5;16;48;5;231m▀\x1b[0m");
  });
});

describe("short CLI commands exit promptly", () => {
  it("scheduler shutdown does not leave its grace timer pending", async () => {
    app = await makeTestApp();
    const pending = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const spySet = ((fn: () => void, ms?: number) => {
      const t = realSet(() => {
        pending.delete(t);
        fn();
      }, ms);
      if ((ms ?? 0) >= 1000) pending.add(t);
      return t;
    }) as typeof setTimeout;
    globalThis.setTimeout = spySet;
    globalThis.clearTimeout = ((t: NodeJS.Timeout) => {
      pending.delete(t);
      realClear(t);
    }) as typeof clearTimeout;
    try {
      await app.scheduler.shutdown(45_000);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    expect(pending.size).toBe(0);
  });
});
