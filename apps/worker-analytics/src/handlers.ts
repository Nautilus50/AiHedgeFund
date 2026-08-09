import { and, asc, eq } from "drizzle-orm";
import { generateId, type MetricUnit } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { backtestRuns, drawdownPoints, equityPoints, metricSnapshots, trades } from "@arf-os/db";
import {
  calculateCoreMetrics,
  computeDrawdownCurve,
  reconstructEquityCurve,
  METRICS_CALCULATION_VERSION,
  type MetricsTrade,
} from "@arf-os/metrics";

/** Loads a run's trade ledger in deterministic order and maps it into the metrics package's shape. */
async function loadTrades(db: Database, backtestRunId: string): Promise<MetricsTrade[]> {
  const rows = await db
    .select()
    .from(trades)
    .where(eq(trades.backtestRunId, backtestRunId))
    .orderBy(asc(trades.sequenceNumber));

  return rows.map((row) => ({
    tradeNumber: row.sequenceNumber,
    direction: row.direction,
    entryTime: row.entryTime.toISOString(),
    exitTime: row.exitTime?.toISOString(),
    netPnl: row.netPnl === null ? undefined : Number(row.netPnl),
    isOpen: row.exitTime === null,
  }));
}

export interface EquityReconstructionResult {
  equityPointCount: number;
  maxDrawdown: string;
  maxDrawdownPct: number;
}

/**
 * Rebuilds equity and drawdown curves from the persisted trade ledger.
 * Idempotent by deletion-then-insert: replaying the job for the same run
 * replaces its curves rather than appending duplicates (CLAUDE.md 3.6).
 */
export async function handleEquityReconstruction(
  db: Database,
  input: { backtestRunId: string; initialCapital: string },
): Promise<EquityReconstructionResult> {
  const ledger = await loadTrades(db, input.backtestRunId);
  const curve = reconstructEquityCurve(ledger, input.initialCapital);
  const drawdown = computeDrawdownCurve(curve);

  await db.transaction(async (tx) => {
    await tx.delete(equityPoints).where(eq(equityPoints.backtestRunId, input.backtestRunId));
    await tx.delete(drawdownPoints).where(eq(drawdownPoints.backtestRunId, input.backtestRunId));

    if (curve.length > 0) {
      await tx.insert(equityPoints).values(
        curve.map((point) => ({
          id: generateId<string>(),
          backtestRunId: input.backtestRunId,
          sequenceNumber: point.sequenceNumber,
          barTime: new Date(point.time),
          equity: point.equity,
        })),
      );
    }

    if (drawdown.points.length > 0) {
      await tx.insert(drawdownPoints).values(
        drawdown.points.map((point) => ({
          id: generateId<string>(),
          backtestRunId: input.backtestRunId,
          sequenceNumber: point.sequenceNumber,
          barTime: new Date(point.time),
          drawdown: point.drawdown,
          drawdownPct: String(point.drawdownPct),
        })),
      );
    }
  });

  return {
    equityPointCount: curve.length,
    maxDrawdown: drawdown.maxDrawdown,
    maxDrawdownPct: drawdown.maxDrawdownPct,
  };
}

/** Metric name -> unit, so every stored snapshot carries explicit units (CLAUDE.md 14). */
const METRIC_UNITS: Record<string, MetricUnit> = {
  closed_trade_count: "count",
  winning_trades: "count",
  losing_trades: "count",
  gross_profit: "currency",
  gross_loss: "currency",
  net_profit: "currency",
  profit_factor: "ratio",
  win_rate_pct: "percent",
  avg_win: "currency",
  avg_loss: "currency",
  payoff_ratio: "ratio",
  longest_losing_streak: "count",
  avg_holding_duration_hours: "hours",
};

/**
 * Computes core metrics independently from the trade ledger and stores one
 * snapshot row per metric. Idempotent per (run, calculation version).
 */
export async function handleMetricCalculation(
  db: Database,
  input: { backtestRunId: string },
): Promise<{ metricCount: number }> {
  const ledger = await loadTrades(db, input.backtestRunId);
  const metrics = calculateCoreMetrics(ledger);

  const values: { name: string; value: number | null }[] = [
    { name: "closed_trade_count", value: metrics.closedTradeCount },
    { name: "winning_trades", value: metrics.winningTrades },
    { name: "losing_trades", value: metrics.losingTrades },
    { name: "gross_profit", value: Number(metrics.grossProfit) },
    { name: "gross_loss", value: Number(metrics.grossLoss) },
    { name: "net_profit", value: Number(metrics.netProfit) },
    { name: "profit_factor", value: metrics.profitFactor },
    { name: "win_rate_pct", value: metrics.winRatePct },
    { name: "avg_win", value: Number(metrics.avgWin) },
    { name: "avg_loss", value: Number(metrics.avgLoss) },
    { name: "payoff_ratio", value: metrics.payoffRatio },
    { name: "longest_losing_streak", value: metrics.longestLosingStreak },
    { name: "avg_holding_duration_hours", value: metrics.avgHoldingDurationHours },
  ];

  // A null metric (e.g. profit factor with no losing trades) is genuinely
  // undefined, not zero — store nothing rather than a misleading 0.
  const storable = values.filter((entry): entry is { name: string; value: number } => entry.value !== null);

  await db.transaction(async (tx) => {
    await tx
      .delete(metricSnapshots)
      .where(
        and(
          eq(metricSnapshots.scopeType, "RUN"),
          eq(metricSnapshots.scopeId, input.backtestRunId),
          eq(metricSnapshots.calculationVersion, METRICS_CALCULATION_VERSION),
        ),
      );

    if (storable.length > 0) {
      await tx.insert(metricSnapshots).values(
        storable.map((entry) => ({
          id: generateId<string>(),
          metricName: entry.name,
          value: String(entry.value),
          unit: METRIC_UNITS[entry.name] ?? "ratio",
          calculationVersion: METRICS_CALCULATION_VERSION,
          scopeType: "RUN" as const,
          scopeId: input.backtestRunId,
        })),
      );
    }
  });

  return { metricCount: storable.length };
}

/** Marks a run succeeded once its analytics chain has completed. */
export async function markRunAnalysed(db: Database, backtestRunId: string): Promise<void> {
  await db
    .update(backtestRuns)
    .set({ status: "SUCCEEDED", completedAt: new Date() })
    .where(eq(backtestRuns.id, backtestRunId));
}
