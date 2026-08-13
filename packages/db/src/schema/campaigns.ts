import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations, users } from "./identity.js";

export const campaignStatusEnum = pgEnum("campaign_status", [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "CANCELLED",
  "COMPLETED",
]);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  brief: text("brief").notNull(),
  allowedMarkets: jsonb("allowed_markets").notNull(),
  status: campaignStatusEnum("status").notNull().default("DRAFT"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  // precision: 3 (milliseconds) is deliberate, not decorative: listCampaigns'
  // cursor pagination round-trips this column through a JS `Date`, which
  // cannot represent Postgres's default microsecond precision. Without
  // capping the column at the same precision the cursor can hold,
  // `gt(createdAt, cursorDate)` is spuriously true for the cursor row's own
  // record, duplicating it onto the next page (same bug/fix as
  // dataset_versions.created_at in datasets.ts).
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const researchTaskStatusEnum = pgEnum("research_task_status", [
  "QUEUED",
  "RUNNING",
  "WAITING_EXTERNAL",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "CANCELLED",
]);

export const researchTasks = pgTable("research_tasks", {
  id: uuid("id").primaryKey(),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  status: researchTaskStatusEnum("status").notNull().default("QUEUED"),
  strategyId: uuid("strategy_id"),
  strategyVersionId: uuid("strategy_version_id"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  retryCount: text("retry_count").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
