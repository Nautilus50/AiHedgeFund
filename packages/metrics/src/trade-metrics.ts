import { Decimal, toDecimal } from "./decimal.js";
import type { MetricsTrade } from "./types.js";

export const METRICS_CALCULATION_VERSION = "1.0.0";

export interface MonthlyReturn {
  /** "YYYY-MM", derived from exitTime in UTC. */
  month: string;
  netProfit: string;
}

export interface CoreMetrics {
  calculationVersion: string;
  closedTradeCount: number;
  winningTrades: number;
  losingTrades: number;
  /** Decimal strings — CLAUDE.md 7.4: never binary floating point for authoritative monetary totals. */
  grossProfit: string;
  grossLoss: string;
  netProfit: string;
  /** null when there are no losing trades (profit factor is undefined, not infinite). */
  profitFactor: number | null;
  /** 0-100, not a 0-1 fraction (CLAUDE.md 7.4 — name fields to distinguish 0.05 from 5). */
  winRatePct: number;
  avgWin: string;
  avgLoss: string;
  /** null when there are no losing trades. */
  payoffRatio: number | null;
  longestLosingStreak: number;
  /** null when no closed trade has both entry and exit timestamps. */
  avgHoldingDurationHours: number | null;
  monthlyReturns: MonthlyReturn[];
}

function isClosed(trade: MetricsTrade): trade is MetricsTrade & { netPnl: number; exitTime: string } {
  return !trade.isOpen && trade.netPnl !== undefined && trade.exitTime !== undefined;
}

/**
 * Independently recomputes core performance metrics from a trade ledger —
 * never trusts a runner- or TradingView-reported number directly
 * (CLAUDE.md 14, "packages/metrics provides independent calculations").
 * Pure and deterministic: same trades in, same metrics out, every time.
 */
export function calculateCoreMetrics(trades: readonly MetricsTrade[]): CoreMetrics {
  const closed = trades.filter(isClosed).sort((a, b) => a.exitTime.localeCompare(b.exitTime));

  let grossProfit = new Decimal(0);
  let grossLoss = new Decimal(0);
  let winningTrades = 0;
  let losingTrades = 0;
  let currentLosingStreak = 0;
  let longestLosingStreak = 0;

  const monthlyTotals = new Map<string, Decimal>();
  let durationHoursTotal = new Decimal(0);
  let durationSampleCount = 0;

  for (const trade of closed) {
    const pnl = toDecimal(trade.netPnl);

    if (pnl.greaterThan(0)) {
      grossProfit = grossProfit.plus(pnl);
      winningTrades += 1;
      currentLosingStreak = 0;
    } else if (pnl.lessThan(0)) {
      grossLoss = grossLoss.plus(pnl.abs());
      losingTrades += 1;
      currentLosingStreak += 1;
      longestLosingStreak = Math.max(longestLosingStreak, currentLosingStreak);
    } else {
      currentLosingStreak = 0;
    }

    const month = trade.exitTime.slice(0, 7);
    monthlyTotals.set(month, (monthlyTotals.get(month) ?? new Decimal(0)).plus(pnl));

    const entryMs = Date.parse(trade.entryTime);
    const exitMs = Date.parse(trade.exitTime);
    if (Number.isFinite(entryMs) && Number.isFinite(exitMs) && exitMs >= entryMs) {
      durationHoursTotal = durationHoursTotal.plus((exitMs - entryMs) / 3_600_000);
      durationSampleCount += 1;
    }
  }

  const netProfit = grossProfit.minus(grossLoss);
  const closedTradeCount = closed.length;

  const profitFactor = grossLoss.isZero() ? null : grossProfit.dividedBy(grossLoss).toNumber();
  const avgWin = winningTrades > 0 ? grossProfit.dividedBy(winningTrades) : new Decimal(0);
  const avgLossMagnitude = losingTrades > 0 ? grossLoss.dividedBy(losingTrades) : new Decimal(0);
  const payoffRatio = losingTrades > 0 && !avgLossMagnitude.isZero() ? avgWin.dividedBy(avgLossMagnitude).toNumber() : null;

  const monthlyReturns: MonthlyReturn[] = Array.from(monthlyTotals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, total]) => ({ month, netProfit: total.toFixed(8) }));

  return {
    calculationVersion: METRICS_CALCULATION_VERSION,
    closedTradeCount,
    winningTrades,
    losingTrades,
    grossProfit: grossProfit.toFixed(8),
    grossLoss: grossLoss.toFixed(8),
    netProfit: netProfit.toFixed(8),
    profitFactor,
    winRatePct: closedTradeCount > 0 ? (winningTrades / closedTradeCount) * 100 : 0,
    avgWin: avgWin.toFixed(8),
    // Reported as a negative value: the average size of a losing trade, not its magnitude.
    avgLoss: avgLossMagnitude.negated().toFixed(8),
    payoffRatio,
    longestLosingStreak,
    avgHoldingDurationHours: durationSampleCount > 0 ? durationHoursTotal.dividedBy(durationSampleCount).toNumber() : null,
    monthlyReturns,
  };
}
