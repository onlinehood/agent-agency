import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { App } from "../app.js";
import { SECRET_REFS, SYSTEM_OWNER } from "../app.js";
import type { User } from "../db/repositories.js";
import type { PersonaPreset, Provider } from "../core/types.js";
import { SetupService, PERSONAS, PERSONA_LABELS, realNet, type SetupNet, type Priority } from "../setup/service.js";
import type { ControlClient } from "../ops/control.js";
import { runDiagnostics, type Check } from "../ops/diagnostics.js";
import { allModes, customModes, modeDef, ALL_MODES } from "../core/organization/modes.js";
import { saveCustomMode, deleteCustomMode } from "../core/organization/customModes.js";
import { describePolicy, resolveExecutionPolicy, setExecutionPolicy } from "../core/execution/policy.js";
import { FLAG_DEFAULTS } from "../core/flags/index.js";
import { syncExecutorFlags } from "../executors/flags.js";
import { retentionPolicy } from "../ops/maintenance.js";
import { revokeCredential } from "../security/revoke.js";
import { WebAuth } from "../web/auth.js";
import { BackSignal, CancelSignal, type Option, type Prompter } from "./prompt.js";
import { mascot } from "./sprites.js";
import { c, box, welcome, stepLine, resultLine, subLine, spinner as ttySpinner, truncate, termWidth, width, type Spinner, type Tone } from "./term.js";

/** Local subscription CLIs the setup can log in to (official subscription login only). */
interface LoginSpec {
  id: string;
  name: string;
  provider: Provider;
  agentName: string;
  flag?: string;
  guide: string;
  command: (cfg: App["ctx"]["config"]) => { cmd: string; args: string[]; env?: Record<string, string> };
}

const LOGINS: LoginSpec[] = [
  { id: "claude-cli", name: "Claude", provider: "anthropic", agentName: "클로드", guide: "Claude Pro/Max 구독 계정으로 로그인합니다. 화면의 주소를 내 PC 브라우저에서 열고, 받은 코드를 여기에 붙여 넣으세요.", command: (cfg) => ({ cmd: cfg.CLAUDE_CLI_PATH, args: ["auth", "login", "--claudeai"] }) },
  { id: "codex-cli", name: "Codex", provider: "openai", agentName: "코덱스", guide: "ChatGPT Plus/Pro 계정으로 로그인합니다. 화면의 주소를 열고 표시된 코드를 입력하세요.", command: (cfg) => ({ cmd: cfg.CODEX_CLI_PATH, args: ["login", "--device-auth"] }) },
  { id: "gemini-cli", name: "Gemini", provider: "google", agentName: "제미니", flag: "executors.gemini", guide: "Google 계정으로 로그인합니다. 화면의 주소를 열고 받은 코드를 붙여 넣은 뒤, 입력창이 나오면 /quit 를 입력하세요.", command: () => ({ cmd: process.execPath, args: [process.argv[1]!, "gemini-login"] }) },
  { id: "cursor-cli", name: "Cursor", provider: "cursor", agentName: "커서", flag: "executors.cursor", guide: "Cursor 구독 계정으로 로그인합니다. 화면의 주소를 브라우저에서 열어 로그인하면 자동으로 이어집니다.", command: (cfg) => ({ cmd: cfg.CURSOR_CLI_PATH, args: ["login"], env: { NO_OPEN_BROWSER: "1" } }) },
];

/** Which account each CLI logs in with (shown when picking). */
const ACCOUNT: Record<string, string> = { "claude-cli": "Claude Pro/Max", "codex-cli": "ChatGPT Plus/Pro", "gemini-cli": "Google 계정", "cursor-cli": "Cursor 구독" };

export interface CliDeps {
  prompt: Prompter;
  out: (line: string) => void;
  control: ControlClient;
  /** Run an interactive login command with the terminal attached; resolves to the exit code. */
  runLogin: (cmd: string, args: string[], env?: Record<string, string>) => Promise<number>;
  spin: (label: string) => Spinner;
  net?: SetupNet;
  version?: string;
}

export function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(fs.readFileSync(path.resolve(here, "../../package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export function ttyDeps(prompt: Prompter, control: ControlClient): CliDeps {
  return {
    prompt,
    control,
    out: (l) => process.stdout.write(`${l}\n`),
    spin: (label) => ttySpinner(label),
    runLogin: (cmd, args, env) =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
        child.on("error", () => resolve(127));
        child.on("exit", (code) => resolve(code ?? 1));
      }),
  };
}

const STATUS_TONE: Record<Check["status"], Tone> = { ok: "ok", warn: "warn", fail: "fail", unsupported: "info" };
const MANUAL = "__manual__";

/**
 * Interactive, terminal-first setup and settings (`agent-agency setup` / `agent-agency config`),
 * styled after Claude Code's CLI. Every action goes through SetupService, the same code the
 * optional web console uses; the running service is told to apply changes via the control channel.
 */
export class SetupCli {
  readonly svc: SetupService;
  private p: Prompter;
  private out: (l: string) => void;

  constructor(
    readonly app: App,
    private deps: CliDeps,
  ) {
    this.svc = new SetupService(app, deps.net ?? realNet, "cli");
    this.p = deps.prompt;
    this.out = deps.out;
  }

  private get ctx() {
    return this.app.ctx;
  }

  private line(s = "") {
    this.out(s);
  }
  private ok(s: string) {
    this.out(resultLine(s, "ok"));
  }
  private warn(s: string) {
    this.out(resultLine(s, "warn"));
  }
  private fail(s: string) {
    this.out(resultLine(s, "fail"));
  }
  private note(s: string) {
    this.out(resultLine(c.dim(s)));
  }

  private async withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const s = this.deps.spin(label);
    try {
      return await fn();
    } finally {
      s.stop();
    }
  }

  /** Run one step; Esc skips it with a hint. */
  private async step(title: string, n: number, total: number, fn: () => Promise<void>): Promise<void> {
    this.line();
    this.line(`${stepLine(title)} ${c.dim(`${n}/${total}`)}`);
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof BackSignal)) throw e;
      this.warn("건너뜀 — 나중에 aa config 에서 할 수 있습니다");
    }
  }

  private banner(subtitle: string) {
    this.line(welcome(this.deps.version ?? packageVersion(), subtitle, ["↑↓ 이동 · Enter 선택 · Esc 건너뛰기/뒤로 · Ctrl+C 종료"]));
  }

  /* ================================================================ setup wizard */

  async runSetup(opts: { banner?: boolean } = {}): Promise<void> {
    if (opts.banner !== false) this.banner("Telegram으로 일하는 AI 팀을 준비합니다");
    if (await this.svc.sys<boolean>("setup.completed")) {
      this.line();
      this.line(stepLine("이미 설정되어 있어요"));
      const next = await this.p.select({
        message: "무엇을 할까요?",
        options: [
          { value: "config", label: "설정 바꾸기", hint: "aa config" },
          { value: "again", label: "처음부터 다시 설정" },
          { value: "exit", label: "끝내기" },
        ],
      });
      if (next === "config") return this.runConfig(false);
      if (next === "exit") return;
    }
    const total = 5;
    await this.step("Telegram 연결", 1, total, () => this.telegramFlow(false));
    await this.step("AI 구독 로그인", 2, total, () => this.executorsFlow());
    await this.step("GitHub 연결", 3, total, () => this.githubFlow());
    await this.step("기본 설정", 4, total, () => this.defaultsFlow());
    await this.step("점검하고 시작하기", 5, total, () => this.finishFlow());
  }

  /* ------------------------------------------------ Telegram */

  async telegramFlow(force: boolean): Promise<void> {
    const had = await this.svc.hasTelegram();
    const current = await this.svc.telegramSettings();
    if (had && current.admins.length && current.lounge && !force) {
      this.ok(`이미 연결됨 · 그룹 ${current.lounge} · 관리자 ${current.admins.length}명`);
      if (!(await this.p.confirm({ message: "Telegram을 다시 설정할까요?", initial: false }))) return;
    }

    // ① bot token
    let token = had ? await this.svc.telegramToken() : "";
    let bot: string | undefined;
    if (had && token && (await this.p.select({ message: "봇", options: [{ value: "keep", label: "지금 봇 그대로 쓰기" }, { value: "new", label: "새 봇 토큰 넣기" }] })) === "keep") {
      const d = await this.withSpinner("봇 확인 중", () => this.svc.net.diagnoseTelegram(token, null));
      bot = d.bot;
      if (d.checks[0]?.ok) this.ok(`@${bot}`);
      else {
        this.fail(`지금 토큰이 동작하지 않습니다: ${d.checks[0]?.detail ?? ""}`);
        token = "";
      }
    } else token = "";
    if (!token) {
      this.note("Telegram 앱에서 @BotFather 에게 /newbot 을 보내 봇을 만들고, 받은 토큰을 붙여 넣으세요.");
      for (;;) {
        const t = await this.p.password({ message: "봇 토큰", placeholder: "123456789:AA...", validate: (v) => (/^\d{5,}:[\w-]{20,}$/.test(v) ? null : "형식: 숫자:영문 (예: 123456789:AAF...)") });
        const r = await this.withSpinner("봇 확인 중", () => this.svc.saveTelegramToken(t));
        if (r.ok) {
          token = t;
          bot = r.bot;
          this.ok(`@${r.bot} 봇을 확인했어요`);
          break;
        }
        this.fail(`토큰 확인 실패: ${r.detail}`);
      }
    }

    // ② group + admins, found automatically
    this.line();
    this.note("이제 그룹을 준비하세요:");
    this.line(subLine(`1. Telegram에서 새 그룹을 만들고 ${bot ? c.accent(`@${bot}`) : "봇"}을 초대`));
    this.line(subLine(`2. 그룹 설정 → ${c.bold("주제(Topics)")} 켜기`));
    this.line(subLine(`3. 관리자 → 봇을 관리자로 지정 (${c.bold("주제 관리")}, ${c.bold("메시지 고정")} 권한)`));
    this.line(subLine(`4. 그룹에 아무 메시지나 하나 보내기 (예: 안녕)`));
    await this.p.pause("다 했으면 Enter");

    let lounge: string | null = null;
    let admins: number[] = [];
    const paused = had ? await this.deps.control({ telegram: "pause" }) : null;
    try {
      for (;;) {
        const r = await this.withSpinner("그룹과 사용자 찾는 중", () => this.svc.net.detectTelegramChats(token));
        if (!r.ok) this.fail(`찾기 실패: ${r.error ?? ""}`);
        else if (!r.chats.length) this.warn("아직 그룹 메시지가 보이지 않아요. 그룹에 메시지를 하나 더 보내 보세요.");
        if (r.ok && r.chats.length) {
          const g = await this.p.select<string>({
            message: "마스터 라운지로 쓸 그룹",
            options: [...r.chats.map((ch) => ({ value: ch.id, label: ch.title, hint: ch.isForum ? c.green("주제 켜짐") : c.yellow("주제(Topics)가 꺼져 있어요") })), { value: MANUAL, label: "직접 입력", hint: "-100으로 시작하는 그룹 ID" }],
          });
          lounge = g === MANUAL ? await this.askGroupId() : g;
          if (r.users.length) {
            admins = await this.p.multiselect<number>({
              message: "봇을 조작할 관리자 (본인)",
              options: r.users.map((u) => ({ value: u.id, label: u.name, hint: `${u.username ? `@${u.username} · ` : ""}${u.id}` })),
              initial: r.users.length === 1 ? [r.users[0]!.id] : current.admins.filter((a) => r.users.some((u) => u.id === a)),
              min: 1,
            });
          } else admins = await this.askAdminIds(current.admins);
          break;
        }
        const next = await this.p.select({ message: "어떻게 할까요?", options: [{ value: "retry", label: "다시 찾기" }, { value: "manual", label: "ID 직접 입력" }] });
        if (next === "manual") {
          lounge = await this.askGroupId();
          admins = await this.askAdminIds(current.admins);
          break;
        }
      }
    } finally {
      if (paused?.reached) await this.deps.control({ telegram: "restart" });
    }

    const d = await this.withSpinner("그룹 권한 확인 중", () => this.svc.configureTelegram({ admins, lounge }));
    for (const ch of d.checks) this.out(resultLine(`${ch.name}${ch.ok ? "" : c.dim(` — ${ch.detail}`)}`, ch.ok ? "ok" : "fail"));
    if (d.checks.some((x) => !x.ok)) this.warn("저장했어요. 빨간 항목을 Telegram에서 고친 뒤 aa config → Telegram 으로 다시 확인하세요.");
    const r = await this.deps.control({ telegram: "restart" });
    if (r.reached) this.ok(r.telegram ? "봇이 Telegram에서 동작을 시작했어요" : "봇 시작 실패 — aa logs 로 확인하세요");
    else this.note(r.detail);
  }

  private async askGroupId(): Promise<string> {
    return this.p.text({ message: "그룹 ID", placeholder: "-1001234567890", validate: (v) => (/^-\d{5,}$/.test(v) ? null : "-100 으로 시작하는 숫자") });
  }

  private async askAdminIds(initial: number[]): Promise<number[]> {
    const v = await this.p.text({ message: "관리자 Telegram 숫자 ID (쉼표로 여러 명)", initial: initial.join(","), hint: "@userinfobot 에게 메시지를 보내면 내 ID를 알려 줍니다", validate: (s) => (s.split(/[,\s]+/).some((x) => /^\d+$/.test(x)) ? null : "숫자 ID를 하나 이상 넣으세요") });
    return v
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  /* ------------------------------------------------ AI executors */

  private statusOf(id: string): { label: string; tone: Tone; installed: boolean; loggedIn: boolean; verified: boolean } {
    const s = this.ctx.executors.getStatus(id);
    const verified = !!this.ctx.executors.getVerification(id);
    const usable = this.ctx.executors.usabilityReason(id);
    if (!s?.installed) return { label: id === "cursor-cli" ? "설치 안 됨 — 서버에서 aa cursor 로 설치" : "설치 안 됨", tone: "info", installed: false, loggedIn: false, verified };
    if (!s.authenticated || !s.subscriptionAuth) return { label: s.authenticated ? "API 키 로그인 — 구독 로그인 필요" : "로그인 필요", tone: "warn", installed: true, loggedIn: false, verified };
    if (!usable.usable) return { label: usable.reason, tone: "warn", installed: true, loggedIn: true, verified };
    return { label: verified ? "사용 가능 · 검증됨" : "로그인됨", tone: "ok", installed: true, loggedIn: true, verified };
  }

  async executorsFlow(): Promise<void> {
    await this.withSpinner("설치된 AI CLI 확인 중", () => this.ctx.executors.detectAll());
    const specs = LOGINS.filter((l) => this.ctx.executors.get(l.id));
    for (const l of specs) {
      const s = this.statusOf(l.id);
      this.out(resultLine(`${l.name.padEnd(7)} ${c.dim(s.label)}`, s.tone));
    }
    const installed = specs.filter((l) => this.statusOf(l.id).installed);
    if (!installed.length) {
      this.fail("설치된 AI CLI가 없습니다. Docker 이미지로 설치했다면 aa update 후 다시 시도하세요.");
      await this.svc.setSys("setup.executors_done", true);
      return;
    }
    const picked = await this.p.multiselect<string>({
      message: "로그인할 AI 구독 (Space로 여러 개 · 가진 것만)",
      options: installed.map((l) => ({ value: l.id, label: l.name, hint: `${ACCOUNT[l.id] ?? ""} · ${this.statusOf(l.id).label}` })),
      initial: installed.filter((l) => l.id === "claude-cli" || l.id === "codex-cli" || this.statusOf(l.id).loggedIn).map((l) => l.id),
    });
    for (const id of picked) await this.loginAndVerify(LOGINS.find((l) => l.id === id)!);
    await this.svc.setSys("setup.executors_done", true);
    await this.deps.control({ executors: true });
    if (!this.ctx.executors.usableIds().some((id) => this.ctx.executors.kindOf(id) === "local_cli")) this.warn("아직 사용 가능한 AI가 없어요. 나중에 aa config → AI 구독 에서 로그인하세요.");
  }

  private async loginAndVerify(l: LoginSpec): Promise<void> {
    this.line();
    this.line(`  ${c.accent("●")} ${c.bold(l.name)}`);
    if (l.flag && !(await this.ctx.flags.isEnabled(l.flag))) {
      await this.ctx.flags.set(l.flag, true);
      await syncExecutorFlags(this.ctx);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.statusOf(l.id).loggedIn || attempt > 0) {
        this.note(l.guide);
        const { cmd, args, env } = l.command(this.ctx.config);
        const code = await this.deps.runLogin(cmd, args, env);
        if (code !== 0) this.warn(`로그인 명령이 종료 코드 ${code}로 끝났어요`);
        const st = await this.ctx.executors.get(l.id)!.detect();
        this.ctx.executors.setStatus(st);
      }
      const r = await this.withSpinner(`${l.name} 검증 중 (짧은 읽기 전용 요청)`, () => this.svc.verify(l.id));
      if (r.ok) {
        this.ok(`${l.name} 사용 준비 완료`);
        return;
      }
      this.fail(truncate(r.detail, 110));
      if (!(await this.p.confirm({ message: `${l.name} 로그인을 다시 할까요?`, initial: true }))) return;
    }
  }

  /* ------------------------------------------------ GitHub */

  async githubFlow(): Promise<void> {
    if (this.ctx.github) {
      const who = await this.ctx.github.whoami().catch(() => null);
      if (who) {
        this.ok(`이미 연결됨 · ${who.login}`);
        if (!(await this.p.confirm({ message: "GitHub을 다시 연결할까요?", initial: false }))) return void (await this.svc.setSys("setup.github_done", true));
      }
    }
    for (;;) {
      const mode = await this.p.select<"pat" | "app" | "skip">({
        message: "AI 팀이 결과를 올릴 GitHub",
        options: [
          { value: "pat", label: "개인 계정 — 토큰", hint: "추천" },
          { value: "app", label: "조직 — GitHub App" },
          { value: "skip", label: "나중에", hint: "서버 안 로컬 저장소로만 작업" },
        ],
      });
      try {
        if (mode === "skip") {
          await this.svc.connectGitHub({ mode: "skip" });
          this.note("건너뛰었어요. 나중에 aa config → GitHub");
          return;
        }
        if (mode === "pat") {
          this.note("GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token");
          this.line(subLine(c.dim("Repository access: All repositories · 권한: Administration, Contents, Pull requests = Read and write (Metadata는 자동)")));
          const token = await this.p.password({ message: "GitHub 토큰", placeholder: "github_pat_...", validate: (v) => (/^(github_pat_|ghp_)\w{20,}/.test(v) ? null : "github_pat_ 로 시작하는 토큰") });
          const who = await this.withSpinner("GitHub 확인 중", () => this.svc.connectGitHub({ mode: "pat", token }));
          this.ok(`${who} 로 연결했어요`);
          const owner = await this.p.text({ message: "새 저장소를 만들 계정/조직", initial: who });
          if (owner) await this.svc.setSys("github.owner", owner);
        } else {
          this.note("조직 Settings → Developer settings → GitHub Apps 에서 앱을 만들고 조직에 설치하세요 (docs/INSTALL.md 5.4).");
          const appId = await this.p.text({ message: "App ID", validate: (v) => (/^\d+$/.test(v) ? null : "숫자") });
          const installationId = await this.p.text({ message: "Installation ID", hint: "설치 후 주소창 .../installations/숫자", validate: (v) => (/^\d+$/.test(v) ? null : "숫자") });
          const privateKey = await this.p.multiline({ message: "Private key (.pem 내용을 통째로 붙여 넣기)", placeholder: "-----BEGIN RSA PRIVATE KEY-----", until: /-----END [A-Z ]*PRIVATE KEY-----/, validate: (v) => (v.includes("PRIVATE KEY") ? null : "PEM 형식이 아닙니다") });
          const owner = await this.p.text({ message: "조직 이름", validate: (v) => (v ? null : "필수") });
          const who = await this.withSpinner("GitHub App 확인 중", () => this.svc.connectGitHub({ mode: "app", appId, installationId, privateKey, owner }));
          this.ok(`GitHub App 연결 (${who})`);
        }
        await this.deps.control({ github: true });
        return;
      } catch (e) {
        if (e instanceof BackSignal) throw e;
        this.fail(`연결 실패: ${truncate((e as Error).message, 120)}`);
      }
    }
  }

  /* ------------------------------------------------ defaults */

  private priorityOptions(): Option<string>[] {
    return [
      { value: "cloud,local_cli", label: "공식 구독 Cloud → 격리된 Local CLI", hint: "기본" },
      { value: "local_cli", label: "Local CLI만" },
      { value: "local_cli,cloud", label: "Local CLI → Cloud" },
    ];
  }
  private parsePriority(v: string): Priority {
    return v.split(",").filter((k): k is "cloud" | "local_cli" => k === "cloud" || k === "local_cli");
  }
  private modeOptions(): Option<string>[] {
    return allModes().map((m) => {
      const d = modeDef(m);
      return { value: m, label: `${d.emoji} ${d.labelKo}`, hint: `${d.titles.user} · ${d.titles.moderator} · ${d.titles.member}` };
    });
  }
  private personaOptions(): Option<PersonaPreset>[] {
    return PERSONAS.map((p) => ({ value: p, label: PERSONA_LABELS[p] }));
  }

  async defaultsFlow(): Promise<void> {
    const user = await this.svc.primaryUser();
    if (!user) {
      this.warn("Telegram 관리자가 없어 건너뜁니다. 먼저 aa config → Telegram");
      return;
    }
    const policy = await resolveExecutionPolicy(this.ctx.repos, { userId: user.id });
    const priority = await this.p.select({ message: "실행 우선순위", options: this.priorityOptions(), initial: policy.priority.join(",") });
    const autoFallback = await this.p.confirm({ message: "실행기에 문제가 생기면 다른 구독 AI로 자동 전환할까요?", initial: policy.autoFallback });
    this.note("종량제 유료 API로는 절대 자동 전환하지 않습니다.");
    const profile = await this.ctx.repos.users.getProfile(user.id);
    const mode = await this.p.select({ message: "조직 세계관 (호칭과 말투)", options: this.modeOptions(), initial: profile.mode });

    const agents: Array<{ name: string; preset: string; provider: Provider; adapterId: string }> = [];
    if (!(await this.ctx.repos.agents.listByOwner(user.id)).length) {
      const candidates = LOGINS.filter((l) => this.ctx.executors.get(l.id) && (this.ctx.executors.isUsable(l.id) || l.id === "claude-cli" || l.id === "codex-cli"));
      const picked = await this.p.multiselect<string>({
        message: "처음 만들 AI 에이전트 (첫 번째가 진행자)",
        options: candidates.map((l) => ({ value: l.id, label: `${l.agentName}`, hint: `${l.name}${this.ctx.executors.isUsable(l.id) ? "" : " · 아직 로그인 안 됨"}` })),
        initial: candidates.filter((l) => this.ctx.executors.isUsable(l.id)).map((l) => l.id),
      });
      for (const [i, id] of picked.entries()) {
        const l = LOGINS.find((x) => x.id === id)!;
        const name = await this.p.text({ message: `${l.name} 에이전트 이름`, initial: l.agentName, validate: (v) => (v ? null : "이름을 넣으세요") });
        const preset = await this.p.select({ message: `${name}의 성격`, options: this.personaOptions(), initial: (["careful", "bold", "friendly"] as PersonaPreset[])[i % 3] });
        agents.push({ name, preset, provider: l.provider, adapterId: l.id });
      }
    }
    await this.svc.saveDefaults({ priority: this.parsePriority(priority), autoFallback, mode, agents });
    this.ok(`저장했어요${agents.length ? ` · 에이전트 ${agents.map((a) => a.name).join(", ")} (진행자 ${agents[0]!.name})` : ""}`);
  }

  /* ------------------------------------------------ diagnostics + finish */

  private printChecks(checks: Check[]) {
    let area = "";
    for (const x of checks) {
      if (x.area !== area) {
        area = x.area;
        this.line(`  ${c.bold(area)}`);
      }
      this.line(`    ${resultLine(`${x.name} ${c.dim(truncate(x.detail, Math.max(16, termWidth() - width(x.name) - 12)))}`, STATUS_TONE[x.status]).trimStart()}`);
    }
  }

  async finishFlow(): Promise<void> {
    const checks = await this.withSpinner("전체 연결 진단 중", () => runDiagnostics(this.ctx, { detect: false }));
    this.printChecks(checks);
    if (await this.p.confirm({ message: "스모크 테스트를 할까요? (라운지 메시지 · AI 실제 실행 · GitHub 확인)", initial: true })) {
      const results = await this.withSpinner("스모크 테스트 중", () => this.svc.smoke());
      for (const r of results) this.out(resultLine(`${r.name} ${c.dim(truncate(r.detail, 80))}`, r.ok ? "ok" : "fail"));
    }
    await this.svc.finish();
    const r = await this.deps.control({ telegram: "restart", executors: true, github: true, greet: true });
    this.line();
    for (const l of mascot()) this.line(`   ${l}`);
    this.line(
      box(
        [
          c.bold("✻ 준비 완료!"),
          "",
          `Telegram 라운지 그룹에서 말을 걸어 보세요:`,
          c.accent(`  새 프로젝트 만들어줘 "할 일 앱"`),
          "",
          c.dim(r.reached ? "진행자 AI가 라운지에 인사를 보냈어요." : r.detail),
          c.dim("설정 바꾸기 aa config · 상태 aa status · 로그 aa logs"),
          c.dim("마스터 키 보관 aa key (꼭 한 번)"),
        ],
        { width: 56 },
      ),
    );
  }

  /* ================================================================ settings menu */

  async runConfig(showBanner = true): Promise<void> {
    if (showBanner) this.banner("설정 — 바꿀 항목을 고르세요");
    for (;;) {
      this.line();
      let choice: string;
      try {
        choice = await this.p.select({
          message: "무엇을 바꿀까요?",
          options: [
            { value: "status", label: "현재 상태 보기" },
            { value: "telegram", label: "Telegram", hint: "봇 · 그룹 · 관리자" },
            { value: "executors", label: "AI 구독", hint: "로그인 · 검증" },
            { value: "github", label: "GitHub" },
            { value: "policy", label: "실행 우선순위 · 자동 전환" },
            { value: "mode", label: "조직 세계관" },
            { value: "custom", label: "사용자 정의 세계관" },
            { value: "agents", label: "에이전트" },
            { value: "flags", label: "기능 플래그" },
            { value: "paid", label: "종량제 유료 API", hint: "기본 꺼짐" },
            { value: "retention", label: "데이터 보존 기간" },
            { value: "backup", label: "원격 백업 (S3 호환)" },
            { value: "revoke", label: "인증정보 즉시 차단", hint: "유출 의심 시" },
            { value: "web", label: "웹 대시보드 (선택)" },
            { value: "exit", label: "끝내기" },
          ],
          hint: "↑↓ 이동 · Enter 선택 · Esc 끝내기",
        });
      } catch (e) {
        if (e instanceof BackSignal) return;
        throw e;
      }
      if (choice === "exit") return;
      try {
        await this.configAction(choice);
      } catch (e) {
        if (e instanceof BackSignal) continue;
        if (e instanceof CancelSignal) throw e;
        this.fail(truncate((e as Error).message, 140));
      }
    }
  }

  private async configAction(choice: string): Promise<void> {
    switch (choice) {
      case "status":
        return this.statusView();
      case "telegram":
        this.line(stepLine("Telegram"));
        return this.telegramFlow(true);
      case "executors":
        this.line(stepLine("AI 구독"));
        await this.executorsFlow();
        if (this.ctx.executors.get("codex-cloud")) {
          const user = await this.svc.primaryUser();
          const pol = user ? await resolveExecutionPolicy(this.ctx.repos, { userId: user.id }) : null;
          const env = await this.p.text({ message: "Codex Cloud 환경 ID (선택, 실험 기능 · 비우면 사용 안 함)", initial: pol?.cloud.codexEnvironmentId ?? "", placeholder: "env_..." });
          await this.svc.setCodexEnvironment(env);
        }
        return;
      case "github":
        this.line(stepLine("GitHub"));
        return this.githubFlow();
      case "policy":
        return this.policyView();
      case "mode":
        return this.modeView();
      case "custom":
        return this.customModeView();
      case "agents":
        return this.agentsView();
      case "flags":
        return this.flagsView();
      case "paid":
        return this.paidApiView();
      case "retention":
        return this.retentionView();
      case "backup":
        return this.backupView();
      case "revoke":
        return this.revokeView();
      case "web":
        return this.webView();
    }
  }

  private async requireUser(): Promise<User> {
    const u = await this.svc.primaryUser();
    if (!u) throw new Error("Telegram 관리자를 먼저 설정하세요 (Telegram 메뉴).");
    return u;
  }

  async statusView(): Promise<void> {
    this.line(stepLine("현재 상태"));
    const user = await this.svc.primaryUser();
    if (user) {
      const profile = await this.ctx.repos.users.getProfile(user.id);
      const d = modeDef(profile.mode);
      const agents = await this.ctx.repos.agents.listByOwner(user.id);
      this.out(resultLine(`세계관 ${d.emoji} ${d.labelKo} · 에이전트 ${agents.map((a) => `${a.name}${a.id === profile.moderatorAgentId ? "(진행자)" : ""}${a.enabled ? "" : "(꺼짐)"}`).join(", ") || "없음"}`, "info"));
      for (const l of describePolicy(await resolveExecutionPolicy(this.ctx.repos, { userId: user.id })).split("\n")) this.line(subLine(c.dim(l)));
    }
    const checks = await this.withSpinner("진단 중", async () => {
      await this.ctx.executors.detectAll();
      return runDiagnostics(this.ctx, { detect: false });
    });
    this.printChecks(checks);
    const svc = await this.deps.control({});
    this.out(resultLine(svc.reached ? `서비스 실행 중 · Telegram 봇 ${svc.telegram ? "동작" : "멈춤"}` : "서비스에 연결되지 않음 (aa status)", svc.reached ? (svc.telegram ? "ok" : "warn") : "fail"));
  }

  async policyView(): Promise<void> {
    const user = await this.requireUser();
    const pol = await resolveExecutionPolicy(this.ctx.repos, { userId: user.id });
    for (const l of describePolicy(pol).split("\n")) this.line(subLine(c.dim(l)));
    const priority = await this.p.select({ message: "실행 우선순위", options: this.priorityOptions(), initial: pol.priority.join(",") });
    const autoFallback = await this.p.confirm({ message: "자동 전환", initial: pol.autoFallback });
    await setExecutionPolicy(this.ctx.repos, "user", user.id, { priority: this.parsePriority(priority), autoFallback });
    this.ok("저장했어요. 프로젝트·에이전트별 설정은 Telegram 프로젝트 Topic의 /exec 로 바꿉니다.");
  }

  async modeView(): Promise<void> {
    const user = await this.requireUser();
    const profile = await this.ctx.repos.users.getProfile(user.id);
    const mode = await this.p.select({ message: "조직 세계관", options: this.modeOptions(), initial: profile.mode });
    await this.app.orchestrator.setMode(user, mode as never);
    this.ok(`${modeDef(mode as never).labelKo} 세계관으로 바꿨어요. 말투와 호칭만 바뀌고 정책은 그대로입니다.`);
  }

  async customModeView(): Promise<void> {
    const list = customModes();
    const pick = await this.p.select<string>({
      message: "사용자 정의 세계관",
      options: [{ value: "__add", label: "＋ 새로 만들기" }, ...list.map((m) => ({ value: m.mode, label: `${m.emoji} ${m.labelKo}`, hint: `${m.titles.user} · ${m.titles.moderator} · ${m.titles.member} — 선택하면 삭제` }))],
    });
    if (pick !== "__add") {
      if (await this.p.confirm({ message: `${modeDef(pick as never).labelKo} 세계관을 삭제할까요?`, initial: false })) {
        const n = await deleteCustomMode(this.ctx.repos, pick.replace("custom:", ""));
        await this.deps.control({ modes: true });
        this.ok(`삭제했어요${n ? ` · 쓰던 사용자 ${n}명은 기반 세계관으로 돌아갑니다` : ""}`);
      }
      return;
    }
    const req = (v: string) => (v ? null : "필수");
    const slug = await this.p.text({ message: "ID (영문 소문자)", placeholder: "startup", validate: (v) => (/^[a-z0-9][a-z0-9-]{1,30}$/.test(v) ? null : "영문 소문자·숫자·하이픈 2~31자") });
    const labelKo = await this.p.text({ message: "이름", placeholder: "스타트업", validate: req });
    const emoji = await this.p.text({ message: "이모지", initial: "🚀", validate: req });
    const baseMode = await this.p.select({ message: "기반 세계관 (말투 기본값)", options: ALL_MODES.map((m) => ({ value: m, label: `${modeDef(m).emoji} ${modeDef(m).labelKo}` })) });
    const user = await this.p.text({ message: "사용자 호칭", placeholder: "대표", validate: req });
    const moderator = await this.p.text({ message: "진행자 AI 호칭", placeholder: "PM", validate: req });
    const member = await this.p.text({ message: "에이전트 호칭", placeholder: "메이커", validate: req });
    const teamAddress = await this.p.text({ message: "팀 전체를 부르는 말", placeholder: "다들", validate: req });
    const atmosphere = await this.p.text({ message: "분위기 한 줄", placeholder: "빠르게 실험하고 솔직하게 말하는 초기 스타트업", validate: req });
    const mm = await this.p.select({ message: "에이전트끼리 말투", options: [{ value: "", label: "기반 따름" }, { value: "polite", label: "존댓말" }, { value: "casual", label: "친해지면 반말" }] });
    const mu = await this.p.select({ message: "에이전트 → 사용자 말투", options: [{ value: "", label: "기반 따름" }, { value: "formal", label: "격식 존댓말" }, { value: "polite", label: "편한 존댓말" }] });
    const overrides: Record<string, string> = {};
    if (mm) overrides["member>member"] = mm;
    if (mu) overrides["member>user"] = mu;
    const def = await saveCustomMode(this.ctx.repos, { slug, labelKo, emoji, atmosphere, baseMode, titles: { user, moderator, member }, teamAddress, registerOverrides: Object.keys(overrides).length ? overrides : undefined });
    await this.deps.control({ modes: true });
    this.ok(`${def.labelKo} 세계관을 저장했어요. 조직 세계관 메뉴나 Telegram /mode ${def.mode} 로 바꿀 수 있어요.`);
  }

  async agentsView(): Promise<void> {
    const user = await this.requireUser();
    const profile = await this.ctx.repos.users.getProfile(user.id);
    const agents = await this.ctx.repos.agents.listByOwner(user.id);
    const pick = await this.p.select<string>({
      message: "에이전트",
      options: [
        ...agents.map((a) => ({ value: a.id, label: a.name, hint: `${a.adapterId} · ${a.modelPolicy}${a.id === profile.moderatorAgentId ? " · 진행자" : ""}${a.enabled ? "" : " · 꺼짐"}` })),
        { value: "__add", label: "＋ 에이전트 추가" },
      ],
    });
    const adapters = this.ctx.executors.list().filter((a) => a.kind !== "paid_api");
    if (pick === "__add") {
      const name = await this.p.text({ message: "이름", validate: (v) => (v ? null : "필수") });
      const adapterId = await this.p.select({ message: "실행기", options: adapters.map((a) => ({ value: a.id, label: a.displayName, hint: this.ctx.executors.isUsable(a.id) ? "사용 가능" : "사용 불가" })) });
      const preset = await this.p.select({ message: "성격", options: this.personaOptions() });
      await this.svc.addAgent(user, { name, preset, provider: this.ctx.executors.get(adapterId)!.provider, adapterId });
      this.ok(`${name} 합류!`);
      return;
    }
    const agent = agents.find((a) => a.id === pick)!;
    const persona = await this.ctx.repos.personas.find(agent.personaId);
    const field = await this.p.select({
      message: `${agent.name} — 무엇을 바꿀까요?`,
      options: [
        { value: "name", label: "이름", hint: agent.name },
        { value: "adapter", label: "실행기", hint: agent.adapterId },
        { value: "model", label: "모델", hint: agent.modelPolicy },
        { value: "persona", label: "성격", hint: persona ? PERSONA_LABELS[persona.preset] : "" },
        { value: "rules", label: "추가 지침", hint: persona?.customRules ?? "없음" },
        { value: "enabled", label: agent.enabled ? "끄기" : "켜기" },
        { value: "moderator", label: "진행자로 지정", hint: agent.id === profile.moderatorAgentId ? "지금 진행자" : "" },
      ],
    });
    if (field === "name") await this.ctx.repos.agents.update(agent.id, { name: await this.p.text({ message: "이름", initial: agent.name, validate: (v) => (v ? null : "필수") }) });
    else if (field === "adapter") {
      const id = await this.p.select({ message: "실행기", options: adapters.map((a) => ({ value: a.id, label: a.displayName, hint: this.ctx.executors.isUsable(a.id) ? "사용 가능" : "사용 불가" })), initial: agent.adapterId });
      await this.ctx.repos.agents.update(agent.id, { adapterId: id, provider: this.ctx.executors.get(id)!.provider, modelPolicy: "auto" });
    } else if (field === "model") {
      const models = this.ctx.executors.get(agent.adapterId)?.knownModels ?? ["auto"];
      const m = await this.p.select({ message: "모델", options: models.map((x) => ({ value: x, label: x })), initial: agent.modelPolicy });
      await this.ctx.repos.agents.update(agent.id, { modelPolicy: this.ctx.executors.resolveModel(agent.adapterId, m) });
    } else if (field === "persona" && agent.personaId) await this.ctx.repos.personas.update(agent.personaId, { preset: await this.p.select({ message: "성격", options: this.personaOptions(), initial: persona?.preset }) });
    else if (field === "rules" && agent.personaId) await this.ctx.repos.personas.update(agent.personaId, { customRules: (await this.p.text({ message: "추가 지침 (비우면 삭제)", initial: persona?.customRules ?? "" })) || null });
    else if (field === "enabled") await this.ctx.repos.agents.update(agent.id, { enabled: !agent.enabled });
    else if (field === "moderator") await this.ctx.repos.users.updateProfile(user.id, { moderatorAgentId: agent.id });
    await this.ctx.repos.audit.record("cli", "agent.update", `agent:${agent.id}`, "success", { field });
    this.ok("저장했어요. 정체성·기억·관계는 그대로입니다.");
  }

  async flagsView(): Promise<void> {
    const flags = await this.ctx.flags.all();
    const keys = Object.keys(FLAG_DEFAULTS).filter((k) => k !== "executors.paid_api");
    const on = await this.p.multiselect({ message: "켤 기능", options: keys.map((k) => ({ value: k, label: k })), initial: keys.filter((k) => flags[k]) });
    for (const k of keys) await this.ctx.flags.set(k, on.includes(k));
    await syncExecutorFlags(this.ctx);
    await this.ctx.repos.audit.record("cli", "flags.update", "flags", "success");
    await this.deps.control({ executors: true });
    this.ok("기능 플래그를 저장했어요");
  }

  async paidApiView(): Promise<void> {
    const enabled = await this.ctx.flags.isEnabled("executors.paid_api");
    this.line(box([c.bold("종량제 유료 API"), "", "켜도 자동으로 쓰지 않으며, 쓸 때마다 Telegram에서", "재확인 승인을 받습니다. 사용하면 비용이 발생합니다."], { color: c.yellow }));
    this.out(resultLine(`지금: ${enabled ? c.yellow("허용") : "꺼짐"}`, "info"));
    let next = !enabled;
    if (!enabled) {
      const typed = await this.p.text({ message: '허용하려면 "유료 허용" 이라고 입력하세요 (취소는 Esc)' });
      if (typed !== "유료 허용") return void this.note("바꾸지 않았어요");
    } else next = !(await this.p.confirm({ message: "유료 API를 끌까요?", initial: true }));
    if (next === enabled) return;
    await this.ctx.flags.set("executors.paid_api", next);
    const user = await this.svc.primaryUser();
    if (user) await setExecutionPolicy(this.ctx.repos, "user", user.id, { paidApi: { enabled: next } });
    await this.ctx.repos.audit.record("cli", "paid_api.toggle", "execution", "success", { enabled: next });
    this.ok(next ? "허용했어요. 쓸 때마다 별도 승인이 필요합니다." : "껐어요.");
  }

  async retentionView(): Promise<void> {
    const ret = await retentionPolicy(this.ctx);
    const num = (v: string) => (/^\d+$/.test(v) && Number(v) >= 1 ? null : "1 이상의 숫자");
    const logDays = Number(await this.p.text({ message: "실행 로그·스크린샷 보존 (일)", initial: String(ret.logDays), validate: num }));
    const tmpDays = Number(await this.p.text({ message: "임시 파일 보존 (일)", initial: String(ret.tmpDays), validate: num }));
    await this.svc.setSys("retention", { logDays, tmpDays });
    this.ok("저장했어요. 진행 중인 작업의 증거는 정리하지 않습니다.");
  }

  async backupView(): Promise<void> {
    const cur = await this.svc.sys<{ endpoint: string; region: string; bucket: string; prefix?: string }>("backup.remote");
    if (!process.env.AA_BACKUP_PASSPHRASE) this.warn("AA_BACKUP_PASSPHRASE 가 없어 원격 백업이 동작하지 않습니다 (install.sh는 자동으로 만들어 둡니다).");
    const endpoint = await this.p.text({ message: "Endpoint", initial: cur?.endpoint ?? "", placeholder: "https://s3.ap-northeast-2.amazonaws.com", validate: (v) => (/^https?:\/\//.test(v) ? null : "https:// 로 시작") });
    const region = await this.p.text({ message: "Region", initial: cur?.region ?? "", validate: (v) => (v ? null : "필수") });
    const bucket = await this.p.text({ message: "Bucket", initial: cur?.bucket ?? "", validate: (v) => (v ? null : "필수") });
    const prefix = await this.p.text({ message: "Prefix", initial: cur?.prefix ?? "agent-agency" });
    const access = await this.p.password({ message: "Access key (그대로 두려면 비움)" });
    const secret = await this.p.password({ message: "Secret key (그대로 두려면 비움)" });
    await this.svc.setSys("backup.remote", { endpoint, region, bucket, prefix: prefix || undefined });
    if (access) await this.ctx.vault.put(SYSTEM_OWNER, "Backup S3 access key", access, null, SECRET_REFS.s3Access);
    if (secret) await this.ctx.vault.put(SYSTEM_OWNER, "Backup S3 secret key", secret, null, SECRET_REFS.s3Secret);
    const on = await this.p.confirm({ message: "정기 백업 때 원격으로도 올릴까요?", initial: true });
    await this.ctx.flags.set("backup.remote", on);
    this.ok(`저장했어요${on ? " · 원격 백업 켜짐" : ""}`);
  }

  async revokeView(): Promise<void> {
    const list = (await this.ctx.vault.list(SYSTEM_OWNER)).filter((x) => !x.revoked);
    if (!list.length) return void this.note("저장된 인증정보가 없어요");
    const ref = await this.p.select({ message: "즉시 차단할 인증정보", options: list.map((x) => ({ value: x.ref, label: x.label, hint: x.createdAt.slice(0, 10) })) });
    if (!(await this.p.confirm({ message: "차단하면 바로 쓸 수 없게 됩니다. 계속할까요?", initial: false }))) return;
    const r = await revokeCredential(this.ctx, ref);
    if (ref === SECRET_REFS.telegramToken) await this.deps.control({ telegram: "pause" });
    if (ref === SECRET_REFS.githubToken || ref === SECRET_REFS.githubAppKey) {
      await this.app.reloadGitHub();
      await this.deps.control({ github: true });
    }
    this.out(resultLine(`로컬 차단 완료. ${r.detail}`, r.official === "failed" ? "warn" : "ok"));
  }

  async webView(): Promise<void> {
    this.note("웹 대시보드는 선택 사항입니다. 설정은 모두 이 터미널에서 할 수 있어요.");
    const auth = new WebAuth(this.ctx.repos);
    const pw = await this.p.password({ message: (await auth.hasAdmin()) ? "새 대시보드 비밀번호 (12자 이상)" : "대시보드 비밀번호 (12자 이상)", validate: (v) => (v.length >= 12 ? null : "12자 이상") });
    const again = await this.p.password({ message: "한 번 더" });
    if (pw !== again) throw new Error("비밀번호가 서로 다릅니다.");
    await auth.setPassword(pw);
    this.ok("저장했어요. 접속 방법:");
    this.line(subLine(`내 PC 터미널에서 ${c.accent("ssh -L 8080:127.0.0.1:8080 사용자@서버주소")} 를 연 채로`));
    this.line(subLine(`브라우저에서 ${c.accent("http://localhost:8080")}`));
  }
}
