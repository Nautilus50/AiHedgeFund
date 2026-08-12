import { and, asc, eq, gt, or } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import {
  backtestRuns,
  drawdownPoints,
  equityPoints,
  metricSnapshots,
  parityReports,
  strategies,
  strategyVersions,
  trades,
} from "@arf-os/db";
import { buildPage, clampPageSize, decodeCursor, type Page } from "../lib/pagination.js";

/**
 * A backtest run's evidence tables (trades, equity, drawdown, metrics,
 * parity) are all keyed by `backtest_run_id`, not `strategy_version_id`
 * directly — every read below confirms the run belongs to the caller's
 * organisation first, mirroring `getBacktestRun`'s join
 * (CLAUDE.md 19.1: verify organisation ownership on every aggregate
 * access), then reads the child rows scoped to that one run.
 */
export async function backtestRunBelongsToOrg(
  db: Database,
  organisationId: string,
  backtestRunId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: backtestRuns.id })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(backtestRuns.id, backtestRunId), eq(strategies.organisationId, organisationId)))
    .limit(1);

  return row !== undefined;
}

export interface ListBacktestRunsInput {
  strategyVersionId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export type ListBacktestRunsResult =
  | { ok: true; page: Page<{ id: string; createdAt: Date } & Record<string, unknown>> }
  | { ok: false; reasonCode: "INVALID_CURSOR" };

/** Cursor-paginated: a strategy version can accumulate many runs over repeated re-runs and walk-forward segments. */
export async function listBacktestRuns(
  db: Database,
  organisationId: string,
  input: ListBacktestRunsInput,
): Promise<ListBacktestRunsResult> {
  const limit = clampPageSize(input.limit);

  let cursorClause;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded.ok) {
      return { ok: false, reasonCode: "INVALID_CURSOR" };
    }
    const { createdAtIso, id } = decoded.cursor;
    const createdAtDate = new Date(createdAtIso);
    cursorClause = or(
      gt(backtestRuns.createdAt, createdAtDate),
      and(eq(backtestRuns.createdAt, createdAtDate), gt(backtestRuns.id, id)),
    );
  }

  const baseClause = and(
    eq(backtestRuns.strategyVersionId, input.strategyVersionId),
    eq(strategies.organisationId, organisationId),
  );

  const rows = await db
    .select({
      id: backtestRuns.id,
      strategyVersionId: backtestRuns.strategyVersionId,
      runnerType: backtestRuns.runnerType,
      runnerVersion: backtestRuns.runnerVersion,
      symbol: backtestRuns.symbol,
      timeframe: backtestRuns.timeframe,
      segmentKind: backtestRuns.segmentKind,
      status: backtestRuns.status,
      errorCode: backtestRuns.errorCode,
      startedAt: backtestRuns.startedAt,
      completedAt: backtestRuns.completedAt,
      createdAt: backtestRuns.createdAt,
    })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(cursorClause ? and(baseClause, cursorClause) : baseClause)
    .orderBy(backtestRuns.createdAt, backtestRuns.id)
    .limit(limit + 1);

  return { ok: true, page: buildPage(rows, limit) };
}

/**
 * Every evidence-read function below returns `undefined` when the run
 * isn't the caller's — never partial data, never a 500 that would leak
 * whether the id exists in another organisation.
 */

const MAX_EVIDENCE_ROWS = 5000;

export async function getTrades(db: Database, organisationId: string, backtestRunId: string) {
  if (!(await backtestRunBelongsToOrg(db, organisationId, backtestRunId))) return undefined;

  return db
    .select()
    .from(trades)
    .where(eq(trades.backtestRunId, backtestRunId))
    .orderBy(asc(trades.sequenceNumber))
    .limit(MAX_EVIDENCE_ROWS);
}

export async function getEquityCurve(db: Database, organisationId: string, backtestRunId: string) {
  if (!(await backtestRunBelongsToOrg(db, organisationId, backtestRunId))) return undefined;

  return db
    .select()
    .from(equityPoints)
    .where(eq(equityPoints.backtestRunId, backtestRunId))
    .orderBy(asc(equityPoints.sequenceNumber))
    .limit(MAX_EVIDENCE_ROWS);
}

export async function getDrawdownCurve(db: Database, organisationId: string, backtestRunId: string) {
  if (!(await backtestRunBelongsToOrg(db, organisationId, backtestRunId))) return undefined;

  return db
    .select()
    .from(drawdownPoints)
    .where(eq(drawdownPoints.backtestRunId, backtestRunId))
    .orderBy(asc(drawdownPoints.sequenceNumber))
    .limit(MAX_EVIDENCE_ROWS);
}

/** `metric_snapshots` is scoped generically (CLAUDE.md 14 — run/segment/strategy version/.../portfolio); this reads only the RUN scope. */
export async function getMetrics(db: Database, organisationId: string, backtestRunId: string) {
  if (!(await backtestRunBelongsToOrg(db, organisationId, backtestRunId))) return undefined;

  return db
    .select()
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.scopeType, "RUN"), eq(metricSnapshots.scopeId, backtestRunId)))
    .orderBy(asc(metricSnapshots.metricName));
}

export async function getParityReports(db: Database, organisationId: string, backtestRunId: string) {
  if (!(await backtestRunBelongsToOrg(db, organisationId, backtestRunId))) return undefined;

  return db
    .select()
    .from(parityReports)
    .where(eq(parityReports.backtestRunId, backtestRunId))
    .orderBy(asc(parityReports.createdAt));
}
