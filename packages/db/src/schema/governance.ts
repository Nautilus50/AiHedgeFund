import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { strategyVersions } from "./strategy.js";

export const committeeDecisionTypeEnum = pgEnum("committee_decision_type", [
  "REJECT",
  "REWORK_WITH_NEW_VERSION",
  "PAPER_APPROVED",
]);

export const committeeDecisions = pgTable(
  "committee_decisions",
  {
    id: uuid("id").primaryKey(),
    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id, { onDelete: "cascade" }),
    decision: committeeDecisionTypeEnum("decision").notNull(),
    reasonCodes: text("reason_codes").array().notNull(),
    rejectionCase: text("rejection_case").notNull(),
    positiveCase: text("positive_case").notNull(),
    conditions: text("conditions").array().notNull().default([]),
    requiredNextEvidence: text("required_next_evidence").array().notNull().default([]),
    reviewDate: timestamp("review_date", { withTimezone: true }),
    actorId: uuid("actor_id").notNull(),
    humanOverride: boolean("human_override").notNull().default(false),
    overrideReason: text("override_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // listRecentDecisions/loadReportedParityMetrics-style lookups and the
  // Strategy Library read-model refresh all filter by strategy_version_id.
  (table) => [index("committee_decisions_strategy_version_id_idx").on(table.strategyVersionId)],
);

/**
 * Append-only through the application layer (CLAUDE.md 9.4). No update/delete
 * repository method should ever be written against this table.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    organisationId: uuid("organisation_id").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    priorStateSummary: jsonb("prior_state_summary"),
    newStateSummary: jsonb("new_state_summary"),
    reason: text("reason"),
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // listCampaignAuditEvents and any per-aggregate audit lookup filter by
  // (aggregate_type, aggregate_id), then order newest-first.
  (table) => [index("audit_events_aggregate_type_aggregate_id_created_at_idx").on(table.aggregateType, table.aggregateId, table.createdAt)],
);
