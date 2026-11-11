/**
 * PostgreSQL schema migrations. Applied once, in order, inside a transaction.
 * Never edit an applied migration — append a new one (safe upgrade, PRD §8.2).
 *
 * Storage split (PRD §17):
 *  - PostgreSQL: raw agent conversation events, summaries, confirmed decisions, agent identity,
 *    relationships, project memory/preferences, task state/checkpoints, settings, jobs.
 *  - GitHub: code, PRD/design/decision documents, PRs, test definitions.
 *  - File storage (deployment volume): execution logs, screenshots, attachments, temp files.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  display_name TEXT,
  preferences JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'corporate',
  dialogue_style_flag BOOLEAN NOT NULL DEFAULT false,
  moderator_agent_id TEXT,
  lounge_chat_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_personas (
  id TEXT PRIMARY KEY,
  preset TEXT NOT NULL,
  custom_rules TEXT,
  tone_bounds JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  model_policy TEXT NOT NULL DEFAULT 'auto',
  auth_mode TEXT NOT NULL DEFAULT 'official_subscription',
  persona_id TEXT REFERENCES agent_personas(id),
  organization_role TEXT NOT NULL DEFAULT 'auto',
  dialogue_policy TEXT NOT NULL DEFAULT 'relationship_aware',
  memory_enabled BOOLEAN NOT NULL DEFAULT true,
  relationship_history BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agents_owner ON agents(owner_id);

CREATE TABLE agent_relationships (
  org_id TEXT NOT NULL,
  agent_a_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_b_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  affinity DOUBLE PRECISION NOT NULL DEFAULT 0.2,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  interaction_summary TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, agent_a_id, agent_b_id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  topic_id BIGINT,
  chat_id TEXT,
  progress_message_id BIGINT,
  repo_ref TEXT,
  repo_mode TEXT NOT NULL DEFAULT 'new',
  default_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'proposed',
  priority INTEGER NOT NULL DEFAULT 50,
  stack JSONB NOT NULL DEFAULT '[]',
  work_type TEXT NOT NULL DEFAULT 'coding',
  leader_agent_id TEXT,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_projects_owner_slug ON projects(owner_id, slug);
CREATE INDEX idx_projects_topic ON projects(chat_id, topic_id);

CREATE TABLE project_agents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  functional_role TEXT NOT NULL,
  org_role TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  source TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  classification TEXT NOT NULL,
  mentioned_agent_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'requirements',
  priority INTEGER NOT NULL DEFAULT 50,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  assigned_agent_id TEXT,
  reviewer_agent_id TEXT,
  tester_agent_id TEXT,
  branch TEXT,
  pr_ref TEXT,
  blocked_reason TEXT,
  budget JSONB NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  checkpoint JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_tasks_project_state ON tasks(project_id, state);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  executor_kind TEXT NOT NULL DEFAULT 'local_cli',
  purpose TEXT NOT NULL,
  session_ref TEXT,
  external_ref TEXT,
  checkpoint_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT,
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  usage JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  log_ref TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_executions_task ON executions(task_id);
CREATE INDEX idx_executions_status ON executions(status);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  action TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  nonce TEXT NOT NULL,
  requires_reconfirm BOOLEAN NOT NULL DEFAULT false,
  reconfirm_pending BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  message_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_approvals_status ON approvals(status);

-- Raw agent conversation events (source of truth; Telegram is only a view)
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  speaker_agent_id TEXT,
  listener_ref TEXT,
  kind TEXT NOT NULL,
  rendered_text TEXT NOT NULL,
  machine_state JSONB NOT NULL DEFAULT '{}',
  telegram_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_project ON conversation_messages(project_id, created_at);
CREATE INDEX idx_conv_task ON conversation_messages(task_id, created_at);

-- Summaries derived from raw conversation, linked to their source events
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  summary TEXT NOT NULL,
  source_message_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_sum_project ON conversation_summaries(project_id, created_at);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  alternatives JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'confirmed',
  source_refs JSONB NOT NULL DEFAULT '[]',
  approval_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_decisions_project ON decisions(project_id, created_at);

CREATE TABLE project_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  certainty TEXT NOT NULL DEFAULT 'confirmed',
  source_refs JSONB NOT NULL DEFAULT '[]',
  provenance JSONB NOT NULL DEFAULT '{}',
  retention_class TEXT NOT NULL DEFAULT 'long_term',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_memories_project_type ON project_memories(project_id, type, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  storage_ref TEXT,
  github_ref TEXT,
  retention_class TEXT NOT NULL DEFAULT 'detailed_log',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_artifacts_retention ON artifacts(retention_class, created_at);

CREATE TABLE service_connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  service TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  credential_ref TEXT,
  health TEXT NOT NULL DEFAULT 'unknown',
  health_detail TEXT,
  blocked BOOLEAN NOT NULL DEFAULT false,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_service_owner ON service_connections(owner_id, service);

CREATE TABLE secrets (
  ref TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT,
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  outcome TEXT NOT NULL,
  masked_details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_events(created_at);

CREATE TABLE feature_flags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  flag_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  rollout_scope TEXT NOT NULL DEFAULT 'global',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_flags_owner_key ON feature_flags(owner_id, flag_key);

-- Layered settings: scope = system | user | project | agent (PRD §15, §18)
CREATE TABLE settings (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id, key)
);

-- Idempotency ledger for external side effects (PRD §12-8)
CREATE TABLE external_effects (
  key TEXT PRIMARY KEY,
  task_id TEXT,
  kind TEXT NOT NULL,
  result JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable job queue (replaceable; FOR UPDATE SKIP LOCKED on PostgreSQL)
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_ready ON jobs(status, run_at, priority);
`,
  },
  {
    version: 2,
    name: "phase2_approval_ux",
    sql: `
ALTER TABLE approvals ADD COLUMN reminded_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN feedback TEXT;
`,
  },
];
