/**
 * Domain types shared across the orchestration core.
 * Character/dialogue data and machine-readable execution state are kept separate (PRD §2.2, §7).
 */

export type BuiltInMode = "corporate" | "construction" | "campus";

/** Built-in worldview, or a user-defined one ("custom:<slug>", Phase 4). */
export type OrganizationMode = BuiltInMode | `custom:${string}`;

/** Organization (worldview) roles — expression layer only. */
export type OrgRole = "user" | "moderator" | "member";

/** Functional (real work) roles — may change per task. */
export type FunctionalRole = "leader" | "implementer" | "reviewer" | "tester" | "planner" | "researcher";

export type Provider = "anthropic" | "openai" | "google" | "cursor" | "other";

export type AuthMode = "official_subscription" | "official_cloud_session";

export type PersonaPreset = "careful" | "bold" | "friendly" | "analytical" | "mentor" | "pragmatic";

export interface Persona {
  id: string;
  preset: PersonaPreset;
  customRules: string | null;
  toneBounds: ToneBounds;
}

export interface ToneBounds {
  /** 0..1 how much humor is permitted */
  humor?: number;
  /** whether informal speech (반말) is ever allowed */
  informalAllowed?: boolean;
}

export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  provider: Provider;
  adapterId: string;
  modelPolicy: string; // "auto" or explicit model id
  authMode: AuthMode;
  personaId: string | null;
  organizationRole: "auto" | OrgRole;
  dialoguePolicy: "relationship_aware" | "fixed";
  memoryEnabled: boolean;
  relationshipHistory: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRelationship {
  orgId: string;
  agentAId: string;
  agentBId: string;
  /** 0..1 affinity; affects expression only (PRD §2.2) */
  affinity: number;
  interactionCount: number;
  interactionSummary: string;
  updatedAt: string;
}

export type ProjectStatus = "proposed" | "active" | "paused" | "blocked" | "completed" | "archived";

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string;
  topicId: number | null;
  chatId: string | null;
  progressMessageId: number | null;
  repoRef: string | null; // owner/name
  repoMode: "new" | "imported";
  defaultBranch: string;
  status: ProjectStatus;
  priority: number;
  stack: string[];
  workType: string;
  leaderAgentId: string | null;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectSettings {
  approvalMode?: "default" | "strict" | "auto_within_scope";
  previewUrl?: string;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  playwrightCommand?: string;
  maxDiscussionRounds?: number;
  allowedScope?: string[];
  /** Quality gate result on the untouched default branch of an imported repository. */
  baseline?: { ranAt: string; commit: string | null; checks: Array<{ name: string; status: "passed" | "failed" | "skipped" | "error"; summary: string }> };
}

export type TaskState =
  | "queued"
  | "planning"
  | "awaiting_approval"
  | "in_progress"
  | "blocked"
  | "review"
  | "pr_open"
  | "done"
  | "cancelled"
  | "failed";

export type TaskStage = "requirements" | "implementation" | "testing" | "review" | "fix" | "pr" | "complete";

export type Difficulty = "trivial" | "easy" | "medium" | "hard" | "epic";

export interface TaskBudget {
  maxMinutes: number;
  maxRetries: number;
  maxAgents: number;
  maxQualityGateRuns: number;
}

export interface TaskCheckpoint {
  stage?: TaskStage;
  lastExecutionId?: string;
  lastSessionRef?: string;
  commitSha?: string;
  qualityGate?: QualityGateSummary;
  reviewVerdict?: ReviewVerdict;
  notes?: string[];
  [k: string]: unknown;
}

export interface Task {
  id: string;
  projectId: string;
  requestId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  state: TaskState;
  stage: TaskStage;
  priority: number;
  difficulty: Difficulty;
  assignedAgentId: string | null;
  reviewerAgentId: string | null;
  testerAgentId: string | null;
  branch: string | null;
  prRef: string | null;
  blockedReason: string | null;
  budget: TaskBudget;
  attempts: number;
  checkpoint: TaskCheckpoint;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ExecutionStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export interface Execution {
  id: string;
  taskId: string;
  agentId: string;
  adapterId: string;
  purpose: string;
  sessionRef: string | null;
  checkpointRef: string | null;
  status: ExecutionStatus;
  model: string | null;
  inputSummary: string;
  outputSummary: string;
  usage: Record<string, unknown>;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalAction =
  | "create_project"
  | "import_project"
  | "plan_scope"
  | "architecture_change"
  | "scope_expansion"
  | "pr_merge"
  | "deploy_production"
  | "prod_db_change"
  | "cost_increase"
  | "budget_exceed"
  | "destructive_operation"
  | "security_change"
  | "feature_complete"
  | "project_complete"
  | "permanent_delete"
  | "external_service_change"
  | "risky_command"
  | "upgrade"
  | "smoke_test"
  | "paid_api_usage";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface Approval {
  id: string;
  actorId: string;
  projectId: string | null;
  taskId: string | null;
  action: ApprovalAction;
  riskLevel: RiskLevel;
  scope: Record<string, unknown>;
  summary: string;
  nonce: string;
  requiresReconfirm: boolean;
  reconfirmPending: boolean;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  messageRef: string | null;
  /** When an expiry reminder was sent (Phase 2 approval UX). */
  remindedAt?: string | null;
  /** Revision feedback the user gave after "수정 요청". */
  feedback?: string | null;
  createdAt: string;
}

export interface QualityCheckResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "error";
  durationMs: number;
  summary: string;
  details?: string;
}

export interface QualityGateSummary {
  passed: boolean;
  checks: QualityCheckResult[];
  ranAt: string;
  /** Checks failing now that already failed on the imported repo's baseline (not regressions). */
  preexisting?: string[];
}

export interface ReviewVerdict {
  reviewerAgentId: string;
  approved: boolean;
  summary: string;
  issues: Array<{ severity: "blocker" | "major" | "minor"; description: string; file?: string }>;
}

export type MemoryType = "requirement" | "decision" | "task" | "handoff" | "lesson" | "relationship" | "preference" | "import_analysis";

export type RetentionClass = "long_term" | "detailed_log" | "temporary" | "evidence";

/** Confirmed facts/decisions vs proposals vs speculation are kept distinct (PRD §17). */
export type Certainty = "confirmed" | "proposal" | "speculation";

export interface ProjectMemory {
  id: string;
  projectId: string;
  type: MemoryType;
  content: string;
  certainty: Certainty;
  /** Source conversation message ids / task ids / execution ids backing this memory. */
  sourceRefs: string[];
  provenance: Record<string, unknown>;
  retentionClass: RetentionClass;
  createdAt: string;
}

export type RequestClassification =
  | "new_project"
  | "import_project"
  | "task_request"
  | "idea"
  | "question"
  | "discussion"
  | "status"
  | "command"
  | "approval_response"
  | "unknown";

export interface ReportCard {
  projectName: string;
  taskTitle: string;
  feature: string;
  changes: string[];
  tests: QualityGateSummary | null;
  review: ReviewVerdict | null;
  prUrl: string | null;
  previewUrl: string | null;
  openIssues: string[];
  requiresUserConfirmation: boolean;
}

/** Machine-readable state attached to every character message. Never derived from the character text. */
export interface MachineState {
  kind: string;
  taskId?: string;
  projectId?: string;
  executionId?: string;
  status?: string;
  data?: Record<string, unknown>;
}
