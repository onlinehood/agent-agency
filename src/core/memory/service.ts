import type { Repos } from "../../db/repositories.js";
import type { Certainty, MemoryType } from "../types.js";

/**
 * Memory service (PRD §6.1-9, §17). PostgreSQL is the source of truth; Telegram and
 * individual AI sessions are never relied on for memory. Raw conversation events stay in
 * conversation_messages; this service writes structured memory with certainty and source links.
 */
export class MemoryService {
  constructor(private repos: Repos) {}

  async remember(projectId: string, type: MemoryType, content: string, opts: { certainty?: Certainty; sourceRefs?: string[]; provenance?: Record<string, unknown> } = {}): Promise<void> {
    await this.repos.memories.add(projectId, type, content, { certainty: opts.certainty ?? "confirmed", sourceRefs: opts.sourceRefs ?? [], provenance: opts.provenance ?? {} });
  }

  /** Repeated feedback becomes a preference (active from the 2nd occurrence). */
  async learnPreference(projectId: string, feedback: string, sourceRef?: string): Promise<{ count: number }> {
    const norm = feedback.trim().toLowerCase().replace(/\s+/g, " ");
    const prior = (await this.repos.memories.list(projectId, ["preference"], 500)).filter((m) => (m.provenance as any).norm === norm);
    await this.repos.memories.add(projectId, "preference", feedback, { provenance: { norm }, certainty: "confirmed", sourceRefs: sourceRef ? [sourceRef] : [] });
    return { count: prior.length + 1 };
  }

  async activePreferences(projectId: string): Promise<string[]> {
    const all = await this.repos.memories.list(projectId, ["preference"], 500);
    const counts = new Map<string, { text: string; n: number }>();
    for (const m of all) {
      const norm = String((m.provenance as any).norm ?? m.content.toLowerCase());
      const cur = counts.get(norm);
      counts.set(norm, { text: cur?.text ?? m.content, n: (cur?.n ?? 0) + 1 });
    }
    return [...counts.values()].filter((c) => c.n >= 2).map((c) => c.text);
  }

  /**
   * Summarize raw conversation into a linked summary once enough new events accumulated.
   * The summarizer may be an LLM call; the deterministic fallback only restates structured
   * machine state, so nothing is invented.
   */
  async summarizeIfNeeded(projectId: string, opts: { threshold?: number; summarizer?: (lines: string[]) => Promise<string | null> } = {}): Promise<string | null> {
    const threshold = opts.threshold ?? 30;
    const last = await this.repos.summaries.latest(projectId);
    const n = await this.repos.conversations.countSince(projectId, last?.createdAt ?? null);
    if (n < threshold) return null;
    const msgs = (await this.repos.conversations.list(projectId, Math.min(n, 200))).filter((m) => !last || m.createdAt > last.createdAt);
    if (!msgs.length) return null;
    const lines = msgs.map((m) => `[${m.kind}] ${m.renderedText.replace(/\s+/g, " ").slice(0, 300)}`);
    let summary = opts.summarizer ? await opts.summarizer(lines).catch(() => null) : null;
    if (!summary) {
      const kinds = new Map<string, number>();
      for (const m of msgs) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
      const positions = msgs
        .filter((m) => m.kind === "discussion.turn" && typeof (m.machineState.data as any)?.position === "string")
        .map((m) => `- ${(m.machineState.data as any).position}`)
        .slice(-8);
      summary = [`이벤트 ${msgs.length}건: ${[...kinds].map(([k, v]) => `${k}×${v}`).join(", ")}`, ...positions].join("\n");
    }
    const taskId = msgs.every((m) => m.taskId === msgs[0]!.taskId) ? msgs[0]!.taskId : null;
    await this.repos.summaries.add(projectId, taskId, summary, msgs.map((m) => m.id));
    return summary;
  }
}
