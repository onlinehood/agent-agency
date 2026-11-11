import { z } from "zod";
import path from "node:path";
import fs from "node:fs";

const csvInts = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );

export const ConfigSchema = z.object({
  AA_DATA_DIR: z.string().default("./data"),
  /** postgres://user:pass@host:5432/db — PostgreSQL is the source of truth (PRD §17). */
  DATABASE_URL: z.string().optional(),
  /** When DATABASE_URL is absent, embedded PostgreSQL (PGlite) persists here (dev/small installs). */
  AA_PGLITE_DIR: z.string().optional(),
  /** Public HTTPS base URL, only needed for webhook/OAuth-callback integrations. */
  AA_PUBLIC_URL: z.string().optional(),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  AA_MASTER_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_USER_IDS: csvInts,
  TELEGRAM_LOUNGE_CHAT_ID: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().optional(),
  CLAUDE_CLI_PATH: z.string().default("claude"),
  CODEX_CLI_PATH: z.string().default("codex"),
  GEMINI_CLI_PATH: z.string().default("gemini"),
  CURSOR_CLI_PATH: z.string().default("cursor-agent"),
  AA_WEB_PORT: z.coerce.number().int().default(8080),
  AA_WEB_BIND: z.string().default("127.0.0.1"),
  AA_SETUP_TOKEN: z.string().optional(),
  AA_WORKSPACE_MODE: z.enum(["local", "docker"]).default("local"),
  AA_WORKSPACE_IMAGE: z.string().default("agent-agency/workspace:latest"),
  AA_MAX_CONCURRENT_PROJECTS: z.coerce.number().int().min(1).default(2),
  /** Concurrent runs allowed per executor (subscription CLIs are rate limited per account). */
  AA_MAX_RUNS_PER_EXECUTOR: z.coerce.number().int().min(1).default(2),
  /** How long a stop waits for running work before cancelling it (keep below Docker's stop_grace_period). */
  AA_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(45_000),
  /** Docker workspace sandbox: network name ("none" disables network), CPU and RAM limits. */
  AA_WORKSPACE_NETWORK: z.string().default("bridge"),
  AA_WORKSPACE_CPUS: z.coerce.number().default(2),
  AA_WORKSPACE_MEMORY: z.string().default("4g"),
  /** Host-side paths of CLI subscription logins, mounted read-only into workspace containers. */
  AA_CLAUDE_HOME_HOST: z.string().optional(),
  AA_CODEX_HOME_HOST: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof ConfigSchema> & {
  dataDir: string;
  dbPath: string;
  workspacesDir: string;
  backupsDir: string;
  artifactsDir: string;
  filesDir: string;
  pgliteDir: string;
};

export function loadDotEnv(file = ".env"): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let val = m[2] ?? "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  const dataDir = path.resolve(parsed.AA_DATA_DIR);
  return {
    ...parsed,
    dataDir,
    dbPath: path.join(dataDir, "agent-agency.sqlite"),
    workspacesDir: path.join(dataDir, "workspaces"),
    backupsDir: path.join(dataDir, "backups"),
    artifactsDir: path.join(dataDir, "artifacts"),
    filesDir: path.join(dataDir, "files"),
    pgliteDir: path.resolve(parsed.AA_PGLITE_DIR ?? path.join(dataDir, "pglite")),
  };
}

export function ensureDataDirs(cfg: Config): void {
  for (const d of [cfg.dataDir, cfg.workspacesDir, cfg.backupsDir, cfg.artifactsDir, cfg.filesDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
