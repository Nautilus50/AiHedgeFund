import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import { createDatabase, type Database } from "./client.js";
import { prompts } from "./schema/agent-runtime.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://arf:arf@localhost:5432/arf_os_test";

/** Resolves from both `src/` and the built `dist/`, which are siblings of `drizzle/`. */
const JOURNAL_PATH = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/meta/_journal.json");

/**
 * The `when` of the newest migration on disk. Drizzle's migrator stores that
 * same value in `drizzle.__drizzle_migrations.created_at`, so the two are
 * directly comparable.
 */
function latestMigrationOnDisk(): number | undefined {
  try {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as { entries?: { when: number }[] };
    const whens = (journal.entries ?? []).map((entry) => entry.when);
    return whens.length > 0 ? Math.max(...whens) : undefined;
  } catch {
    return undefined;
  }
}

async function latestMigrationApplied(db: Database): Promise<number | undefined> {
  // Returns undefined when the bookkeeping table does not exist, i.e. the
  // database has never been migrated at all.
  const result = await db.execute<{ latest: string | null }>(
    sql`SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`,
  );
  const rows = result as unknown as { latest: string | null }[];
  const latest = rows[0]?.latest;
  return latest === null || latest === undefined ? undefined : Number(latest);
}

/**
 * True when a test Postgres is reachable **and** its schema is current.
 *
 * Reachability alone is not enough. A database left over from an earlier
 * checkout answers `SELECT 1` perfectly well and then fails deep inside a
 * test with a raw `column ... does not exist`, which reads like a code bug
 * rather than a missing migration. Suites skip on a stale schema instead,
 * after printing the command that fixes it — a skip you were told about
 * beats a failure you have to diagnose.
 */
export async function isTestDatabaseAvailable(): Promise<boolean> {
  let db: Database | undefined;
  try {
    db = createDatabase(TEST_DATABASE_URL);
    await db.execute(sql`SELECT 1`);

    const expected = latestMigrationOnDisk();
    if (expected === undefined) return true; // No journal to compare against.

    const applied = await latestMigrationApplied(db).catch(() => undefined);
    if (applied !== undefined && applied >= expected) return true;

    console.warn(
      [
        "",
        "  Integration suites skipped: the test database schema is out of date.",
        `    database: ${TEST_DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@")}`,
        `    newest migration on disk:    ${expected}`,
        `    newest migration applied:    ${applied ?? "none"}`,
        "",
        "  Apply migrations, then re-run:",
        `    DATABASE_URL=${TEST_DATABASE_URL} pnpm db:migrate`,
        "",
      ].join("\n"),
    );
    return false;
  } catch {
    return false;
  } finally {
    if (db) await closeDatabase(db).catch(() => undefined);
  }
}

export function createTestDatabase(): Database {
  return createDatabase(TEST_DATABASE_URL);
}

/** postgres-js keeps the pool open; tests must close it or vitest hangs on exit. */
export async function closeDatabase(db: Database): Promise<void> {
  // The driver handle is not part of Drizzle's public surface, so reach for
  // it defensively rather than asserting a shape the version might change.
  const session = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
  await session?.end?.();
}

/**
 * Every table, ordered so TRUNCATE ... CASCADE has a deterministic starting
 * point. Called between tests so each one starts from a known-empty state
 * instead of inheriting whatever the previous test left behind.
 */
const TABLES = [
  "algo_stat_snapshots",
  "algo_releases",
  "algos",
  "sse_tickets",
  "practice_runs",
  "benchmark_tasks",
  "agent_run_diagnostics",
  // Deliberately NOT truncated: prompts are real, migration-seeded records
  // (CLAUDE.md 11.2), not per-test fixtures — a worker with no APPROVED
  // row for a role hard-fails in every environment, this DB included.
  "outbox_events",
  "idempotency_records",
  "audit_events",
  "committee_decisions",
  "strategy_read_models",
  "paper_fills",
  "paper_orders",
  "signal_events",
  "forward_drawdown_points",
  "forward_equity_points",
  "forward_deployments",
  "parity_reports",
  "metric_snapshots",
  "drawdown_points",
  "equity_points",
  "trades",
  "backtest_runs",
  "dataset_versions",
  "report_uploads",
  "tradingview_verifications",
  "artefacts",
  "pine_revisions",
  "strategy_definitions",
  "strategy_lineage",
  "strategy_versions",
  "strategies",
  "research_tasks",
  "campaigns",
  "memberships",
  "users",
  "organisations",
] as const;

/**
 * Content distinct from the real migration-seeded prompts (deliberately —
 * this is test-only re-seed data, not a duplicate of production content)
 * for every role `AGENT_RUNTIME_REGISTRY` currently wires. Re-inserted
 * after every truncate because `prompts.approved_by REFERENCES users(id)`
 * means `TRUNCATE users ... CASCADE` cascades into `prompts` too, even
 * though `prompts` isn't itself in {@link TABLES} — a worker calling
 * `loadApprovedPrompt` needs an APPROVED row to exist for every test, not
 * just whatever the last real migration happened to seed.
 */
const TEST_PROMPT_ROLES = ["IDEA_SCOUT", "INDICATOR_RESEARCHER"] as const;

export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));

  await db.insert(prompts).values(
    TEST_PROMPT_ROLES.map((role) => ({
      id: generateId<string>(),
      role,
      semanticVersion: "1.0.0",
      content: `Test-only prompt content for ${role}.`,
      contentHash: `test-${role.toLowerCase()}`,
      status: "APPROVED" as const,
      approvedAt: new Date(),
    })),
  );
}
