import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDatabase>;

/**
 * The `tx` a `Database.transaction(async (tx) => ...)` callback receives.
 * Structurally close enough to `Database` (same query builder methods, and
 * Drizzle's postgres-js driver lets a transaction open its own nested
 * `.transaction()` as a savepoint) that most repository code can accept
 * either without caring which one it got.
 */
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Either the top-level client or an already-open transaction. A repository
 * typed against this can be constructed around a caller's open transaction
 * so its writes join that transaction (calling `.transaction()` on an
 * already-open one opens a savepoint, not a new independent transaction),
 * making it possible to compose two otherwise-separate units of work into
 * one atomic commit (CLAUDE.md 9.3) without the repository needing to know
 * it's being composed.
 */
export type DatabaseClient = Database | DatabaseTransaction;

/**
 * Creates a Drizzle client bound to the given connection string. Callers
 * inject this rather than importing a shared singleton, so tests and
 * workers can each own their own pool (CLAUDE.md 21.2).
 */
export function createDatabase(connectionString: string) {
  const sql = postgres(connectionString, { max: 10 });
  return drizzle(sql, { schema });
}
