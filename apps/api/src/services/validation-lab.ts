import type { S3Client } from "@aws-sdk/client-s3";
import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import {
  computeBenchmarkComparison,
  computeDegradation,
  computeDirectionalBreakdown,
  computeMonteCarloFan,
  computeTradeRemovalConcentration,
  calculateCoreMetrics,
  toSubsetMetrics,
  type BenchmarkComparisonResult,
  type DegradationResult,
  type DirectionalBreakdown,
  type MetricsTrade,
  type MonteCarloFanResult,
  type TradeRemovalConcentration,
} from "@arf-os/metrics";
import type { Database } from "@arf-os/db";
import { backtestRuns, strategies, strategyVersions } from "@arf-os/db";
import type { Bar } from "@arf-os/pine";
import { getTrades } from "./backtest-evidence.js";
import { getBacktestRun } from "./backtest-runs.js";
import { loadDatasetBars } from "./datasets.js";

/**
 * Which segment kinds count as a meaningful in-sample/out-of-sample
 * comparison for a given target run's own kind — the complement within
 * {IN_SAMPLE, VALIDATION, OUT_OF_SAMPLE}. Any other kind (FINAL_HOLDOUT,
 * ROLLING_WALK_FORWARD, ANCHORED_WALK_FORWARD, REGIME) has no defined
 * comparison set here — this slice doesn't attempt walk-forward or regime
 * analysis (ADR 0009), so it yields an empty sibling list, not an error.
 */
function comparisonSegmentKinds(targetSegmentKind: string): string[] {
  if (targetSegmentKind === "IN_SAMPLE") return ["VALIDATION", "OUT_OF_SAMPLE"];
  if (targetSegmentKind === "VALIDATION" || targetSegmentKind === "OUT_OF_SAMPLE") return ["IN_SAMPLE"];
  return [];
}

type TradeRow = NonNullable<Awaited<ReturnType<typeof getTrades>>>[number];

/** Maps a raw `trades` row into the metrics package's shape — same mapping `worker-analytics` uses, duplicated locally rather than shared across apps for one small function. */
function toMetricsTrades(rows: readonly TradeRow[]): MetricsTrade[] {
  return rows.map((row) => ({
    tradeNumber: row.sequenceNumber,
    direction: row.direction,
    entryTime: row.entryTime.toISOString(),
    exitTime: row.exitTime?.toISOString() ?? undefined,
    netPnl: row.netPnl === null ? undefined : Number(row.netPnl),
    isOpen: row.exitTime === null,
  }));
}

export interface SiblingComparison {
  siblingRunId: string;
  segmentKind: string;
  createdAt: string;
  result: DegradationResult;
}

export interface SegmentDistributionRow {
  segmentKind: string;
  status: string;
  total: number;
}

export interface BenchmarkComparisonPanel {
  result: BenchmarkComparisonResult | undefined;
  reasonCode?: "NO_DATASET" | "NO_BARS_IN_WINDOW";
}

/**
 * Picks the buy-and-hold entry/exit prices for a benchmark comparison: the
 * open of the first bar and the close of the last bar whose `time` falls
 * inside `[fromTs, toTs]` — a single frictionless trade spanning the run's
 * own window, not a resampled or interpolated price series. Pure and
 * exported for direct unit testing (no S3/DB needed), separate from
 * {@link loadDatasetBars}'s IO. `bars` need not be pre-sorted; `parseOhlcvCsv`
 * already sorts ascending by time, but this doesn't assume its caller does.
 */
export function resolveBenchmarkComparison(
  bars: readonly Bar[],
  fromTs: Date,
  toTs: Date,
  netProfit: string,
  initialCapital: string,
): BenchmarkComparisonPanel {
  const fromIso = fromTs.toISOString();
  const toIso = toTs.toISOString();
  const inWindow = [...bars].filter((bar) => bar.time >= fromIso && bar.time <= toIso).sort((a, b) => a.time.localeCompare(b.time));

  const firstBar = inWindow[0];
  const lastBar = inWindow[inWindow.length - 1];
  if (!firstBar || !lastBar) {
    return { result: undefined, reasonCode: "NO_BARS_IN_WINDOW" };
  }

  return { result: computeBenchmarkComparison(netProfit, initialCapital, firstBar.open, lastBar.close) };
}

export interface ValidationLabReport {
  computedAt: string;
  targetRunId: string;
  segmentDistribution: SegmentDistributionRow[];
  degradation: SiblingComparison[];
  tradeRemovalConcentration: TradeRemovalConcentration & { topN: number };
  directionalBreakdown: DirectionalBreakdown;
  benchmarkComparison: BenchmarkComparisonPanel;
  /** Undefined for a run with no closed trades yet — a fan needs at least one outcome to resample from. */
  monteCarloFan: MonteCarloFanResult | undefined;
}

/**
 * Every panel here is computed live from data already in Postgres for one
 * strategy version — no new backtest runs, no persisted report (ADR 0009).
 * Reproducibility comes from the response itself: `computedAt` plus every
 * run id actually compared, not from a stored snapshot.
 */
export async function getValidationLabReport(
  db: Database,
  s3: S3Client,
  bucket: string,
  organisationId: string,
  backtestRunId: string,
  options: { topN?: number | undefined } = {},
): Promise<ValidationLabReport | undefined> {
  const target = await getBacktestRun(db, organisationId, backtestRunId);
  if (!target) return undefined;

  const topN = Math.min(Math.max(options.topN ?? 5, 1), 20);

  const targetTradeRows = await getTrades(db, organisationId, backtestRunId);
  const targetTrades = toMetricsTrades(targetTradeRows ?? []);
  const targetSubsetMetrics = toSubsetMetrics(calculateCoreMetrics(targetTrades));

  let benchmarkComparison: BenchmarkComparisonPanel = { result: undefined, reasonCode: "NO_DATASET" };
  if (target.datasetVersionId) {
    const bars = await loadDatasetBars(db, s3, bucket, organisationId, target.datasetVersionId);
    benchmarkComparison = bars
      ? resolveBenchmarkComparison(bars, target.fromTs, target.toTs, targetSubsetMetrics.netProfit, target.initialCapital)
      : { result: undefined, reasonCode: "NO_BARS_IN_WINDOW" };
  }

  const comparisonKinds = comparisonSegmentKinds(target.segmentKind);
  const siblings =
    comparisonKinds.length === 0
      ? []
      : await db
          .select({
            id: backtestRuns.id,
            segmentKind: backtestRuns.segmentKind,
            createdAt: backtestRuns.createdAt,
          })
          .from(backtestRuns)
          .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
          .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
          .where(
            and(
              eq(backtestRuns.strategyVersionId, target.strategyVersionId),
              eq(backtestRuns.symbol, target.symbol),
              eq(backtestRuns.timeframe, target.timeframe),
              eq(backtestRuns.status, "SUCCEEDED"),
              ne(backtestRuns.id, backtestRunId),
              inArray(backtestRuns.segmentKind, comparisonKinds),
              eq(strategies.organisationId, organisationId),
            ),
          )
          .orderBy(desc(backtestRuns.createdAt));

  const degradation: SiblingComparison[] = [];
  for (const sibling of siblings) {
    const siblingTradeRows = await getTrades(db, organisationId, sibling.id);
    const siblingTrades = toMetricsTrades(siblingTradeRows ?? []);
    const siblingSubsetMetrics = toSubsetMetrics(calculateCoreMetrics(siblingTrades));
    degradation.push({
      siblingRunId: sibling.id,
      segmentKind: sibling.segmentKind,
      createdAt: sibling.createdAt.toISOString(),
      result: computeDegradation(targetSubsetMetrics, siblingSubsetMetrics),
    });
  }

  const segmentDistributionRows = await db
    .select({ segmentKind: backtestRuns.segmentKind, status: backtestRuns.status, total: count() })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(backtestRuns.strategyVersionId, target.strategyVersionId), eq(strategies.organisationId, organisationId)))
    .groupBy(backtestRuns.segmentKind, backtestRuns.status);

  return {
    computedAt: new Date().toISOString(),
    targetRunId: backtestRunId,
    segmentDistribution: segmentDistributionRows,
    degradation,
    tradeRemovalConcentration: { ...computeTradeRemovalConcentration(targetTrades), topN },
    directionalBreakdown: computeDirectionalBreakdown(targetTrades),
    benchmarkComparison,
    monteCarloFan: computeMonteCarloFan(targetTrades, target.initialCapital),
  };
}
