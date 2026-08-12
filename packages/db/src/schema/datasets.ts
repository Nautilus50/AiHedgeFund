import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { artefacts } from "./artefacts.js";
import { organisations } from "./identity.js";

/**
 * A versioned, checksummed OHLCV bar series backing local-runner backtests
 * (spec 14.4's `dataset_versions`). The bytes live in object storage as an
 * `artefacts` row; this table is the queryable identity a
 * `backtest_runs.dataset_version_id` points at, matching how the local
 * runner records the optional `datasetHash` on a `BacktestRunResult`.
 *
 * There is no upload/ingestion API for this table yet — this slice seeds
 * one golden fixture dataset directly (CLAUDE.md 3.8, avoid building ahead
 * of what's needed).
 */
export const datasetVersions = pgTable("dataset_versions", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
  toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
  barCount: bigint("bar_count", { mode: "number" }).notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  artefactId: uuid("artefact_id")
    .notNull()
    .references(() => artefacts.id),
  // precision: 3 (milliseconds) is deliberate, not decorative: cursor
  // pagination (packages such as this one's listDatasetVersions) round-trips
  // this column through a JS `Date`, which cannot represent Postgres's
  // default microsecond precision. Without capping the column at the same
  // precision the cursor can hold, `gt(createdAt, cursorDate)` is spuriously
  // true for the cursor row's *own* record (its real value has residual
  // microseconds greater than the millisecond-truncated cursor), duplicating
  // it onto the next page. Confirmed via a failing pagination test before
  // this fix.
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});
