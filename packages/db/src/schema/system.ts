import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations, users } from "./identity.js";

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
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    eventType: text("event_type").notNull(),
    eventVersion: text("event_version").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: text("aggregate_version").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    actor: text("actor").notNull(),
    // Not present when this table was first created — every domain event
    // originates from an organisation-scoped write, but nothing needed to
    // filter the outbox by tenant until SSE streams needed to scope and
    // resume by (organisation, id). Backfilled for pre-existing rows in
    // migration 0010.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    payload: jsonb("payload").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [index("outbox_events_organisation_id_id_idx").on(table.organisationId, table.id)],
);

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

/**
 * Short-lived, single-use bridge between a normal Bearer-authenticated
 * request and an SSE connection (CLAUDE.md 17.4): browser `EventSource`
 * cannot set an `Authorization` header, so a client exchanges its Clerk
 * token for a ticket, then opens the stream with the ticket in the URL
 * path. `usedAt` is set atomically with the validity check
 * (`claimSseTicket`), not as a separate step, so two requests racing the
 * same ticket can never both succeed (see ADR 0007).
 */
export const sseTickets = pgTable("sse_tickets", {
  id: uuid("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
