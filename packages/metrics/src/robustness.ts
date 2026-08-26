import { toDecimal } from "./decimal.js";
import { calculateCoreMetrics, type CoreMetrics } from "./trade-metrics.js";
import type { MetricsTrade } from "./types.js";

/**
 * `CoreMetrics` minus the two fields that are sequence-shaped over a run's
 * *real* trade order and become fabricated when computed over a filtered
 * subset: `longestLosingStreak` (counts consecutive real-time losers — a
 * trade-removal or long-only filter breaks up streaks that really happened,
 * or invents ones that never did) and `monthlyReturns` (gappy/misleading on
 * a subset). Every robustness function below returns this, never the raw
 * `CoreMetrics`, when computing over anything other than a run's full
 * ledger (ADR 0009).
 */
export type SubsetMetrics = Omit<CoreMetrics, "longestLosingStreak" | "monthlyReturns">;

/**
 * Exported so a caller comparing a target run's own (full-ledger, not
 * subset-filtered) `CoreMetrics` against a sibling's — e.g. for
 * {@link computeDegradation} — can produce the same `SubsetMetrics` shape
 * without a second, duplicate field-picking helper.
 */
export function toSubsetMetrics(full: CoreMetrics): SubsetMetrics {
  return {
    calculationVersion: full.calculationVersion,
    closedTradeCount: full.closedTradeCount,
    winningTrades: full.winningTrades,
    losingTrades: full.losingTrades,
    grossProfit: full.grossProfit,
    grossLoss: full.grossLoss,
    netProfit: full.netProfit,
    profitFactor: full.profitFactor,
    winRatePct: full.winRatePct,
    avgWin: full.avgWin,
    avgLoss: full.avgLoss,
    payoffRatio: full.payoffRatio,
    avgHoldingDurationHours: full.avgHoldingDurationHours,
  };
}

function isClosed(trade: MetricsTrade): trade is MetricsTrade & { netPnl: number } {
  return !trade.isOpen && trade.netPnl !== undefined;
}

export interface TradeContribution {
  tradeNumber: number;
  netPnl: number;
  /** Running cumulative % of total net profit, in netPnl-descending order. */
  cumulativePct: number;
}

export interface TradeRemovalConcentration {
  curve: TradeContribution[];
  totalNetProfit: string;
}

/**
 * Answers "does the edge depend on a few extreme trades?" (spec §7.7 item
 * 15) with the full cumulative-contribution curve, not a single "top N" —
 * a fixed N would just be a UI highlight, not the definition of the test.
 */
export function computeTradeRemovalConcentration(trades: readonly MetricsTrade[]): TradeRemovalConcentration {
  const closed = trades.filter(isClosed);
  const totalNetProfit = closed.reduce((sum, t) => sum.plus(t.netPnl), toDecimal(0));

  const sorted = [...closed].sort((a, b) => b.netPnl - a.netPnl);

  let running = toDecimal(0);
  const curve: TradeContribution[] = sorted.map((trade) => {
    running = running.plus(trade.netPnl);
    const cumulativePct = totalNetProfit.isZero() ? 0 : running.dividedBy(totalNetProfit.abs()).times(100).toNumber();
    return { tradeNumber: trade.tradeNumber, netPnl: trade.netPnl, cumulativePct };
  });

  return { curve, totalNetProfit: totalNetProfit.toFixed(8) };
}

export interface DirectionalBreakdown {
  long: SubsetMetrics;
  short: SubsetMetrics;
}

/** Long-only vs short-only performance. `calculateCoreMetrics` re-sorts internally and never reads `tradeNumber`, so filtering by direction before calling it is safe. */
export function computeDirectionalBreakdown(trades: readonly MetricsTrade[]): DirectionalBreakdown {
  return {
    long: toSubsetMetrics(calculateCoreMetrics(trades.filter((t) => t.direction === "LONG"))),
    short: toSubsetMetrics(calculateCoreMetrics(trades.filter((t) => t.direction === "SHORT"))),
  };
}

export interface DegradationResult {
  /** Relative % change vs baseline; null when baseline netProfit is zero (no defined base to degrade from). Positive = comparison is worse. */
  netProfitDegradationPct: number | null;
  /** Relative % change vs baseline; null when either side has no profit factor (no losing trades on that side). */
  profitFactorDegradationPct: number | null;
  /** Percentage-*point* difference (baseline - comparison), not a relative %, since win rate is already itself a percentage. Positive = comparison is worse. */
  winRateDegradationPct: number;
}

/** Compares a baseline run's metrics (e.g. in-sample) against a comparison run (e.g. out-of-sample). */
export function computeDegradation(baseline: SubsetMetrics, comparison: SubsetMetrics): DegradationResult {
  const baselineNetProfit = toDecimal(baseline.netProfit);
  const comparisonNetProfit = toDecimal(comparison.netProfit);
  const netProfitDegradationPct = baselineNetProfit.isZero()
    ? null
    : baselineNetProfit.minus(comparisonNetProfit).dividedBy(baselineNetProfit.abs()).times(100).toNumber();

  const profitFactorDegradationPct =
    baseline.profitFactor === null || comparison.profitFactor === null
      ? null
      : ((baseline.profitFactor - comparison.profitFactor) / Math.abs(baseline.profitFactor)) * 100;

  const winRateDegradationPct = baseline.winRatePct - comparison.winRatePct;

  return { netProfitDegradationPct, profitFactorDegradationPct, winRateDegradationPct };
}

export interface BenchmarkComparisonResult {
  /** The run's own realized return over its full window: netProfit / initialCapital * 100. Cost-inclusive, since netProfit already is. */
  strategyReturnPct: number;
  /** Buy-and-hold price return over the same window's first and last available bars: (exitPrice - entryPrice) / entryPrice * 100. Zero transaction cost assumed — a single entry and exit, unlike the strategy's own trade sequence. */
  benchmarkReturnPct: number;
  /** strategyReturnPct minus benchmarkReturnPct, in percentage points (not a relative %) — matching winRateDegradationPct's convention above, since both sides are already percentages. */
  excessReturnPct: number;
}

/**
 * Compares a run's own return against a buy-and-hold benchmark over the
 * same symbol and window (spec §7.7's "benchmark comparison", the last item
 * on ADR 0009's originally-unbuilt list — buildable now that ADR 0014 added
 * real OHLCV data to source `benchmarkEntryPrice`/`benchmarkExitPrice`
 * from). This answers "did the strategy beat just holding the asset?" and
 * nothing more: no risk adjustment (a strategy with a lower return but far
 * shallower drawdown is not "worse" by this number alone), no statistical
 * significance, and the benchmark side assumes a single frictionless
 * buy-and-hold trade while the strategy side is cost-inclusive — an
 * asymmetry stated here, not smoothed over.
 */
export function computeBenchmarkComparison(
  netProfit: string,
  initialCapital: string,
  benchmarkEntryPrice: number,
  benchmarkExitPrice: number,
): BenchmarkComparisonResult | undefined {
  const capital = toDecimal(initialCapital);
  if (capital.isZero() || benchmarkEntryPrice === 0) return undefined;

  const strategyReturnPct = toDecimal(netProfit).dividedBy(capital).times(100).toNumber();
  const benchmarkReturnPct = ((benchmarkExitPrice - benchmarkEntryPrice) / benchmarkEntryPrice) * 100;

  return { strategyReturnPct, benchmarkReturnPct, excessReturnPct: strategyReturnPct - benchmarkReturnPct };
}

export const MONTE_CARLO_CALCULATION_VERSION = "1.0.0";
export const MONTE_CARLO_ITERATIONS = 1000;
/** A fixed constant, not a per-call random seed — every call over the same trade ledger reshuffles identically, so results are reproducible (CLAUDE.md 4), not different on every page load. */
export const MONTE_CARLO_SEED = 20260826;

/**
 * A small, deterministic, seedable PRNG (mulberry32) — not `Math.random()`,
 * which would make every reload of an immutable run's Monte Carlo panel
 * report a different fan. Same seed, same trade count, same output, always.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PercentileBand {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

function percentileBand(sortedAscending: readonly number[]): PercentileBand {
  const at = (p: number): number => {
    const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.round(p * (sortedAscending.length - 1))));
    return sortedAscending[index] ?? 0;
  };
  return { p5: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95) };
}

export interface MonteCarloFanResult {
  calculationVersion: string;
  iterations: number;
  seed: number;
  /** Percentile band of each simulated path's total return (%, relative to initialCapital) after reshuffling this run's own closed-trade P&L sequence. */
  finalReturnPct: PercentileBand;
  /** Percentile band of each simulated path's max drawdown, as a % of that path's own running peak. */
  maxDrawdownPct: PercentileBand;
}

/**
 * Trade-order resampling, spec §7.7's "Monte Carlo fan" — the one item on
 * ADR 0009's originally-unbuilt list buildable with zero new data: it
 * reshuffles (bootstrap, with replacement) this run's own closed-trade net
 * P&L sequence `iterations` times, walks each resampled sequence as an
 * equity path from `initialCapital`, and reports percentile bands of each
 * path's final return and max drawdown. This measures exactly one thing —
 * how much *trade-order luck alone* shaped this run's own equity curve —
 * and nothing else: it says nothing about parameter robustness, regime
 * sensitivity, or whether a *different* set of trades would have occurred
 * under different market conditions. Every resampled path draws from the
 * same fixed bag of this run's own outcomes; it cannot invent a trade this
 * run never had. Returns undefined for a run with no closed trades or a
 * non-positive `initialCapital` (no return % is defined to plot a fan of).
 */
export function computeMonteCarloFan(
  trades: readonly MetricsTrade[],
  initialCapital: string,
  options: { iterations?: number; seed?: number } = {},
): MonteCarloFanResult | undefined {
  const closedPnls = trades.filter(isClosed).map((t) => t.netPnl);
  if (closedPnls.length === 0) return undefined;

  const capital = toDecimal(initialCapital).toNumber();
  if (!(capital > 0)) return undefined;

  const iterations = options.iterations ?? MONTE_CARLO_ITERATIONS;
  const seed = options.seed ?? MONTE_CARLO_SEED;
  const rand = mulberry32(seed);

  const finalReturns: number[] = [];
  const maxDrawdowns: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let equity = capital;
    let peak = capital;
    let maxDrawdown = 0;

    for (let j = 0; j < closedPnls.length; j++) {
      const pick = closedPnls[Math.floor(rand() * closedPnls.length)] ?? 0;
      equity += pick;
      peak = Math.max(peak, equity);
      const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      maxDrawdown = Math.max(maxDrawdown, drawdownPct);
    }

    finalReturns.push(((equity - capital) / capital) * 100);
    maxDrawdowns.push(maxDrawdown);
  }

  finalReturns.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  return {
    calculationVersion: MONTE_CARLO_CALCULATION_VERSION,
    iterations,
    seed,
    finalReturnPct: percentileBand(finalReturns),
    maxDrawdownPct: percentileBand(maxDrawdowns),
  };
}
