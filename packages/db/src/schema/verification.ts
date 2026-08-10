import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { strategyVersions } from "./strategy.js";
import { artefacts } from "./artefacts.js";

export const verificationStatusEnum = pgEnum("verification_status", [
  "PENDING",
  "UPLOADED",
  "PARSED",
  "PASSED",
  "FAILED",
  "INVESTIGATION_REQUIRED",
]);

/** MVP TradingView verification workflow (spec 13.2) — human-assisted, not automated. */
export const tradingviewVerifications = pgTable("tradingview_verifications", {
  id: uuid("id").primaryKey(),
  strategyVersionId: uuid("strategy_version_id")
    .notNull()
    .references(() => strategyVersions.id, { onDelete: "cascade" }),
  status: verificationStatusEnum("status").notNull().default("PENDING"),
  requiredSymbol: text("required_symbol").notNull(),
  requiredTimeframe: text("required_timeframe").notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const reportUploadKindEnum = pgEnum("report_upload_kind", [
  "PERFORMANCE_SUMMARY",
  "LIST_OF_TRADES",
]);

/** Raw TradingView export, preserved by checksum before any parsing (CLAUDE.md 15.1). */
export const reportUploads = pgTable("report_uploads", {
  id: uuid("id").primaryKey(),
  verificationId: uuid("verification_id")
    .notNull()
    .references(() => tradingviewVerifications.id, { onDelete: "cascade" }),
  kind: reportUploadKindEnum("kind").notNull(),
  rawArtefactId: uuid("raw_artefact_id")
    .notNull()
    .references(() => artefacts.id),
  parseStatus: text("parse_status").notNull().default("PENDING"),
  parserVersion: text("parser_version"),
  parseWarnings: text("parse_warnings").array().notNull().default([]),
  /**
   * What the report itself reported, exactly as parsed: metric titles with
   * values keyed by their source column headers, never reinterpreted
   * (CLAUDE.md 15.2). Deliberately not in `metric_snapshots` — TradingView's
   * numbers stay structurally separate from independently calculated ones,
   * attached to the upload they came from. Null when the parse failed.
   */
  parsedMetrics: jsonb("parsed_metrics"),
  uploadedByUserId: uuid("uploaded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
