import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Creates a Drizzle client bound to the given connection string. Callers
 * inject this rather than importing a shared singleton, so tests and
 * workers can each own their own pool (CLAUDE.md 21.2).
 */
export function createDatabase(connectionString: string) {
  const sql = postgres(connectionString, { max: 10 });
  return drizzle(sql, { schema });
}
