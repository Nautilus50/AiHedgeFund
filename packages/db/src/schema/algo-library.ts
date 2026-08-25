import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organisations } from "./identity.js";
import { strategyVersions } from "./strategy.js";

/**
 * Algo library (ADR 0015). The organisation's own catalogue of finished algos:
 * what came out of the research pipeline, what evidence backs it, and which
 * immutable revision to actually run.
 *
 * No table here stores Pine source. A release points at a strategy_version and
 * the source is read through pine_revisions, so cataloguing an algo can never
 * fork its lineage (CLAUDE.md 3.1).
 */

export const algoStatusEnum = pgEnum("algo_status", ["DRAFT", "PUBLISHED", "RETIRED"]);
export const releaseStatusEnum = pgEnum("release_status", ["DRAFT", "PUBLISHED", "SUPERSEDED"]);
export const statScopeEnum = pgEnum("stat_scope", ["IN_SAMPLE", "OUT_OF_SAMPLE", "FORWARD_PAPER"]);
export const statSourceKindEnum = pgEnum("stat_source_kind", ["BACKTEST_RUN", "FORWARD_DEPLOYMENT"]);
export const marketCategoryEnum = pgEnum("market_category", [
  "CRYPTO",
  "INDEX_FUTURES",
  "FX",
  "COMMODITIES",
  "EQUITIES",
]);

/**
 * A catalogued algo: the stable name for a line of work whose releases point at
 * successive strategy versions.
 */
export const algos = pgTable(
  "algos",
  {
    id: uuid("id").primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline").notNull().default(""),
    description: text("description").notNull().default(""),
    riskNote: text("risk_note").notNull().default(""),
    marketCategory: marketCategoryEnum("market_category").notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    status: algoStatusEnum("status").notNull().default("DRAFT"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // precision: 3 — the library listing orders by created_at and round-trips
    // it through a JS `Date`, same reason as strategies.created_at.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("algos_organisation_id_slug_idx").on(table.organisationId, table.slug),
    // The library query: WHERE organisation_id = $1 [AND status] ORDER BY created_at, id.
    index("algos_organisation_id_status_created_at_id_idx").on(
      table.organisationId,
      table.status,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * One release per immutable strategy version. Revising an algo means adding a
 * release that points at a new strategy version — never editing a shipped one.
 */
export const algoReleases = pgTable(
  "algo_releases",
  {
    id: uuid("id").primaryKey(),
    algoId: uuid("algo_id")
      .notNull()
      .references(() => algos.id, { onDelete: "cascade" }),
    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    releaseNumber: integer("release_number").notNull(),
    status: releaseStatusEnum("status").notNull().default("DRAFT"),
    changelog: text("changelog").notNull().default(""),
    setupInstructions: text("setup_instructions").notNull().default(""),
    /** Copied at publish time for display and tamper-evidence; the source itself stays in pine_revisions. */
    pineSourceHash: text("pine_source_hash").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("algo_releases_algo_id_release_number_idx").on(table.algoId, table.releaseNumber),
    // A strategy version is released once per algo — a retried publish command
    // cannot create a second identical release.
    uniqueIndex("algo_releases_algo_id_strategy_version_id_idx").on(table.algoId, table.strategyVersionId),
    index("algo_releases_algo_id_status_idx").on(table.algoId, table.status),
  ],
);

/**
 * A catalogued performance claim, always traceable to the run that produced it.
 * The library may not display a number that has no row here (ADR 0015).
 */
export const algoStatSnapshots = pgTable(
  "algo_stat_snapshots",
  {
    id: uuid("id").primaryKey(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => algoReleases.id, { onDelete: "cascade" }),
    scope: statScopeEnum("scope").notNull(),
    sourceKind: statSourceKindEnum("source_kind").notNull(),
    /** backtest_runs.id or forward_deployments.id. */
    sourceId: uuid("source_id").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics").notNull(),
    monthlyReturns: jsonb("monthly_returns").notNull().default([]),
    equityCurve: jsonb("equity_curve").notNull().default([]),
    calculationVersion: text("calculation_version").notNull(),
    costsApplied: boolean("costs_applied").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("algo_stat_snapshots_release_id_scope_source_id_idx").on(table.releaseId, table.scope, table.sourceId),
    index("algo_stat_snapshots_release_id_idx").on(table.releaseId),
  ],
);
