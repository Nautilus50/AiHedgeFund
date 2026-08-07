import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations, users } from "./identity.js";
import { campaigns } from "./campaigns.js";

export const workflowStateEnum = pgEnum("workflow_state", [
  "CAMPAIGN_BACKLOG",
  "IDEA_RESEARCH",
  "HYPOTHESIS_DRAFT",
  "PINE_DEVELOPMENT",
  "TRADINGVIEW_VERIFICATION",
  "PAPER_APPROVAL_REVIEW",
  "PAPER_APPROVED",
  "REJECTED",
  "BLOCKED",
]);

/** Conceptual lineage root. Has many immutable StrategyVersions (spec 14.5). */
export const strategies = pgTable("strategies", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Immutable strategy version (CLAUDE.md 3.1). Never mutate a tested row —
 * any material change creates a new version referencing this one as parent.
 */
export const strategyVersions = pgTable("strategy_versions", {
  id: uuid("id").primaryKey(),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  parentVersionId: uuid("parent_version_id"),
  versionNumber: integer("version_number").notNull(),
  workflowState: workflowStateEnum("workflow_state").notNull().default("CAMPAIGN_BACKLOG"),
  definitionHash: text("definition_hash"),
  pineSourceHash: text("pine_source_hash"),
  manifestHash: text("manifest_hash"),
  createdByAgentRunId: uuid("created_by_agent_run_id"),
  changeReason: text("change_reason"),
  contaminatedDatasetIds: jsonb("contaminated_dataset_ids").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Explicit lineage edges, kept separate from parentVersionId for multi-parent/merge queries. */
export const strategyLineage = pgTable("strategy_lineage", {
  id: uuid("id").primaryKey(),
  strategyVersionId: uuid("strategy_version_id")
    .notNull()
    .references(() => strategyVersions.id, { onDelete: "cascade" }),
  parentVersionId: uuid("parent_version_id")
    .notNull()
    .references(() => strategyVersions.id),
  changeCategory: text("change_category").notNull(),
  changedFields: jsonb("changed_fields").notNull(),
  motivatingEvidenceIds: jsonb("motivating_evidence_ids").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable Strategy Definition Language (SDL) document (spec 9). One row per strategy version. */
export const strategyDefinitions = pgTable("strategy_definitions", {
  id: uuid("id").primaryKey(),
  strategyVersionId: uuid("strategy_version_id")
    .notNull()
    .references(() => strategyVersions.id, { onDelete: "cascade" })
    .unique(),
  definition: jsonb("definition").notNull(),
  definitionHash: text("definition_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable Pine Script v6 revision + manifest (CLAUDE.md 12). Never edited in place — new revision instead. */
export const pineRevisions = pgTable("pine_revisions", {
  id: uuid("id").primaryKey(),
  strategyVersionId: uuid("strategy_version_id")
    .notNull()
    .references(() => strategyVersions.id, { onDelete: "cascade" })
    .unique(),
  source: text("source").notNull(),
  sourceHash: text("source_hash").notNull(),
  manifest: jsonb("manifest").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  compileStatus: text("compile_status").notNull().default("PENDING"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
