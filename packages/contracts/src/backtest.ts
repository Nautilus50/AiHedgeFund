import { z } from "zod";

/** Declares which SDL parameters are optimisable and their bounded search range (spec 9.2, 12.4). */
export const ParameterManifest = z.object({
  strategyVersionId: z.string().uuid(),
  parameters: z.array(
    z.object({
      key: z.string().min(1),
      value: z.union([z.number(), z.boolean(), z.string()]),
      optimisable: z.boolean(),
    }),
  ),
});
export type ParameterManifest = z.infer<typeof ParameterManifest>;

export const BacktestSegmentKind = z.enum([
  "IN_SAMPLE",
  "VALIDATION",
  "OUT_OF_SAMPLE",
  "FINAL_HOLDOUT",
  "ROLLING_WALK_FORWARD",
  "ANCHORED_WALK_FORWARD",
  "REGIME",
]);
export type BacktestSegmentKind = z.infer<typeof BacktestSegmentKind>;

/** A reproducible backtest plan (spec 7.6, CLAUDE_CODE_BUILD_PROMPT.md). */
export const BacktestPlan = z.object({
  strategyVersionId: z.string().uuid(),
  runnerType: z.enum(["LOCAL_RUNNER", "TRADINGVIEW"]),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  segmentKind: BacktestSegmentKind,
  fromTs: z.string().datetime(),
  toTs: z.string().datetime(),
  costModel: z.object({
    commissionType: z.enum(["percent", "cash_per_order", "cash_per_contract"]),
    commissionValue: z.number().min(0),
    slippageTicks: z.number().int().min(0),
  }),
  initialCapital: z.number().positive(),
});
export type BacktestPlan = z.infer<typeof BacktestPlan>;

export const BacktestRunStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "CANCELLED",
]);
export type BacktestRunStatus = z.infer<typeof BacktestRunStatus>;

/** Result of a single backtest run, independent of source (local runner or TradingView ingestion). */
export const BacktestRunResult = z.object({
  id: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  plan: BacktestPlan,
  status: BacktestRunStatus,
  runnerName: z.string().min(1),
  runnerVersion: z.string().min(1),
  sourceHash: z.string().min(1),
  datasetHash: z.string().min(1).optional(),
  environmentHash: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  errorCode: z.string().optional(),
  warnings: z.array(z.string()),
});
export type BacktestRunResult = z.infer<typeof BacktestRunResult>;
