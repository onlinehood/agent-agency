import { Bot, GrammyError, InputFile, type Context } from "grammy";
import type { Orchestrator, InboundAttachment } from "../core/orchestration/orchestrator.js";
import type { Button, OutboundMessage, OutboundPort, SentRef } from "../core/orchestration/ports.js";
import type { Project } from "../core/types.js";
import type { AppContext } from "../core/context.js";
import { keyboard, renderHtml } from "./format.js";
import { maskSecrets } from "../security/masking.js";

/**
 * Telegram Gateway (PRD §6.1-1). One bot for every agent; speaker/role/listener are shown in
 * the header. Long polling by default so no public domain is required (PRD §18).
 * Every update is authorized server-side by numeric user id inside the orchestrator.
 */
export class TelegramGateway implements OutboundPort {
  readonly bot: Bot;
  private chains = new Map<string, Promise<unknown>>();
  private running = false;

  constructor(
    token: string,
    private ctx: AppContext,
    private orch: Orchestrator,
  ) {
    this.bot = new Bot(token);
    this.bot.on("callback_query:data", (c) => this.onCallback(c));
    this.bot.on("message", (c) => this.onMessage(c));
    this.bot.catch((err) => ctx.logger.error({ err: maskSecrets(String(err.error)) }, "telegram handler error"));
  }

  /** Per-chat serialized sending with spacing to respect Telegram rate limits. */
  private enqueue<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fn();
          await new Promise((res) => setTimeout(res, 350));
          return r;
        } catch (e) {
          if (e instanceof GrammyError && e.error_code === 429 && attempt < 3) {
            const wait = ((e.parameters as any)?.retry_after ?? 2) * 1000;
            await new Promise((res) => setTimeout(res, wait));
            continue;
          }
          throw e;
        }
      }
    };
    const next = prev.then(run, run);
    this.chains.set(chatId, next.catch(() => undefined));
    return next;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const me = await this.bot.api.getMe();
    this.ctx.logger.info({ bot: me.username }, "telegram bot connected (long polling)");
    await this.bot.api.setMyCommands([
      { command: "status", description: "전체 프로젝트 현황" },
      { command: "help", description: "도움말" },
      { command: "mode", description: "조직 세계관 변경" },
      { command: "agents", description: "에이전트 목록" },
      { command: "exec", description: "실행 우선순위" },
      { command: "executors", description: "실행기 상태" },
    ]).catch(() => undefined);
    this.running = true;
    void this.bot.start({ drop_pending_updates: false, allowed_updates: ["message", "callback_query"] }).catch((e) => {
      this.running = false;
      this.ctx.logger.error({ err: maskSecrets((e as Error).message) }, "telegram polling stopped");
    });
  }

  async stop(): Promise<void> {
    if (this.running) await this.bot.stop();
    this.running = false;
  }

  /* ---------------------------------------------------------- inbound */

  private async onMessage(c: Context): Promise<void> {
    const m = c.message;
    if (!m || !c.from || c.from.is_bot) return;
    const text = m.text ?? m.caption ?? "";
    const attachments: InboundAttachment[] = [];
    try {
      const pick = m.photo?.length ? { kind: "photo" as const, id: m.photo[m.photo.length - 1]!.file_id, name: "photo.jpg" } : m.document ? { kind: "document" as const, id: m.document.file_id, name: m.document.file_name ?? "document" } : m.voice ? { kind: "voice" as const, id: m.voice.file_id, name: "voice.ogg" } : m.audio ? { kind: "audio" as const, id: m.audio.file_id, name: m.audio.file_name ?? "audio" } : null;
      if (pick && (await this.orch.adminIds()).includes(c.from.id)) {
        const f = await c.api.getFile(pick.id);
        if (f.file_path && (f.file_size ?? 0) <= 20 * 1024 * 1024) {
          const res = await fetch(`https://api.telegram.org/file/bot${this.bot.token}/${f.file_path}`);
          if (res.ok) {
            const stored = await this.ctx.files.put("attachments", pick.name, Buffer.from(await res.arrayBuffer()));
            attachments.push({ kind: pick.kind, fileRef: stored.ref, name: pick.name, absPath: `${this.ctx.config.filesDir}/${stored.ref}` });
          }
        }
      }
    } catch (e) {
      this.ctx.logger.warn({ err: (e as Error).message }, "attachment download failed");
    }
    if (!text && !attachments.length) return;
    await this.orch.handleMessage({
      telegramUserId: c.from.id,
      displayName: [c.from.first_name, c.from.last_name].filter(Boolean).join(" ") || c.from.username || null,
      chatId: String(m.chat.id),
      topicId: m.is_topic_message ? (m.message_thread_id ?? null) : null,
      text,
      attachments,
    });
  }

  private async onCallback(c: Context): Promise<void> {
    const q = c.callbackQuery;
    if (!q?.data || !q.message) return;
    const r = await this.orch.handleCallback({ telegramUserId: q.from.id, data: q.data, chatId: String(q.message.chat.id), messageId: q.message.message_id, topicId: (q.message as any).message_thread_id ?? null });
    await c.answerCallbackQuery({ text: r.toast.slice(0, 190) }).catch(() => undefined);
  }

  /* --------------------------------------------------------- outbound */

  private async send(chatId: string, threadId: number | null, msg: OutboundMessage): Promise<SentRef | null> {
    const chunks = renderHtml(msg);
    let last: SentRef | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sent = await this.enqueue(chatId, () =>
        this.bot.api.sendMessage(chatId, chunks[i]!, {
          parse_mode: "HTML",
          ...(threadId != null ? { message_thread_id: threadId } : {}),
          ...(isLast && msg.buttons ? { reply_markup: keyboard(msg.buttons) } : {}),
          link_preview_options: { is_disabled: true },
        }),
      );
      last = { chatId, messageId: sent.message_id };
    }
    return last;
  }

  async postLounge(userTelegramId: number, msg: OutboundMessage): Promise<SentRef | null> {
    const user = await this.ctx.repos.users.findByTelegram(userTelegramId);
    const lounge = user ? (await this.ctx.repos.users.getProfile(user.id)).loungeChatId : null;
    return this.send(lounge ?? String(userTelegramId), null, msg);
  }

  async postProject(project: Project, msg: OutboundMessage): Promise<SentRef | null> {
    if (!project.chatId) return null;
    return this.send(project.chatId, project.topicId, msg);
  }

  async upsertPinnedProgress(project: Project, text: string, buttons?: Button[][]): Promise<number | null> {
    if (!project.chatId || project.topicId == null) return null;
    const html = renderHtml({ text, preformatted: false })[0]!;
    if (project.progressMessageId) {
      try {
        await this.enqueue(project.chatId, () => this.bot.api.editMessageText(project.chatId!, project.progressMessageId!, html, { parse_mode: "HTML", reply_markup: keyboard(buttons) ?? { inline_keyboard: [] } }));
        return project.progressMessageId;
      } catch (e) {
        if (e instanceof GrammyError && /not modified/i.test(e.description)) return project.progressMessageId;
        // message deleted → fall through and recreate
      }
    }
    const sent = await this.enqueue(project.chatId, () => this.bot.api.sendMessage(project.chatId!, html, { parse_mode: "HTML", message_thread_id: project.topicId!, ...(buttons ? { reply_markup: keyboard(buttons) } : {}) }));
    await this.bot.api.pinChatMessage(project.chatId, sent.message_id, { disable_notification: true }).catch((e) => this.ctx.logger.warn({ err: String(e) }, "pin failed (bot needs pin permission)"));
    return sent.message_id;
  }

  async createTopic(chatId: string, name: string): Promise<number | null> {
    const t = await this.enqueue(chatId, () => this.bot.api.createForumTopic(chatId, name.slice(0, 128)));
    return t.message_thread_id;
  }

  async postDocument(project: Project, filename: string, content: Buffer, caption?: string): Promise<SentRef | null> {
    const owner = await this.ctx.repos.users.get(project.ownerId);
    const chatId = project.chatId ?? (await this.ctx.repos.users.getProfile(owner.id)).loungeChatId ?? String(owner.telegramUserId);
    const sent = await this.enqueue(chatId, () =>
      this.bot.api.sendDocument(chatId, new InputFile(content, filename), { ...(project.chatId && project.topicId != null ? { message_thread_id: project.topicId } : {}), ...(caption ? { caption: caption.slice(0, 1000) } : {}) }),
    );
    return { chatId, messageId: sent.message_id };
  }

  async editMessage(ref: SentRef, msg: OutboundMessage): Promise<void> {
    const html = renderHtml(msg)[0]!;
    await this.enqueue(ref.chatId, () => this.bot.api.editMessageText(ref.chatId, ref.messageId, html, { parse_mode: "HTML", reply_markup: keyboard(msg.buttons) ?? { inline_keyboard: [] } })).catch((e) => {
      if (!(e instanceof GrammyError && /not modified/i.test(e.description))) throw e;
    });
  }
}

/** Connection diagnostics used by setup (PRD §18, Phase 0-3). */
export async function diagnoseTelegram(token: string, loungeChatId?: string | null): Promise<{ ok: boolean; bot?: string; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  if (!token) return { ok: false, checks: [{ name: "봇 토큰", ok: false, detail: "토큰이 비어 있습니다" }] };
  const bot = new Bot(token);
  let username: string | undefined;
  try {
    const me = await bot.api.getMe();
    username = me.username;
    checks.push({ name: "봇 토큰", ok: true, detail: `@${me.username}` });
  } catch (e) {
    checks.push({ name: "봇 토큰", ok: false, detail: maskSecrets((e as Error).message) });
    return { ok: false, checks };
  }
  if (loungeChatId) {
    try {
      const chat = await bot.api.getChat(loungeChatId);
      const isForum = (chat as any).is_forum === true;
      checks.push({ name: "포럼(Topic) 그룹", ok: isForum, detail: isForum ? `${(chat as any).title}` : "Topics가 활성화된 슈퍼그룹이 필요합니다" });
      const me = await bot.api.getMe();
      const member = await bot.api.getChatMember(loungeChatId, me.id);
      const admin = member.status === "administrator";
      checks.push({ name: "봇 관리자 권한", ok: admin, detail: admin ? "관리자" : "봇을 그룹 관리자로 지정해야 합니다" });
      if (admin) {
        const m: any = member;
        checks.push({ name: "Topic 관리 권한", ok: !!m.can_manage_topics, detail: m.can_manage_topics ? "허용" : "Manage Topics 권한 필요" });
        checks.push({ name: "메시지 고정 권한", ok: !!m.can_pin_messages, detail: m.can_pin_messages ? "허용" : "Pin Messages 권한 필요" });
      }
    } catch (e) {
      checks.push({ name: "라운지 그룹", ok: false, detail: maskSecrets((e as Error).message) });
    }
  }
  return { ok: checks.every((c) => c.ok), bot: username, checks };
}

/* ------------------------------------------------ setup helper: find IDs automatically */

export interface DetectedChat {
  id: string;
  title: string;
  type: string;
  isForum: boolean;
}

export interface DetectedUser {
  id: number;
  name: string;
  username: string | null;
}

/**
 * Extract groups and human senders from raw Telegram updates (setup: no need to look up
 * numeric IDs by hand). Pure function so it can be tested without the network.
 */
export function summarizeUpdates(updates: any[]): { chats: DetectedChat[]; users: DetectedUser[] } {
  const chats = new Map<string, DetectedChat>();
  const users = new Map<number, DetectedUser>();
  for (const u of updates) {
    const msg = u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member;
    const chat = msg?.chat;
    if (chat && (chat.type === "group" || chat.type === "supergroup")) {
      chats.set(String(chat.id), { id: String(chat.id), title: String(chat.title ?? chat.id), type: chat.type, isForum: chat.is_forum === true });
    }
    const from = msg?.from;
    if (from && !from.is_bot && typeof from.id === "number") {
      users.set(from.id, { id: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id), username: from.username ?? null });
    }
  }
  return { chats: [...chats.values()], users: [...users.values()] };
}

/** Read recent updates once (only works before the bot starts long polling). */
export async function detectTelegramChats(token: string): Promise<{ ok: boolean; bot?: string; chats: DetectedChat[]; users: DetectedUser[]; error?: string }> {
  try {
    const bot = new Bot(token);
    const me = await bot.api.getMe();
    const updates = await bot.api.getUpdates({ timeout: 0, limit: 100, allowed_updates: ["message", "my_chat_member"] });
    const s = summarizeUpdates(updates as any[]);
    // getUpdates does not always carry is_forum; ask Telegram for each group.
    for (const c of s.chats) {
      try {
        const info: any = await bot.api.getChat(c.id);
        c.isForum = info.is_forum === true;
        c.title = info.title ?? c.title;
      } catch {}
    }
    return { ok: true, bot: me.username, ...s };
  } catch (e) {
    return { ok: false, chats: [], users: [], error: maskSecrets((e as Error).message) };
  }
}
