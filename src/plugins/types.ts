import type { AppContext } from "../core/context.js";
import type { AgentRunner } from "../core/agents/runner.js";
import type { Communicator } from "../core/orchestration/communicator.js";
import type { Discussion } from "../core/orchestration/discussion.js";
import type { Approval, Project, Task } from "../core/types.js";
import type { User } from "../db/repositories.js";

/**
 * Work-type plugin boundary (PRD §1): the core is work-type agnostic; Coding Agency is the
 * first plugin. Future plugins (research, analysis, content) implement the same contract.
 */
export interface WorkflowEnv {
  ctx: AppContext;
  runner: AgentRunner;
  comm: Communicator;
  discussion: Discussion;
  user: User;
  project: Project;
  refreshProgress: () => Promise<void>;
  /** Returns a stop reason when the user cancelled/paused the task or project meanwhile. */
  checkStop: (taskId: string) => Promise<"cancelled" | "paused" | null>;
}

export type TaskOutcome =
  | { kind: "done" }
  | { kind: "awaiting_approval"; approvalId: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" }
  | { kind: "paused" }
  /** Put the task back on the queue (e.g. after an approval) */
  | { kind: "requeue" }
  /** The leader split the request; these child tasks must be scheduled. */
  | { kind: "spawned"; taskIds: string[] };

export interface WorkTypePlugin {
  readonly id: string;
  readonly name: string;
  runTask(env: WorkflowEnv, task: Task): Promise<TaskOutcome>;
  /** Called after an approval tied to a task of this plugin is decided. */
  onApprovalDecided?(env: WorkflowEnv, task: Task, approval: Approval): Promise<TaskOutcome | null>;
  /** The user rejected an approval with "수정 요청" and then wrote what to change. */
  onFeedback?(env: WorkflowEnv, task: Task, approval: Approval, feedback: string): Promise<TaskOutcome>;
}
