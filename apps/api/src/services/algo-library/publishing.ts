import { and, asc, desc, eq, max } from "drizzle-orm";
import { generateId, AlgoMetrics } from "@arf-os/contracts";
import type { MarketCategory, StatScope } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { algoReleases, algoStatSnapshots, algos, auditEvents, backtestRuns, pineRevisions, strategyVersions, trades } from "@arf-os/db";
import {
  calculateCoreMetrics,
  computeDrawdownCurve,
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

export interface PublishStatsInput {
  releaseId: string;
  organisationId: string;
  backtestRunId: string;
  scope: StatScope;
  actorUserId: string;
  traceId?: string;
}

/**
 * Builds a catalogued snapshot by recomputing metrics from the stored trade
 * ledger (CLAUDE.md 14 — independent calculation). Nothing here reads a
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

  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, input.backtestRunId)).limit(1);

  if (!run) {
    return { ok: false, reasonCode: "RUN_NOT_FOUND", message: "No such backtest run." };
  }

  if (run.strategyVersionId !== release.strategyVersionId) {
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
    .where(eq(trades.backtestRunId, input.backtestRunId))
    .orderBy(asc(trades.sequenceNumber));

  if (tradeRows.length === 0) {
    return { ok: false, reasonCode: "NO_TRADES", message: "A run with no trades has nothing to catalogue." };
  }

  const metricsTrades: MetricsTrade[] = tradeRows.map((row) => ({
    tradeNumber: row.sequenceNumber,
    direction: row.direction,
    entryTime: row.entryTime.toISOString(),
    exitTime: row.exitTime?.toISOString(),
    netPnl: row.netPnl === null ? undefined : Number(row.netPnl),
    isOpen: row.exitTime === null,
  }));

  const core = calculateCoreMetrics(metricsTrades);

  // The catalogued curve is reconstructed from the ledger, not read from the
  // stored equity_points a runner produced — same rule as everywhere else in
  // packages/metrics: the trades are the evidence.
  const initialCapital = Number(run.initialCapital);
  const equityCurve = reconstructEquityCurve(metricsTrades, run.initialCapital);
  const drawdown = computeDrawdownCurve(equityCurve);
  const netProfit = Number(core.netProfit);

  const metrics = AlgoMetrics.parse({
    netProfitPct: initialCapital === 0 ? 0 : (netProfit / initialCapital) * 100,
    maxDrawdownPct: Number(drawdown.maxDrawdownPct),
    profitFactor: core.profitFactor,
    winRatePct: core.winRatePct,
    tradeCount: core.closedTradeCount,
    sharpe: null,
    averageTradePct:
      core.closedTradeCount === 0 || initialCapital === 0
        ? null
        : (netProfit / core.closedTradeCount / initialCapital) * 100,
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
      scope: input.scope,
      sourceKind: "BACKTEST_RUN",
      sourceId: input.backtestRunId,
      periodStart: run.fromTs,
      periodEnd: run.toTs,
      metrics,
      monthlyReturns,
      equityCurve: equityCurve.map((point) => ({ at: point.time, equity: Number(point.equity) })),
      calculationVersion: METRICS_CALCULATION_VERSION,
      // The run's cost model is applied inside the stored net P&L, so every
      // catalogued number here is net — never gross dressed up as net.
      costsApplied: true,
    })
    .onConflictDoUpdate({
      target: [algoStatSnapshots.releaseId, algoStatSnapshots.scope, algoStatSnapshots.sourceId],
      set: { metrics, monthlyReturns, calculationVersion: METRICS_CALCULATION_VERSION },
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
