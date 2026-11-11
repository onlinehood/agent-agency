import type { Config } from "../config/index.js";
import type { Repos } from "../db/repositories.js";
import type { Vault } from "../security/vault.js";
import type { FeatureFlags } from "./flags/index.js";
import type { EventBus } from "./events.js";
import type { ApprovalEngine } from "./approvals/engine.js";
import type { ExecutorRegistry } from "../executors/registry.js";
import type { UsageTracker } from "./usage/tracker.js";
import type { TeamCoordinator } from "./agents/team.js";
import type { MemoryService } from "./memory/service.js";
import type { ContextBuilder } from "./memory/contextBuilder.js";
import type { FileStore } from "../storage/fileStore.js";
import type { GitHubService } from "../github/client.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { OutboundPort } from "./orchestration/ports.js";
import type { Logger } from "../util/logger.js";

/** Dependency container passed through the core. */
export interface AppContext {
  config: Config;
  repos: Repos;
  vault: Vault;
  flags: FeatureFlags;
  events: EventBus;
  approvals: ApprovalEngine;
  executors: ExecutorRegistry;
  usage: UsageTracker;
  team: TeamCoordinator;
  memory: MemoryService;
  contextBuilder: ContextBuilder;
  files: FileStore;
  github: GitHubService | null;
  workspaces: WorkspaceManager;
  out: OutboundPort;
  logger: Logger;
  /** Process lifecycle flags shared by the scheduler and workflows. */
  lifecycle: { shuttingDown: boolean };
}
