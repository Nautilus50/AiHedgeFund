import { and, eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { backtestRuns, datasetVersions, outboxEvents, strategies, strategyVersions, tradingviewVerifications } from "@arf-os/db";

export interface CreateBacktestRunInput {
  organisationId: string;
  strategyVersionId: string;
  runnerType: "LOCAL_RUNNER" | "TRADINGVIEW";
  runnerVersion: string;
  verificationId?: string | undefined;
  datasetVersionId?: string | undefined;
  symbol: string;
  timeframe: string;
  segmentKind: string;
  fromTs: Date;
  toTs: Date;
  costModel: Record<string, unknown>;
  initialCapital: string;
  sourceHash: string;
  environmentHash?: string | undefined;
  actor: string;
}

/**
 * Creates the run identity every piece of downstream evidence hangs from.
 *
 * This is deliberately an explicit command rather than something ingestion
 * infers. A run records the market, window, cost model, capital, and source
 * hash a result was produced under — reproducibility depends on those being
 * what the researcher actually used (CLAUDE.md 4), and none of them can be
 * recovered from a TradingView export. A worker inventing them to satisfy
 * NOT NULL columns would be manufacturing provenance.
 */
export async function createBacktestRun(
  db: Database,
  input: CreateBacktestRunInput,
): Promise<{ backtestRunId: string }> {
  const backtestRunId = generateId<string>();

  await db.transaction(async (tx) => {
    await tx.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId: input.strategyVersionId,
      runnerType: input.runnerType,
      runnerVersion: input.runnerVersion,
      verificationId: input.verificationId ?? null,
      datasetVersionId: input.datasetVersionId ?? null,
      symbol: input.symbol,
      timeframe: input.timeframe,
      segmentKind: input.segmentKind,
      fromTs: input.fromTs,
      toTs: input.toTs,
      costModel: input.costModel,
      initialCapital: input.initialCapital,
      sourceHash: input.sourceHash,
      environmentHash: input.environmentHash ?? null,
    });

    // Transactional outbox (CLAUDE.md 9.3): committed with the run it
    // describes. TradingView runs get no event — that path is driven by
    // report upload, not run creation.
    if (input.runnerType === "LOCAL_RUNNER") {
      const now = new Date();
      await tx.insert(outboxEvents).values({
        id: generateId<string>(),
        eventType: "backtest_run.local_execution_requested",
        eventVersion: "1.0.0",
        aggregateId: backtestRunId,
        aggregateVersion: now.getTime().toString(),
        correlationId: generateId<string>(),
        organisationId: input.organisationId,
        actor: input.actor,
        // LocalRunnerExecutionJob's exact shape.
        payload: { backtestRunId },
        createdAt: now,
      });
    }
  });

  return { backtestRunId };
}

/** Organisation-scoped existence check, mirroring `verificationMatchesVersion`'s ownership pattern. */
export async function datasetVersionBelongsToOrg(
  db: Database,
  organisationId: string,
  datasetVersionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: datasetVersions.id })
    .from(datasetVersions)
    .where(and(eq(datasetVersions.id, datasetVersionId), eq(datasetVersions.organisationId, organisationId)))
    .limit(1);

  return row !== undefined;
}

/**
 * Organisation-scoped fetch, joined through `strategies` so a caller can
 * never reach another organisation's run by guessing an id (CLAUDE.md 19.1).
 */
export async function getBacktestRun(db: Database, organisationId: string, backtestRunId: string) {
  const [row] = await db
    .select({
      id: backtestRuns.id,
      strategyVersionId: backtestRuns.strategyVersionId,
      organisationId: strategies.organisationId,
      runnerType: backtestRuns.runnerType,
      runnerVersion: backtestRuns.runnerVersion,
      verificationId: backtestRuns.verificationId,
      symbol: backtestRuns.symbol,
      timeframe: backtestRuns.timeframe,
      segmentKind: backtestRuns.segmentKind,
      fromTs: backtestRuns.fromTs,
      toTs: backtestRuns.toTs,
      initialCapital: backtestRuns.initialCapital,
      status: backtestRuns.status,
      sourceHash: backtestRuns.sourceHash,
      errorCode: backtestRuns.errorCode,
      startedAt: backtestRuns.startedAt,
      completedAt: backtestRuns.completedAt,
      createdAt: backtestRuns.createdAt,
    })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(backtestRuns.id, backtestRunId), eq(strategies.organisationId, organisationId)))
    .limit(1);

  return row;
}

/**
 * Confirms a verification belongs to the same organisation *and* the same
 * strategy version as the run being created. Without the second check a
 * caller could attach a run to a verification of an unrelated version in
 * their own organisation, which would make parity compare two different
 * strategies against each other.
 */
export async function verificationMatchesVersion(
  db: Database,
  organisationId: string,
  verificationId: string,
  strategyVersionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: tradingviewVerifications.id })
    .from(tradingviewVerifications)
    .innerJoin(strategyVersions, eq(strategyVersions.id, tradingviewVerifications.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(
      and(
        eq(tradingviewVerifications.id, verificationId),
        eq(tradingviewVerifications.strategyVersionId, strategyVersionId),
        eq(strategies.organisationId, organisationId),
      ),
    )
    .limit(1);

  return row !== undefined;
}
