import { and, asc, desc, eq, sql } from "drizzle-orm";
import { generateId, ForwardFillModel, type MetricUnit, type SignalEvent } from "@arf-os/contracts";
import type { Database, DatabaseTransaction } from "@arf-os/db";
import {
  forwardDeployments,
  forwardDrawdownPoints,
  forwardEquityPoints,
  metricSnapshots,
  paperFills,
  paperOrders,
  signalEvents,
} from "@arf-os/db";
import type { ForwardSignalProcessingJob } from "@arf-os/event-bus";
import { calculateCoreMetrics, computeDrawdownCurve, reconstructEquityCurve, METRICS_CALCULATION_VERSION } from "@arf-os/metrics";
import { pairPaperFillsIntoTrades } from "./fill-pairing.js";

export interface ForwardSignalProcessingResult {
  status: "PROCESSED" | "REJECTED" | "ALREADY_PROCESSED";
  reasonCode?: string;
}

/** Mirrors `apps/worker-analytics/src/handlers.ts`'s METRIC_UNITS exactly — same metrics, same units, different scope. */
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

interface OpenPosition {
  orderId: string;
  direction: "LONG" | "SHORT";
  quantity: string;
}

/** Depth ≤ 1 by construction: an ENTRY is rejected while one is open, so at most one ENTRY can ever lack a matching EXIT. */
async function findOpenPosition(tx: DatabaseTransaction, deploymentId: string): Promise<OpenPosition | undefined> {
  const rows = await tx
    .select({
      orderId: paperOrders.id,
      role: paperOrders.role,
      direction: paperOrders.direction,
      quantity: paperOrders.quantity,
    })
    .from(paperFills)
    .innerJoin(paperOrders, eq(paperOrders.id, paperFills.paperOrderId))
    .where(eq(paperFills.deploymentId, deploymentId))
    .orderBy(asc(paperFills.sequenceNumber));

  const entries = rows.filter((r) => r.role === "ENTRY").length;
  const exits = rows.filter((r) => r.role === "EXIT").length;
  if (entries <= exits) return undefined;

  const lastEntry = [...rows].reverse().find((r) => r.role === "ENTRY");
  if (!lastEntry) return undefined;
  return { orderId: lastEntry.orderId, direction: lastEntry.direction as "LONG" | "SHORT", quantity: lastEntry.quantity };
}

async function nextSequenceNumber(tx: DatabaseTransaction, deploymentId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${paperFills.sequenceNumber})` })
    .from(paperFills)
    .where(eq(paperFills.deploymentId, deploymentId));
  return (row?.max ?? 0) + 1;
}

async function resolveCurrentEquity(tx: DatabaseTransaction, deploymentId: string, initialCapital: number): Promise<number> {
  const [latest] = await tx
    .select({ equity: forwardEquityPoints.equity })
    .from(forwardEquityPoints)
    .where(eq(forwardEquityPoints.deploymentId, deploymentId))
    .orderBy(desc(forwardEquityPoints.sequenceNumber))
    .limit(1);
  return latest ? Number(latest.equity) : initialCapital;
}

function resolveQuantity(model: ForwardFillModel["quantityModel"], price: number, currentEquity: number): number {
  switch (model.type) {
    case "percent_of_equity":
      return (currentEquity * (model.percent / 100)) / price;
    case "fixed":
      return model.quantity;
    case "cash":
      return model.cashAmount / price;
  }
}

/**
 * Slippage always moves the fill price against the trader: entering a LONG
 * (or exiting a SHORT) costs more; exiting a LONG (or entering a SHORT)
 * yields less. `fixed_ticks` is treated as an absolute price delta rather
 * than a per-symbol tick size — this repo has no tick-size table for any
 * symbol, so this is an honest, documented scope limit (see ADR 0006), not
 * a hidden approximation.
 */
function applySlippage(price: number, model: ForwardFillModel["slippageModel"], direction: "LONG" | "SHORT", side: "ENTRY" | "EXIT"): number {
  const worseIsHigher = (direction === "LONG" && side === "ENTRY") || (direction === "SHORT" && side === "EXIT");
  const sign = worseIsHigher ? 1 : -1;
  const delta = model.type === "fixed_percent" ? price * (model.value / 100) : model.value;
  return price + sign * delta;
}

function computeFees(price: number, quantity: number, model: ForwardFillModel["commissionModel"]): number {
  return model.type === "percent" ? price * quantity * (model.value / 100) : model.value;
}

async function reject(tx: DatabaseTransaction, signalEventId: string, reasonCode: string): Promise<void> {
  await tx.update(signalEvents).set({ processingStatus: "REJECTED", rejectionReason: reasonCode }).where(eq(signalEvents.id, signalEventId));
}

/**
 * Recomputes the deployment's equity/drawdown/metrics from every fill so
 * far — the same idempotent-recompute idiom `worker-analytics` uses for the
 * backtest chain (delete-then-insert, never patched incrementally).
 */
async function recomputeForwardCurves(tx: DatabaseTransaction, deploymentId: string, initialCapital: number): Promise<void> {
  const rows = await tx
    .select({
      sequenceNumber: paperFills.sequenceNumber,
      role: paperOrders.role,
      direction: paperOrders.direction,
      quantity: paperOrders.quantity,
      filledPrice: paperFills.filledPrice,
      fees: paperFills.fees,
      filledAt: paperFills.filledAt,
    })
    .from(paperFills)
    .innerJoin(paperOrders, eq(paperOrders.id, paperFills.paperOrderId))
    .where(eq(paperFills.deploymentId, deploymentId))
    .orderBy(asc(paperFills.sequenceNumber));

  const trades = pairPaperFillsIntoTrades(
    rows.map((r) => ({
      sequenceNumber: r.sequenceNumber,
      role: r.role as "ENTRY" | "EXIT",
      direction: r.direction as "LONG" | "SHORT",
      quantity: r.quantity,
      filledPrice: r.filledPrice,
      fees: r.fees,
      filledAt: r.filledAt,
    })),
  );

  const curve = reconstructEquityCurve(trades, initialCapital);
  const drawdown = computeDrawdownCurve(curve);
  const metrics = calculateCoreMetrics(trades);

  await tx.delete(forwardEquityPoints).where(eq(forwardEquityPoints.deploymentId, deploymentId));
  await tx.delete(forwardDrawdownPoints).where(eq(forwardDrawdownPoints.deploymentId, deploymentId));
  await tx
    .delete(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.scopeType, "FORWARD_DEPLOYMENT"),
        eq(metricSnapshots.scopeId, deploymentId),
        eq(metricSnapshots.calculationVersion, METRICS_CALCULATION_VERSION),
      ),
    );

  if (curve.length > 0) {
    await tx.insert(forwardEquityPoints).values(
      curve.map((point) => ({
        id: generateId<string>(),
        deploymentId,
        sequenceNumber: point.sequenceNumber,
        barTime: new Date(point.time),
        equity: point.equity,
      })),
    );
  }

  if (drawdown.points.length > 0) {
    await tx.insert(forwardDrawdownPoints).values(
      drawdown.points.map((point) => ({
        id: generateId<string>(),
        deploymentId,
        sequenceNumber: point.sequenceNumber,
        barTime: new Date(point.time),
        drawdown: point.drawdown,
        drawdownPct: String(point.drawdownPct),
      })),
    );
  }

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
  const storable = values.filter((entry): entry is { name: string; value: number } => entry.value !== null);

  if (storable.length > 0) {
    await tx.insert(metricSnapshots).values(
      storable.map((entry) => ({
        id: generateId<string>(),
        metricName: entry.name,
        value: String(entry.value),
        unit: METRIC_UNITS[entry.name] ?? "ratio",
        calculationVersion: METRICS_CALCULATION_VERSION,
        scopeType: "FORWARD_DEPLOYMENT" as const,
        scopeId: deploymentId,
      })),
    );
  }
}

/**
 * Turns one ingested `SignalEvent` into a deterministic paper fill (or a
 * recorded rejection), all inside one transaction — including the
 * deployment-state re-check, so there is no partial-state window between
 * checking `ACTIVE` and writing a fill (CLAUDE.md 3.6, 9.3).
 *
 * Idempotent by construction: `paper_orders.signal_event_id` is UNIQUE, and
 * step 1 below no-ops immediately if this `signal_events` row is no longer
 * `PENDING` — a BullMQ redelivery of the same job never double-fills.
 */
export async function handleForwardSignalProcessing(db: Database, input: ForwardSignalProcessingJob): Promise<ForwardSignalProcessingResult> {
  return db.transaction(async (tx) => {
    const [signal] = await tx.select().from(signalEvents).where(eq(signalEvents.id, input.signalEventId)).limit(1);
    if (!signal) throw new Error(`Signal event ${input.signalEventId} not found.`);

    if (signal.processingStatus !== "PENDING") {
      return { status: signal.processingStatus === "PROCESSED" ? ("ALREADY_PROCESSED" as const) : ("REJECTED" as const) };
    }

    const [deployment] = await tx.select().from(forwardDeployments).where(eq(forwardDeployments.id, input.deploymentId)).limit(1);
    if (!deployment) throw new Error(`Forward deployment ${input.deploymentId} not found.`);

    // Re-checked here, not only at ingestion: a pause can land between the
    // webhook accepting the signal and this job running.
    if (deployment.state !== "ACTIVE") {
      await reject(tx, signal.id, "DEPLOYMENT_NOT_ACTIVE");
      return { status: "REJECTED", reasonCode: "DEPLOYMENT_NOT_ACTIVE" };
    }

    const fillModel = ForwardFillModel.parse(deployment.fillModel);
    const rawPayload = signal.rawPayload as SignalEvent;
    const openPosition = await findOpenPosition(tx, deployment.id);
    const isEntry = signal.eventType === "ENTRY_LONG" || signal.eventType === "ENTRY_SHORT";

    if (isEntry) {
      if (openPosition) {
        await reject(tx, signal.id, "POSITION_ALREADY_OPEN");
        return { status: "REJECTED", reasonCode: "POSITION_ALREADY_OPEN" };
      }

      // Denormalised at ingestion (see forward-signals.ts) — guaranteed
      // non-null for an ENTRY_* event type.
      const direction = signal.direction as "LONG" | "SHORT";
      const currentEquity = await resolveCurrentEquity(tx, deployment.id, Number(deployment.initialCapital));
      const quantity = resolveQuantity(fillModel.quantityModel, rawPayload.price, currentEquity);
      const filledPrice = applySlippage(rawPayload.price, fillModel.slippageModel, direction, "ENTRY");
      const fees = computeFees(filledPrice, quantity, fillModel.commissionModel);

      const orderId = generateId<string>();
      await tx.insert(paperOrders).values({
        id: orderId,
        deploymentId: deployment.id,
        signalEventId: signal.id,
        direction,
        role: "ENTRY",
        requestedPrice: String(rawPayload.price),
        quantity: String(quantity),
      });

      const sequenceNumber = await nextSequenceNumber(tx, deployment.id);
      const filledAt = new Date(new Date(rawPayload.sentAt).getTime() + fillModel.latencyModel.seconds * 1000);
      await tx.insert(paperFills).values({
        id: generateId<string>(),
        paperOrderId: orderId,
        deploymentId: deployment.id,
        sequenceNumber,
        filledPrice: String(filledPrice),
        fees: String(fees),
        filledAt,
      });

      await tx.update(signalEvents).set({ processingStatus: "PROCESSED" }).where(eq(signalEvents.id, signal.id));
      return { status: "PROCESSED" };
    }

    // EXIT_LONG / EXIT_SHORT / STOP_HIT / TARGET_HIT — all close whatever is open.
    if (!openPosition) {
      await reject(tx, signal.id, "NO_OPEN_POSITION");
      return { status: "REJECTED", reasonCode: "NO_OPEN_POSITION" };
    }
    // Only EXIT_LONG/EXIT_SHORT carry a direction on the signal itself
    // (STOP_HIT/TARGET_HIT don't); when present it must match the open
    // position, or this alert belongs to a different position than ARF-OS
    // thinks is open.
    if (signal.direction && signal.direction !== openPosition.direction) {
      await reject(tx, signal.id, "DIRECTION_MISMATCH");
      return { status: "REJECTED", reasonCode: "DIRECTION_MISMATCH" };
    }

    const filledPrice = applySlippage(rawPayload.price, fillModel.slippageModel, openPosition.direction, "EXIT");
    const fees = computeFees(filledPrice, Number(openPosition.quantity), fillModel.commissionModel);

    const orderId = generateId<string>();
    await tx.insert(paperOrders).values({
      id: orderId,
      deploymentId: deployment.id,
      signalEventId: signal.id,
      direction: openPosition.direction,
      role: "EXIT",
      requestedPrice: String(rawPayload.price),
      quantity: openPosition.quantity,
    });

    const sequenceNumber = await nextSequenceNumber(tx, deployment.id);
    const filledAt = new Date(new Date(rawPayload.sentAt).getTime() + fillModel.latencyModel.seconds * 1000);
    await tx.insert(paperFills).values({
      id: generateId<string>(),
      paperOrderId: orderId,
      deploymentId: deployment.id,
      sequenceNumber,
      filledPrice: String(filledPrice),
      fees: String(fees),
      filledAt,
    });

    await tx.update(signalEvents).set({ processingStatus: "PROCESSED" }).where(eq(signalEvents.id, signal.id));

    // Only a closing fill changes the trade ledger, so only a closing fill
    // triggers a recompute.
    await recomputeForwardCurves(tx, deployment.id, Number(deployment.initialCapital));

    return { status: "PROCESSED" };
  });
}
