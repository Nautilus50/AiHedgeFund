import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "./client.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://arf:arf@localhost:5432/arf_os_test";

/**
 * True when a test Postgres is reachable. Integration suites use this to
 * skip rather than fail on machines without Docker running, so `pnpm test`
 * stays green everywhere while `pnpm test:integration` does the real work.
 */
export async function isTestDatabaseAvailable(): Promise<boolean> {
  try {
    const db = createDatabase(TEST_DATABASE_URL);
    await db.execute(sql`SELECT 1`);
    await closeDatabase(db);
    return true;
  } catch {
    return false;
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
  "outbox_events",
  "idempotency_records",
  "audit_events",
  "committee_decisions",
  "parity_reports",
  "metric_snapshots",
  "drawdown_points",
  "equity_points",
  "trades",
  "backtest_runs",
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

export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}
