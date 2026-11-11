import { createHash } from "node:crypto";
import type { AppContext } from "../context.js";
import type { AgentRunner } from "../agents/runner.js";
import type { Agent } from "../types.js";
import type { User } from "../../db/repositories.js";

/**
 * Optional LLM polish for moderator speech (Phase 2 "팀 간 자연스러운 대화").
 *
 * Cost/latency controls (PRD §13): behind the `dialogue.llm_renderer` flag (off by default), short
 * messages only, an LRU cache keyed by style + text, a short timeout, and local CLI executors only.
 * Facts are guarded: every number, URL, quoted span, code span, path/branch, #ref and @mention of the
 * original must appear verbatim in the result, no new numbers may appear, and the length is bounded.
 * Anything that fails the check falls back to the deterministic template.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)]+/g,
  /`[^`]+`/g,
  /'[^'\n]+'/g,
  /"[^"\n]+"/g,
  /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g,
  /#\d+/g,
  /@[^\s,.]+/g,
];
const NUMBER = /\d+(?:[.,]\d+)?/g;

export function preservedTokens(text: string): string[] {
  const out = new Set<string>();
  for (const re of TOKEN_PATTERNS) for (const m of text.match(re) ?? []) out.add(m);
  for (const m of text.match(NUMBER) ?? []) out.add(m);
  return [...out];
}

export function preservesFacts(original: string, rewritten: string): { ok: boolean; reason?: string } {
  const r = rewritten.trim();
  if (!r) return { ok: false, reason: "empty" };
  if (r.length > Math.max(original.length * 2, original.length + 200)) return { ok: false, reason: "too long" };
  for (const t of preservedTokens(original)) if (!r.includes(t)) return { ok: false, reason: `missing ${t}` };
  const allowedNumbers = new Set(original.match(NUMBER) ?? []);
  for (const n of r.match(NUMBER) ?? []) if (!allowedNumbers.has(n)) return { ok: false, reason: `new number ${n}` };
  return { ok: true };
}

export class DialogueStylist {
  private cache = new Map<string, string>();

  constructor(
    private ctx: AppContext,
    private runner: AgentRunner,
    private maxEntries = 500,
  ) {}

  private key(style: string, body: string): string {
    return createHash("sha256").update(`${style}\u0000${body}`).digest("hex");
  }

  private remember(k: string, v: string): void {
    this.cache.delete(k);
    this.cache.set(k, v);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
  }

  /** Internal task that owns stylist executions (executions always belong to a task). */
  private async taskFor(user: User) {
    const cached = await this.ctx.repos.settings.get<string>("user", user.id, "dialogue.task_id");
    const existing = await this.ctx.repos.tasks.find(cached);
    if (existing) return existing;
    const lounge = (await this.ctx.repos.projects.findBySlug(user.id, "_lounge")) ?? (await this.ctx.repos.projects.create({ ownerId: user.id, name: "마스터 라운지", slug: "_lounge", workType: "lounge", status: "active", priority: 0 }));
    const task = await this.ctx.repos.tasks.create({ projectId: lounge.id, title: "진행자 말투 다듬기", state: "done", stage: "complete", checkpoint: { internal: true, kind: "dialogue" } });
    await this.ctx.repos.settings.set("user", user.id, "dialogue.task_id", task.id);
    return task;
  }

  /** Returns polished text, or null to fall back to the template. */
  async polish(user: User, speaker: Agent, style: string, body: string): Promise<string | null> {
    if (body.length > 600 || !body.trim()) return null;
    const k = this.key(style, body);
    const hit = this.cache.get(k);
    if (hit) {
      this.remember(k, hit);
      return hit;
    }
    const prompt = [
      "아래 '원문'을 말투 지침에 맞게 자연스러운 한국어 대화체로 다시 쓰세요.",
      "규칙: 숫자·이름·URL·따옴표 안 내용·코드·경로는 글자 그대로 유지합니다. 새로운 사실, 숫자, 약속을 추가하지 않습니다. 결과 문장만 출력합니다.",
      style,
      `원문:\n${body}`,
    ].join("\n\n");
    const out = await this.runner
      .run({ agent: speaker, task: await this.taskFor(user), purpose: "summarize", prompt, cwd: this.ctx.config.dataDir, mode: "readonly", kinds: ["local_cli"], timeoutMs: 30_000 })
      .catch(() => null);
    if (!out || out.status !== "succeeded") return null;
    const text = out.text.trim().replace(/^["“]|["”]$/g, "");
    const check = preservesFacts(body, text);
    if (!check.ok) {
      this.ctx.logger.debug({ reason: check.reason }, "stylist output rejected; using template");
      return null;
    }
    this.remember(k, text);
    return text;
  }
}
