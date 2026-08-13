import { integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations, users } from "./identity.js";
import { strategyVersions } from "./strategy.js";

export const forwardDeploymentStateEnum = pgEnum("forward_deployment_state", [
  "PLANNED",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/**
 * One paper-testing deployment of an immutable, PAPER_APPROVED strategy
 * version (CLAUDE.md 16.2). `deploymentTokenHash` is the sha256 of a
 * high-entropy token generated at creation (CLAUDE.md 16.1) — only the hash
 * is ever persisted; the plaintext is returned once in the create response
 * and never logged. `fillModel` is `ForwardFillModel` from
 * `@arf-os/contracts`, validated at the API boundary before it reaches this
 * table — never edited after creation (CLAUDE.md 16.2: "do not edit a
 * running deployment's model, create a new deployment").
 */
export const forwardDeployments = pgTable("forward_deployments", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  strategyVersionId: uuid("strategy_version_id")
    .notNull()
    .references(() => strategyVersions.id),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  initialCapital: numeric("initial_capital", { precision: 20, scale: 8 }).notNull(),
  fillModel: jsonb("fill_model").notNull(),
  timestampToleranceSeconds: integer("timestamp_tolerance_seconds").notNull(),
  maxDrawdownPctAlertThreshold: numeric("max_drawdown_pct_alert_threshold", { precision: 5, scale: 2 }),
  deploymentTokenHash: text("deployment_token_hash").notNull().unique(),
  state: forwardDeploymentStateEnum("state").notNull().default("PLANNED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const signalProcessingStatusEnum = pgEnum("signal_processing_status", ["PENDING", "PROCESSED", "REJECTED"]);

/**
 * Raw TradingView alert payloads, preserved before any interpretation
 * (CLAUDE.md 16.1: "store the raw safe payload"). `idempotencyKey` is
 * `signalIdempotencyKey(payload, payload.eventId)` from
 * `@arf-os/contracts` — unique per deployment, so a retried webhook
 * delivery (accepted or rejected) never creates a second row.
 * `eventType`/`direction` are denormalised out of `rawPayload` at
 * ingestion so the processing worker never needs to re-parse it.
 */
export const signalEvents = pgTable("signal_events", {
  id: uuid("id").primaryKey(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => forwardDeployments.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  eventType: text("event_type").notNull(),
  direction: text("direction"),
  rawPayload: jsonb("raw_payload").notNull(),
  processingStatus: signalProcessingStatusEnum("processing_status").notNull().default("PENDING"),
  rejectionReason: text("rejection_reason"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paperOrderRoleEnum = pgEnum("paper_order_role", ["ENTRY", "EXIT"]);

/**
 * The processing worker's idempotency guard is `signalEventId` being
 * UNIQUE: a BullMQ redelivery of the same job checks for an existing order
 * by that id before writing anything (CLAUDE.md 3.6), matching how
 * `packages/workflow`'s `applyTransition` checks its idempotency key before
 * writing.
 */
export const paperOrders = pgTable("paper_orders", {
  id: uuid("id").primaryKey(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => forwardDeployments.id, { onDelete: "cascade" }),
  signalEventId: uuid("signal_event_id")
    .notNull()
    .unique()
    .references(() => signalEvents.id),
  direction: text("direction").notNull(),
  role: paperOrderRoleEnum("role").notNull(),
  requestedPrice: numeric("requested_price", { precision: 20, scale: 8 }).notNull(),
  quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paperFills = pgTable("paper_fills", {
  id: uuid("id").primaryKey(),
  paperOrderId: uuid("paper_order_id")
    .notNull()
    .unique()
    .references(() => paperOrders.id, { onDelete: "cascade" }),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => forwardDeployments.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull(),
  filledPrice: numeric("filled_price", { precision: 20, scale: 8 }).notNull(),
  fees: numeric("fees", { precision: 20, scale: 8 }).notNull().default("0"),
  filledAt: timestamp("filled_at", { withTimezone: true }).notNull(),
});

/** Exact mirror of `equity_points`, FK'd to a forward deployment instead of a backtest run — kept structurally separate so historical and forward equity are never one uninterrupted series (spec 15.1, CLAUDE.md 18.1). */
export const forwardEquityPoints = pgTable("forward_equity_points", {
  id: uuid("id").primaryKey(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => forwardDeployments.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull(),
  barTime: timestamp("bar_time", { withTimezone: true }).notNull(),
  equity: numeric("equity", { precision: 20, scale: 8 }).notNull(),
});

/** Exact mirror of `drawdown_points`, FK'd to a forward deployment. */
export const forwardDrawdownPoints = pgTable("forward_drawdown_points", {
  id: uuid("id").primaryKey(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => forwardDeployments.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull(),
  barTime: timestamp("bar_time", { withTimezone: true }).notNull(),
  drawdown: numeric("drawdown", { precision: 20, scale: 8 }).notNull(),
  drawdownPct: numeric("drawdown_pct", { precision: 10, scale: 6 }).notNull(),
});
