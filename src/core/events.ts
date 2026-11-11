import { EventEmitter } from "node:events";
import type { Approval, Project, Task, Execution, ReportCard } from "./types.js";

export interface EventMap {
  "approval.requested": { approval: Approval };
  "approval.decided": { approval: Approval };
  "project.updated": { project: Project };
  "task.updated": { task: Task };
  "execution.updated": { execution: Execution };
  "report.ready": { projectId: string; taskId: string; card: ReportCard };
  "message.posted": { projectId: string | null; messageId: string };
  "alert": { level: "info" | "warn" | "error"; message: string; projectId?: string | null };
}

/** Typed in-process event bus used to decouple core from the Telegram gateway. */
export class EventBus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  on<K extends keyof EventMap>(event: K, listener: (payload: EventMap[K]) => void): () => void {
    this.ee.on(event, listener);
    return () => this.ee.off(event, listener);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const l of this.ee.listeners(event)) {
      try {
        (l as (p: EventMap[K]) => void)(payload);
      } catch {
        // listeners must not break the emitter
      }
    }
  }
}
