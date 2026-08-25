import { and, asc, desc, eq, max } from "drizzle-orm";
import { generateId, AlgoMetrics } from "@arf-os/contracts";
import type { MarketCategory, StatScope } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  algoReleases,
  algoStatSnapshots,
  algos,
  auditEvents,
  backtestRuns,
  forwardDeployments,
  paperFills,
  paperOrders,
  pineRevisions,
  strategyVersions,
  trades,
} from "@arf-os/db";
import {
  calculateCoreMetrics,
  computeDrawdownCurve,
  pairPaperFillsIntoTrades,
  reconstructEquityCurve,
  METRICS_CALCULATION_VERSION,
} from "@arf-os/metrics";
import type { MetricsTrade } from "@arf-os/metrics";

/**
 * Publishing into the library (ADR 0015). The rule this file exists to enforce:
 * an algo reaches the library only by way of an immutable strategy version that
 * has already survived the research gates, and every catalogued number is
 * recomputed here from the stored ledger rather than copied from a report.
 */

export type PublishFailure = { ok: false; reasonCode: string; message: string };

export interface CreateAlgoInput {
  organisationId: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  riskNote: string;
  marketCategory: MarketCategory;
  symbol: string;
  timeframe: string;
}

export async function createAlgo(
  db: Database,
  input: CreateAlgoInput,
): Promise<{ ok: true; algoId: string } | PublishFailure> {
  const [existing] = await db
    .select({ id: algos.id })
    .from(algos)
    .where(and(eq(algos.organisationId, input.organisationId), eq(algos.slug, input.slug)))
    .limit(1);

  if (existing) {
    return { ok: false, reasonCode: "SLUG_TAKEN", message: `Slug "${input.slug}" already exists in this library.` };
  }

  const algoId = generateId();
  await db.insert(algos).values({
    id: algoId,
    organisationId: input.organisationId,
    slug: input.slug,
    name: input.name,
    tagline: input.tagline,
    description: input.description,
    riskNote: input.riskNote,
    marketCategory: input.marketCategory,
    symbol: input.symbol,
    timeframe: input.timeframe,
    status: "DRAFT",
  });

  return { ok: true, algoId };
}

export interface PublishReleaseInput {
  algoId: string;
  organisationId: string;
  strategyVersionId: string;
  changelog: string;
  setupInstructions: string;
  actorUserId: string;
  traceId?: string;
}

/**
 * The promotion gate. A strategy version may back a library release only once
 * it reached PAPER_APPROVED — the state that requires a committee decision the
 * strategy's own author could not make (CLAUDE.md 3.4). Cataloguing an algo is
 * not a way around the research gates.
 */
export async function publishRelease(
  db: Database,
  input: PublishReleaseInput,
): Promise<{ ok: true; releaseId: string; releaseNumber: number } | PublishFailure> {
  const [algo] = await db
    .select({ id: algos.id })
    .from(algos)
    .where(and(eq(algos.id, input.algoId), eq(algos.organisationId, input.organisationId)))
    .limit(1);

  if (!algo) {
    return { ok: false, reasonCode: "ALGO_NOT_FOUND", message: "No such algo." };
  }

  const [version] = await db
    .select({ id: strategyVersions.id, workflowState: strategyVersions.workflowState })
    .from(strategyVersions)
    .where(eq(strategyVersions.id, input.strategyVersionId))
    .limit(1);

  if (!version) {
    return { ok: false, reasonCode: "STRATEGY_VERSION_NOT_FOUND", message: "No such strategy version." };
  }

  if (version.workflowState !== "PAPER_APPROVED") {
    return {
      ok: false,
      reasonCode: "NOT_PAPER_APPROVED",
      message: `A release requires a PAPER_APPROVED strategy version (this one is ${version.workflowState}).`,
    };
  }

  const [revision] = await db
    .select({ sourceHash: pineRevisions.sourceHash })
    .from(pineRevisions)
    .where(eq(pineRevisions.strategyVersionId, input.strategyVersionId))
    .limit(1);

  if (!revision) {
    return { ok: false, reasonCode: "NO_PINE_REVISION", message: "That strategy version has no Pine revision." };
  }

  const [existingForVersion] = await db
    .select({ id: algoReleases.id, releaseNumber: algoReleases.releaseNumber })
    .from(algoReleases)
    .where(and(eq(algoReleases.algoId, input.algoId), eq(algoReleases.strategyVersionId, input.strategyVersionId)))
    .limit(1);

  if (existingForVersion) {
    // Idempotent: re-releasing the same version returns the release that
    // already represents it rather than minting a duplicate.
    return { ok: true, releaseId: existingForVersion.id, releaseNumber: existingForVersion.releaseNumber };
  }

  const [{ highest } = { highest: null }] = await db
    .select({ highest: max(algoReleases.releaseNumber) })
    .from(algoReleases)
    .where(eq(algoReleases.algoId, input.algoId));

  const releaseNumber = (highest ?? 0) + 1;
  const releaseId = generateId();

  await db.transaction(async (tx) => {
    // Everything previously published becomes SUPERSEDED in the same
    // transaction, so there is never a moment with two "current" releases.
    await tx
      .update(algoReleases)
      .set({ status: "SUPERSEDED" })
      .where(and(eq(algoReleases.algoId, input.algoId), eq(algoReleases.status, "PUBLISHED")));

    await tx.insert(algoReleases).values({
      id: releaseId,
      algoId: input.algoId,
      strategyVersionId: input.strategyVersionId,
      releaseNumber,
      status: "PUBLISHED",
      changelog: input.changelog,
      setupInstructions: input.setupInstructions,
      pineSourceHash: revision.sourceHash,
      publishedAt: new Date(),
    });

    await tx.insert(auditEvents).values({
      id: generateId(),
      organisationId: input.organisationId,
      actor: `user:${input.actorUserId}`,
      action: "ALGO_RELEASE_PUBLISHED",
      aggregateType: "algo",
      aggregateId: input.algoId,
      priorStateSummary: { latestReleaseNumber: highest ?? 0 },
      newStateSummary: {
        releaseNumber,
        strategyVersionId: input.strategyVersionId,
        pineSourceHash: revision.sourceHash,
      },
      reason: input.changelog || "Release published.",
      traceId: input.traceId ?? null,
    });
  });

  return { ok: true, releaseId, releaseNumber };
}

/**
 * Where a snapshot's numbers come from. Scope travels *inside* the source
 * rather than beside it, so a backtest can never be labelled FORWARD_PAPER and
 * a forward deployment can never be labelled as a backtest — the mislabelling
 * is unrepresentable rather than merely validated against.
 */
export type EvidenceSourceInput =
  | { kind: "BACKTEST_RUN"; backtestRunId: string; scope: "IN_SAMPLE" | "OUT_OF_SAMPLE" }
  | { kind: "FORWARD_DEPLOYMENT"; forwardDeploymentId: string };

export interface PublishStatsInput {
  releaseId: string;
  organisationId: string;
  source: EvidenceSourceInput;
  actorUserId: string;
  traceId?: string;
}

/** A resolved ledger, ready to be turned into a snapshot. */
interface ResolvedEvidence {
  sourceKind: "BACKTEST_RUN" | "FORWARD_DEPLOYMENT";
  sourceId: string;
  scope: StatScope;
  trades: MetricsTrade[];
  initialCapital: string;
  periodStart: Date;
  periodEnd: Date;
}

/** A forward deployment must have actually run. PLANNED has no fills; FAILED and CANCELLED are not results. */
const PUBLISHABLE_DEPLOYMENT_STATES = new Set(["ACTIVE", "PAUSED", "COMPLETED"]);

async function resolveBacktestEvidence(
  db: Database,
  source: Extract<EvidenceSourceInput, { kind: "BACKTEST_RUN" }>,
  releaseStrategyVersionId: string,
): Promise<ResolvedEvidence | PublishFailure> {
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, source.backtestRunId)).limit(1);

  if (!run) {
    return { ok: false, reasonCode: "RUN_NOT_FOUND", message: "No such backtest run." };
  }

  if (run.strategyVersionId !== releaseStrategyVersionId) {
    return {
      ok: false,
      reasonCode: "RUN_VERSION_MISMATCH",
      message: "That run belongs to a different strategy version than this release.",
    };
  }

  if (run.status !== "SUCCEEDED") {
    return { ok: false, reasonCode: "RUN_NOT_SUCCEEDED", message: `Run status is ${run.status}.` };
  }

  const tradeRows = await db
    .select()
    .from(trades)
    .where(eq(trades.backtestRunId, source.backtestRunId))
    .orderBy(asc(trades.sequenceNumber));

  return {
    sourceKind: "BACKTEST_RUN",
    sourceId: source.backtestRunId,
    scope: source.scope,
    trades: tradeRows.map((row) => ({
      tradeNumber: row.sequenceNumber,
      direction: row.direction,
      entryTime: row.entryTime.toISOString(),
      exitTime: row.exitTime?.toISOString(),
      netPnl: row.netPnl === null ? undefined : Number(row.netPnl),
      isOpen: row.exitTime === null,
    })),
    initialCapital: run.initialCapital,
    // The run's own window, not the span of its trades: a run that traded for
    // one week of a six-month window tested six months.
    periodStart: run.fromTs,
    periodEnd: run.toTs,
  };
}

async function resolveForwardEvidence(
  db: Database,
  source: Extract<EvidenceSourceInput, { kind: "FORWARD_DEPLOYMENT" }>,
  organisationId: string,
  releaseStrategyVersionId: string,
): Promise<ResolvedEvidence | PublishFailure> {
  const [deployment] = await db
    .select({
      id: forwardDeployments.id,
      strategyVersionId: forwardDeployments.strategyVersionId,
      initialCapital: forwardDeployments.initialCapital,
      state: forwardDeployments.state,
      activatedAt: forwardDeployments.activatedAt,
      createdAt: forwardDeployments.createdAt,
    })
    .from(forwardDeployments)
    // Ownership is part of the lookup, as everywhere else in this domain.
    .where(
      and(eq(forwardDeployments.id, source.forwardDeploymentId), eq(forwardDeployments.organisationId, organisationId)),
    )
    .limit(1);

  if (!deployment) {
    return { ok: false, reasonCode: "DEPLOYMENT_NOT_FOUND", message: "No such forward deployment." };
  }

  if (deployment.strategyVersionId !== releaseStrategyVersionId) {
    return {
      ok: false,
      reasonCode: "DEPLOYMENT_VERSION_MISMATCH",
      message: "That deployment runs a different strategy version than this release.",
    };
  }

  if (!PUBLISHABLE_DEPLOYMENT_STATES.has(deployment.state)) {
    return {
      ok: false,
      reasonCode: "DEPLOYMENT_NOT_PUBLISHABLE",
      message: `A ${deployment.state} deployment has no result to publish.`,
    };
  }

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
    .where(eq(paperFills.deploymentId, source.forwardDeploymentId))
    .orderBy(asc(paperFills.sequenceNumber));

  // Same pairing the drift report and the forward worker use — paper fills
  // become the same MetricsTrade shape a backtest ledger does, so both kinds
  // of evidence go through one metric implementation.
  const forwardTrades = pairPaperFillsIntoTrades(
    fillRows.map((row) => ({
      sequenceNumber: row.sequenceNumber,
      role: row.role as "ENTRY" | "EXIT",
      direction: row.direction as "LONG" | "SHORT",
      quantity: row.quantity,
      filledPrice: row.filledPrice,
      fees: row.fees,
      filledAt: row.filledAt,
    })),
  );

  // A deployment has no declared window the way a backtest run does, so the
  // period is what it actually traded: activation (or creation) to the last
  // fill. An ACTIVE deployment's snapshot is therefore explicitly a
  // point-in-time claim, not a running total.
  const lastFilledAt = fillRows.at(-1)?.filledAt;

  return {
    sourceKind: "FORWARD_DEPLOYMENT",
    sourceId: source.forwardDeploymentId,
    scope: "FORWARD_PAPER",
    trades: forwardTrades,
    initialCapital: deployment.initialCapital,
    periodStart: deployment.activatedAt ?? deployment.createdAt,
    periodEnd: lastFilledAt ?? deployment.activatedAt ?? deployment.createdAt,
  };
}

/**
 * Builds a catalogued snapshot by recomputing metrics from the stored ledger —
 * a backtest run's trades, or a forward deployment's paper fills paired into
 * trades (CLAUDE.md 14 — independent calculation). Nothing here reads a
 * runner-reported summary, so a library number cannot be better than the trades
 * that produced it.
 */
export async function publishStatSnapshot(
  db: Database,
  input: PublishStatsInput,
): Promise<{ ok: true; snapshotId: string } | PublishFailure> {
  const [release] = await db
    .select({
      id: algoReleases.id,
      algoId: algoReleases.algoId,
      strategyVersionId: algoReleases.strategyVersionId,
    })
    .from(algoReleases)
    .innerJoin(algos, eq(algos.id, algoReleases.algoId))
    .where(and(eq(algoReleases.id, input.releaseId), eq(algos.organisationId, input.organisationId)))
    .limit(1);

  if (!release) {
    return { ok: false, reasonCode: "RELEASE_NOT_FOUND", message: "No such release." };
  }

  const resolved =
    input.source.kind === "BACKTEST_RUN"
      ? await resolveBacktestEvidence(db, input.source, release.strategyVersionId)
      : await resolveForwardEvidence(db, input.source, input.organisationId, release.strategyVersionId);

  if ("ok" in resolved) return resolved;

  const core = calculateCoreMetrics(resolved.trades);

  if (core.closedTradeCount === 0) {
    // An open position is not a result. Metrics computed from no closed trade
    // would be a row of zeroes presented as a track record.
    return { ok: false, reasonCode: "NO_CLOSED_TRADES", message: "There are no closed trades to publish." };
  }

  // The catalogued curve is reconstructed from the ledger, not read from the
  // stored equity points a runner or the paper engine produced — same rule as
  // everywhere else in packages/metrics: the trades are the evidence.
  const initialCapital = Number(resolved.initialCapital);
  const equityCurve = reconstructEquityCurve(resolved.trades, resolved.initialCapital);
  const drawdown = computeDrawdownCurve(equityCurve);
  const netProfit = Number(core.netProfit);

  const metrics = AlgoMetrics.parse({
    netProfitPct: initialCapital === 0 ? 0 : (netProfit / initialCapital) * 100,
    maxDrawdownPct: Number(drawdown.maxDrawdownPct),
    profitFactor: core.profitFactor,
    winRatePct: core.winRatePct,
    tradeCount: core.closedTradeCount,
    sharpe: null,
    averageTradePct: initialCapital === 0 ? null : (netProfit / core.closedTradeCount / initialCapital) * 100,
  });

  const monthlyReturns = core.monthlyReturns.map((entry) => ({
    month: entry.month,
    returnPct: initialCapital === 0 ? 0 : (Number(entry.netProfit) / initialCapital) * 100,
  }));

  const snapshotId = generateId();

  await db
    .insert(algoStatSnapshots)
    .values({
      id: snapshotId,
      releaseId: input.releaseId,
      scope: resolved.scope,
      sourceKind: resolved.sourceKind,
      sourceId: resolved.sourceId,
      periodStart: resolved.periodStart,
      periodEnd: resolved.periodEnd,
      metrics,
      monthlyReturns,
      equityCurve: equityCurve.map((point) => ({ at: point.time, equity: Number(point.equity) })),
      calculationVersion: METRICS_CALCULATION_VERSION,
      // Costs are inside the stored net P&L on both paths: a run's cost model
      // for a backtest, the deployment's fill model fees for a forward test.
      // Every catalogued number is net — never gross dressed up as net.
      costsApplied: true,
    })
    .onConflictDoUpdate({
      target: [algoStatSnapshots.releaseId, algoStatSnapshots.scope, algoStatSnapshots.sourceId],
      set: {
        metrics,
        monthlyReturns,
        // A forward snapshot is republished as the deployment accumulates
        // trades, so the curve and the period must move with it.
        equityCurve: equityCurve.map((point) => ({ at: point.time, equity: Number(point.equity) })),
        periodEnd: resolved.periodEnd,
        calculationVersion: METRICS_CALCULATION_VERSION,
      },
    });

  return { ok: true, snapshotId };
}

export interface AlgoVisibilityInput {
  algoId: string;
  organisationId: string;
  actorUserId: string;
  traceId?: string;
}

/**
 * Marks an algo as PUBLISHED — ready to run, rather than still being written
 * up. Refuses without a published release and at least one evidence snapshot: a
 * library entry you cannot run and cannot check is a note, not an algo.
 */
export async function publishAlgo(db: Database, input: AlgoVisibilityInput): Promise<{ ok: true } | PublishFailure> {
  const [algo] = await db
    .select({ id: algos.id, status: algos.status })
    .from(algos)
    .where(and(eq(algos.id, input.algoId), eq(algos.organisationId, input.organisationId)))
    .limit(1);

  if (!algo) return { ok: false, reasonCode: "ALGO_NOT_FOUND", message: "No such algo." };

  const [release] = await db
    .select({ id: algoReleases.id })
    .from(algoReleases)
    .where(and(eq(algoReleases.algoId, input.algoId), eq(algoReleases.status, "PUBLISHED")))
    .orderBy(desc(algoReleases.releaseNumber))
    .limit(1);

  if (!release) {
    return { ok: false, reasonCode: "NO_PUBLISHED_RELEASE", message: "Publish a release before the algo." };
  }

  const [snapshot] = await db
    .select({ id: algoStatSnapshots.id })
    .from(algoStatSnapshots)
    .where(eq(algoStatSnapshots.releaseId, release.id))
    .limit(1);

  if (!snapshot) {
    return {
      ok: false,
      reasonCode: "NO_PUBLISHED_EVIDENCE",
      message: "Catalogue at least one evidence snapshot before publishing the algo.",
    };
  }

  await db.transaction(async (tx) => {
    await tx.update(algos).set({ status: "PUBLISHED", publishedAt: new Date() }).where(eq(algos.id, input.algoId));

    await tx.insert(auditEvents).values({
      id: generateId(),
      organisationId: input.organisationId,
      actor: `user:${input.actorUserId}`,
      action: "ALGO_PUBLISHED",
      aggregateType: "algo",
      aggregateId: input.algoId,
      priorStateSummary: { status: algo.status },
      newStateSummary: { status: "PUBLISHED" },
      reason: "Algo marked ready to run.",
      traceId: input.traceId ?? null,
    });
  });

  return { ok: true };
}

/** Retires an algo from the active library. Its releases and evidence stay readable. */
export async function retireAlgo(db: Database, input: AlgoVisibilityInput): Promise<{ ok: true } | PublishFailure> {
  const [algo] = await db
    .select({ id: algos.id, status: algos.status })
    .from(algos)
    .where(and(eq(algos.id, input.algoId), eq(algos.organisationId, input.organisationId)))
    .limit(1);

  if (!algo) return { ok: false, reasonCode: "ALGO_NOT_FOUND", message: "No such algo." };

  await db.transaction(async (tx) => {
    await tx.update(algos).set({ status: "RETIRED" }).where(eq(algos.id, input.algoId));

    await tx.insert(auditEvents).values({
      id: generateId(),
      organisationId: input.organisationId,
      actor: `user:${input.actorUserId}`,
      action: "ALGO_RETIRED",
      aggregateType: "algo",
      aggregateId: input.algoId,
      priorStateSummary: { status: algo.status },
      newStateSummary: { status: "RETIRED" },
      // Retiring stops an algo being offered as current; it deliberately does
      // NOT delete its releases or evidence — a rejected line of work is
      // exactly the thing this platform is supposed to keep.
      reason: "Algo retired from the active library.",
      traceId: input.traceId ?? null,
    });
  });

  return { ok: true };
}
