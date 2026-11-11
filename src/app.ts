import type { Config } from "./config/index.js";
import { ensureDataDirs } from "./config/index.js";
import { openAndMigrate, type Database } from "./db/index.js";
import { Repos } from "./db/repositories.js";
import { Vault, resolveMasterKey } from "./security/vault.js";
import { FeatureFlags } from "./core/flags/index.js";
import { EventBus } from "./core/events.js";
import { ApprovalEngine } from "./core/approvals/engine.js";
import { ExecutorRegistry, type VerificationRecord } from "./executors/registry.js";
import { UsageTracker } from "./core/usage/tracker.js";
import { TeamCoordinator } from "./core/agents/team.js";
import { MemoryService } from "./core/memory/service.js";
import { ContextBuilder } from "./core/memory/contextBuilder.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { LocalFileStore, type FileStore } from "./storage/fileStore.js";
import { NullOutboundPort, type OutboundPort } from "./core/orchestration/ports.js";
import { OctokitGitHubService, type GitHubService } from "./github/client.js";
import { GitHubAppTokenProvider, type TokenSource } from "./github/appAuth.js";
import { ClaudeCliAdapter } from "./executors/claude.js";
import { CodexCliAdapter } from "./executors/codex.js";
import { CodexCloudAdapter } from "./executors/codexCloud.js";
import { ClaudeCloudAdapter } from "./executors/claudeCloud.js";
import { GeminiCliAdapter } from "./executors/gemini.js";
import { CursorCliAdapter } from "./executors/cursor.js";
import { syncExecutorFlags } from "./executors/flags.js";
import { loadCustomModes } from "./core/organization/customModes.js";
import type { ExecutorAdapter } from "./executors/types.js";
import type { AppContext } from "./core/context.js";
import { Orchestrator } from "./core/orchestration/orchestrator.js";
import { Scheduler } from "./core/scheduler/scheduler.js";
import { CodingAgencyPlugin } from "./plugins/coding-agency/workflow.js";
import { ResearchAgencyPlugin } from "./plugins/research-agency/workflow.js";
import type { WorkTypePlugin } from "./plugins/types.js";
import { logger as defaultLogger, type Logger } from "./util/logger.js";
import { startMaintenance } from "./ops/maintenance.js";
import os from "node:os";
import path from "node:path";

export const SYSTEM_OWNER = "system";
export const SECRET_REFS = { telegramToken: "sys_telegram_bot_token", githubToken: "sys_github_token", githubAppKey: "sys_github_app_private_key", s3Secret: "sys_backup_s3_secret", s3Access: "sys_backup_s3_access" } as const;

/** GitHub connection: GitHub App installation (preferred, least privilege) or a fine-grained PAT. */
export async function resolveGitHubAuth(ctx: Pick<AppContext, "vault" | "repos" | "config">): Promise<{ source: TokenSource; mode: "app" | "pat" } | null> {
  const app = await ctx.repos.settings.get<{ appId: string; installationId: string }>("system", "", "github.app");
  if (app?.appId && app.installationId) {
    const key = await resolveSecret(ctx, undefined, SECRET_REFS.githubAppKey);
    if (key) {
      const provider = new GitHubAppTokenProvider({ appId: app.appId, installationId: app.installationId, privateKeyPem: key });
      return { source: () => provider.token(), mode: "app" };
    }
  }
  const pat = await resolveSecret(ctx, ctx.config.GITHUB_TOKEN, SECRET_REFS.githubToken);
  return pat ? { source: pat, mode: "pat" } : null;
}

export interface AppOverrides {
  db?: Database;
  out?: OutboundPort;
  github?: GitHubService | null;
  adapters?: ExecutorAdapter[];
  files?: FileStore;
  logger?: Logger;
  masterKey?: Buffer;
  skipDetect?: boolean;
  plugins?: WorkTypePlugin[];
  remoteUrlFor?: (repoRef: string) => string;
}

export interface App {
  ctx: AppContext;
  orchestrator: Orchestrator;
  scheduler: Scheduler;
  start(opts?: { scheduler?: boolean; maintenance?: boolean }): Promise<void>;
  stop(): Promise<void>;
  /** Rebuild the GitHub client after the wizard stored a token. */
  reloadGitHub(): Promise<void>;
  setOutbound(out: OutboundPort): void;
}

export function defaultAdapters(config: Config): ExecutorAdapter[] {
  return [
    new ClaudeCloudAdapter(config.CLAUDE_CLI_PATH),
    new CodexCloudAdapter(config.CODEX_CLI_PATH),
    new ClaudeCliAdapter(config.CLAUDE_CLI_PATH),
    new CodexCliAdapter(config.CODEX_CLI_PATH),
    new GeminiCliAdapter(config.GEMINI_CLI_PATH),
    new CursorCliAdapter(config.CURSOR_CLI_PATH),
  ];
}

/** Secrets: environment first, then the encrypted vault (populated by `aa setup` / `aa config`). */
export async function resolveSecret(ctx: Pick<AppContext, "vault">, envValue: string | undefined, ref: string): Promise<string | undefined> {
  if (envValue) return envValue;
  try {
    return await ctx.vault.get(ref, { ownerId: SYSTEM_OWNER });
  } catch {
    return undefined;
  }
}

export async function createApp(config: Config, o: AppOverrides = {}): Promise<App> {
  ensureDataDirs(config);
  const log = o.logger ?? defaultLogger;
  const db = o.db ?? (await openAndMigrate({ databaseUrl: config.DATABASE_URL, pgliteDir: config.pgliteDir }));
  const repos = new Repos(db);
  const vault = new Vault(db, o.masterKey ?? resolveMasterKey(config.dataDir, config.AA_MASTER_KEY));
  const events = new EventBus();
  const usage = new UsageTracker();
  const executors = new ExecutorRegistry(usage);
  for (const a of o.adapters ?? defaultAdapters(config)) executors.register(a);
  // Load recorded verification evidence for executors whose CLI surface is not yet stable.
  for (const a of executors.list()) {
    const rec = await repos.settings.get<VerificationRecord>("system", "", `executor.verification.${a.id}`);
    if (rec) executors.setVerification(rec);
  }
  await loadCustomModes(repos);
  const memory = new MemoryService(repos);
  const ctx: AppContext = {
    config,
    repos,
    vault,
    flags: new FeatureFlags(db),
    events,
    approvals: new ApprovalEngine(repos, events),
    executors,
    usage,
    team: new TeamCoordinator(repos, executors),
    memory,
    contextBuilder: new ContextBuilder(repos, memory),
    files: o.files ?? new LocalFileStore(config.filesDir),
    github: null,
    workspaces: null as unknown as WorkspaceManager,
    out: o.out ?? new NullOutboundPort(),
    logger: log,
    lifecycle: { shuttingDown: false },
  };
  const ghAuth = await resolveGitHubAuth(ctx);
  const githubToken = ghAuth?.source;
  ctx.github = o.github !== undefined ? o.github : ghAuth ? new OctokitGitHubService(ghAuth.source, undefined, ghAuth.mode) : null;
  const authMounts =
    config.AA_WORKSPACE_MODE === "docker"
      ? [
          { host: config.AA_CLAUDE_HOME_HOST ?? path.join(os.homedir(), ".claude"), container: "/home/agent/.claude" },
          { host: config.AA_CODEX_HOME_HOST ?? path.join(os.homedir(), ".codex"), container: "/home/agent/.codex" },
        ]
      : [];
  ctx.workspaces = new WorkspaceManager({ root: config.workspacesDir, mode: config.AA_WORKSPACE_MODE, image: config.AA_WORKSPACE_IMAGE, gitToken: githubToken, authMounts, remoteUrlFor: o.remoteUrlFor, network: config.AA_WORKSPACE_NETWORK, cpus: config.AA_WORKSPACE_CPUS, memory: config.AA_WORKSPACE_MEMORY });

  const plugins = new Map<string, WorkTypePlugin>();
  for (const p of o.plugins ?? [new CodingAgencyPlugin(), new ResearchAgencyPlugin()]) plugins.set(p.id, p);
  const orchestrator = new Orchestrator(ctx, plugins);
  const scheduler = new Scheduler(ctx, orchestrator);

  // Surface alerts to every admin's lounge.
  events.on("alert", (a) => {
    void (async () => {
      for (const u of await repos.users.list()) {
        const project = a.projectId ? await repos.projects.find(a.projectId) : undefined;
        await orchestrator.comm
          .say({ user: u, project: project?.ownerId === u.id ? project : null, speaker: { kind: "system" }, listener: { kind: "user" }, situation: "error", body: `${a.level === "error" ? "🚨" : a.level === "warn" ? "⚠️" : "ℹ️"} ${a.message}`, machineState: { kind: `alert.${a.level}` } })
          .catch(() => undefined);
      }
    })();
  });

  let stopMaintenance: (() => void) | null = null;
  return {
    ctx,
    orchestrator,
    scheduler,
    async start(opts = {}) {
      await syncExecutorFlags(ctx);
      if (!o.skipDetect) {
        const statuses = await executors.detectAll();
        for (const s of statuses) {
          for (const u of await repos.users.list()) {
            await repos.services.upsert(u.id, s.adapterId, { health: executors.isUsable(s.adapterId) ? "ok" : s.installed ? "degraded" : "unsupported", healthDetail: executors.usabilityReason(s.adapterId).reason });
          }
        }
      }
      if (opts.scheduler !== false) {
        await scheduler.recover();
        await orchestrator.resumeMaintenanceOnStart();
        scheduler.start();
      }
      if (opts.maintenance !== false) stopMaintenance = startMaintenance(ctx, { everyMinute: [() => orchestrator.remindApprovals()] });
    },
    async stop() {
      stopMaintenance?.();
      await scheduler.stop();
      await db.close();
    },
    async reloadGitHub() {
      const auth = await resolveGitHubAuth(ctx);
      const tok = auth?.source;
      if (o.github === undefined) ctx.github = auth ? new OctokitGitHubService(auth.source, undefined, auth.mode) : null;
      ctx.workspaces = new WorkspaceManager({ root: config.workspacesDir, mode: config.AA_WORKSPACE_MODE, image: config.AA_WORKSPACE_IMAGE, gitToken: tok, authMounts, remoteUrlFor: o.remoteUrlFor, network: config.AA_WORKSPACE_NETWORK, cpus: config.AA_WORKSPACE_CPUS, memory: config.AA_WORKSPACE_MEMORY });
    },
    setOutbound(out) {
      ctx.out = out;
    },
  };
}
