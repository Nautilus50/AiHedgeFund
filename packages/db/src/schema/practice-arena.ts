import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations, users } from "./identity.js";
import { prompts } from "./agent-runtime.js";

export const benchmarkVisibilityEnum = pgEnum("benchmark_visibility", ["VISIBLE", "HIDDEN"]);

/**
 * A blind practice task for one agent role (CLAUDE.md §10.1 — "production
 * work is not the training set", spec §15.13). `HIDDEN` has exactly one
 * enforcement point: `listBenchmarkTasks` excludes it unless the caller
 * created it — not a defined-but-unenforced flag.
 */
export const benchmarkTasks = pgTable("benchmark_tasks", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  objective: text("objective").notNull(),
  visibility: benchmarkVisibilityEnum("visibility").notNull().default("VISIBLE"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const practiceRunStatusEnum = pgEnum("practice_run_status", ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED_TERMINAL"]);

/**
 * One run of a benchmark task against one specific `prompts` row — DRAFT or
 * APPROVED, deliberately not resolved automatically the way the real
 * research path resolves "the APPROVED prompt" (`loadApprovedPrompt` in
 * apps/worker-research). `output` mirrors `research_tasks.output`'s exact
 * shape; the raw provider output is never persisted here at all — there is
 * nothing protected to store for synthetic practice content, so this
 * deliberately has no `agent_run_diagnostics`-style sibling table.
 *
 * `schemaValid`/`costUsd`/`latencyMs` are recorded for future comparability
 * once a real model provider exists — the dev fixture provider is
 * deterministic and always schema-valid, so today these carry no signal.
 * `humanReviewScore` is the only real score this slice (ADR 0010).
 */
export const practiceRuns = pgTable(
  "practice_runs",
  {
    id: uuid("id").primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    benchmarkTaskId: uuid("benchmark_task_id")
      .notNull()
      .references(() => benchmarkTasks.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id),
    role: text("role").notNull(),
    status: practiceRunStatusEnum("status").notNull().default("QUEUED"),
    output: jsonb("output"),
    schemaValid: boolean("schema_valid"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
    humanReviewScore: numeric("human_review_score", { precision: 3, scale: 2 }),
    humanReviewedByUserId: uuid("human_reviewed_by_user_id").references(() => users.id),
    humanReviewedAt: timestamp("human_reviewed_at", { withTimezone: true }),
    humanReviewNotes: text("human_review_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("practice_runs_benchmark_task_id_idx").on(table.benchmarkTaskId)],
);
