import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import { backtestRuns } from "@arf-os/db";
import {
  computeExposureOverlap,
  computeSeriesCorrelation,
  toDailyDrawdownSeries,
  toDailyEquitySeries,
  toDecimal,
  toReturnSeries,
  type ExposureOverlapResult,
  type SeriesCorrelationResult,
} from "@arf-os/metrics";
import { getDrawdownCurve, getEquityCurve, getTrades } from "./backtest-evidence.js";

const METHODOLOGY_NOTE =
  "Return and drawdown correlation are computed from trade-close events, not fixed daily bars — equity only updates when a trade closes, so this measures correlation of realized P&L timing, never correlation of held exposure (an open position is never marked to market between closes). Rank (Spearman) correlation is used for both, not Pearson: equity returns here are irregular-period (the gap between two consecutive readings varies), and drawdown levels are strongly serially autocorrelated — both undermine Pearson's assumptions. A pair with fewer than 10 overlapping days reports no coefficient rather than an unreliable one. Turnover/fee concentration assumes every selected strategy's symbol is quoted in the same currency — unverified by the schema, since no quote-currency field exists.";

interface SelectedStrategy {
  strategyId: string;
  strategyName: string;
  strategyVersionId: string;
}

/**
 * Extends `resolveFilteredStrategyIds`'s LATERAL "latest version per
 * strategy" pattern (`strategy-registry.ts`) with the PAPER_APPROVED filter
 * and, when supplied, the id-list filter — composed inside the SAME query
 * as the organisation clause, never a separate post-filter step (ADR 0009's
 * "Consequences" flagged exactly this as the risk to avoid).
 */
async function resolvePaperApprovedStrategies(
  db: Database,
  organisationId: string,
  strategyVersionIds: string[] | undefined,
): Promise<SelectedStrategy[]> {
  const conditions: SQL[] = [sql`s.organisation_id = ${organisationId}`, sql`latest.workflow_state = 'PAPER_APPROVED'`];
  if (strategyVersionIds && strategyVersionIds.length > 0) {
    conditions.push(sql`latest.id IN (${sql.join(strategyVersionIds.map((id) => sql`${id}`), sql`, `)})`);
  }

  const rows = await db.execute<{ strategy_id: string; strategy_name: string; strategy_version_id: string }>(sql`
    SELECT s.id AS strategy_id, s.name AS strategy_name, latest.id AS strategy_version_id
    FROM strategies s
    INNER JOIN LATERAL (
      SELECT sv.id, sv.workflow_state
      FROM strategy_versions sv
      WHERE sv.strategy_id = s.id
      ORDER BY sv.version_number DESC
      LIMIT 1
    ) latest ON true
    WHERE ${sql.join(conditions, sql` AND `)}
  `);

  return rows.map((row) => ({ strategyId: row.strategy_id, strategyName: row.strategy_name, strategyVersionId: row.strategy_version_id }));
}

const SEGMENT_PREFERENCE: Record<string, number> = { OUT_OF_SAMPLE: 0, VALIDATION: 1, IN_SAMPLE: 2 };

interface RepresentativeRun {
  backtestRunId: string;
  segmentKind: string;
  symbol: string;
}

/**
 * No "canonical run" concept exists anywhere in this repo — a deliberate,
 * reasoned departure from ADR 0009's "never invent a single comparison"
 * precedent: a correlation matrix needs exactly one node per strategy,
 * where Validation Lab's pairwise list didn't. Prefers the most
 * out-of-sample-like evidence available, most recent within that tier.
 */
async function resolveRepresentativeRun(db: Database, strategyVersionId: string): Promise<RepresentativeRun | undefined> {
  const rows = await db
    .select({ id: backtestRuns.id, segmentKind: backtestRuns.segmentKind, symbol: backtestRuns.symbol, createdAt: backtestRuns.createdAt })
    .from(backtestRuns)
    .where(and(eq(backtestRuns.strategyVersionId, strategyVersionId), eq(backtestRuns.status, "SUCCEEDED")));

  if (rows.length === 0) return undefined;

  rows.sort((a, b) => {
    const prefA = SEGMENT_PREFERENCE[a.segmentKind] ?? 3;
    const prefB = SEGMENT_PREFERENCE[b.segmentKind] ?? 3;
    return prefA !== prefB ? prefA - prefB : b.createdAt.getTime() - a.createdAt.getTime();
  });

  const best = rows[0];
  if (!best) return undefined;
  return { backtestRunId: best.id, segmentKind: best.segmentKind, symbol: best.symbol };
}

export interface StrategyEvidence {
  strategyId: string;
  strategyName: string;
  strategyVersionId: string;
  backtestRunId: string;
  segmentKind: string;
  symbol: string;
}

export interface ExcludedStrategy {
  strategyId: string;
  strategyName: string;
  reasonCode: "NO_SUCCEEDED_RUN";
}

export interface PairCorrelation {
  strategyAId: string;
  strategyBId: string;
  returnCorrelation: SeriesCorrelationResult;
  drawdownCorrelation: SeriesCorrelationResult;
  exposureOverlap: ExposureOverlapResult;
  /** True when the two strategies' representative runs come from different segmentKind tiers — a viewer shouldn't have to cross-reference two strings to notice they're comparing in-sample against out-of-sample evidence. */
  evidenceTierMismatch: boolean;
}

export interface MarketConcentrationRow {
  symbol: string;
  count: number;
}

export interface TurnoverRow {
  strategyId: string;
  strategyName: string;
  symbol: string;
  turnoverNotional: string;
  fees: string;
  turnoverPct: number;
  feePct: number;
}

export interface PortfolioCorrelationReport {
  computedAt: string;
  methodologyNote: string;
  strategies: StrategyEvidence[];
  excludedStrategies: ExcludedStrategy[];
  pairCorrelations: PairCorrelation[];
  marketConcentration: MarketConcentrationRow[];
  turnoverConcentration: TurnoverRow[];
}

interface StrategyTradeAndCurveData {
  dailyEquity: Map<string, number>;
  dailyDrawdown: Map<string, number>;
  trades: { entryTime: Date; exitTime: Date; quantity: string; entryPrice: string; fees: string }[];
}

/**
 * Every panel is computed live from data already in Postgres for a
 * caller-selected (or default: all) set of an organisation's PAPER_APPROVED
 * strategies — no new table, no persistence (ADR 0011).
 */
export async function getPortfolioCorrelationReport(
  db: Database,
  organisationId: string,
  options: { strategyVersionIds?: string[] | undefined } = {},
): Promise<PortfolioCorrelationReport> {
  const selected = await resolvePaperApprovedStrategies(db, organisationId, options.strategyVersionIds);

  const evidence: StrategyEvidence[] = [];
  const excludedStrategies: ExcludedStrategy[] = [];

  for (const s of selected) {
    const run = await resolveRepresentativeRun(db, s.strategyVersionId);
    if (!run) {
      excludedStrategies.push({ strategyId: s.strategyId, strategyName: s.strategyName, reasonCode: "NO_SUCCEEDED_RUN" });
      continue;
    }
    evidence.push({ ...s, backtestRunId: run.backtestRunId, segmentKind: run.segmentKind, symbol: run.symbol });
  }

  const dataByStrategyVersion = new Map<string, StrategyTradeAndCurveData>();
  for (const e of evidence) {
    const [equityRows, drawdownRows, tradeRows] = await Promise.all([
      getEquityCurve(db, organisationId, e.backtestRunId),
      getDrawdownCurve(db, organisationId, e.backtestRunId),
      getTrades(db, organisationId, e.backtestRunId),
    ]);

    const closedTrades = (tradeRows ?? [])
      .filter((t): t is typeof t & { exitTime: Date } => t.exitTime !== null)
      .map((t) => ({ entryTime: t.entryTime, exitTime: t.exitTime, quantity: t.quantity, entryPrice: t.entryPrice, fees: t.fees }));

    dataByStrategyVersion.set(e.strategyVersionId, {
      dailyEquity: toDailyEquitySeries(equityRows ?? []),
      dailyDrawdown: toDailyDrawdownSeries((drawdownRows ?? []).map((p) => ({ ...p, drawdownPct: Number(p.drawdownPct) }))),
      trades: closedTrades,
    });
  }

  const pairCorrelations: PairCorrelation[] = [];
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      const a = evidence[i];
      const b = evidence[j];
      if (!a || !b) continue;
      const dataA = dataByStrategyVersion.get(a.strategyVersionId);
      const dataB = dataByStrategyVersion.get(b.strategyVersionId);
      if (!dataA || !dataB) continue;

      pairCorrelations.push({
        strategyAId: a.strategyId,
        strategyBId: b.strategyId,
        returnCorrelation: computeSeriesCorrelation(toReturnSeries(dataA.dailyEquity), toReturnSeries(dataB.dailyEquity)),
        drawdownCorrelation: computeSeriesCorrelation(dataA.dailyDrawdown, dataB.dailyDrawdown),
        exposureOverlap: computeExposureOverlap(dataA.trades, dataB.trades),
        evidenceTierMismatch: a.segmentKind !== b.segmentKind,
      });
    }
  }

  const marketCounts = new Map<string, number>();
  for (const e of evidence) marketCounts.set(e.symbol, (marketCounts.get(e.symbol) ?? 0) + 1);
  const marketConcentration = Array.from(marketCounts.entries(), ([symbol, count]) => ({ symbol, count }));

  const rawTurnover = evidence.map((e) => {
    const trades = dataByStrategyVersion.get(e.strategyVersionId)?.trades ?? [];
    const turnoverNotional = trades.reduce((sum, t) => sum.plus(toDecimal(t.quantity).times(t.entryPrice)), toDecimal(0));
    const fees = trades.reduce((sum, t) => sum.plus(t.fees), toDecimal(0));
    return { strategyId: e.strategyId, strategyName: e.strategyName, symbol: e.symbol, turnoverNotional, fees };
  });
  const grandTurnover = rawTurnover.reduce((sum, r) => sum.plus(r.turnoverNotional), toDecimal(0));
  const grandFees = rawTurnover.reduce((sum, r) => sum.plus(r.fees), toDecimal(0));

  const turnoverConcentration: TurnoverRow[] = rawTurnover.map((r) => ({
    strategyId: r.strategyId,
    strategyName: r.strategyName,
    symbol: r.symbol,
    turnoverNotional: r.turnoverNotional.toFixed(2),
    fees: r.fees.toFixed(8),
    turnoverPct: grandTurnover.isZero() ? 0 : r.turnoverNotional.dividedBy(grandTurnover).times(100).toNumber(),
    feePct: grandFees.isZero() ? 0 : r.fees.dividedBy(grandFees).times(100).toNumber(),
  }));

  return {
    computedAt: new Date().toISOString(),
    methodologyNote: METHODOLOGY_NOTE,
    strategies: evidence,
    excludedStrategies,
    pairCorrelations,
    marketConcentration,
    turnoverConcentration,
  };
}

