import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * PUBLISHING is the claimed-but-not-yet-confirmed state. Without it, a
 * relay's `FOR UPDATE SKIP LOCKED` claim would release the moment its
 * statement commits, letting a second relay re-claim and double-publish the
 * same rows while the first is still mid-flight.
 */
export const outboxStatusEnum = pgEnum("outbox_status", ["PENDING", "PUBLISHING", "PUBLISHED", "FAILED"]);

/**
 * Transactional outbox (CLAUDE.md 9.3 / spec 14.9): domain events are
 * written in the same transaction as the state change, then published by a
 * separate relay, so events survive a crash between commit and publish.
 */
export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey(),
  eventType: text("event_type").notNull(),
  eventVersion: text("event_version").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  aggregateVersion: text("aggregate_version").notNull(),
  correlationId: uuid("correlation_id").notNull(),
  causationId: uuid("causation_id"),
  actor: text("actor").notNull(),
  payload: jsonb("payload").notNull(),
  status: outboxStatusEnum("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

/**
 * Backs `Idempotency-Key` command handling (spec 14.11 / CLAUDE.md 3.6).
 * A retried request with the same key and a different body is rejected.
 */
export const idempotencyRecords = pgTable("idempotency_records", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  organisationId: uuid("organisation_id").notNull(),
  requestHash: text("request_hash").notNull(),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
