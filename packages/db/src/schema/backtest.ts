import { integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { datasetVersions } from "./datasets.js";
import { strategyVersions } from "./strategy.js";
import { tradingviewVerifications } from "./verification.js";

export const backtestRunStatusEnum = pgEnum("backtest_run_status", [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "CANCELLED",
]);

export const backtestRunnerTypeEnum = pgEnum("backtest_runner_type", ["LOCAL_RUNNER", "TRADINGVIEW"]);

export const backtestRuns = pgTable("backtest_runs", {
  id: uuid("id").primaryKey(),
  strategyVersionId: uuid("strategy_version_id")
    .notNull()
    .references(() => strategyVersions.id, { onDelete: "cascade" }),
  runnerType: backtestRunnerTypeEnum("runner_type").notNull(),
  runnerVersion: text("runner_version").notNull(),
  verificationId: uuid("verification_id").references(() => tradingviewVerifications.id),
  // Required only for LOCAL_RUNNER runs (enforced at the API layer, not the
  // DB — a TRADINGVIEW run has no local dataset to point at).
  datasetVersionId: uuid("dataset_version_id").references(() => datasetVersions.id),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  segmentKind: text("segment_kind").notNull(),
  fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
  toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
  costModel: jsonb("cost_model").notNull(),
  initialCapital: numeric("initial_capital", { precision: 20, scale: 8 }).notNull(),
  status: backtestRunStatusEnum("status").notNull().default("QUEUED"),
  sourceHash: text("source_hash").notNull(),
  environmentHash: text("environment_hash"),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // precision: 3 (milliseconds) matches JS Date's resolution. Without it,
  // Postgres keeps microsecond precision, a cursor built from this column's
  // (millisecond-truncated) JS Date value never equals the row's real stored
  // value on re-query, so the `eq` branch of the cursor's OR always misses
  // and the `gt` branch re-includes the boundary row on the next page.
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

export const tradeDirectionEnum = pgEnum("trade_direction", ["LONG", "SHORT"]);

/** Independently reconstructed trade ledger row (never sourced from screenshots — CLAUDE.md 26). */
export const trades = pgTable("trades", {
  id: uuid("id").primaryKey(),
  backtestRunId: uuid("backtest_run_id")
    .notNull()
    .references(() => backtestRuns.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull(),
  direction: tradeDirectionEnum("direction").notNull(),
  entryTime: timestamp("entry_time", { withTimezone: true }).notNull(),
  exitTime: timestamp("exit_time", { withTimezone: true }),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }).notNull(),
  exitPrice: numeric("exit_price", { precision: 20, scale: 8 }),
  quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull(),
  grossPnl: numeric("gross_pnl", { precision: 20, scale: 8 }),
  fees: numeric("fees", { precision: 20, scale: 8 }).notNull().default("0"),
  netPnl: numeric("net_pnl", { precision: 20, scale: 8 }),
  entryReason: text("entry_reason"),
  exitReason: text("exit_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const equityPoints = pgTable("equity_points", {
  id: uuid("id").primaryKey(),
  backtestRunId: uuid("backtest_run_id")
    .notNull()
    .references(() => backtestRuns.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull(),
  barTime: timestamp("bar_time", { withTimezone: true }).notNull(),
  equity: numeric("equity", { precision: 20, scale: 8 }).notNull(),
});

export const drawdownPoints = pgTable("drawdown_points", {
  id: uuid("id").primaryKey(),
  backtestRunId: uuid("backtest_run_id")
    .notNull()
    .references(() => backtestRuns.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull(),
  barTime: timestamp("bar_time", { withTimezone: true }).notNull(),
  drawdown: numeric("drawdown", { precision: 20, scale: 8 }).notNull(),
  drawdownPct: numeric("drawdown_pct", { precision: 10, scale: 6 }).notNull(),
});

export const metricScopeEnum = pgEnum("metric_scope", [
  "RUN",
  "SEGMENT",
  "STRATEGY_VERSION",
  "SYMBOL",
  "PARAMETER_SET",
  "FORWARD_DEPLOYMENT",
  "PORTFOLIO",
]);

export const metricSnapshots = pgTable("metric_snapshots", {
  id: uuid("id").primaryKey(),
  metricName: text("metric_name").notNull(),
  value: numeric("value", { precision: 24, scale: 8 }).notNull(),
  unit: text("unit").notNull(),
  calculationVersion: text("calculation_version").notNull(),
  scopeType: metricScopeEnum("scope_type").notNull(),
  scopeId: uuid("scope_id").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const parityStatusEnum = pgEnum("parity_status", ["PASS", "WARN", "FAIL", "INSUFFICIENT_DATA"]);

export const parityReports = pgTable("parity_reports", {
  id: uuid("id").primaryKey(),
  backtestRunId: uuid("backtest_run_id")
    .notNull()
    .references(() => backtestRuns.id, { onDelete: "cascade" }),
  verificationId: uuid("verification_id")
    .notNull()
    .references(() => tradingviewVerifications.id),
  status: parityStatusEnum("status").notNull(),
  comparison: jsonb("comparison").notNull(),
  firstDivergence: text("first_divergence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
