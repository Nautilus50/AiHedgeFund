import { and, asc, desc, eq, gt } from "drizzle-orm";
import { generateId, type CreateForwardDeploymentInput } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  forwardDeployments,
  forwardDrawdownPoints,
  forwardEquityPoints,
  healthSnapshots,
  paperFills,
  paperOrders,
  signalEvents,
  strategies,
  strategyVersions,
} from "@arf-os/db";
import {
  calculateCoreMetrics,
  computeDegradation,
  pairPaperFillsIntoTrades,
  toSubsetMetrics,
  type DegradationResult,
  type MetricsTrade,
  type SubsetMetrics,
} from "@arf-os/metrics";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";
import { getTrades } from "./backtest-evidence.js";
import { resolveRepresentativeRun } from "./portfolio-research.js";

const MAX_EVIDENCE_ROWS = 5000;
/** Over how many of the most recent signals the health endpoint's rejection rate is computed. */
const HEALTH_SIGNAL_WINDOW = 20;
/** A rejection rate above this fraction of the recent window marks infrastructureHealth DEGRADED. */
const DEGRADED_REJECTION_RATE = 0.5;
/**
 * Below this many closed forward trades, `computeDegradation`'s percentages
 * are dominated by whichever trade happened to close most recently rather
 * than anything resembling drift — `winRatePct` can only land on one of a
 * handful of coarse values (0/20/25/33/50/100) and a single losing trade can
 * read as up to 100% "net profit degradation." A different, independently
 * justified threshold from `MIN_OVERLAP_DAYS` in
 * `packages/metrics/src/portfolio.ts` (that one guards against
 * correlated-shock bias in a correlation; this guards against single-trade
 * dominance in a percentage) — not borrowed from it. See ADR 0012.
 */
const MIN_FORWARD_TRADES_FOR_DRIFT = 5;

export type CreateForwardDeploymentResult =
  | { ok: true; deploymentId: string; token: string }
  | { ok: false; reasonCode: "STRATEGY_VERSION_NOT_FOUND" | "NOT_PAPER_APPROVED"; message: string };

/**
 * Creates a forward-test deployment for an immutable, PAPER_APPROVED
 * strategy version. Goes straight to ACTIVE — this slice has no separate
 * CONFIGURING step (config is fully supplied here) and no reason to require
 * a manual activation click for a paper-only deployment. `PLANNED` remains
 * in `ForwardDeploymentState` for a future review-before-activating step,
 * but this flow never produces it.
 *
 * The plaintext token is generated here and returned exactly once — only
 * its hash is ever persisted (CLAUDE.md 16.1, 19: never log secrets).
 */
export async function createForwardDeployment(
  db: Database,
  organisationId: string,
  createdByUserId: string,
  input: CreateForwardDeploymentInput,
): Promise<CreateForwardDeploymentResult> {
  const [versionRow] = await db
    .select({ workflowState: strategyVersions.workflowState })
    .from(strategyVersions)
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(strategyVersions.id, input.strategyVersionId), eq(strategies.organisationId, organisationId)))
    .limit(1);

  if (!versionRow) {
    return {
      ok: false,
      reasonCode: "STRATEGY_VERSION_NOT_FOUND",
      message: `No strategy version ${input.strategyVersionId}.`,
    };
  }
  if (versionRow.workflowState !== "PAPER_APPROVED") {
    return {
      ok: false,
      reasonCode: "NOT_PAPER_APPROVED",
      message: `Strategy version ${input.strategyVersionId} is ${versionRow.workflowState}, not PAPER_APPROVED.`,
    };
  }

  const deploymentId = generateId<string>();
  const token = generateOpaqueToken();
  const now = new Date();

  await db.insert(forwardDeployments).values({
    id: deploymentId,
    organisationId,
    strategyVersionId: input.strategyVersionId,
    createdByUserId,
    symbol: input.symbol,
    timeframe: input.timeframe,
    initialCapital: String(input.initialCapital),
    fillModel: input.fillModel,
    timestampToleranceSeconds: input.timestampToleranceSeconds,
    maxDrawdownPctAlertThreshold:
      input.maxDrawdownPctAlertThreshold === undefined ? null : String(input.maxDrawdownPctAlertThreshold),
    deploymentTokenHash: hashToken(token),
    state: "ACTIVE",
    activatedAt: now,
  });

  return { ok: true, deploymentId, token };
}

/**
 * Organisation-scoped fetch, plus `newerApprovedVersionExists` — the
 * concrete fact CLAUDE.md 3.4 is protecting against here: the deployment's
 * own strategy version can't itself change (PAPER_APPROVED is a
 * TERMINAL_STATES entry), but a sibling version can quietly supersede it
 * while the deployment keeps running against the older one. Surfaced, not
 * auto-acted-on — a human decides whether to complete this deployment and
 * start a new one against the newer version.
 */
export async function getForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  const [row] = await db
    .select({
      id: forwardDeployments.id,
      organisationId: forwardDeployments.organisationId,
      strategyVersionId: forwardDeployments.strategyVersionId,
      strategyId: strategyVersions.strategyId,
      currentVersionNumber: strategyVersions.versionNumber,
      symbol: forwardDeployments.symbol,
      timeframe: forwardDeployments.timeframe,
      initialCapital: forwardDeployments.initialCapital,
      fillModel: forwardDeployments.fillModel,
      timestampToleranceSeconds: forwardDeployments.timestampToleranceSeconds,
      maxDrawdownPctAlertThreshold: forwardDeployments.maxDrawdownPctAlertThreshold,
      state: forwardDeployments.state,
      createdAt: forwardDeployments.createdAt,
      activatedAt: forwardDeployments.activatedAt,
      pausedAt: forwardDeployments.pausedAt,
      completedAt: forwardDeployments.completedAt,
    })
    .from(forwardDeployments)
    .innerJoin(strategyVersions, eq(strategyVersions.id, forwardDeployments.strategyVersionId))
    .where(and(eq(forwardDeployments.id, deploymentId), eq(forwardDeployments.organisationId, organisationId)))
    .limit(1);

  if (!row) return undefined;

  const [newerVersion] = await db
    .select({ id: strategyVersions.id })
    .from(strategyVersions)
    .where(
      and(
        eq(strategyVersions.strategyId, row.strategyId),
        eq(strategyVersions.workflowState, "PAPER_APPROVED"),
        gt(strategyVersions.versionNumber, row.currentVersionNumber),
      ),
    )
    .limit(1);

  return { ...row, newerApprovedVersionExists: newerVersion !== undefined };
}

/**
 * Every forward deployment of one strategy version, newest first. Exists so a
 * caller choosing a deployment (the Algo Library's evidence picker) can see
 * what a version has actually run, without widening getForwardDeployment.
 */
export async function listForwardDeploymentsForVersion(
  db: Database,
  organisationId: string,
  strategyVersionId: string,
) {
  return db
    .select({
      id: forwardDeployments.id,
      symbol: forwardDeployments.symbol,
      timeframe: forwardDeployments.timeframe,
      state: forwardDeployments.state,
      createdAt: forwardDeployments.createdAt,
      activatedAt: forwardDeployments.activatedAt,
    })
    .from(forwardDeployments)
    .where(
      and(
        eq(forwardDeployments.organisationId, organisationId),
        eq(forwardDeployments.strategyVersionId, strategyVersionId),
      ),
    )
    .orderBy(desc(forwardDeployments.createdAt));
}

export type DeploymentTransitionResult =
  | { ok: true }
  | { ok: false; reasonCode: "NOT_FOUND" | "INVALID_STATE"; message: string };

async function transitionDeploymentState(
  db: Database,
  organisationId: string,
  deploymentId: string,
  from: readonly string[],
  to: "ACTIVE" | "PAUSED" | "COMPLETED",
  timestampColumn: "activatedAt" | "pausedAt" | "completedAt",
): Promise<DeploymentTransitionResult> {
  const [current] = await db
    .select({ state: forwardDeployments.state })
    .from(forwardDeployments)
    .where(and(eq(forwardDeployments.id, deploymentId), eq(forwardDeployments.organisationId, organisationId)))
    .limit(1);

  if (!current) {
    return { ok: false, reasonCode: "NOT_FOUND", message: `No forward deployment ${deploymentId}.` };
  }
  if (!from.includes(current.state)) {
    return {
      ok: false,
      reasonCode: "INVALID_STATE",
      message: `Deployment is ${current.state}; expected one of ${from.join(", ")}.`,
    };
  }

  await db
    .update(forwardDeployments)
    .set({ state: to, [timestampColumn]: new Date() })
    .where(eq(forwardDeployments.id, deploymentId));

  return { ok: true };
}

export function pauseForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  return transitionDeploymentState(db, organisationId, deploymentId, ["ACTIVE"], "PAUSED", "pausedAt");
}

/** Not in the spec's literal endpoint list — a one-way pause would be an operational trap, so this is a deliberate small addition. */
export function resumeForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  return transitionDeploymentState(db, organisationId, deploymentId, ["PAUSED"], "ACTIVE", "activatedAt");
}

export function completeForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  return transitionDeploymentState(db, organisationId, deploymentId, ["ACTIVE", "PAUSED"], "COMPLETED", "completedAt");
}

export interface ForwardDeploymentHealth {
  deploymentState: string;
  infrastructureHealth: "HEALTHY" | "DEGRADED";
  infrastructureReasons: string[];
  strategyPerformanceHealth: "OK" | "DRAWDOWN_ALERT" | "NOT_CONFIGURED";
}

/**
 * Pure comparison logic, split out of `getForwardDeploymentHealth` so the
 * live `/health` route and `sweepHealthSnapshots` (below) can never silently
 * drift apart on the `DEGRADED_REJECTION_RATE` threshold.
 */
export function classifyInfrastructureHealth(
  recentSignals: readonly { processingStatus: string; rejectionReason: string | null }[],
): { health: "HEALTHY" | "DEGRADED"; reasons: string[]; rejectionRate: number } {
  const rejected = recentSignals.filter((s) => s.processingStatus === "REJECTED");
  const rejectionRate = recentSignals.length > 0 ? rejected.length / recentSignals.length : 0;
  const health: "HEALTHY" | "DEGRADED" = rejectionRate > DEGRADED_REJECTION_RATE ? "DEGRADED" : "HEALTHY";
  const reasons =
    health === "DEGRADED" ? Array.from(new Set(rejected.map((s) => s.rejectionReason).filter((r): r is string => r !== null))) : [];
  return { health, reasons, rejectionRate };
}

/** Same split-out-for-reuse reasoning as `classifyInfrastructureHealth`. */
export function classifyStrategyPerformanceHealth(
  currentDrawdownPct: number | null,
  thresholdPct: number | null,
): "OK" | "DRAWDOWN_ALERT" | "NOT_CONFIGURED" {
  if (thresholdPct === null) return "NOT_CONFIGURED";
  return (currentDrawdownPct ?? 0) >= thresholdPct ? "DRAWDOWN_ALERT" : "OK";
}

/**
 * Two independent axes, per CLAUDE.md 16.3 ("infrastructure degradation
 * must be tracked separately from strategy performance"). Computed live on
 * every read. CLAUDE.md 17.4 names forward-deployment health as an SSE use
 * case; polling this endpoint is a deliberate deviation for this first
 * slice, documented in ADR 0006. `health_snapshots` (ADR 0012) now persists
 * a periodic history alongside this live read — see `sweepHealthSnapshots`.
 */
export async function getForwardDeploymentHealth(
  db: Database,
  organisationId: string,
  deploymentId: string,
): Promise<ForwardDeploymentHealth | undefined> {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  const recentSignals = await db
    .select({ processingStatus: signalEvents.processingStatus, rejectionReason: signalEvents.rejectionReason })
    .from(signalEvents)
    .where(eq(signalEvents.deploymentId, deploymentId))
    .orderBy(desc(signalEvents.receivedAt))
    .limit(HEALTH_SIGNAL_WINDOW);

  const infrastructure = classifyInfrastructureHealth(recentSignals);

  const [latestDrawdown] = await db
    .select({ drawdownPct: forwardDrawdownPoints.drawdownPct })
    .from(forwardDrawdownPoints)
    .where(eq(forwardDrawdownPoints.deploymentId, deploymentId))
    .orderBy(desc(forwardDrawdownPoints.sequenceNumber))
    .limit(1);

  const strategyPerformanceHealth = classifyStrategyPerformanceHealth(
    latestDrawdown ? Number(latestDrawdown.drawdownPct) : null,
    deployment.maxDrawdownPctAlertThreshold === null ? null : Number(deployment.maxDrawdownPctAlertThreshold),
  );

  return {
    deploymentState: deployment.state,
    infrastructureHealth: infrastructure.health,
    infrastructureReasons: infrastructure.reasons,
    strategyPerformanceHealth,
  };
}

/**
 * Computes and persists one `health_snapshots` row per `ACTIVE` deployment
 * in `organisationId`, for `sweep-health-snapshots.ts` (ADR 0012) — the
 * operator/external-scheduler-invoked pattern this repo already chose once
 * for `reap-abandoned-uploads.ts`, not a new in-process scheduler.
 *
 * Idempotent by construction (CLAUDE.md 3.6): `tickAt` is one shared value
 * for the whole sweep run, and a `(deploymentId, tickAt)` pair that already
 * exists is skipped rather than re-inserted, so re-running the same tick
 * after a partial failure is a safe no-op — the check-then-write convention
 * already used everywhere else in this repo (no `ON CONFLICT` exists here).
 */
export async function sweepHealthSnapshots(
  db: Database,
  organisationId: string,
  tickAt: Date,
  dryRun: boolean,
): Promise<{ deploymentId: string; skippedExisting: boolean }[]> {
  const activeDeployments = await db
    .select({ id: forwardDeployments.id, maxDrawdownPctAlertThreshold: forwardDeployments.maxDrawdownPctAlertThreshold })
    .from(forwardDeployments)
    .where(and(eq(forwardDeployments.organisationId, organisationId), eq(forwardDeployments.state, "ACTIVE")));

  const results: { deploymentId: string; skippedExisting: boolean }[] = [];

  for (const deployment of activeDeployments) {
    const [existing] = await db
      .select({ id: healthSnapshots.id })
      .from(healthSnapshots)
      .where(and(eq(healthSnapshots.deploymentId, deployment.id), eq(healthSnapshots.tickAt, tickAt)))
      .limit(1);

    if (existing) {
      results.push({ deploymentId: deployment.id, skippedExisting: true });
      continue;
    }

    results.push({ deploymentId: deployment.id, skippedExisting: false });
    if (dryRun) continue;

    const recentSignals = await db
      .select({ processingStatus: signalEvents.processingStatus, rejectionReason: signalEvents.rejectionReason })
      .from(signalEvents)
      .where(eq(signalEvents.deploymentId, deployment.id))
      .orderBy(desc(signalEvents.receivedAt))
      .limit(HEALTH_SIGNAL_WINDOW);
    const infrastructure = classifyInfrastructureHealth(recentSignals);

    const [latestDrawdown] = await db
      .select({ drawdownPct: forwardDrawdownPoints.drawdownPct })
      .from(forwardDrawdownPoints)
      .where(eq(forwardDrawdownPoints.deploymentId, deployment.id))
      .orderBy(desc(forwardDrawdownPoints.sequenceNumber))
      .limit(1);
    const currentDrawdownPct = latestDrawdown ? Number(latestDrawdown.drawdownPct) : null;
    const thresholdPct = deployment.maxDrawdownPctAlertThreshold === null ? null : Number(deployment.maxDrawdownPctAlertThreshold);

    await db.insert(healthSnapshots).values({
      id: generateId<string>(),
      deploymentId: deployment.id,
      tickAt,
      infrastructureHealth: infrastructure.health,
      infrastructureReasons: infrastructure.reasons,
      rejectionRate: String(infrastructure.rejectionRate),
      strategyPerformanceHealth: classifyStrategyPerformanceHealth(currentDrawdownPct, thresholdPct),
      currentDrawdownPct: currentDrawdownPct === null ? null : String(currentDrawdownPct),
      maxDrawdownPctAlertThresholdAtSnapshot: thresholdPct === null ? null : String(thresholdPct),
    });
  }

  return results;
}

/** Org-scoped history read for the "Health history" panel — newest first, capped like every other evidence read in this file. */
export async function getHealthSnapshots(db: Database, organisationId: string, deploymentId: string) {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  return db
    .select()
    .from(healthSnapshots)
    .where(eq(healthSnapshots.deploymentId, deploymentId))
    .orderBy(desc(healthSnapshots.tickAt))
    .limit(200);
}

export async function getForwardEquityCurve(db: Database, organisationId: string, deploymentId: string) {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  return db
    .select()
    .from(forwardEquityPoints)
    .where(eq(forwardEquityPoints.deploymentId, deploymentId))
    .orderBy(forwardEquityPoints.sequenceNumber)
    .limit(MAX_EVIDENCE_ROWS);
}

export async function getForwardDrawdownCurve(db: Database, organisationId: string, deploymentId: string) {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  return db
    .select()
    .from(forwardDrawdownPoints)
    .where(eq(forwardDrawdownPoints.deploymentId, deploymentId))
    .orderBy(forwardDrawdownPoints.sequenceNumber)
    .limit(MAX_EVIDENCE_ROWS);
}

/** Raw signal events, newest first — the event timeline spec 15.9 calls for (signal received/rejected). */
export async function getForwardSignalEvents(db: Database, organisationId: string, deploymentId: string) {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  return db
    .select({
      id: signalEvents.id,
      eventType: signalEvents.eventType,
      direction: signalEvents.direction,
      processingStatus: signalEvents.processingStatus,
      rejectionReason: signalEvents.rejectionReason,
      receivedAt: signalEvents.receivedAt,
    })
    .from(signalEvents)
    .where(eq(signalEvents.deploymentId, deploymentId))
    .orderBy(desc(signalEvents.receivedAt))
    .limit(MAX_EVIDENCE_ROWS);
}

type BaselineTradeRow = NonNullable<Awaited<ReturnType<typeof getTrades>>>[number];

/** Same mapping validation-lab.ts has locally for backtest trade rows — duplicated per that file's own stated convention rather than shared across one small function. */
function toMetricsTrades(rows: readonly BaselineTradeRow[]): MetricsTrade[] {
  return rows.map((row) => ({
    tradeNumber: row.sequenceNumber,
    direction: row.direction,
    entryTime: row.entryTime.toISOString(),
    exitTime: row.exitTime?.toISOString() ?? undefined,
    netPnl: row.netPnl === null ? undefined : Number(row.netPnl),
    isOpen: row.exitTime === null,
  }));
}

const DRIFT_METHODOLOGY_NOTE =
  "This is the same relative net-profit/profit-factor/win-rate comparison Validation Lab already uses for backtest-vs-backtest degradation, applied across the backtest-vs-forward boundary — not a statistical drift test. No p-value, no distribution or regime comparison, no live market-data price tracking. Below 5 closed forward trades, no comparison is shown: a single trade can swing the percentages by up to 100%, which would look precise while meaning nothing. The baseline is one representative backtest run for this deployment's strategy version (preferring out-of-sample evidence, most recent within that tier) — not every historical run, since a single-number comparison needs exactly one thing to compare against.";

export type ForwardDriftReport =
  | { methodologyNote: string; baseline: undefined; reasonCode: "NO_BASELINE_RUN" }
  | {
      methodologyNote: string;
      baseline: { backtestRunId: string; segmentKind: string };
      reasonCode: "INSUFFICIENT_FORWARD_TRADES";
      closedForwardTradeCount: number;
    }
  | {
      methodologyNote: string;
      baseline: { backtestRunId: string; segmentKind: string };
      result: DegradationResult;
      closedForwardTradeCount: number;
    };;

/**
 * Compares a forward deployment's live-computed metrics against its
 * originating strategy version's best available backtest evidence (ADR
 * 0012) — reusing `computeDegradation` unmodified, the same function
 * Validation Lab (ADR 0009) already uses for backtest-vs-backtest
 * comparisons. Both sides are computed live from raw trade/fill rows, never
 * read from the write-only `metric_snapshots` rows `recomputeForwardCurves`
 * writes — matching Validation Lab's own convention of always recomputing
 * rather than trusting a stored snapshot.
 */
export async function getForwardDriftReport(
  db: Database,
  organisationId: string,
  deploymentId: string,
): Promise<ForwardDriftReport | undefined> {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  // Safe to call with no org check inside resolveRepresentativeRun itself
  // because deployment.strategyVersionId came from getForwardDeployment's
  // own organisation-scoped join, above.
  const representativeRun = await resolveRepresentativeRun(db, deployment.strategyVersionId);
  if (!representativeRun) {
    return { methodologyNote: DRIFT_METHODOLOGY_NOTE, baseline: undefined, reasonCode: "NO_BASELINE_RUN" };
  }
  const baseline = { backtestRunId: representativeRun.backtestRunId, segmentKind: representativeRun.segmentKind };

  const fillRows = await db
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

  const forwardTrades = pairPaperFillsIntoTrades(
    fillRows.map((r) => ({
      sequenceNumber: r.sequenceNumber,
      role: r.role as "ENTRY" | "EXIT",
      direction: r.direction as "LONG" | "SHORT",
      quantity: r.quantity,
      filledPrice: r.filledPrice,
      fees: r.fees,
      filledAt: r.filledAt,
    })),
  );
  const closedForwardTradeCount = forwardTrades.filter((t) => !t.isOpen).length;

  if (closedForwardTradeCount < MIN_FORWARD_TRADES_FOR_DRIFT) {
    return { methodologyNote: DRIFT_METHODOLOGY_NOTE, baseline, reasonCode: "INSUFFICIENT_FORWARD_TRADES", closedForwardTradeCount };
  }

  const baselineTradeRows = await getTrades(db, organisationId, representativeRun.backtestRunId);
  const baselineSubsetMetrics: SubsetMetrics = toSubsetMetrics(calculateCoreMetrics(toMetricsTrades(baselineTradeRows ?? [])));
  const forwardSubsetMetrics: SubsetMetrics = toSubsetMetrics(calculateCoreMetrics(forwardTrades));

  return {
    methodologyNote: DRIFT_METHODOLOGY_NOTE,
    baseline,
    result: computeDegradation(baselineSubsetMetrics, forwardSubsetMetrics),
    closedForwardTradeCount,
  };
}
