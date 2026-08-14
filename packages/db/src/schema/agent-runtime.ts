import { sql } from "drizzle-orm";
import { index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { researchTasks } from "./campaigns.js";

export const promptStatusEnum = pgEnum("prompt_status", ["DRAFT", "APPROVED", "DEPRECATED"]);

/**
 * Versioned prompt records (CLAUDE.md 11.2). `role` is plain text, matching
 * `research_tasks.role`'s existing convention rather than introducing a
 * second, inconsistent representation of the same `AgentRole` domain.
 *
 * The partial unique index is what makes "load the APPROVED row for this
 * role" well-defined: at most one APPROVED row can exist per role at a
 * time, so there's no ambiguity for a worker to resolve at runtime.
 * `benchmarkScore` is nullable and unpopulated this slice — nothing in the
 * repo computes it yet (see ADR 0008).
 */
export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey(),
    role: text("role").notNull(),
    semanticVersion: text("semantic_version").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    status: promptStatusEnum("status").notNull().default("DRAFT"),
    benchmarkScore: numeric("benchmark_score", { precision: 5, scale: 4 }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("prompts_approved_role_idx").on(table.role).where(sql`${table.status} = 'APPROVED'`)],
);

/**
 * Protected diagnostics storage (CLAUDE.md 11.3 steps 7-8): the full raw
 * provider output, kept out of `research_tasks.output` (which only ever
 * holds the safe, schema-validated summary). Write-only this slice — no
 * read endpoint exists yet; ADR 0008 resolves who would be allowed to read
 * it (a protected-data-tier role check plus an audit_events row on every
 * read, CLAUDE.md 3.5) without building that endpoint.
 */
export const agentRunDiagnostics = pgTable(
  "agent_run_diagnostics",
  {
    id: uuid("id").primaryKey(),
    researchTaskId: uuid("research_task_id")
      .notNull()
      .unique()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    rawProviderOutput: jsonb("raw_provider_output").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_run_diagnostics_research_task_id_idx").on(table.researchTaskId)],
);
