import type { App } from "../app.js";
import { SECRET_REFS, SYSTEM_OWNER } from "../app.js";
import type { User } from "../db/repositories.js";
import type { PersonaPreset, Provider } from "../core/types.js";
import { diagnoseTelegram, detectTelegramChats } from "../telegram/gateway.js";
import { OctokitGitHubService } from "../github/client.js";
import { GitHubAppTokenProvider } from "../github/appAuth.js";
import { setExecutionPolicy } from "../core/execution/policy.js";
import { isOrganizationMode, modeDef } from "../core/organization/modes.js";
import { verifyExecutor } from "../executors/verify.js";
import { MOOD_KO, defaultLook, isLook, type Look, type Mood } from "../cli/sprites.js";

export const PERSONAS: PersonaPreset[] = ["careful", "bold", "friendly", "analytical", "mentor", "pragmatic"];
export const PERSONA_LABELS: Record<PersonaPreset, string> = {
  careful: "신중함",
  bold: "과감함",
  friendly: "친근함",
  analytical: "분석적",
  mentor: "멘토형",
  pragmatic: "실용적",
};

export type SetupStep = "telegram" | "executors" | "github" | "defaults" | "diagnostics";
export type Priority = Array<"cloud" | "local_cli">;

/** Telegram/GitHub network calls, injectable for tests. */
export interface SetupNet {
  diagnoseTelegram: typeof diagnoseTelegram;
  detectTelegramChats: typeof detectTelegramChats;
  githubWhoami(source: string | (() => Promise<string>), mode: "pat" | "app"): Promise<{ login: string }>;
  sendTelegram(token: string, chatId: string, text: string): Promise<boolean>;
}

export const realNet: SetupNet = {
  diagnoseTelegram,
  detectTelegramChats,
  githubWhoami: (source, mode) => new OctokitGitHubService(source, undefined, mode).whoami(),
  async sendTelegram(token, chatId, text) {
    const { Bot } = await import("grammy");
    const m = await new Bot(token).api.sendMessage(chatId, text);
    return !!m.message_id;
  },
};

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Setup actions shared by the interactive CLI (`agent-agency setup` / `config`) and the optional
 * web console. Everything is stored in PostgreSQL (secrets encrypted in the vault), so changes
 * survive restarts and are visible to the running service.
 */
export class SetupService {
  constructor(
    readonly app: App,
    readonly net: SetupNet = realNet,
    private actor = "cli",
  ) {}

  get ctx() {
    return this.app.ctx;
  }

  sys<T>(key: string) {
    return this.ctx.repos.settings.get<T>("system", "", key);
  }
  setSys(key: string, v: unknown) {
    return this.ctx.repos.settings.set("system", "", key, v);
  }

  async primaryUser(): Promise<User | null> {
    const users = await this.ctx.repos.users.list();
    if (users[0]) return users[0];
    const admins = [...this.ctx.config.TELEGRAM_ADMIN_USER_IDS, ...((await this.sys<number[]>("telegram.admin_ids")) ?? [])];
    return admins[0] ? this.ctx.repos.users.upsertByTelegram(admins[0], null, "admin") : null;
  }

  async telegramToken(): Promise<string> {
    if (this.ctx.config.TELEGRAM_BOT_TOKEN) return this.ctx.config.TELEGRAM_BOT_TOKEN;
    return (await this.ctx.vault.get(SECRET_REFS.telegramToken, { ownerId: SYSTEM_OWNER }).catch(() => "")) || "";
  }

  async hasTelegram(): Promise<boolean> {
    return !!this.ctx.config.TELEGRAM_BOT_TOKEN || (await this.ctx.vault.has(SECRET_REFS.telegramToken));
  }

  async telegramSettings() {
    return {
      admins: (await this.sys<number[]>("telegram.admin_ids")) ?? this.ctx.config.TELEGRAM_ADMIN_USER_IDS,
      lounge: (await this.sys<string>("telegram.lounge_chat_id")) ?? this.ctx.config.TELEGRAM_LOUNGE_CHAT_ID ?? null,
    };
  }

  /** First step not done yet (the web console uses the same order). */
  async currentStep(): Promise<SetupStep> {
    if (!(await this.hasTelegram()) || !(await this.primaryUser())) return "telegram";
    if (!(await this.sys<boolean>("setup.executors_done"))) return "executors";
    if (!(await this.sys<boolean>("setup.github_done"))) return "github";
    if (!(await this.sys<boolean>("setup.defaults_done"))) return "defaults";
    return "diagnostics";
  }

  /* ------------------------------------------------ Telegram */

  /** Check a bot token with getMe and store it encrypted. */
  async saveTelegramToken(token: string): Promise<{ ok: boolean; bot?: string; detail: string }> {
    const d = await this.net.diagnoseTelegram(token, null);
    if (!d.checks[0]?.ok) return { ok: false, detail: d.checks[0]?.detail ?? "확인 실패" };
    await this.ctx.vault.put(SYSTEM_OWNER, "Telegram bot token", token, null, SECRET_REFS.telegramToken);
    await this.ctx.repos.settings.delete("system", "", "setup.telegram_detect");
    return { ok: true, bot: d.bot, detail: `@${d.bot}` };
  }

  /** Save admins + lounge group and check bot permissions there. */
  async configureTelegram(input: { admins: number[]; lounge: string | null; token?: string }) {
    const admins = [...new Set(input.admins.filter((n) => Number.isInteger(n) && n > 0))];
    if (!admins.length) throw new Error("관리자 숫자 사용자 ID가 필요합니다.");
    const token = input.token || (await this.telegramToken());
    const d = await this.net.diagnoseTelegram(token, input.lounge);
    if (!d.checks[0]?.ok) throw new Error(`봇 토큰 확인 실패: ${d.checks[0]?.detail ?? ""}`);
    if (input.token) await this.ctx.vault.put(SYSTEM_OWNER, "Telegram bot token", token, null, SECRET_REFS.telegramToken);
    await this.setSys("telegram.admin_ids", admins);
    if (input.lounge) await this.setSys("telegram.lounge_chat_id", input.lounge);
    for (const id of admins) {
      const u = await this.ctx.repos.users.upsertByTelegram(id, null, "admin");
      if (input.lounge) await this.ctx.repos.users.updateProfile(u.id, { loungeChatId: input.lounge });
    }
    await this.ctx.repos.audit.record(this.actor, "telegram.configure", "telegram", "success", { admins: admins.length, lounge: !!input.lounge });
    return d;
  }

  /* ------------------------------------------------ executors */

  async verify(adapterId: string) {
    return verifyExecutor(this.ctx, adapterId, { userId: (await this.primaryUser())?.id });
  }

  async setCodexEnvironment(env: string) {
    const u = await this.primaryUser();
    if (u) await setExecutionPolicy(this.ctx.repos, "user", u.id, { cloud: { codexEnvironmentId: env || undefined } });
  }

  /* ------------------------------------------------ GitHub */

  async connectGitHub(input: { mode: "pat"; token: string; owner?: string } | { mode: "app"; appId: string; installationId: string; privateKey: string; owner?: string } | { mode: "skip"; owner?: string }): Promise<string> {
    let detail = "건너뜀";
    if (input.mode === "app") {
      if (!input.appId || !input.installationId || !input.privateKey) throw new Error("App ID, Installation ID, Private key가 모두 필요합니다.");
      const provider = new GitHubAppTokenProvider({ appId: input.appId, installationId: input.installationId, privateKeyPem: input.privateKey });
      const me = await this.net.githubWhoami(() => provider.token(), "app");
      await this.ctx.vault.put(SYSTEM_OWNER, "GitHub App private key", input.privateKey, null, SECRET_REFS.githubAppKey);
      await this.setSys("github.app", { appId: input.appId, installationId: input.installationId });
      detail = me.login;
    } else if (input.mode === "pat") {
      const me = await this.net.githubWhoami(input.token, "pat");
      await this.ctx.vault.put(SYSTEM_OWNER, "GitHub token", input.token, null, SECRET_REFS.githubToken);
      detail = me.login;
    }
    if (input.owner) await this.setSys("github.owner", input.owner);
    await this.app.reloadGitHub();
    await this.setSys("setup.github_done", true);
    await this.ctx.repos.audit.record(this.actor, "github.configure", "github", "success", { mode: input.mode });
    return detail;
  }

  /* ------------------------------------------------ defaults */

  async saveDefaults(input: { priority: Priority; autoFallback: boolean; mode?: string; agents?: Array<{ name: string; preset: string; provider: Provider; adapterId: string; look?: Look }> }) {
    const user = await this.primaryUser();
    if (!user) throw new Error("Telegram 관리자를 먼저 설정하세요.");
    await setExecutionPolicy(this.ctx.repos, "user", user.id, { priority: input.priority, autoFallback: input.autoFallback });
    if (input.mode && isOrganizationMode(input.mode)) await this.app.orchestrator.setMode(user, input.mode as never);
    if (!(await this.ctx.repos.agents.listByOwner(user.id)).length && input.agents?.length) {
      const created = [];
      for (const a of input.agents) {
        const agent = await this.addAgent(user, a);
        if (a.look) await this.setLook(agent.id, a.look);
        created.push(agent);
      }
      if (created[0]) await this.ctx.repos.users.updateProfile(user.id, { moderatorAgentId: created[0].id });
    }
    await this.setSys("setup.defaults_done", true);
  }

  async addAgent(user: User, a: { name: string; preset: string; provider: Provider; adapterId: string }) {
    const persona = await this.ctx.repos.personas.create((PERSONAS.includes(a.preset as PersonaPreset) ? a.preset : "careful") as PersonaPreset);
    return this.ctx.repos.agents.create({ ownerId: user.id, name: a.name, provider: a.provider, adapterId: a.adapterId, modelPolicy: "auto", authMode: "official_subscription", personaId: persona.id, organizationRole: "auto", dialoguePolicy: "relationship_aware", memoryEnabled: true, relationshipHistory: true, enabled: true });
  }

  /* ------------------------------------------------ avatars (expression only) */

  async lookOf(agent: { id: string; adapterId: string }, index = 0): Promise<Look> {
    const v = await this.sys<Look>(`agent.look.${agent.id}`);
    return isLook(v) ? v : defaultLook(agent.adapterId, index);
  }

  async setLook(agentId: string, look: Look) {
    await this.setSys(`agent.look.${agentId}`, look);
  }

  /** What each agent is doing right now, from the task table (shown as the avatar's face). */
  async moods(): Promise<Map<string, Mood>> {
    const out = new Map<string, Mood>();
    const rank: Record<Mood, number> = { worried: 4, waiting: 3, working: 2, happy: 1, idle: 0, sleepy: 0 };
    const put = (id: string | null, m: Mood) => {
      if (id && rank[m] > rank[out.get(id) ?? "idle"]) out.set(id, m);
    };
    for (const t of await this.ctx.repos.tasks.listByStates(["planning", "in_progress", "review", "awaiting_approval", "blocked"])) {
      if (t.state === "blocked") put(t.assignedAgentId, "worried");
      else if (t.state === "awaiting_approval") put(t.assignedAgentId, "waiting");
      else if (t.state === "review") put(t.reviewerAgentId ?? t.assignedAgentId, "working");
      else put(t.assignedAgentId, "working");
    }
    return out;
  }

  /** The user's agents as a team (moderator first) with their current mood. */
  async party(user?: User | null, opts: { mood?: Mood } = {}): Promise<Array<{ look: Look; mood: Mood; name: string; note: string }>> {
    const u = user ?? (await this.primaryUser());
    if (!u) return [];
    const profile = await this.ctx.repos.users.getProfile(u.id);
    const agents = (await this.ctx.repos.agents.listByOwner(u.id)).filter((a) => a.enabled);
    agents.sort((a, b) => Number(b.id === profile.moderatorAgentId) - Number(a.id === profile.moderatorAgentId));
    const moods = opts.mood ? new Map<string, Mood>() : await this.moods();
    const out = [];
    for (const [i, a] of agents.entries()) {
      const mood = opts.mood ?? moods.get(a.id) ?? "idle";
      out.push({ look: await this.lookOf(a, i), mood, name: a.name, note: `${a.id === profile.moderatorAgentId ? "진행자 · " : ""}${MOOD_KO[mood]}` });
    }
    return out;
  }

  /* ------------------------------------------------ smoke + finish */

  /**
   * End-to-end check: a message to the lounge, a real read-only executor run, GitHub auth.
   * `post` lets the web console use its in-process bot; the CLI sends directly with the token.
   */
  async smoke(post?: (user: User) => Promise<boolean>): Promise<SmokeResult[]> {
    const results: SmokeResult[] = [];
    const user = await this.primaryUser();
    try {
      if (!user) throw new Error("Telegram 미연결");
      let sent: boolean;
      if (post) sent = await post(user);
      else {
        const { lounge } = await this.telegramSettings();
        const token = await this.telegramToken();
        if (!token || !lounge) throw new Error("Telegram 미연결");
        sent = await this.net.sendTelegram(token, lounge, "⚙️ AgentAgency 스모크 테스트: 연결 확인 메시지입니다.");
      }
      results.push({ name: "Telegram 전송", ok: sent, detail: sent ? "라운지에 메시지 전송" : "전송 실패" });
    } catch (e) {
      results.push({ name: "Telegram 전송", ok: false, detail: (e as Error).message.slice(0, 160) });
    }
    const usable = this.ctx.executors.usableIds().filter((id) => this.ctx.executors.kindOf(id) === "local_cli");
    if (!usable.length) results.push({ name: "AI 실행기 실행", ok: false, detail: "사용 가능한 Local CLI 실행기 없음" });
    for (const id of usable) {
      const r = await verifyExecutor(this.ctx, id, { userId: user?.id });
      results.push({ name: `AI 실행기 실행 (${id})`, ok: r.ok, detail: r.detail });
    }
    if (this.ctx.github) {
      try {
        results.push({ name: "GitHub 인증", ok: true, detail: (await this.ctx.github.whoami()).login });
      } catch (e) {
        results.push({ name: "GitHub 인증", ok: false, detail: (e as Error).message.slice(0, 160) });
      }
    } else results.push({ name: "GitHub 인증", ok: false, detail: "미연결 (선택)" });
    await this.setSys("setup.smoke", { at: new Date().toISOString(), results });
    await this.ctx.repos.audit.record(this.actor, "setup.smoke", "setup", results.every((r) => r.ok) ? "success" : "failure", { results });
    return results;
  }

  async finish() {
    await this.setSys("setup.completed", true);
    await this.ctx.repos.audit.record(this.actor, "setup.finish", "setup", "success");
  }

  /** Moderator greeting in the lounge (runs in the service process, which owns the bot). */
  async greet() {
    const user = await this.primaryUser();
    if (!user) return;
    const mode = (await this.ctx.repos.users.getProfile(user.id)).mode;
    await this.app.orchestrator.comm
      .say({ user, project: null, speaker: { kind: "moderator" }, listener: { kind: "user" }, situation: "greeting", body: `${modeDef(mode).labelKo} 모드로 운영을 시작해요. 무엇을 도와드릴까요?`, machineState: { kind: "setup.finished" } })
      .catch(() => undefined);
  }
}
