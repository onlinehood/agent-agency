import pg from "pg";
import { migrations } from "./migrations.js";

/**
 * Database abstraction (PRD §16, §17): PostgreSQL is the source of truth.
 * - "postgres": real PostgreSQL via node-postgres (production / Docker Compose).
 * - "pglite": embedded PostgreSQL (WASM) with the same SQL dialect — tests, local dev,
 *   and very small single-node installs. Both run the same migrations and queries.
 */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Database extends Queryable {
  readonly kind: "postgres" | "pglite";
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ---------------------------------------------------------- PostgreSQL */

// BIGINT (int8) → number. Our bigint columns (telegram ids, sizes) fit in 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export class PgDatabase implements Database {
  readonly kind = "postgres" as const;
  private pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max });
    // Idle client errors (DB restart, network blip) must not crash the process; the pool reconnects.
    this.pool.on("error", (err) => {
      process.emitWarning(`postgres pool error: ${err.message}`);
    });
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params as any[]);
    return r.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const q: Queryable = { query: async (s, p = []) => (await client.query(s, p as any[])).rows };
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* -------------------------------------------------------------- PGlite */

export class PgliteDatabase implements Database {
  readonly kind = "pglite" as const;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private db: any) {}

  /** dataDir: filesystem path for persistence, or undefined for in-memory. */
  static async open(dataDir?: string): Promise<PgliteDatabase> {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = dataDir ? new PGlite(dataDir) : new PGlite();
    await db.waitReady;
    return new PgliteDatabase(db);
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.db.query(sql, params);
    return r.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    // PGlite is single-connection; serialize transactions.
    const run = async () =>
      this.db.transaction(async (t: any) => {
        const q: Queryable = { query: async (s, p = []) => (await t.query(s, p)).rows };
        return fn(q);
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/* ------------------------------------------------------------ factory */

export interface DbConfig {
  /** postgres://... — when absent, embedded PGlite is used. */
  databaseUrl?: string;
  /** PGlite data dir; ":memory:" or undefined for in-memory */
  pgliteDir?: string;
}

export async function openDatabase(cfg: DbConfig): Promise<Database> {
  if (cfg.databaseUrl) return new PgDatabase(cfg.databaseUrl);
  return PgliteDatabase.open(cfg.pgliteDir && cfg.pgliteDir !== ":memory:" ? cfg.pgliteDir : undefined);
}

/* --------------------------------------------------------- migrations */

const MIGRATION_LOCK = 727_274_001;

export function latestSchemaVersion(): number {
  return migrations.reduce((m, x) => Math.max(m, x.version), 0);
}

export async function currentSchemaVersion(db: Queryable): Promise<number> {
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS t");
  if (!exists[0]?.t) return 0;
  const r = await db.query<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_migrations");
  return Number(r[0]?.v ?? 0);
}

export interface MigrationReport {
  from: number;
  to: number;
  applied: string[];
}

export async function migrate(db: Database): Promise<MigrationReport> {
  if (db.kind === "postgres") await db.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const from = await currentSchemaVersion(db);
    const applied: string[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (m.version <= from) continue;
      await db.tx(async (q) => {
        for (const stmt of splitStatements(m.sql)) await q.query(stmt);
        await q.query("INSERT INTO schema_migrations(version, name) VALUES ($1, $2)", [m.version, m.name]);
      });
      applied.push(`${m.version}:${m.name}`);
    }
    return { from, to: await currentSchemaVersion(db), applied };
  } finally {
    if (db.kind === "postgres") await db.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  }
}

/** Split migration SQL on top-level semicolons (our migrations contain no functions or ';' in strings). */
export function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Upgrade compatibility check (PRD §8.2): refuse to run on a schema newer than this build. */
export async function checkSchemaCompatibility(db: Queryable): Promise<{ ok: boolean; reason?: string; dbVersion: number; appVersion: number }> {
  const dbVersion = await currentSchemaVersion(db);
  const appVersion = latestSchemaVersion();
  if (dbVersion > appVersion) return { ok: false, reason: "database schema is newer than this application build; upgrade the app or restore a backup", dbVersion, appVersion };
  return { ok: true, dbVersion, appVersion };
}

export async function openAndMigrate(cfg: DbConfig): Promise<Database> {
  const db = await openDatabase(cfg);
  const compat = await checkSchemaCompatibility(db);
  if (!compat.ok) {
    await db.close();
    throw new Error(compat.reason);
  }
  await migrate(db);
  return db;
}

/* ----------------------------------------------------------- helpers */

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  return v == null ? "" : String(v);
}

export function isoOrNull(v: unknown): string | null {
  return v == null ? null : iso(v);
}

export function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}

export function parseJson<T>(v: unknown, d: T): T {
  // All JSON columns are JSONB, which both node-postgres and PGlite already decode.
  // A JS string here is a JSONB string scalar and must be returned as-is.
  if (v == null) return d;
  return v as T;
}
