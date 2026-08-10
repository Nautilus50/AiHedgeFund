import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { generateId, type MetricUnit, type ParityStatus } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  backtestRuns,
  drawdownPoints,
  equityPoints,
  metricSnapshots,
  outboxEvents,
  parityReports,
  reportUploads,
  trades,
} from "@arf-os/db";
import {
  calculateCoreMetrics,
  compareParity,
  computeDrawdownCurve,
  reconstructEquityCurve,
  METRICS_CALCULATION_VERSION,
  type MetricsTrade,
} from "@arf-os/metrics";
import { extractReportedParityMetrics, type PerformanceSummaryMetric } from "@arf-os/pine";

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
): Promise<{ metricCount: number; parityQueued: boolean }> {
  const ledger = await loadTrades(db, input.backtestRunId);
  const metrics = calculateCoreMetrics(ledger);

  // Parity compares against a TradingView verification, so a run with no
  // verification has nothing to compare to. Emitting the event anyway would
  // enqueue a job whose payload cannot satisfy ParityCalculationJob.
  const [run] = await db
    .select({ verificationId: backtestRuns.verificationId })
    .from(backtestRuns)
    .where(eq(backtestRuns.id, input.backtestRunId))
    .limit(1);
  const verificationId = run?.verificationId ?? undefined;

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

    // Written in the same transaction as the snapshots so the event cannot
    // survive a rolled-back write, nor be lost after a committed one
    // (CLAUDE.md 9.3). The relay routes it to the parity queue.
    if (verificationId) {
      const now = new Date();
      await tx.insert(outboxEvents).values({
        id: generateId<string>(),
        eventType: "metrics.calculated",
        eventVersion: "1.0.0",
        aggregateId: input.backtestRunId,
        aggregateVersion: now.getTime().toString(),
        correlationId: generateId<string>(),
        actor: "worker-analytics",
        payload: { backtestRunId: input.backtestRunId, verificationId },
        createdAt: now,
      });
    }
  });

  return { metricCount: storable.length, parityQueued: verificationId !== undefined };
}

/** Marks a run succeeded once its analytics chain has completed. */
export async function markRunAnalysed(db: Database, backtestRunId: string): Promise<void> {
  await db
    .update(backtestRuns)
    .set({ status: "SUCCEEDED", completedAt: new Date() })
    .where(eq(backtestRuns.id, backtestRunId));
}

export interface ParityCalculationResult {
  status: ParityStatus;
  firstDivergence: string | undefined;
}

/**
 * Reads the locally calculated figures parity compares. `net_profit` and
 * `closed_trade_count` come from this run's metric snapshots at the current
 * calculation version; max drawdown is the peak of the reconstructed
 * drawdown curve, which is stored as points rather than a snapshot.
 */
async function loadLocalParityMetrics(
  db: Database,
  backtestRunId: string,
): Promise<{ closedTradeCount: number; netProfit: number; maxDrawdown?: number }> {
  const snapshots = await db
    .select({ metricName: metricSnapshots.metricName, value: metricSnapshots.value })
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.scopeType, "RUN"),
        eq(metricSnapshots.scopeId, backtestRunId),
        eq(metricSnapshots.calculationVersion, METRICS_CALCULATION_VERSION),
        inArray(metricSnapshots.metricName, ["closed_trade_count", "net_profit"]),
      ),
    );

  const byName = new Map(snapshots.map((row) => [row.metricName, Number(row.value)]));
  const closedTradeCount = byName.get("closed_trade_count");
  const netProfit = byName.get("net_profit");

  // The relay only enqueues parity after metrics.calculated, so absence here
  // means the chain ran out of order rather than that the figures are
  // genuinely unknown. Fail loudly instead of comparing against a guess.
  if (closedTradeCount === undefined || netProfit === undefined) {
    throw new Error(
      `Run ${backtestRunId} has no closed_trade_count/net_profit snapshot at calculation version ${METRICS_CALCULATION_VERSION}; metric calculation must run before parity.`,
    );
  }

  const [peak] = await db
    .select({ maxDrawdown: sql<string | null>`max(${drawdownPoints.drawdown})` })
    .from(drawdownPoints)
    .where(eq(drawdownPoints.backtestRunId, backtestRunId));

  const maxDrawdown = peak?.maxDrawdown === null || peak?.maxDrawdown === undefined ? undefined : Number(peak.maxDrawdown);

  return { closedTradeCount, netProfit, ...(maxDrawdown === undefined ? {} : { maxDrawdown }) };
}

/**
 * Reads what TradingView reported for a verification. Uses the most recent
 * successfully parsed Performance Summary: a researcher who re-uploads is
 * correcting the earlier attempt, and the superseded uploads remain on
 * record with their raw artefacts either way.
 */
async function loadReportedParityMetrics(db: Database, verificationId: string) {
  const [upload] = await db
    .select({ parsedMetrics: reportUploads.parsedMetrics })
    .from(reportUploads)
    .where(
      and(
        eq(reportUploads.verificationId, verificationId),
        eq(reportUploads.kind, "PERFORMANCE_SUMMARY"),
        eq(reportUploads.parseStatus, "PARSED"),
      ),
    )
    .orderBy(desc(reportUploads.createdAt))
    .limit(1);

  if (!upload?.parsedMetrics) return {};
  return extractReportedParityMetrics(upload.parsedMetrics as PerformanceSummaryMetric[]);
}

/**
 * Compares this run's independently calculated metrics against the figures
 * TradingView reported, and persists the result (spec 13.4).
 *
 * Idempotent by deletion-then-insert per (run, verification), matching the
 * other analytics handlers: replaying the job replaces the report rather
 * than accumulating duplicates, which matters because `parity_reports` has
 * no unique constraint on that pair.
 *
 * An absent or unparsed report yields INSUFFICIENT_DATA rather than an
 * error — a verification whose summary has not been uploaded yet is an
 * ordinary state, not a failure.
 */
export async function handleParityCalculation(
  db: Database,
  input: { backtestRunId: string; verificationId: string },
): Promise<ParityCalculationResult> {
  const local = await loadLocalParityMetrics(db, input.backtestRunId);
  const reported = await loadReportedParityMetrics(db, input.verificationId);
  const report = compareParity(local, reported);

  await db.transaction(async (tx) => {
    await tx
      .delete(parityReports)
      .where(
        and(
          eq(parityReports.backtestRunId, input.backtestRunId),
          eq(parityReports.verificationId, input.verificationId),
        ),
      );

    await tx.insert(parityReports).values({
      id: generateId<string>(),
      backtestRunId: input.backtestRunId,
      verificationId: input.verificationId,
      status: report.status,
      // Both sides and every field's severity are kept, so an investigator
      // can see what was compared without re-running anything.
      comparison: { local, reported, comparisons: report.comparisons },
      firstDivergence: report.firstDivergence ?? null,
    });
  });

  return { status: report.status, firstDivergence: report.firstDivergence };
}
