import type { Database, Queryable } from "./index.js";
import { iso, isoOrNull, json, parseJson } from "./index.js";
import { newId, nonce } from "../util/ids.js";
import { NotFoundError } from "../util/errors.js";
import { maskObject, maskSecrets } from "../security/masking.js";
import type {
  Agent,
  AgentRelationship,
  Approval,
  ApprovalAction,
  ApprovalStatus,
  Certainty,
  Execution,
  ExecutionStatus,
  MachineState,
  MemoryType,
  OrganizationMode,
  Persona,
  PersonaPreset,
  Project,
  ProjectMemory,
  ProjectStatus,
  RequestClassification,
  RetentionClass,
  RiskLevel,
  Task,
  TaskBudget,
  TaskState,
  ToneBounds,
} from "../core/types.js";

async function one<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q.query<T>(sql, params);
  return rows[0];
}

/* ---------------------------------------------------------------- users */

export interface User {
  id: string;
  telegramUserId: number;
  role: "admin" | "member";
  displayName: string | null;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationProfile {
  userId: string;
  mode: OrganizationMode;
  dialogueStyleFlag: boolean;
  moderatorAgentId: string | null;
  loungeChatId: string | null;
  updatedAt: string;
}

export class UserRepo {
  constructor(private db: Database) {}

  private map(r: any): User {
    return {
      id: r.id,
      telegramUserId: Number(r.telegram_user_id),
      role: r.role,
      displayName: r.display_name,
      preferences: parseJson(r.preferences, {}),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async upsertByTelegram(telegramUserId: number, displayName: string | null = null, role: User["role"] = "admin"): Promise<User> {
    const existing = await this.findByTelegram(telegramUserId);
    if (existing) {
      if (displayName && displayName !== existing.displayName) {
        await this.db.query("UPDATE users SET display_name=$1, updated_at=now() WHERE id=$2", [displayName, existing.id]);
        return { ...existing, displayName };
      }
      return existing;
    }
    const id = newId("usr");
    await this.db.tx(async (q) => {
      await q.query("INSERT INTO users(id, telegram_user_id, role, display_name) VALUES ($1,$2,$3,$4)", [id, telegramUserId, role, displayName]);
      await q.query("INSERT INTO organization_profiles(user_id) VALUES ($1)", [id]);
    });
    return this.get(id);
  }

  async get(id: string): Promise<User> {
    const r = await one(this.db, "SELECT * FROM users WHERE id=$1", [id]);
    if (!r) throw new NotFoundError("user", id);
    return this.map(r);
  }

  async findByTelegram(telegramUserId: number): Promise<User | undefined> {
    const r = await one(this.db, "SELECT * FROM users WHERE telegram_user_id=$1", [telegramUserId]);
    return r ? this.map(r) : undefined;
  }

  async list(): Promise<User[]> {
    return (await this.db.query("SELECT * FROM users ORDER BY created_at")).map((r) => this.map(r));
  }

  async setPreferences(id: string, prefs: Record<string, unknown>): Promise<void> {
    await this.db.query("UPDATE users SET preferences=$1, updated_at=now() WHERE id=$2", [json(prefs), id]);
  }

  async getProfile(userId: string): Promise<OrganizationProfile> {
    const r = await one<any>(this.db, "SELECT * FROM organization_profiles WHERE user_id=$1", [userId]);
    if (!r) throw new NotFoundError("organization_profile", userId);
    return { userId: r.user_id, mode: r.mode, dialogueStyleFlag: !!r.dialogue_style_flag, moderatorAgentId: r.moderator_agent_id, loungeChatId: r.lounge_chat_id, updatedAt: iso(r.updated_at) };
  }

  async updateProfile(userId: string, patch: Partial<Omit<OrganizationProfile, "userId" | "updatedAt">>): Promise<OrganizationProfile> {
    const n = { ...(await this.getProfile(userId)), ...patch };
    await this.db.query("UPDATE organization_profiles SET mode=$1, dialogue_style_flag=$2, moderator_agent_id=$3, lounge_chat_id=$4, updated_at=now() WHERE user_id=$5", [
      n.mode,
      n.dialogueStyleFlag,
      n.moderatorAgentId,
      n.loungeChatId,
      userId,
    ]);
    return this.getProfile(userId);
  }
}

/* --------------------------------------------------------------- agents */

export class AgentRepo {
  constructor(private db: Database) {}

  private map(r: any): Agent {
    return {
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      provider: r.provider,
      adapterId: r.adapter_id,
      modelPolicy: r.model_policy,
      authMode: r.auth_mode,
      personaId: r.persona_id,
      organizationRole: r.organization_role,
      dialoguePolicy: r.dialogue_policy,
      memoryEnabled: !!r.memory_enabled,
      relationshipHistory: !!r.relationship_history,
      enabled: !!r.enabled,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async create(input: Omit<Agent, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Agent> {
    const id = input.id ?? newId("agt");
    await this.db.query(
      `INSERT INTO agents(id, owner_id, name, provider, adapter_id, model_policy, auth_mode, persona_id, organization_role, dialogue_policy, memory_enabled, relationship_history, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, input.ownerId, input.name, input.provider, input.adapterId, input.modelPolicy, input.authMode, input.personaId, input.organizationRole, input.dialoguePolicy, input.memoryEnabled, input.relationshipHistory, input.enabled],
    );
    return this.get(id);
  }

  async get(id: string): Promise<Agent> {
    const r = await one(this.db, "SELECT * FROM agents WHERE id=$1", [id]);
    if (!r) throw new NotFoundError("agent", id);
    return this.map(r);
  }

  async find(id: string | null | undefined): Promise<Agent | undefined> {
    if (!id) return undefined;
    const r = await one(this.db, "SELECT * FROM agents WHERE id=$1", [id]);
    return r ? this.map(r) : undefined;
  }

  async findByName(ownerId: string, name: string): Promise<Agent | undefined> {
    const r = await one(this.db, "SELECT * FROM agents WHERE owner_id=$1 AND lower(name)=lower($2)", [ownerId, name]);
    return r ? this.map(r) : undefined;
  }

  async listByOwner(ownerId: string, onlyEnabled = false): Promise<Agent[]> {
    const sql = onlyEnabled ? "SELECT * FROM agents WHERE owner_id=$1 AND enabled ORDER BY created_at, id" : "SELECT * FROM agents WHERE owner_id=$1 ORDER BY created_at, id";
    return (await this.db.query(sql, [ownerId])).map((r) => this.map(r));
  }

  /**
   * The agent id is immutable, so memories, relationships, project assignments and execution
   * history survive a rename or model/executor swap (PRD §3.2, §12-2; §17).
   */
  async update(id: string, patch: Partial<Omit<Agent, "id" | "ownerId" | "createdAt" | "updatedAt">>): Promise<Agent> {
    const n = { ...(await this.get(id)), ...patch };
    await this.db.query(
      `UPDATE agents SET name=$1, provider=$2, adapter_id=$3, model_policy=$4, auth_mode=$5, persona_id=$6, organization_role=$7, dialogue_policy=$8, memory_enabled=$9, relationship_history=$10, enabled=$11, updated_at=now() WHERE id=$12`,
      [n.name, n.provider, n.adapterId, n.modelPolicy, n.authMode, n.personaId, n.organizationRole, n.dialoguePolicy, n.memoryEnabled, n.relationshipHistory, n.enabled, id],
    );
    return this.get(id);
  }
}

export class PersonaRepo {
  constructor(private db: Database) {}

  private map(r: any): Persona {
    return { id: r.id, preset: r.preset, customRules: r.custom_rules, toneBounds: parseJson(r.tone_bounds, {}) };
  }

  async create(preset: PersonaPreset, customRules: string | null = null, toneBounds: ToneBounds = {}): Promise<Persona> {
    const id = newId("per");
    await this.db.query("INSERT INTO agent_personas(id, preset, custom_rules, tone_bounds) VALUES ($1,$2,$3,$4)", [id, preset, customRules, json(toneBounds)]);
    return this.get(id);
  }

  async get(id: string): Promise<Persona> {
    const r = await one(this.db, "SELECT * FROM agent_personas WHERE id=$1", [id]);
    if (!r) throw new NotFoundError("persona", id);
    return this.map(r);
  }

  async find(id: string | null | undefined): Promise<Persona | null> {
    if (!id) return null;
    const r = await one(this.db, "SELECT * FROM agent_personas WHERE id=$1", [id]);
    return r ? this.map(r) : null;
  }

  async update(id: string, patch: Partial<Omit<Persona, "id">>): Promise<Persona> {
    const n = { ...(await this.get(id)), ...patch };
    await this.db.query("UPDATE agent_personas SET preset=$1, custom_rules=$2, tone_bounds=$3 WHERE id=$4", [n.preset, n.customRules, json(n.toneBounds), id]);
    return this.get(id);
  }
}

export class RelationshipRepo {
  constructor(private db: Database) {}

  private key(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  private map(r: any): AgentRelationship {
    return { orgId: r.org_id, agentAId: r.agent_a_id, agentBId: r.agent_b_id, affinity: Number(r.affinity), interactionCount: r.interaction_count, interactionSummary: r.interaction_summary, updatedAt: iso(r.updated_at) };
  }

  async get(orgId: string, a: string, b: string): Promise<AgentRelationship> {
    const [x, y] = this.key(a, b);
    const r = await one(this.db, "SELECT * FROM agent_relationships WHERE org_id=$1 AND agent_a_id=$2 AND agent_b_id=$3", [orgId, x, y]);
    return r ? this.map(r) : { orgId, agentAId: x, agentBId: y, affinity: 0.2, interactionCount: 0, interactionSummary: "", updatedAt: new Date().toISOString() };
  }

  /** Affinity grows slowly and saturates. Expression-only metadata (PRD §2.2). */
  async recordInteraction(orgId: string, a: string, b: string, outcome: "positive" | "neutral" | "conflict", note?: string): Promise<AgentRelationship> {
    if (a === b) return this.get(orgId, a, b);
    const cur = await this.get(orgId, a, b);
    const delta = outcome === "positive" ? 0.05 : outcome === "conflict" ? -0.02 : 0.01;
    const affinity = Math.max(0, Math.min(1, cur.affinity + delta * (1 - cur.affinity)));
    const summary = note ? [cur.interactionSummary, maskSecrets(note)].filter(Boolean).join(" | ").slice(-1000) : cur.interactionSummary;
    await this.db.query(
      `INSERT INTO agent_relationships(org_id, agent_a_id, agent_b_id, affinity, interaction_count, interaction_summary, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (org_id, agent_a_id, agent_b_id) DO UPDATE SET affinity=EXCLUDED.affinity, interaction_count=EXCLUDED.interaction_count, interaction_summary=EXCLUDED.interaction_summary, updated_at=now()`,
      [orgId, cur.agentAId, cur.agentBId, affinity, cur.interactionCount + 1, summary],
    );
    return this.get(orgId, a, b);
  }

  async listForAgent(agentId: string): Promise<AgentRelationship[]> {
    return (await this.db.query("SELECT * FROM agent_relationships WHERE agent_a_id=$1 OR agent_b_id=$1", [agentId])).map((r) => this.map(r));
  }
}

/* ------------------------------------------------------------- projects */

export class ProjectRepo {
  constructor(private db: Database) {}

  private map(r: any): Project {
    return {
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      topicId: r.topic_id == null ? null : Number(r.topic_id),
      chatId: r.chat_id,
      progressMessageId: r.progress_message_id == null ? null : Number(r.progress_message_id),
      repoRef: r.repo_ref,
      repoMode: r.repo_mode,
      defaultBranch: r.default_branch,
      status: r.status,
      priority: r.priority,
      stack: parseJson(r.stack, []),
      workType: r.work_type,
      leaderAgentId: r.leader_agent_id,
      settings: parseJson(r.settings, {}),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      archivedAt: isoOrNull(r.archived_at),
    };
  }

  async create(input: {
    ownerId: string;
    name: string;
    slug: string;
    description?: string;
    stack?: string[];
    repoRef?: string | null;
    repoMode?: Project["repoMode"];
    priority?: number;
    workType?: string;
    leaderAgentId?: string | null;
    settings?: Project["settings"];
    status?: ProjectStatus;
  }): Promise<Project> {
    const id = newId("prj");
    await this.db.query(
      `INSERT INTO projects(id, owner_id, name, slug, description, repo_ref, repo_mode, status, priority, stack, work_type, leader_agent_id, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, input.ownerId, input.name, input.slug, input.description ?? "", input.repoRef ?? null, input.repoMode ?? "new", input.status ?? "proposed", input.priority ?? 50, json(input.stack ?? []), input.workType ?? "coding", input.leaderAgentId ?? null, json(input.settings ?? {})],
    );
    return this.get(id);
  }

  async get(id: string): Promise<Project> {
    const r = await one(this.db, "SELECT * FROM projects WHERE id=$1", [id]);
    if (!r) throw new NotFoundError("project", id);
    return this.map(r);
  }

  async find(id: string | null | undefined): Promise<Project | undefined> {
    if (!id) return undefined;
    const r = await one(this.db, "SELECT * FROM projects WHERE id=$1", [id]);
    return r ? this.map(r) : undefined;
  }

  async findByTopic(chatId: string, topicId: number): Promise<Project | undefined> {
    const r = await one(this.db, "SELECT * FROM projects WHERE chat_id=$1 AND topic_id=$2", [chatId, topicId]);
    return r ? this.map(r) : undefined;
  }

  async findBySlug(ownerId: string, slug: string): Promise<Project | undefined> {
    const r = await one(this.db, "SELECT * FROM projects WHERE owner_id=$1 AND slug=$2", [ownerId, slug]);
    return r ? this.map(r) : undefined;
  }

  async listByOwner(ownerId: string, includeArchived = false): Promise<Project[]> {
    const sql = includeArchived
      ? "SELECT * FROM projects WHERE owner_id=$1 ORDER BY priority DESC, created_at"
      : "SELECT * FROM projects WHERE owner_id=$1 AND status <> 'archived' ORDER BY priority DESC, created_at";
    return (await this.db.query(sql, [ownerId])).map((r) => this.map(r));
  }

  async listAll(): Promise<Project[]> {
    return (await this.db.query("SELECT * FROM projects ORDER BY created_at")).map((r) => this.map(r));
  }

  async update(id: string, patch: Partial<Omit<Project, "id" | "ownerId" | "createdAt" | "updatedAt">>): Promise<Project> {
    const n = { ...(await this.get(id)), ...patch };
    await this.db.query(
      `UPDATE projects SET name=$1, slug=$2, description=$3, topic_id=$4, chat_id=$5, progress_message_id=$6, repo_ref=$7, repo_mode=$8, default_branch=$9, status=$10, priority=$11, stack=$12, work_type=$13, leader_agent_id=$14, settings=$15, archived_at=$16, updated_at=now() WHERE id=$17`,
      [n.name, n.slug, n.description, n.topicId, n.chatId, n.progressMessageId, n.repoRef, n.repoMode, n.defaultBranch, n.status, n.priority, json(n.stack), n.workType, n.leaderAgentId, json(n.settings), n.archivedAt, id],
    );
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM projects WHERE id=$1", [id]);
  }

  async setAgents(projectId: string, members: Array<{ agentId: string; functionalRole: string; orgRole: string }>): Promise<void> {
    await this.db.tx(async (q) => {
      await q.query("DELETE FROM project_agents WHERE project_id=$1", [projectId]);
      for (const m of members) await q.query("INSERT INTO project_agents(project_id, agent_id, functional_role, org_role) VALUES ($1,$2,$3,$4)", [projectId, m.agentId, m.functionalRole, m.orgRole]);
    });
  }

  async listAgents(projectId: string): Promise<Array<{ agentId: string; functionalRole: string; orgRole: string }>> {
    return (await this.db.query("SELECT * FROM project_agents WHERE project_id=$1", [projectId])).map((r: any) => ({ agentId: r.agent_id, functionalRole: r.functional_role, orgRole: r.org_role }));
  }
}

/* ---------------------------------------------------------------- tasks */

export const DEFAULT_BUDGET: TaskBudget = { maxMinutes: 30, maxRetries: 2, maxAgents: 3, maxQualityGateRuns: 3 };

export class TaskRepo {
  constructor(private db: Database) {}

  private map(r: any): Task {
    return {
      id: r.id,
      projectId: r.project_id,
      requestId: r.request_id,
      title: r.title,
      description: r.description,
      acceptanceCriteria: parseJson(r.acceptance_criteria, []),
      state: r.state,
      stage: r.stage,
      priority: r.priority,
      difficulty: r.difficulty,
      assignedAgentId: r.assigned_agent_id,
      reviewerAgentId: r.reviewer_agent_id,
      testerAgentId: r.tester_agent_id,
      branch: r.branch,
      prRef: r.pr_ref,
      blockedReason: r.blocked_reason,
      budget: { ...DEFAULT_BUDGET, ...parseJson(r.budget, {}) },
      attempts: r.attempts,
      checkpoint: parseJson(r.checkpoint, {}),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      completedAt: isoOrNull(r.completed_at),
    };
  }

  async create(input: Partial<Task> & { projectId: string; title: string }): Promise<Task> {
    const id = newId("tsk");
    await this.db.query(
      `INSERT INTO tasks(id, project_id, request_id, title, description, acceptance_criteria, state, stage, priority, difficulty, assigned_agent_id, reviewer_agent_id, tester_agent_id, branch, budget, checkpoint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        input.projectId,
        input.requestId ?? null,
        maskSecrets(input.title),
        maskSecrets(input.description ?? ""),
        json(input.acceptanceCriteria ?? []),
        input.state ?? "queued",
        input.stage ?? "requirements",
        input.priority ?? 50,
        input.difficulty ?? "medium",
        input.assignedAgentId ?? null,
        input.reviewerAgentId ?? null,
        input.testerAgentId ?? null,
        input.branch ?? null,
        json(input.budget ?? DEFAULT_BUDGET),
        json(input.checkpoint ?? {}),
      ],
    );
    return this.get(id);
  }

  async get(id: string): Promise<Task> {
    const r = await one(this.db, "SELECT * FROM tasks WHERE id=$1", [id]);
    if (!r) throw new NotFoundError("task", id);
    return this.map(r);
  }

  async find(id: string | null | undefined): Promise<Task | undefined> {
    if (!id) return undefined;
    const r = await one(this.db, "SELECT * FROM tasks WHERE id=$1", [id]);
    return r ? this.map(r) : undefined;
  }

  async listByProject(projectId: string, states?: TaskState[]): Promise<Task[]> {
    const rows = states
      ? await this.db.query("SELECT * FROM tasks WHERE project_id=$1 AND state = ANY($2) ORDER BY priority DESC, created_at", [projectId, states])
      : await this.db.query("SELECT * FROM tasks WHERE project_id=$1 ORDER BY priority DESC, created_at", [projectId]);
    return rows.map((r) => this.map(r));
  }

  async listByStates(states: TaskState[]): Promise<Task[]> {
    return (await this.db.query("SELECT * FROM tasks WHERE state = ANY($1) ORDER BY priority DESC, created_at", [states])).map((r) => this.map(r));
  }

  /** Checkpoint keys are merged (never wholesale replaced) so concurrent writers don't lose data. */
  async update(id: string, patch: Partial<Omit<Task, "id" | "projectId" | "createdAt" | "updatedAt">>): Promise<Task> {
    const cur = await this.get(id);
    const n = { ...cur, ...patch, checkpoint: { ...cur.checkpoint, ...(patch.checkpoint ?? {}) } };
    await this.db.query(
      `UPDATE tasks SET request_id=$1, title=$2, description=$3, acceptance_criteria=$4, state=$5, stage=$6, priority=$7, difficulty=$8, assigned_agent_id=$9, reviewer_agent_id=$10, tester_agent_id=$11, branch=$12, pr_ref=$13, blocked_reason=$14, budget=$15, attempts=$16, checkpoint=$17, completed_at=$18, updated_at=now() WHERE id=$19`,
      [n.requestId, n.title, n.description, json(n.acceptanceCriteria), n.state, n.stage, n.priority, n.difficulty, n.assignedAgentId, n.reviewerAgentId, n.testerAgentId, n.branch, n.prRef, n.blockedReason, json(n.budget), n.attempts, json(n.checkpoint), n.completedAt, id],
    );
    return this.get(id);
  }

  async checkpoint(id: string, patch: Record<string, unknown>): Promise<Task> {
    await this.db.query("UPDATE tasks SET checkpoint = checkpoint || $1::jsonb, updated_at=now() WHERE id=$2", [json(patch), id]);
    return this.get(id);
  }
}

/* ----------------------------------------------------------- executions */

export class ExecutionRepo {
  constructor(private db: Database) {}

  private map(r: any): Execution & { executorKind: string; externalRef: string | null; logRef: string | null } {
    return {
      id: r.id,
      taskId: r.task_id,
      agentId: r.agent_id,
      adapterId: r.adapter_id,
      executorKind: r.executor_kind,
      purpose: r.purpose,
      sessionRef: r.session_ref,
      externalRef: r.external_ref,
      checkpointRef: r.checkpoint_ref,
      status: r.status,
      model: r.model,
      inputSummary: r.input_summary,
      outputSummary: r.output_summary,
      usage: parseJson(r.usage, {}),
      error: r.error,
      logRef: r.log_ref,
      startedAt: isoOrNull(r.started_at),
      endedAt: isoOrNull(r.ended_at),
      createdAt: iso(r.created_at),
    };
  }

  async create(input: { taskId: string; agentId: string; adapterId: string; executorKind?: string; purpose: string; inputSummary?: string; sessionRef?: string | null }) {
    const id = newId("exe");
    await this.db.query(
      "INSERT INTO executions(id, task_id, agent_id, adapter_id, executor_kind, purpose, session_ref, status, input_summary) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)",
      [id, input.taskId, input.agentId, input.adapterId, input.executorKind ?? "local_cli", input.purpose, input.sessionRef ?? null, maskSecrets(input.inputSummary ?? "").slice(0, 4000)],
    );
    return this.get(id);
  }

  async get(id: string) {
    const r = await one(this.db, "SELECT * FROM executions WHERE id=$1", [id]);
    if (!r) throw new NotFoundError("execution", id);
    return this.map(r);
  }

  async listByTask(taskId: string) {
    return (await this.db.query("SELECT * FROM executions WHERE task_id=$1 ORDER BY created_at", [taskId])).map((r) => this.map(r));
  }

  async listByStatus(statuses: ExecutionStatus[]) {
    return (await this.db.query("SELECT * FROM executions WHERE status = ANY($1) ORDER BY created_at", [statuses])).map((r) => this.map(r));
  }

  async markRunning(id: string, model: string | null): Promise<void> {
    await this.db.query("UPDATE executions SET status='running', model=$1, started_at=now() WHERE id=$2", [model, id]);
  }

  async setExternalRef(id: string, externalRef: string): Promise<void> {
    await this.db.query("UPDATE executions SET external_ref=$1 WHERE id=$2", [externalRef, id]);
  }

  async finish(id: string, result: { status: ExecutionStatus; outputSummary?: string; sessionRef?: string | null; usage?: Record<string, unknown>; error?: string | null; model?: string | null; logRef?: string | null }) {
    await this.db.query(
      "UPDATE executions SET status=$1, output_summary=$2, session_ref=COALESCE($3, session_ref), usage=$4, error=$5, model=COALESCE($6, model), log_ref=COALESCE($7, log_ref), ended_at=now() WHERE id=$8",
      [result.status, maskSecrets(result.outputSummary ?? "").slice(0, 8000), result.sessionRef ?? null, json(result.usage ?? {}), result.error ? maskSecrets(result.error).slice(0, 4000) : null, result.model ?? null, result.logRef ?? null, id],
    );
    return this.get(id);
  }

  /** Per-executor usage from the persistent execution log (tokens are provider-official values). */
  async usageByAdapter(sinceIso: string): Promise<Array<{ adapterId: string; runs: number; succeeded: number; failed: number; cancelled: number; avgSeconds: number; inputTokens: number; outputTokens: number; costEstimate: number }>> {
    const num = (k: string) => `CASE WHEN jsonb_typeof(usage->'${k}')='number' THEN (usage->>'${k}')::float ELSE 0 END`;
    const rows = await this.db.query<any>(
      `SELECT adapter_id,
         COUNT(*)::int AS runs,
         COUNT(*) FILTER (WHERE status='succeeded')::int AS succeeded,
         COUNT(*) FILTER (WHERE status IN ('failed','timeout'))::int AS failed,
         COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
         COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - started_at))), 0)::float AS avg_seconds,
         COALESCE(SUM(${num("input_tokens")}), 0)::float AS input_tokens,
         COALESCE(SUM(${num("output_tokens")}), 0)::float AS output_tokens,
         COALESCE(SUM(${num("api_equivalent_cost_usd_estimate")}), 0)::float AS cost
       FROM executions WHERE created_at >= $1 GROUP BY adapter_id ORDER BY runs DESC`,
      [sinceIso],
    );
    return rows.map((r) => ({ adapterId: r.adapter_id, runs: r.runs, succeeded: r.succeeded, failed: r.failed, cancelled: r.cancelled, avgSeconds: Number(r.avg_seconds), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), costEstimate: Number(r.cost) }));
  }

  /** Individual performance (PRD §9): tests passing first time, review change requests, lead time. */
  async agentPerformance(ownerId: string, sinceIso: string): Promise<Array<{ agentId: string; name: string; tasksDone: number; firstPass: number; avgAttempts: number; avgLeadMinutes: number; reviewChangeRequests: number }>> {
    const rows = await this.db.query<any>(
      `SELECT a.id, a.name,
         COUNT(t.id) FILTER (WHERE t.state='done')::int AS tasks_done,
         COUNT(t.id) FILTER (WHERE t.state='done' AND t.attempts <= 1)::int AS first_pass,
         COALESCE(AVG(t.attempts) FILTER (WHERE t.state='done'), 0)::float AS avg_attempts,
         COALESCE(AVG(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 60) FILTER (WHERE t.state='done'), 0)::float AS avg_lead,
         (SELECT COUNT(*)::int FROM conversation_messages m WHERE m.listener_ref = a.id AND m.kind = 'review.verdict' AND m.machine_state->>'status' = 'changes_requested' AND m.created_at >= $2) AS review_cr
       FROM agents a
       LEFT JOIN tasks t ON t.assigned_agent_id = a.id AND t.created_at >= $2 AND COALESCE(t.checkpoint->>'internal', 'false') <> 'true'
       WHERE a.owner_id = $1
       GROUP BY a.id, a.name, a.created_at ORDER BY a.created_at`,
      [ownerId, sinceIso],
    );
    return rows.map((r) => ({ agentId: r.id, name: r.name, tasksDone: r.tasks_done, firstPass: r.first_pass, avgAttempts: Number(r.avg_attempts), avgLeadMinutes: Number(r.avg_lead), reviewChangeRequests: r.review_cr }));
  }

  /** Reviewer quality: of the tasks a reviewer approved, how many still needed a user revision. */
  async reviewerStats(agentId: string): Promise<{ reviewed: number; userRevisions: number }> {
    const r = await this.db.query<{ reviewed: number; revised: number }>(
      `SELECT COUNT(*)::int AS reviewed, COUNT(*) FILTER (WHERE COALESCE((checkpoint->>'userRevision')::int, 0) > 0)::int AS revised
       FROM tasks WHERE reviewer_agent_id = $1 AND state IN ('done','awaiting_approval','pr_open') AND checkpoint ? 'reviewVerdict'`,
      [agentId],
    );
    return { reviewed: r[0]?.reviewed ?? 0, userRevisions: r[0]?.revised ?? 0 };
  }

  /** Team collaboration (PRD §9): handoffs, executor fallbacks, duplicate-run deferrals. */
  async teamStats(ownerId: string, sinceIso: string): Promise<{ handoffs: number; fallbacks: number; deferred: number }> {
    const h = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM project_memories m JOIN projects p ON p.id = m.project_id WHERE p.owner_id = $1 AND m.type = 'handoff' AND m.created_at >= $2", [ownerId, sinceIso]);
    const a = await this.db.query<{ action: string; n: number }>("SELECT action, COUNT(*)::int AS n FROM audit_events WHERE action IN ('executor.fallback','executor.deferred') AND created_at >= $1 GROUP BY action", [sinceIso]);
    return { handoffs: h[0]?.n ?? 0, fallbacks: a.find((x) => x.action === "executor.fallback")?.n ?? 0, deferred: a.find((x) => x.action === "executor.deferred")?.n ?? 0 };
  }

  async successStats(agentId: string, purpose: string): Promise<{ ok: number; total: number }> {
    const r = await one<{ ok: number; total: number }>(this.db, "SELECT COUNT(*) FILTER (WHERE status='succeeded')::int AS ok, COUNT(*)::int AS total FROM executions WHERE agent_id=$1 AND purpose=$2", [agentId, purpose]);
    return { ok: r?.ok ?? 0, total: r?.total ?? 0 };
  }
}

/* ------------------------------------------------------------ approvals */

export class ApprovalRepo {
  constructor(private db: Database) {}

  private map(r: any): Approval {
    return {
      id: r.id,
      actorId: r.actor_id,
      projectId: r.project_id,
      taskId: r.task_id,
      action: r.action,
      riskLevel: r.risk_level,
      scope: parseJson(r.scope, {}),
      summary: r.summary,
      nonce: r.nonce,
      requiresReconfirm: !!r.requires_reconfirm,
      reconfirmPending: !!r.reconfirm_pending,
      status: r.status,
      decidedBy: r.decided_by,
      decidedAt: isoOrNull(r.decided_at),
      expiresAt: iso(r.expires_at),
      messageRef: r.message_ref,
      remindedAt: isoOrNull(r.reminded_at),
      feedback: r.feedback ?? null,
      createdAt: iso(r.created_at),
    };
  }

  async create(input: { actorId: string; projectId?: string | null; taskId?: string | null; action: ApprovalAction; riskLevel: RiskLevel; scope?: Record<string, unknown>; summary: string; requiresReconfirm?: boolean; ttlMinutes?: number }): Promise<Approval> {
    const id = newId("apr");
    const expires = new Date(Date.now() + (input.ttlMinutes ?? 24 * 60) * 60_000);
    await this.db.query(
      `INSERT INTO approvals(id, actor_id, project_id, task_id, action, risk_level, scope, summary, nonce, requires_reconfirm, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)`,
      [id, input.actorId, input.projectId ?? null, input.taskId ?? null, input.action, input.riskLevel, json(input.scope ?? {}), maskSecrets(input.summary), nonce(6), !!input.requiresReconfirm, expires.toISOString()],
    );
    return this.get(id);
  }

  async get(id: string): Promise<Approval> {
    const r = await one(this.db, "SELECT * FROM approvals WHERE id=$1", [id]);
    if (!r) throw new NotFoundError("approval", id);
    return this.map(r);
  }

  async find(id: string): Promise<Approval | undefined> {
    const r = await one(this.db, "SELECT * FROM approvals WHERE id=$1", [id]);
    return r ? this.map(r) : undefined;
  }

  async listPending(actorId?: string): Promise<Approval[]> {
    const rows = actorId ? await this.db.query("SELECT * FROM approvals WHERE status='pending' AND actor_id=$1 ORDER BY created_at", [actorId]) : await this.db.query("SELECT * FROM approvals WHERE status='pending' ORDER BY created_at");
    return rows.map((r) => this.map(r));
  }

  async listByTask(taskId: string): Promise<Approval[]> {
    return (await this.db.query("SELECT * FROM approvals WHERE task_id=$1 ORDER BY created_at", [taskId])).map((r) => this.map(r));
  }

  async listByProject(projectId: string): Promise<Approval[]> {
    return (await this.db.query("SELECT * FROM approvals WHERE project_id=$1 ORDER BY created_at", [projectId])).map((r) => this.map(r));
  }

  async setStatus(id: string, status: ApprovalStatus, decidedBy: string | null): Promise<Approval> {
    await this.db.query("UPDATE approvals SET status=$1, decided_by=$2, decided_at=now(), reconfirm_pending=false WHERE id=$3", [status, decidedBy, id]);
    return this.get(id);
  }

  async setReconfirmPending(id: string, pending: boolean): Promise<void> {
    await this.db.query("UPDATE approvals SET reconfirm_pending=$1 WHERE id=$2", [pending, id]);
  }

  async setMessageRef(id: string, ref: string): Promise<void> {
    await this.db.query("UPDATE approvals SET message_ref=$1 WHERE id=$2", [ref, id]);
  }

  async markReminded(id: string): Promise<void> {
    await this.db.query("UPDATE approvals SET reminded_at=now() WHERE id=$1", [id]);
  }

  async setFeedback(id: string, feedback: string): Promise<void> {
    await this.db.query("UPDATE approvals SET feedback=$1 WHERE id=$2", [maskSecrets(feedback).slice(0, 4000), id]);
  }

  /** Pending approvals expiring within `withinMs` that were not reminded yet. */
  async listExpiringSoon(withinMs: number): Promise<Approval[]> {
    const rows = await this.db.query("SELECT * FROM approvals WHERE status='pending' AND reminded_at IS NULL AND expires_at > now() AND expires_at <= now() + ($1::bigint || ' milliseconds')::interval ORDER BY expires_at", [withinMs]);
    return rows.map((r) => this.map(r));
  }

  async hasApproved(action: ApprovalAction, ref: { taskId?: string | null; projectId?: string | null }): Promise<boolean> {
    const r = await one(
      this.db,
      "SELECT 1 AS x FROM approvals WHERE action=$1 AND status='approved' AND task_id IS NOT DISTINCT FROM $2 AND project_id IS NOT DISTINCT FROM $3 LIMIT 1",
      [action, ref.taskId ?? null, ref.projectId ?? null],
    );
    return !!r;
  }
}

/* --------------------------------------------------- decisions, memory */

export interface Decision {
  id: string;
  projectId: string;
  taskId: string | null;
  title: string;
  rationale: string;
  alternatives: string[];
  status: "confirmed" | "proposed";
  sourceRefs: string[];
  approvalRef: string | null;
  createdAt: string;
}

export class DecisionRepo {
  constructor(private db: Database) {}

  private map(r: any): Decision {
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      title: r.title,
      rationale: r.rationale,
      alternatives: parseJson(r.alternatives, []),
      status: r.status,
      sourceRefs: parseJson(r.source_refs, []),
      approvalRef: r.approval_ref,
      createdAt: iso(r.created_at),
    };
  }

  async create(input: Omit<Decision, "id" | "createdAt" | "status" | "sourceRefs"> & { status?: Decision["status"]; sourceRefs?: string[] }): Promise<Decision> {
    const id = newId("dec");
    await this.db.query(
      "INSERT INTO decisions(id, project_id, task_id, title, rationale, alternatives, status, source_refs, approval_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, input.projectId, input.taskId, maskSecrets(input.title), maskSecrets(input.rationale), json(input.alternatives), input.status ?? "confirmed", json(input.sourceRefs ?? []), input.approvalRef],
    );
    return this.map(await one(this.db, "SELECT * FROM decisions WHERE id=$1", [id]));
  }

  async list(projectId: string, status?: Decision["status"]): Promise<Decision[]> {
    const rows = status
      ? await this.db.query("SELECT * FROM decisions WHERE project_id=$1 AND status=$2 ORDER BY created_at", [projectId, status])
      : await this.db.query("SELECT * FROM decisions WHERE project_id=$1 ORDER BY created_at", [projectId]);
    return rows.map((r) => this.map(r));
  }

  async confirm(id: string, approvalRef: string | null): Promise<void> {
    await this.db.query("UPDATE decisions SET status='confirmed', approval_ref=COALESCE($1, approval_ref) WHERE id=$2", [approvalRef, id]);
  }
}

export class MemoryRepo {
  constructor(private db: Database) {}

  private map(r: any): ProjectMemory {
    return {
      id: r.id,
      projectId: r.project_id,
      type: r.type,
      content: r.content,
      certainty: r.certainty,
      sourceRefs: parseJson(r.source_refs, []),
      provenance: parseJson(r.provenance, {}),
      retentionClass: r.retention_class,
      createdAt: iso(r.created_at),
    };
  }

  async add(
    projectId: string,
    type: MemoryType,
    content: string,
    opts: { provenance?: Record<string, unknown>; certainty?: Certainty; sourceRefs?: string[]; retentionClass?: RetentionClass } = {},
  ): Promise<ProjectMemory> {
    const id = newId("mem");
    await this.db.query(
      "INSERT INTO project_memories(id, project_id, type, content, certainty, source_refs, provenance, retention_class) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, projectId, type, maskSecrets(content), opts.certainty ?? "confirmed", json(opts.sourceRefs ?? []), json(maskObject(opts.provenance ?? {})), opts.retentionClass ?? "long_term"],
    );
    return this.map(await one(this.db, "SELECT * FROM project_memories WHERE id=$1", [id]));
  }

  /** Always scoped to one project — project-private context isolation (PRD §17). */
  async list(projectId: string, types?: MemoryType[], limit = 200): Promise<ProjectMemory[]> {
    const rows = types
      ? await this.db.query("SELECT * FROM project_memories WHERE project_id=$1 AND type = ANY($2) ORDER BY created_at DESC LIMIT $3", [projectId, types, limit])
      : await this.db.query("SELECT * FROM project_memories WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]);
    return rows.map((r) => this.map(r));
  }

  async deleteOlderThan(retentionClass: RetentionClass, cutoffIso: string): Promise<number> {
    const r = await this.db.query("DELETE FROM project_memories WHERE retention_class=$1 AND created_at < $2 RETURNING id", [retentionClass, cutoffIso]);
    return r.length;
  }

  async deleteByProject(projectId: string): Promise<number> {
    return (await this.db.query("DELETE FROM project_memories WHERE project_id=$1 RETURNING id", [projectId])).length;
  }
}

/* -------------------------------------------------------------- artifacts */

export interface Artifact {
  id: string;
  taskId: string;
  kind: string;
  storageRef: string | null;
  githubRef: string | null;
  retentionClass: RetentionClass;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export class ArtifactRepo {
  constructor(private db: Database) {}

  private map(r: any): Artifact {
    return { id: r.id, taskId: r.task_id, kind: r.kind, storageRef: r.storage_ref, githubRef: r.github_ref, retentionClass: r.retention_class, metadata: parseJson(r.metadata, {}), createdAt: iso(r.created_at) };
  }

  async add(input: Omit<Artifact, "id" | "createdAt">): Promise<Artifact> {
    const id = newId("art");
    await this.db.query("INSERT INTO artifacts(id, task_id, kind, storage_ref, github_ref, retention_class, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      id,
      input.taskId,
      input.kind,
      input.storageRef,
      input.githubRef,
      input.retentionClass,
      json(maskObject(input.metadata)),
    ]);
    return this.map(await one(this.db, "SELECT * FROM artifacts WHERE id=$1", [id]));
  }

  async listByTask(taskId: string): Promise<Artifact[]> {
    return (await this.db.query("SELECT * FROM artifacts WHERE task_id=$1 ORDER BY created_at", [taskId])).map((r) => this.map(r));
  }

  async listExpired(retentionClass: RetentionClass, cutoffIso: string): Promise<Artifact[]> {
    return (await this.db.query("SELECT * FROM artifacts WHERE retention_class=$1 AND created_at < $2", [retentionClass, cutoffIso])).map((r) => this.map(r));
  }

  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM artifacts WHERE id=$1", [id]);
  }
}

/* ---------------------------------------------------- service connections */

export interface ServiceConnection {
  id: string;
  ownerId: string;
  service: string;
  scope: string;
  credentialRef: string | null;
  health: "unknown" | "ok" | "degraded" | "failed" | "blocked" | "unsupported";
  healthDetail: string | null;
  blocked: boolean;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ServiceConnectionRepo {
  constructor(private db: Database) {}

  private map(r: any): ServiceConnection {
    return {
      id: r.id,
      ownerId: r.owner_id,
      service: r.service,
      scope: r.scope,
      credentialRef: r.credential_ref,
      health: r.health,
      healthDetail: r.health_detail,
      blocked: !!r.blocked,
      checkedAt: isoOrNull(r.checked_at),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async upsert(ownerId: string, service: string, patch: Partial<Pick<ServiceConnection, "scope" | "credentialRef" | "health" | "healthDetail" | "blocked">>): Promise<ServiceConnection> {
    const cur = await this.find(ownerId, service);
    const n = { scope: "", credentialRef: null, health: "unknown", healthDetail: null, blocked: false, ...(cur ?? {}), ...patch };
    await this.db.query(
      `INSERT INTO service_connections(id, owner_id, service, scope, credential_ref, health, health_detail, blocked, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() ELSE NULL END)
       ON CONFLICT (owner_id, service) DO UPDATE SET scope=EXCLUDED.scope, credential_ref=EXCLUDED.credential_ref, health=EXCLUDED.health, health_detail=EXCLUDED.health_detail, blocked=EXCLUDED.blocked,
         checked_at=CASE WHEN $9 THEN now() ELSE service_connections.checked_at END, updated_at=now()`,
      [cur?.id ?? newId("svc"), ownerId, service, n.scope, n.credentialRef, n.health, n.healthDetail ? maskSecrets(n.healthDetail) : null, n.blocked, patch.health !== undefined],
    );
    return (await this.find(ownerId, service))!;
  }

  async find(ownerId: string, service: string): Promise<ServiceConnection | undefined> {
    const r = await one(this.db, "SELECT * FROM service_connections WHERE owner_id=$1 AND service=$2", [ownerId, service]);
    return r ? this.map(r) : undefined;
  }

  async list(ownerId: string): Promise<ServiceConnection[]> {
    return (await this.db.query("SELECT * FROM service_connections WHERE owner_id=$1 ORDER BY service", [ownerId])).map((r) => this.map(r));
  }
}

/* ------------------------------------------------------------------ audit */

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  resource: string;
  outcome: "success" | "failure" | "denied" | "info";
  maskedDetails: Record<string, unknown>;
  createdAt: string;
}

export class AuditRepo {
  constructor(private db: Database) {}

  async record(actor: string, action: string, resource: string, outcome: AuditEvent["outcome"], details: Record<string, unknown> = {}): Promise<AuditEvent> {
    const id = newId("aud");
    const masked = maskObject(details);
    await this.db.query("INSERT INTO audit_events(id, actor, action, resource, outcome, masked_details) VALUES ($1,$2,$3,$4,$5,$6)", [id, actor, action, resource, outcome, json(masked)]);
    return { id, actor, action, resource, outcome, maskedDetails: masked, createdAt: new Date().toISOString() };
  }

  async list(limit = 100, resourcePrefix?: string): Promise<AuditEvent[]> {
    const rows = resourcePrefix
      ? await this.db.query("SELECT * FROM audit_events WHERE resource LIKE $1 ORDER BY seq DESC LIMIT $2", [`${resourcePrefix}%`, limit])
      : await this.db.query("SELECT * FROM audit_events ORDER BY seq DESC LIMIT $1", [limit]);
    return rows.map((r: any) => ({ id: r.id, actor: r.actor, action: r.action, resource: r.resource, outcome: r.outcome, maskedDetails: parseJson(r.masked_details, {}), createdAt: iso(r.created_at) }));
  }
}

/* --------------------------------------------------------- conversations */

export interface ConversationMessage {
  id: string;
  projectId: string | null;
  taskId: string | null;
  speakerAgentId: string | null;
  listenerRef: string | null;
  kind: string;
  renderedText: string;
  machineState: MachineState;
  telegramMessageId: number | null;
  createdAt: string;
}

export class ConversationRepo {
  constructor(private db: Database) {}

  private map(r: any): ConversationMessage {
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      speakerAgentId: r.speaker_agent_id,
      listenerRef: r.listener_ref,
      kind: r.kind,
      renderedText: r.rendered_text,
      machineState: parseJson(r.machine_state, { kind: "unknown" }),
      telegramMessageId: r.telegram_message_id == null ? null : Number(r.telegram_message_id),
      createdAt: iso(r.created_at),
    };
  }

  async add(input: Omit<ConversationMessage, "id" | "createdAt" | "telegramMessageId"> & { telegramMessageId?: number | null }): Promise<ConversationMessage> {
    const id = newId("msg");
    await this.db.query(
      "INSERT INTO conversation_messages(id, project_id, task_id, speaker_agent_id, listener_ref, kind, rendered_text, machine_state, telegram_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, input.projectId, input.taskId, input.speakerAgentId, input.listenerRef, input.kind, maskSecrets(input.renderedText), json(input.machineState), input.telegramMessageId ?? null],
    );
    return this.map(await one(this.db, "SELECT * FROM conversation_messages WHERE id=$1", [id]));
  }

  /** Recent messages posted in one place (a project, or the lounge when projectId is null), oldest first. */
  async listRecentIn(projectId: string | null, since: Date, limit = 8): Promise<ConversationMessage[]> {
    const params: unknown[] = [since.toISOString(), limit];
    const where = projectId ? (params.push(projectId), "project_id=$3") : "project_id IS NULL";
    const rows = await this.db.query(`SELECT * FROM conversation_messages WHERE ${where} AND created_at > $1::timestamptz ORDER BY created_at DESC LIMIT $2`, params);
    return rows.map((r) => this.map(r)).reverse();
  }

  /** Most recent messages for a project, oldest first. */
  async list(projectId: string, limit = 50, opts: { taskId?: string; speakerIds?: string[] } = {}): Promise<ConversationMessage[]> {
    const conds = ["project_id=$1"];
    const params: unknown[] = [projectId];
    if (opts.taskId) {
      params.push(opts.taskId);
      conds.push(`task_id=$${params.length}`);
    }
    if (opts.speakerIds?.length) {
      params.push(opts.speakerIds);
      conds.push(`speaker_agent_id = ANY($${params.length})`);
    }
    params.push(limit);
    const rows = await this.db.query(`SELECT * FROM conversation_messages WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    return rows.map((r) => this.map(r)).reverse();
  }

  /** A/B collaboration experiment metrics from discussion.end events. */
  async discussionStats(sinceIso: string): Promise<Array<{ mode: string; variant: string; discussions: number; avgRounds: number; consensusRate: number; avgSeconds: number }>> {
    const rows = await this.db.query<any>(
      `SELECT COALESCE(machine_state->'data'->>'mode', '?') AS mode, COALESCE(machine_state->'data'->>'variant', 'A') AS variant,
         COUNT(*)::int AS n,
         COALESCE(AVG((machine_state->'data'->>'rounds')::float), 0)::float AS rounds,
         COALESCE(AVG(CASE WHEN machine_state->'data'->>'consensus' = 'true' THEN 1 ELSE 0 END), 0)::float AS consensus,
         COALESCE(AVG((machine_state->'data'->>'durationMs')::float), 0)::float / 1000 AS secs
       FROM conversation_messages WHERE kind = 'discussion.end' AND created_at >= $1
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [sinceIso],
    );
    return rows.map((r) => ({ mode: r.mode, variant: r.variant, discussions: r.n, avgRounds: Number(r.rounds), consensusRate: Number(r.consensus), avgSeconds: Number(r.secs) }));
  }

  async countSince(projectId: string, sinceIso: string | null): Promise<number> {
    const r = await one<{ n: number }>(this.db, "SELECT COUNT(*)::int AS n FROM conversation_messages WHERE project_id=$1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)", [projectId, sinceIso]);
    return r?.n ?? 0;
  }
}

export interface ConversationSummary {
  id: string;
  projectId: string;
  taskId: string | null;
  summary: string;
  sourceMessageIds: string[];
  createdAt: string;
}

export class SummaryRepo {
  constructor(private db: Database) {}

  private map(r: any): ConversationSummary {
    return { id: r.id, projectId: r.project_id, taskId: r.task_id, summary: r.summary, sourceMessageIds: parseJson(r.source_message_ids, []), createdAt: iso(r.created_at) };
  }

  async add(projectId: string, taskId: string | null, summary: string, sourceMessageIds: string[]): Promise<ConversationSummary> {
    const id = newId("sum");
    await this.db.query("INSERT INTO conversation_summaries(id, project_id, task_id, summary, source_message_ids) VALUES ($1,$2,$3,$4,$5)", [id, projectId, taskId, maskSecrets(summary), json(sourceMessageIds)]);
    return this.map(await one(this.db, "SELECT * FROM conversation_summaries WHERE id=$1", [id]));
  }

  async list(projectId: string, limit = 10, taskId?: string): Promise<ConversationSummary[]> {
    const rows = taskId
      ? await this.db.query("SELECT * FROM conversation_summaries WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT $3", [projectId, taskId, limit])
      : await this.db.query("SELECT * FROM conversation_summaries WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]);
    return rows.map((r) => this.map(r));
  }

  async latest(projectId: string): Promise<ConversationSummary | undefined> {
    return (await this.list(projectId, 1))[0];
  }
}

/* ------------------------------------------------------- requests, ideas */

export class RequestRepo {
  constructor(private db: Database) {}

  /** The user's recent messages in one place (a project topic, or the lounge when projectId is null), oldest first. */
  async listRecent(userId: string, projectId: string | null, since: Date, limit = 8): Promise<Array<{ rawText: string; createdAt: string }>> {
    const params: unknown[] = [userId, since.toISOString(), limit];
    const where = projectId ? (params.push(projectId), "project_id=$4") : "project_id IS NULL";
    const rows = await this.db.query(`SELECT raw_text, created_at FROM requests WHERE user_id=$1 AND ${where} AND created_at > $2::timestamptz ORDER BY created_at DESC LIMIT $3`, params);
    return rows.map((r: any) => ({ rawText: String(r.raw_text), createdAt: iso(r.created_at) })).reverse();
  }

  async add(input: { userId: string; projectId: string | null; source: string; rawText: string; classification: RequestClassification; mentionedAgentIds: string[] }): Promise<string> {
    const id = newId("req");
    await this.db.query("INSERT INTO requests(id, user_id, project_id, source, raw_text, classification, mentioned_agent_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      id,
      input.userId,
      input.projectId,
      input.source,
      maskSecrets(input.rawText),
      input.classification,
      json(input.mentionedAgentIds),
    ]);
    return id;
  }
}

export interface Idea {
  id: string;
  projectId: string | null;
  userId: string;
  text: string;
  status: "candidate" | "promoted" | "dismissed";
  createdAt: string;
}

export class IdeaRepo {
  constructor(private db: Database) {}

  private map(r: any): Idea {
    return { id: r.id, projectId: r.project_id, userId: r.user_id, text: r.text, status: r.status, createdAt: iso(r.created_at) };
  }

  async add(userId: string, projectId: string | null, text: string): Promise<Idea> {
    const id = newId("ide");
    await this.db.query("INSERT INTO ideas(id, project_id, user_id, text) VALUES ($1,$2,$3,$4)", [id, projectId, userId, maskSecrets(text)]);
    return this.map(await one(this.db, "SELECT * FROM ideas WHERE id=$1", [id]));
  }

  async list(projectId: string | null, status: Idea["status"] = "candidate"): Promise<Idea[]> {
    const rows = await this.db.query("SELECT * FROM ideas WHERE project_id IS NOT DISTINCT FROM $1 AND status=$2 ORDER BY created_at", [projectId, status]);
    return rows.map((r) => this.map(r));
  }

  async setStatus(id: string, status: Idea["status"]): Promise<void> {
    await this.db.query("UPDATE ideas SET status=$1 WHERE id=$2", [status, id]);
  }
}

/* -------------------------------------------------------- external effects */

/**
 * Idempotency ledger for external side effects (repo creation, PR, merge, deploy).
 * Replays after restart return the recorded result instead of repeating the effect (PRD §12-8).
 */
export class ExternalEffectRepo {
  constructor(private db: Database) {}

  async get<T = Record<string, unknown>>(key: string): Promise<T | undefined> {
    const r = await one<{ result: unknown }>(this.db, "SELECT result FROM external_effects WHERE key=$1", [key]);
    return r ? parseJson<T>(r.result, {} as T) : undefined;
  }

  async record(key: string, kind: string, taskId: string | null, result: Record<string, unknown>): Promise<void> {
    await this.db.query("INSERT INTO external_effects(key, task_id, kind, result) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET result=EXCLUDED.result", [key, taskId, kind, json(result)]);
  }

  async once<T extends Record<string, unknown>>(key: string, kind: string, taskId: string | null, fn: () => Promise<T>): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing) return existing;
    const result = await fn();
    await this.record(key, kind, taskId, result);
    return result;
  }
}

/* ---------------------------------------------------------------- settings */

export type SettingScope = "system" | "user" | "project" | "agent";

export class SettingsRepo {
  constructor(private db: Database) {}

  async get<T>(scope: SettingScope, scopeId: string, key: string): Promise<T | undefined> {
    const r = await one<{ value: unknown }>(this.db, "SELECT value FROM settings WHERE scope=$1 AND scope_id=$2 AND key=$3", [scope, scopeId, key]);
    return r ? parseJson<T>(r.value, undefined as T) : undefined;
  }

  async set(scope: SettingScope, scopeId: string, key: string, value: unknown): Promise<void> {
    await this.db.query("INSERT INTO settings(scope, scope_id, key, value) VALUES ($1,$2,$3,$4) ON CONFLICT (scope, scope_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [
      scope,
      scopeId,
      key,
      json(value),
    ]);
  }

  async delete(scope: SettingScope, scopeId: string, key: string): Promise<void> {
    await this.db.query("DELETE FROM settings WHERE scope=$1 AND scope_id=$2 AND key=$3", [scope, scopeId, key]);
  }

  async listScope(scope: SettingScope, scopeId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings WHERE scope=$1 AND scope_id=$2", [scope, scopeId]);
    return Object.fromEntries(rows.map((r) => [r.key, parseJson(r.value, null)]));
  }
}

/* -------------------------------------------------------------------- jobs */

export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  priority: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedBy: string | null;
  lastError: string | null;
}

/** Durable queue on PostgreSQL (FOR UPDATE SKIP LOCKED). Replaceable via the JobQueue interface. */
export class JobRepo {
  constructor(private db: Database) {}

  private map(r: any): Job {
    return {
      id: r.id,
      kind: r.kind,
      payload: parseJson(r.payload, {}),
      dedupeKey: r.dedupe_key,
      priority: r.priority,
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      runAt: iso(r.run_at),
      lockedBy: r.locked_by,
      lastError: r.last_error,
    };
  }

  async enqueue(kind: string, payload: Record<string, unknown>, opts: { dedupeKey?: string; priority?: number; runAt?: Date; maxAttempts?: number } = {}): Promise<Job | undefined> {
    const id = newId("job");
    const rows = await this.db.query(
      `INSERT INTO jobs(id, kind, payload, dedupe_key, priority, run_at, max_attempts) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         status = CASE WHEN jobs.status IN ('done','failed','cancelled') THEN 'queued' ELSE jobs.status END,
         payload = CASE WHEN jobs.status IN ('done','failed','cancelled') THEN EXCLUDED.payload ELSE jobs.payload END,
         run_at = CASE WHEN jobs.status IN ('done','failed','cancelled') THEN EXCLUDED.run_at ELSE jobs.run_at END,
         attempts = CASE WHEN jobs.status IN ('done','failed','cancelled') THEN 0 ELSE jobs.attempts END,
         updated_at = now()
       RETURNING *`,
      [id, kind, json(payload), opts.dedupeKey ?? null, opts.priority ?? 50, (opts.runAt ?? new Date()).toISOString(), opts.maxAttempts ?? 3],
    );
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  /** Jobs that are ready to run now (used to decide whether a resource alert is worth sending). */
  async countReady(kinds?: string[]): Promise<number> {
    const params: unknown[] = [];
    let kindCond = "";
    if (kinds?.length) {
      params.push(kinds);
      kindCond = `AND kind = ANY($1)`;
    }
    const rows = await this.db.query<{ n: string | number }>(`SELECT count(*) AS n FROM jobs WHERE status='queued' AND run_at <= now() ${kindCond}`, params);
    return Number(rows[0]?.n ?? 0);
  }

  /** Claim up to `limit` ready jobs. */
  async claim(workerId: string, limit = 1, kinds?: string[]): Promise<Job[]> {
    return this.db.tx(async (q) => {
      const params: unknown[] = [limit];
      let kindCond = "";
      if (kinds?.length) {
        params.push(kinds);
        kindCond = `AND kind = ANY($${params.length})`;
      }
      const sel = await q.query(`SELECT id FROM jobs WHERE status='queued' AND run_at <= now() ${kindCond} ORDER BY priority DESC, run_at LIMIT $1 FOR UPDATE SKIP LOCKED`, params);
      if (!sel.length) return [];
      const ids = sel.map((r: any) => r.id);
      const rows = await q.query("UPDATE jobs SET status='running', locked_by=$1, locked_at=now(), attempts=attempts+1, updated_at=now() WHERE id = ANY($2) RETURNING *", [workerId, ids]);
      return rows.map((r) => this.map(r));
    });
  }

  async complete(id: string): Promise<void> {
    await this.db.query("UPDATE jobs SET status='done', locked_by=NULL, updated_at=now() WHERE id=$1", [id]);
  }

  async fail(id: string, error: string, retryInMs?: number): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = CASE WHEN attempts < max_attempts AND $2::bigint IS NOT NULL THEN 'queued' ELSE 'failed' END,
        run_at = CASE WHEN $2::bigint IS NOT NULL THEN now() + ($2::bigint || ' milliseconds')::interval ELSE run_at END,
        last_error=$3, locked_by=NULL, updated_at=now() WHERE id=$1`,
      [id, retryInMs ?? null, maskSecrets(error).slice(0, 2000)],
    );
  }

  async reschedule(id: string, runAt: Date): Promise<void> {
    await this.db.query("UPDATE jobs SET status='queued', run_at=$2, attempts=GREATEST(attempts-1,0), locked_by=NULL, updated_at=now() WHERE id=$1", [id, runAt.toISOString()]);
  }

  async cancelByDedupe(dedupeKey: string): Promise<void> {
    await this.db.query("UPDATE jobs SET status='cancelled', updated_at=now() WHERE dedupe_key=$1 AND status IN ('queued')", [dedupeKey]);
  }

  /** Recovery after restart: jobs left 'running' by a dead worker go back to the queue. */
  async requeueStale(olderThanMs = 0): Promise<number> {
    const r = await this.db.query("UPDATE jobs SET status='queued', locked_by=NULL, updated_at=now() WHERE status='running' AND locked_at < now() - ($1::bigint || ' milliseconds')::interval RETURNING id", [olderThanMs]);
    return r.length;
  }

  async list(status?: Job["status"]): Promise<Job[]> {
    const rows = status ? await this.db.query("SELECT * FROM jobs WHERE status=$1 ORDER BY created_at", [status]) : await this.db.query("SELECT * FROM jobs ORDER BY created_at");
    return rows.map((r) => this.map(r));
  }
}

/* ---------------------------------------------------------------- aggregate */

export class Repos {
  users: UserRepo;
  agents: AgentRepo;
  personas: PersonaRepo;
  relationships: RelationshipRepo;
  projects: ProjectRepo;
  tasks: TaskRepo;
  executions: ExecutionRepo;
  approvals: ApprovalRepo;
  decisions: DecisionRepo;
  memories: MemoryRepo;
  artifacts: ArtifactRepo;
  services: ServiceConnectionRepo;
  audit: AuditRepo;
  conversations: ConversationRepo;
  summaries: SummaryRepo;
  requests: RequestRepo;
  ideas: IdeaRepo;
  effects: ExternalEffectRepo;
  settings: SettingsRepo;
  jobs: JobRepo;

  constructor(public readonly db: Database) {
    this.users = new UserRepo(db);
    this.agents = new AgentRepo(db);
    this.personas = new PersonaRepo(db);
    this.relationships = new RelationshipRepo(db);
    this.projects = new ProjectRepo(db);
    this.tasks = new TaskRepo(db);
    this.executions = new ExecutionRepo(db);
    this.approvals = new ApprovalRepo(db);
    this.decisions = new DecisionRepo(db);
    this.memories = new MemoryRepo(db);
    this.artifacts = new ArtifactRepo(db);
    this.services = new ServiceConnectionRepo(db);
    this.audit = new AuditRepo(db);
    this.conversations = new ConversationRepo(db);
    this.summaries = new SummaryRepo(db);
    this.requests = new RequestRepo(db);
    this.ideas = new IdeaRepo(db);
    this.effects = new ExternalEffectRepo(db);
    this.settings = new SettingsRepo(db);
    this.jobs = new JobRepo(db);
  }
}
