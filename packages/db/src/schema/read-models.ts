import { index, integer, pgTable, timestamp, text, uuid } from "drizzle-orm/pg-core";
import { organisations } from "./identity.js";
import { campaigns } from "./campaigns.js";
import { strategies, strategyVersions, workflowStateEnum } from "./strategy.js";
import { committeeDecisionTypeEnum } from "./governance.js";

/**
 * Denormalised Strategy Library projection (spec 14.12). One row per
 * strategy, always recomputed from scratch by `handleReadModelRefresh` —
 * never patched incrementally from an event's own payload — so replaying an
 * event out of order, or one that arrived for an older version after a
 * newer version already transitioned, converges on the same correct row
 * rather than reintroducing stale state. The transactional tables
 * (`strategy_versions`, `committee_decisions`) remain canonical; this table
 * exists only to make the common "state + latest decision per strategy"
 * read fast without a LATERAL join on every request.
 */
export const strategyReadModels = pgTable(
  "strategy_read_models",
  {
    strategyId: uuid("strategy_id")
      .primaryKey()
      .references(() => strategies.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    latestVersionId: uuid("latest_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    latestVersionNumber: integer("latest_version_number").notNull(),
    workflowState: workflowStateEnum("workflow_state").notNull(),
    latestDecision: committeeDecisionTypeEnum("latest_decision"),
    latestDecisionAt: timestamp("latest_decision_at", { withTimezone: true }),
    latestDecisionActorId: uuid("latest_decision_actor_id"),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // listCommitteeQueue's WHERE organisation_id = $1 AND workflow_state = 'PAPER_APPROVAL_REVIEW' [AND campaign_id = $2].
  (table) => [index("strategy_read_models_organisation_id_workflow_state_idx").on(table.organisationId, table.workflowState)],
);
