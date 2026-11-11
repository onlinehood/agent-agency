import type { Project } from "../types.js";

/**
 * Outbound messaging port. The Telegram gateway implements it; tests use an in-memory fake.
 * Keeps the core independent of Telegram specifics.
 */
export interface Button {
  text: string;
  data: string;
}

export interface OutboundMessage {
  /** Header line: speaker → listener */
  header?: string;
  text: string;
  buttons?: Button[][];
  /** Render as monospace block (for report cards / status) */
  preformatted?: boolean;
}

export interface SentRef {
  chatId: string;
  messageId: number;
}

export interface OutboundPort {
  /** Master lounge for a user (falls back to private chat with the user). */
  postLounge(userTelegramId: number, msg: OutboundMessage): Promise<SentRef | null>;
  /** Project topic. */
  postProject(project: Project, msg: OutboundMessage): Promise<SentRef | null>;
  /** Create or edit the single pinned progress message of a project topic. Returns message id. */
  upsertPinnedProgress(project: Project, text: string, buttons?: Button[][]): Promise<number | null>;
  /** Create a forum topic for a project. */
  createTopic(chatId: string, name: string): Promise<number | null>;
  /** Edit a previously sent message (e.g. to remove approval buttons after decision). */
  editMessage(ref: SentRef, msg: OutboundMessage): Promise<void>;
  /** Send a file (e.g. a research report) to the project topic, or the lounge when there is none. */
  postDocument(project: Project, filename: string, content: Buffer, caption?: string): Promise<SentRef | null>;
}

/** No-op port used when Telegram is not configured (e.g. CLI smoke tests). */
export class NullOutboundPort implements OutboundPort {
  async postLounge(): Promise<SentRef | null> {
    return null;
  }
  async postProject(): Promise<SentRef | null> {
    return null;
  }
  async upsertPinnedProgress(): Promise<number | null> {
    return null;
  }
  async createTopic(): Promise<number | null> {
    return null;
  }
  async editMessage(): Promise<void> {}
  async postDocument(): Promise<SentRef | null> {
    return null;
  }
}

/** Recording port for tests. */
export class RecordingOutboundPort implements OutboundPort {
  lounge: Array<{ to: number; msg: OutboundMessage }> = [];
  project: Array<{ projectId: string; msg: OutboundMessage }> = [];
  pinned = new Map<string, string>();
  pinnedButtons = new Map<string, Button[][] | undefined>();
  topics: Array<{ chatId: string; name: string; id: number }> = [];
  edits: Array<{ ref: SentRef; msg: OutboundMessage }> = [];
  documents: Array<{ projectId: string; filename: string; content: Buffer; caption?: string }> = [];
  private seq = 100;

  async postLounge(to: number, msg: OutboundMessage): Promise<SentRef> {
    this.lounge.push({ to, msg });
    return { chatId: String(to), messageId: this.seq++ };
  }
  async postProject(project: Project, msg: OutboundMessage): Promise<SentRef> {
    this.project.push({ projectId: project.id, msg });
    return { chatId: project.chatId ?? "0", messageId: this.seq++ };
  }
  async upsertPinnedProgress(project: Project, text: string, buttons?: Button[][]): Promise<number> {
    this.pinned.set(project.id, text);
    this.pinnedButtons.set(project.id, buttons);
    return project.progressMessageId ?? this.seq++;
  }
  async createTopic(chatId: string, name: string): Promise<number> {
    const id = this.seq++;
    this.topics.push({ chatId, name, id });
    return id;
  }
  async editMessage(ref: SentRef, msg: OutboundMessage): Promise<void> {
    this.edits.push({ ref, msg });
  }
  async postDocument(project: Project, filename: string, content: Buffer, caption?: string): Promise<SentRef> {
    this.documents.push({ projectId: project.id, filename, content, caption });
    return { chatId: project.chatId ?? "0", messageId: this.seq++ };
  }

  allText(): string {
    return [...this.lounge.map((m) => `${m.msg.header ?? ""}\n${m.msg.text}`), ...this.project.map((m) => `${m.msg.header ?? ""}\n${m.msg.text}`)].join("\n---\n");
  }
}
