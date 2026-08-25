import { z } from "zod";

/**
 * Algo library contracts (ADR 0015). Version 1.
 *
 * A private, organisation-scoped catalogue of finished algos. An entry never
 * carries Pine source of its own: a release points at an immutable
 * `strategy_version`, and the source is always read through that version, so
 * cataloguing an algo can never fork its lineage (CLAUDE.md 3.1).
 */
export const ALGO_LIBRARY_CONTRACT_VERSION = 1;

export const AlgoStatus = z.enum(["DRAFT", "PUBLISHED", "RETIRED"]);
export type AlgoStatus = z.infer<typeof AlgoStatus>;

export const ReleaseStatus = z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED"]);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

/**
 * Evidence scope of a catalogued number. Never merged into a single series in
 * the UI (CLAUDE.md 18.1) — an in-sample curve and a forward paper curve are
 * different claims about the world.
 */
export const StatScope = z.enum(["IN_SAMPLE", "OUT_OF_SAMPLE", "FORWARD_PAPER"]);
export type StatScope = z.infer<typeof StatScope>;

export const StatSourceKind = z.enum(["BACKTEST_RUN", "FORWARD_DEPLOYMENT"]);
export type StatSourceKind = z.infer<typeof StatSourceKind>;

export const MarketCategory = z.enum(["CRYPTO", "INDEX_FUTURES", "FX", "COMMODITIES", "EQUITIES"]);
export type MarketCategory = z.infer<typeof MarketCategory>;

/** Metric block for one catalogued snapshot. Percentages are whole percent (`12.5` = 12.5%). */
export const AlgoMetrics = z.object({
  netProfitPct: z.number(),
  maxDrawdownPct: z.number(),
  profitFactor: z.number().nullable(),
  winRatePct: z.number().min(0).max(100).nullable(),
  tradeCount: z.number().int().nonnegative(),
  sharpe: z.number().nullable(),
  averageTradePct: z.number().nullable(),
});
export type AlgoMetrics = z.infer<typeof AlgoMetrics>;

export const MonthlyReturn = z.object({
  /** Calendar month in UTC, `YYYY-MM`. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  returnPct: z.number(),
});
export type MonthlyReturn = z.infer<typeof MonthlyReturn>;

export const StatSnapshot = z.object({
  snapshotId: z.string().uuid(),
  scope: StatScope,
  sourceKind: StatSourceKind,
  sourceId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  metrics: AlgoMetrics,
  monthlyReturns: z.array(MonthlyReturn),
  equityCurve: z.array(z.object({ at: z.string().datetime(), equity: z.number() })),
  calculationVersion: z.string().min(1),
  /** Net of the modelled costs recorded on the source run — never a gross number presented as net. */
  costsApplied: z.boolean(),
});
export type StatSnapshot = z.infer<typeof StatSnapshot>;

export const AlgoSummary = z.object({
  contractVersion: z.literal(ALGO_LIBRARY_CONTRACT_VERSION),
  algoId: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  tagline: z.string().max(240),
  marketCategory: MarketCategory,
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  status: AlgoStatus,
  publishedAt: z.string().datetime().nullable(),
  /** Present only when a snapshot row exists. The list shows nothing rather than a placeholder. */
  headline: z
    .object({
      scope: StatScope,
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
      netProfitPct: z.number(),
      maxDrawdownPct: z.number(),
      profitFactor: z.number().nullable(),
      tradeCount: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AlgoSummary = z.infer<typeof AlgoSummary>;

export const AlgoDetail = AlgoSummary.extend({
  description: z.string(),
  riskNote: z.string(),
  currentRelease: z
    .object({
      releaseId: z.string().uuid(),
      releaseNumber: z.number().int().positive(),
      strategyVersionId: z.string().uuid(),
      publishedAt: z.string().datetime().nullable(),
      changelog: z.string(),
      pineSourceHash: z.string().min(1),
    })
    .nullable(),
  snapshots: z.array(StatSnapshot),
});
export type AlgoDetail = z.infer<typeof AlgoDetail>;

/** What a release hands back when you go to run it. */
export const AlgoDelivery = z.object({
  contractVersion: z.literal(ALGO_LIBRARY_CONTRACT_VERSION),
  algoId: z.string().uuid(),
  releaseId: z.string().uuid(),
  releaseNumber: z.number().int().positive(),
  name: z.string(),
  pineSource: z.string().min(1),
  pineSourceHash: z.string().min(1),
  changelog: z.string(),
  setupInstructions: z.string(),
});
export type AlgoDelivery = z.infer<typeof AlgoDelivery>;
